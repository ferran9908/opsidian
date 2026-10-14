// Runs inside Electron against the production app: turns this Mac into a host through the
// settings screens, then plays a second device over the network to see that it all holds.
const { app, BrowserWindow, dialog } = require('electron');
const { existsSync, mkdirSync, readdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { OPSIDIAN_VAULT_DIR: vault, OPSIDIAN_BACKUP_DIR: backups } = process.env;
const port = process.env.OPSIDIAN_HOST_PORT;
app.setPath('userData', process.env.OPSIDIAN_PROFILE_DIR);
mkdirSync(vault, { recursive: true });
writeFileSync(join(vault, 'First.md'), 'written before hosting\n');
require('../apps/desktop/dist-electron/main.cjs');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, tries = 300) {
  for (let n = 0; n < tries; n++) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
let finished = false;
// Quitting by accident must fail the test, not end it quietly.
app.on('will-quit', () => {
  if (!finished) process.exit(1);
});
(async () => {
  await app.whenReady();
  await waitFor(() => BrowserWindow.getAllWindows().length, 'window');
  BrowserWindow.getAllWindows()[0].show();
  // The window is closed and reopened part-way through, so it is looked up each time.
  const evaluate = (script) =>
    BrowserWindow.getAllWindows()[0]
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
  const hosting = () => evaluate('window.opsidian.hosting()');
  const pass = (label) => console.log(`PASS ${label}`);
  const base = `http://127.0.0.1:${port}`;
  const whoami = (token) =>
    fetch(`${base}/v1/whoami`, { headers: { authorization: `Bearer ${token}` } });

  await waitFor(
    () => evaluate('Boolean(document.querySelector(\'[aria-label="Settings"]\'))'),
    'the notebook',
  );
  await click('Settings');
  await waitFor(() => shows('Host it on this Mac'), 'the sync settings');
  await button('Turn on hosting');
  await waitFor(() => shows('This Mac is hosting'), 'hosting to start');
  await waitFor(
    async () => (await hosting()).notebooks[0]?.files === 1,
    'the notebook on the host',
  );
  const started = await hosting();
  assert.equal(started.devices.length, 1);
  assert.equal(started.devices[0].self, true);
  pass('turned on hosting, and this Mac’s notebook is on its own host');

  // Closing the window must not end hosting: the app stays in the menu bar.
  BrowserWindow.getAllWindows()[0].close();
  await waitFor(() => BrowserWindow.getAllWindows().length === 0, 'the window to close');
  await delay(600);
  assert.equal((await fetch(`${base}/v1`)).status, 200);
  app.emit('activate');
  await waitFor(() => BrowserWindow.getAllWindows().length === 1, 'the window to come back');
  await waitFor(
    () =>
      evaluate('Boolean(document.querySelector(\'[aria-label="Settings"]\'))').catch(() => false),
    'the notebook again',
  );
  await click('Settings');
  await waitFor(() => shows('This Mac is hosting'), 'hosting still on');
  pass('hosting carries on with the window closed, and the window comes back');

  await button('Invite a device');
  await waitFor(
    () => evaluate("Boolean(document.getElementById('invite-code')?.textContent)"),
    'an invitation',
  );
  const code = await evaluate("document.getElementById('invite-code').textContent");
  const squares = await evaluate(
    'document.querySelectorAll(\'[aria-label="Invitation code to scan"] rect\').length',
  );
  assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.ok(squares > 200, `a QR code is drawn (${squares} squares)`);
  assert.equal((await hosting()).invitations.length, 1);
  const paired = await (
    await fetch(`${base}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, device: 'Test iPhone' }),
    })
  ).json();
  assert.ok(paired.token, 'the invitation pairs a device');
  assert.deepEqual(await (await whoami(paired.token)).json(), {
    device: 'Test iPhone',
    notebook: paired.notebook.name,
  });
  const changes = await (
    await fetch(`${base}/v1/changes?since=0&wait=0`, {
      headers: { authorization: `Bearer ${paired.token}` },
    })
  ).json();
  assert.deepEqual(
    changes.changes.map((change) => change.path),
    ['First.md'],
  );
  await button('Done');
  pass('an invitation with a QR code paired a second device, which sees the notes');

  await button('Devices');
  await waitFor(() => shows('Test iPhone'), 'the device list');
  assert.equal((await hosting()).invitations.length, 0);
  pass('the device list shows the new device, and the used invitation is gone');

  // Backups: one now, then more work, then back to the backup.
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [backups] });
  await button('Backups');
  await waitFor(() => shows('Not chosen yet'), 'the backup settings');
  await button('Choose…');
  await waitFor(() => shows(backups), 'the backup folder');
  await button('Back up now');
  await waitFor(() => shows('Restore…'), 'a backup');
  assert.equal(
    readdirSync(join(backups, 'snapshots')).filter((n) => n.endsWith('.sqlite')).length,
    1,
  );
  writeFileSync(join(vault, 'Second.md'), 'written after the backup\n');
  await waitFor(
    async () => (await hosting()).notebooks[0]?.files === 2,
    'the new note on the host',
  );
  const generation = async () =>
    (
      await (
        await fetch(`${base}/v1/changes?since=0&wait=0`, {
          headers: { authorization: `Bearer ${paired.token}` },
        })
      ).json()
    ).generation;
  const before = await generation();
  await button('Restore…');
  await waitFor(() => shows('Restore this backup'), 'the restore question');
  await button('Restore this backup');
  // The restored host announces a new history. It went back to one file; this Mac still
  // has both, and sends the second up again.
  await waitFor(
    async () => (await generation().catch(() => before)) !== before,
    'the restore to finish',
    600,
  );
  await waitFor(
    async () => (await hosting()).notebooks[0]?.files === 2,
    'this Mac to catch the host up',
    600,
  );
  assert.ok(existsSync(join(vault, 'Second.md')));
  assert.equal(
    readdirSync(join(backups, 'snapshots')).filter((n) => n.endsWith('.sqlite')).length,
    2,
  );
  assert.equal((await whoami(paired.token)).status, 200);
  pass('backed up, restored, and this Mac sent back what it wrote since');

  await button('Connection check');
  await waitFor(() => shows('Everything is connected'), 'a good connection check').catch(
    async (error) => {
      console.error(await evaluate("document.querySelector('[role=dialog]').innerText"));
      throw error;
    },
  );
  assert.deepEqual(
    await evaluate(
      "[...document.querySelectorAll('[data-check]')].map((row) => row.dataset.state)",
    ),
    ['ok', 'ok', 'ok'],
  );
  pass('the connection check passes every step');

  await button('Devices');
  await waitFor(() => shows('Test iPhone'), 'the device list');
  await button('Remove');
  await waitFor(() => shows('Remove device'), 'the removal question');
  await button('Remove device');
  await waitFor(
    async () => (await whoami(paired.token)).status === 401,
    'the device to be refused',
  );
  await waitFor(async () => !(await shows('Test iPhone')), 'the device to leave the list');
  pass('a removed device is refused at once');

  await button('Sync');
  await button('Stop hosting…');
  await waitFor(() => shows('Stop hosting on this Mac?'), 'the stop question');
  await button('Stop hosting');
  await waitFor(async () => !(await hosting()).hosting, 'hosting to stop');
  await button('Connection check');
  await waitFor(() => shows('This Mac cannot sync right now'), 'a failed connection check', 400);
  assert.deepEqual(
    await evaluate(
      "[...document.querySelectorAll('[data-check]')].map((row) => row.dataset.state)",
    ),
    ['ok', 'failed', 'skipped'],
  );
  pass('with hosting stopped, the check names the host as the step that fails');
  await button('Sync');
  await waitFor(() => shows('Hosting is off'), 'the way back to hosting');
  await button('Turn on hosting');
  await waitFor(() => shows('This Mac is hosting'), 'hosting to start again');
  assert.equal((await hosting()).devices.filter((device) => device.self).length, 1);
  assert.equal((await hosting()).notebooks[0].files, 2);
  pass('hosting turns back on with everything it held, and no second copy of this Mac');

  // A big host makes a slow backup. It must not hold up the app: the window keeps answering.
  {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(join(process.env.OPSIDIAN_PROFILE_DIR, 'host', 'host.sqlite'));
    const filler = 'x'.repeat(2000);
    db.exec('begin');
    const insert = db.prepare("insert into ops (notebook, id, result) values ('filler', ?, ?)");
    for (let n = 0; n < 150_000; n++) insert.run(`op-${n}`, filler);
    db.exec('commit');
    db.close();
  }
  const snapshots = () =>
    readdirSync(join(backups, 'snapshots')).filter((n) => n.endsWith('.sqlite')).length;
  const had = snapshots();
  let worst = 0;
  let last = Date.now();
  const beat = setInterval(() => {
    worst = Math.max(worst, Date.now() - last);
    last = Date.now();
  }, 10);
  const startedBackup = Date.now();
  const made = evaluate('window.opsidian.backUpNow()');
  let answers = 0;
  while (snapshots() === had || Date.now() - startedBackup < 300) {
    await evaluate('1');
    answers++;
    await delay(20);
  }
  await made;
  clearInterval(beat);
  const took = Date.now() - startedBackup;
  assert.ok(worst < 200, `the app stalled for ${worst} ms during the backup`);
  assert.ok(answers > 5, `the window answered ${answers} times during the backup`);
  pass(`a ${took} ms backup of a large host never held up the app (longest pause ${worst} ms)`);

  // Two notebook folders with the same name are two notebooks on the host, never one.
  const twin = join(
    require('node:path').dirname(vault),
    'elsewhere',
    require('node:path').basename(vault),
  );
  mkdirSync(twin, { recursive: true });
  writeFileSync(join(twin, 'Twin.md'), 'a different notebook with the same name\n');
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [twin] });
  await evaluate('window.opsidian.openVault()');
  await evaluate('window.opsidian.startHosting()');
  const name = require('node:path').basename(vault);
  await waitFor(
    async () => (await hosting()).notebooks.find((n) => n.name === `${name} 2`)?.files === 1,
    'the second folder as its own notebook',
  );
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [vault] });
  await evaluate('window.opsidian.openVault()');
  await evaluate('window.opsidian.startHosting()');
  const both = (await hosting()).notebooks.filter((n) => n.name !== 'filler');
  assert.deepEqual(
    both.map((n) => [n.name, n.files]),
    [
      [name, 2],
      [`${name} 2`, 1],
    ],
  );
  pass('two folders with the same name became two notebooks, and each kept its own');
  finished = true;
  app.exit(0);
})().catch((error) => {
  console.error(`FAIL ${error.stack ?? error}`);
  app.exit(1);
});
