// Runs inside Electron against the production app; see test-leaving.mjs.
const { app, BrowserWindow, dialog } = require('electron');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, readdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const env = process.env;
const vault = env.OPSIDIAN_VAULT_DIR;
const profile = env.OPSIDIAN_PROFILE_DIR;
const backups = env.OPSIDIAN_BACKUP_DIR;
app.setPath('userData', profile);
mkdirSync(vault, { recursive: true });
writeFileSync(join(vault, 'First.md'), 'written before syncing\n');
require('../apps/desktop/dist-electron/main.cjs');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, tries = 400) {
  for (let n = 0; n < tries; n++) {
    if (await check().catch(() => false)) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const exit = app.exit.bind(app);
let finished = false;
app.on('will-quit', () => {
  if (!finished) process.exit(1);
});
(async () => {
  await app.whenReady();
  await waitFor(async () => BrowserWindow.getAllWindows().length, 'window');
  const win = () => BrowserWindow.getAllWindows()[0];
  const evaluate = (script) =>
    win()
      .webContents.executeJavaScript(script)
      .catch((error) => {
        throw new Error(`${error.message}\n  in: ${script.slice(0, 300)}`);
      });
  const shows = (text) => evaluate(`document.body.textContent.includes(${JSON.stringify(text)})`);
  const click = (label) =>
    evaluate(`document.querySelector('[aria-label=${JSON.stringify(label)}]').click()`);
  const button = (text) =>
    evaluate(
      `(() => { const all = [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === ${JSON.stringify(text)}); all[all.length - 1].click(); })()`,
    );
  const disabled = (text) =>
    evaluate(
      `[...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === ${JSON.stringify(text)}).pop().disabled`,
    );
  const bridge = (call) => evaluate(`window.opsidian.${call}`);
  const pass = (label) => console.log(`PASS ${label}`);
  const notebooks = () =>
    execFileSync(env.OPSIDIAN_NODE, ['apps/host/bin/opsidian.mjs', 'host', 'notebooks'], {
      env: { ...env, OPSIDIAN_HOME: env.OPSIDIAN_SERVER_HOME },
      encoding: 'utf8',
    });
  const workspace = () =>
    waitFor(
      () => evaluate('Boolean(document.querySelector(\'[aria-label="Settings"]\'))'),
      'the notebook',
    );
  const openSync = async () => {
    await click('Settings');
    await button('Sync');
  };

  // 1. A Mac that syncs with a server stops syncing, and its folder goes to the Trash.
  await workspace();
  await bridge(
    `connect(${JSON.stringify(env.OPSIDIAN_SERVER)}, ${JSON.stringify(env.OPSIDIAN_CODE_1)})`,
  );
  await waitFor(async () => (await bridge('syncInfo()')).state === 'synced', 'the first sync');
  // Written just before stopping: it must reach the host before the folder goes.
  writeFileSync(join(vault, 'Last.md'), 'written last\n');
  await openSync();
  await waitFor(() => shows('Stop syncing here'), 'the sync settings');
  await button('Stop syncing…');
  await waitFor(() => shows('Move the folder to the Trash.'), 'the stop syncing dialog');
  assert.equal(
    await evaluate(`document.querySelector('[role=alertdialog] input[type=checkbox]').checked`),
    true,
  );
  await button('Stop syncing and move to Trash');
  await waitFor(async () => (await bridge('current()')) === null, 'the notebook to close');
  assert.equal(existsSync(vault), false);
  const trashed = join(env.XDG_DATA_HOME, 'Trash', 'files');
  assert.deepEqual(readdirSync(trashed), ['Client']);
  assert.deepEqual(
    readdirSync(join(trashed, 'Client'))
      .filter((n) => !n.startsWith('.'))
      .sort(),
    ['First.md', 'Last.md'],
  );
  assert.match(notebooks(), /^Notes: 2 files/m);
  await waitFor(() => shows('Create'), 'the welcome screen');
  pass('stopped syncing: every note reached the host, then the folder went to the Trash');

  // 2. With the host out of reach, the folder stays.
  const second = join(env.OPSIDIAN_VAULT_DIR, '..', 'Second');
  await bridge(`createVault('Second', ${JSON.stringify(join(second, '..'))})`);
  win().webContents.reload();
  await workspace();
  await bridge(
    `connect(${JSON.stringify(env.OPSIDIAN_SERVER)}, ${JSON.stringify(env.OPSIDIAN_CODE_2)})`,
  );
  await waitFor(async () => (await bridge('syncInfo()')).state === 'synced', 'the second sync');
  process.kill(Number(env.OPSIDIAN_SERVER_PID));
  await delay(300);
  writeFileSync(join(second, 'Offline.md'), 'never reached the host\n');
  await openSync();
  await waitFor(() => shows('Stop syncing here'), 'the sync settings');
  await button('Stop syncing…');
  await waitFor(() => shows('Move the folder to the Trash.'), 'the stop syncing dialog');
  await button('Stop syncing and move to Trash');
  await waitFor(() => shows('The folder was kept'), 'the folder to be kept', 800);
  assert.equal(existsSync(join(second, 'Offline.md')), true);
  assert.notEqual(await bridge('current()'), null);
  assert.equal((await bridge('syncInfo()')).connected, false);
  pass('with the host out of reach, the folder was kept and the Mac said why');

  // 3. Hosting it here, then deleting it from the host.
  await button('Turn on hosting');
  await waitFor(() => shows('This Mac is the host'), 'hosting to start');
  await waitFor(
    async () => (await bridge('hosting()')).notebooks.length === 1,
    'the hosted notebook',
  );
  await click('Delete “Second” from this host');
  await waitFor(() => shows('Delete “Second” from this host?'), 'the delete dialog');
  assert.equal(await shows('This cannot be undone.'), true);
  await button('Delete notebook');
  await waitFor(async () => (await bridge('hosting()')).notebooks.length === 0, 'the deletion');
  assert.equal((await bridge('syncInfo()')).connected, false);
  assert.equal(existsSync(join(second, 'Offline.md')), true);
  pass('deleted the notebook from this Mac’s host; its folder stays, no longer syncing');

  // 4. Starting over, with a backup first.
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [backups] });
  await bridge('chooseBackupFolder()');
  await button('Host this notebook too');
  await waitFor(async () => (await bridge('hosting()')).notebooks.length === 1, 'hosting again');
  let restarted = false;
  app.relaunch = () => {};
  app.exit = () => {
    restarted = true;
  };
  await button('Reset…');
  await waitFor(() => shows('Reset Opsidian on this Mac?'), 'the reset dialog');
  assert.equal(await shows('The host is backed up first,'), true);
  assert.equal(await disabled('Reset and restart'), true);
  await evaluate(`(() => {
    const input = document.querySelector('[role=alertdialog] input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'reset');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  assert.equal(await disabled('Reset and restart'), false);
  await button('Reset and restart');
  await waitFor(async () => restarted, 'the app to restart', 800);
  const left = readdirSync(profile);
  for (const name of [
    'host',
    'hosting.json',
    'settings.json',
    'notebooks.json',
    'devices.json',
    'github.json',
  ])
    assert.equal(left.includes(name), false, `${name} is still there`);
  assert.equal(
    readdirSync(join(backups, 'snapshots')).filter((n) => n.endsWith('.sqlite')).length,
    1,
  );
  assert.equal(existsSync(join(second, 'Offline.md')), true);
  assert.equal(existsSync(join(second, '.opsidian', 'sync.json')), false);
  pass('reset: the host and everything beside it went, after a backup; the folder stays');

  finished = true;
  exit(0);
})().catch((error) => {
  console.error(error);
  exit(1);
});
