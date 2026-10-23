// Runs inside Electron against the production app. The notebook syncs with a headless host
// first; this Mac takes that host over through Settings, then offers it on to another machine.
const { app, BrowserWindow } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const {
  OPSIDIAN_VAULT_DIR: vault,
  OPSIDIAN_OLD_HOST: old,
  OPSIDIAN_INVITE_CODE: invite,
  OPSIDIAN_MOVE_CODE: moveCode,
  OPSIDIAN_HOST_PORT: port,
} = process.env;
app.setPath('userData', process.env.OPSIDIAN_PROFILE_DIR);
mkdirSync(vault, { recursive: true });
writeFileSync(join(vault, 'First.md'), 'written before any host\n');
require('../apps/desktop/dist-electron/main.cjs');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, tries = 400) {
  for (let n = 0; n < tries; n++) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
let finished = false;
app.on('will-quit', () => {
  if (!finished) process.exit(1);
});
(async () => {
  await app.whenReady();
  await waitFor(() => BrowserWindow.getAllWindows().length, 'window');
  const window = BrowserWindow.getAllWindows()[0];
  window.show();
  const evaluate = (script) =>
    window.webContents.executeJavaScript(script).catch((error) => {
      throw new Error(`${error.message}\n  in: ${script.slice(0, 300)}`);
    });
  const shows = (text) => evaluate(`document.body.textContent.includes(${JSON.stringify(text)})`);
  const click = (label) =>
    evaluate(`document.querySelector('[aria-label=${JSON.stringify(label)}]').click()`);
  const button = (text) =>
    evaluate(
      `(() => { const all = [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === ${JSON.stringify(text)}); all[all.length - 1].click(); })()`,
    );
  const type = (selector, value) =>
    evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
  const hosting = () => evaluate('window.opsidian.hosting()');
  const sync = () => evaluate('window.opsidian.syncInfo()');
  const pass = (label) => console.log(`PASS ${label}`);
  // Pictures of each screen, when asked for, to look at what the user sees.
  const picture = async (name) => {
    const folder = process.env.OPSIDIAN_SCREENSHOTS;
    if (!folder) return;
    await delay(300);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  const here = `http://127.0.0.1:${port}`;

  await waitFor(
    () => evaluate('Boolean(document.querySelector(\'[aria-label="Settings"]\'))'),
    'the notebook',
  );
  await evaluate(`window.opsidian.connect(${JSON.stringify(old)}, ${JSON.stringify(invite)})`);
  await waitFor(async () => (await sync()).state === 'synced', 'the notebook to sync');
  pass('the notebook syncs with a headless host on another machine');

  // Take the host over, from the address this Mac already syncs with.
  await click('Settings');
  await button('Sync');
  await waitFor(() => shows('Host from this Mac instead'), 'the sync settings');
  await button('Take over hosting…');
  await waitFor(() => evaluate('Boolean(document.querySelector("#take-over-code"))'), 'the form');
  assert.equal(await evaluate('document.querySelector("#take-over-address").value'), old);
  await type('#take-over-code', moveCode);
  await picture('1-take-over');
  await button('Take over');
  await waitFor(() => shows('This Mac is the host now'), 'the take-over to finish');
  await picture('2-taken-over');
  await button('Done');
  const taken = await hosting();
  assert.equal(taken.hosting, true);
  assert.equal(taken.notebooks.length, 1);
  assert.equal(taken.notebooks[0].files, 1);
  assert.equal(taken.devices.filter((each) => each.self).length, 1);
  await waitFor(async () => (await sync()).host === here, 'this Mac to sync with itself');
  await waitFor(async () => (await sync()).state === 'synced', 'the notebook to sync again');
  const answer = await (await fetch(`http://${old}/v1`)).json();
  assert.equal(answer.moved, true);
  pass('took the host over: its notebook, history and this Mac as a device, now served here');

  writeFileSync(join(vault, 'Second.md'), 'written after the move\n');
  await waitFor(
    async () => (await hosting()).notebooks[0].files === 2,
    'a new note to reach the host here',
  );
  await waitFor(() => shows('This Mac is the host'), 'the hosting settings');
  await picture('3-hosting');
  pass('new notes reach the host on this Mac');

  // Offer it on to the next machine, which here is played over plain HTTP.
  await button('Move…');
  await waitFor(
    () => evaluate('/[A-Z0-9]{4}-/.test(document.querySelector("#move-code")?.textContent ?? "")'),
    'a move code',
  );
  const code = await evaluate('document.querySelector("#move-code").textContent');
  await picture('4-move');
  assert.match(await evaluate('document.querySelector("#move-command").textContent'), /take-over/);
  const call = async (path, init = {}) => {
    const response = await fetch(`${here}/v1${path}`, init);
    assert.ok(response.ok, `${path} answered ${response.status}`);
    return response;
  };
  const { token } = await (
    await call('/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
  ).json();
  const auth = { authorization: `Bearer ${token}` };
  await waitFor(() => shows('The other machine is copying the host now'), 'the dialog to notice');
  const { files } = await (await call('/move/files', { headers: auth })).json();
  assert.ok(files.some((each) => each.path.startsWith('blobs/')));
  await call('/move/freeze', { method: 'POST', headers: auth });
  assert.ok((await (await call('/move/database', { headers: auth })).arrayBuffer()).byteLength);
  const next = 'http://127.0.0.1:9';
  await call('/move/finish', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ to: next }),
  });
  await waitFor(() => shows('Hosting has moved'), 'the dialog to say it moved');
  await button('Done');
  await waitFor(() => shows('Hosting moved'), 'the settings to say it moved');
  await picture('5-moved');
  // Nothing answers at the next address in this test, so this Mac says so and keeps trying.
  await waitFor(
    async () => /moved to 127\.0\.0\.1:9/.test((await sync()).message ?? ''),
    'this Mac to try to follow',
  );
  pass('moved the host on: the settings say where, and this Mac tries to follow it');

  await button('Stop');
  await waitFor(async () => !(await hosting()).hosting, 'hosting to stop');
  pass('stopped pointing devices');

  finished = true;
  app.exit(0);
})().catch((error) => {
  console.error(`FAIL ${error.stack ?? error}`);
  app.exit(1);
});
