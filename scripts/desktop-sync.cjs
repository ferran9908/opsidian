// Runs inside Electron against the production app. The runner (test-sync.mjs) plays the
// other device by talking to the host directly; the two take turns through marker files.
const { app, BrowserWindow, dialog } = require('electron');
const { existsSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const {
  OPSIDIAN_VAULT_DIR: vault,
  OPSIDIAN_SYNC_SHARED: shared,
  OPSIDIAN_SYNC_HOST: host,
} = process.env;
const code = process.env.OPSIDIAN_SYNC_CODE;
app.setPath('userData', process.env.OPSIDIAN_PROFILE_DIR);
require('../apps/desktop/dist-electron/main.cjs');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, tries = 300) {
  for (let n = 0; n < tries; n++) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const signal = (name) => writeFileSync(join(shared, name), '');
const signalled = (name) =>
  waitFor(() => existsSync(join(shared, name)), `the other device: ${name}`);
(async () => {
  await app.whenReady();
  await waitFor(() => BrowserWindow.getAllWindows().length, 'window');
  const win = BrowserWindow.getAllWindows()[0];
  win.show();
  win.focus();
  const web = win.webContents;
  web.focus();
  const evaluate = (script) =>
    web.executeJavaScript(script).catch((error) => {
      throw new Error(`${error.message}\n  in: ${script.slice(0, 300)}`);
    });
  const present = (selector) =>
    evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
  const editorText = () =>
    evaluate(
      "(() => { const c = document.querySelector('.cm-content'); return (c?.cmTile ?? c?.cmView)?.view.state.doc.toString(); })()",
    );
  const key = (keyCode, modifiers = []) => {
    web.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    web.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  const click = (label) =>
    evaluate(`document.querySelector('[aria-label=${JSON.stringify(label)}]').click()`);
  // Radix menus open on pointer down, as a mouse press does; a bare click() does not.
  const pick = async (trigger, item) => {
    await evaluate(
      `document.querySelector('[aria-label=${JSON.stringify(trigger)}]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))`,
    );
    const find = `[...document.querySelectorAll('[role^="menuitem"]')].find((entry) => entry.textContent.trim().startsWith(${JSON.stringify(item)}))`;
    await waitFor(() => evaluate(`Boolean(${find})`), `${item} in the menu`);
    await evaluate(`${find}.click()`);
  };
  const button = (text) =>
    evaluate(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)}).click()`,
    );
  const fill = async (id, value) => {
    await evaluate(`document.getElementById(${JSON.stringify(id)}).focus()`);
    await waitFor(() => evaluate(`document.activeElement?.id === ${JSON.stringify(id)}`), id);
    await web.insertText(value);
  };
  const status = () =>
    evaluate('document.querySelector(\'[aria-label="Sync status"]\')?.textContent');
  const sidebarHas = (name) =>
    evaluate(
      `[...document.querySelectorAll('nav [data-note]')].some((row) => row.textContent.trim() === ${JSON.stringify(name)})`,
    );

  if (process.env.OPSIDIAN_SYNC_PHASE === 'join') {
    // A Mac with no notebook joins the one on the host and gets its notes.
    const parent = process.env.OPSIDIAN_SYNC_PARENT;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [parent] });
    await waitFor(
      () => evaluate("document.body.textContent.includes('Connect to a notebook')"),
      'welcome',
    );
    await button('Connect to a notebook');
    await button('Choose folder…');
    await fill('join-host', host);
    await fill('join-code', code);
    await button('Connect and download');
    await waitFor(() => sidebarHas('From afar'), 'downloaded notes', 400);
    await waitFor(async () => (await status()) === 'Synced', 'synced');
    const folder = join(parent, 'Notes');
    assert.deepEqual(
      readdirSync(folder)
        .filter((entry) => !entry.startsWith('.'))
        .sort(),
      ['From afar.md', 'Sunday.md'],
    );
    assert.equal(
      readFileSync(join(folder, 'Sunday.md'), 'utf8'),
      readFileSync(join(shared, 'final'), 'utf8'),
    );
    console.log('PASS a second Mac joined the notebook and downloaded it');
    app.exit(0);
    return;
  }

  const note = join(vault, 'Sunday.md');
  const original = 'Walk by the water.\n\nMiddle.\n\nEnd.';
  await waitFor(
    () => evaluate("document.body.textContent.includes('No note is open')"),
    'empty state',
  );
  assert.equal(await status(), 'Sync is off');
  key('N', ['meta']);
  await waitFor(() => existsSync(join(vault, 'Untitled.md')), 'new note');
  await waitFor(
    () => evaluate("document.activeElement?.getAttribute('aria-label') === 'Note title'"),
    'title focus',
  );
  await web.insertText('Sunday');
  key('Enter');
  await waitFor(() => existsSync(note), 'named note');
  await waitFor(
    () => evaluate("document.activeElement?.classList.contains('cm-content')"),
    'editor',
  );
  await web.insertText(original);
  await waitFor(() => readFileSync(note, 'utf8') === original, 'first save');

  // Connect the local notebook to the host with an invitation.
  // Sync is off, so the status bar leads to Settings, and from there to the invitation.
  await click('Sync status');
  await waitFor(
    () => evaluate("document.body.textContent.includes('Enter an invitation')"),
    'the sync settings',
  );
  await button('Enter an invitation');
  await waitFor(() => evaluate("Boolean(document.getElementById('sync-host'))"), 'the join form');
  await fill('sync-host', host);
  await fill('sync-code', code);
  await button('Connect');
  await waitFor(async () => (await status()) === 'Synced', 'first sync');
  // Joined, the form closes itself.
  await waitFor(
    async () => !(await evaluate("Boolean(document.getElementById('sync-host'))")),
    'the join form to close',
  );
  // The status bar's Synced opens the details, and Escape puts them away.
  await click('Sync status');
  await waitFor(
    () =>
      evaluate(
        "document.querySelector('[data-slot=\"popover-content\"]')?.textContent.includes('Sync settings…')",
      ),
    'the sync details',
  );
  assert.ok(
    await evaluate(
      `document.querySelector('[data-slot="popover-content"]').textContent.includes(${JSON.stringify(host.replace(/^https?:\/\//, ''))})`,
    ),
  );
  key('Escape');
  await waitFor(
    async () =>
      !(await evaluate('Boolean(document.querySelector(\'[data-slot="popover-content"]\'))')),
    'the sync details to close',
  );
  signal('connected');
  console.log('PASS connected a local notebook to the host with an invitation');

  // The other device edits the open note and adds one; both show up here unprompted.
  await signalled('edited');
  const started = Date.now();
  await waitFor(async () => (await editorText())?.includes('from the other Mac'), 'remote edit');
  await waitFor(() => sidebarHas('From afar'), 'remote note');
  console.log(
    `PASS an edit from the other device reached the open note in ${Date.now() - started} ms`,
  );

  // Both devices edit the same note at once: typing here, a new last line there.
  await evaluate(`(() => {
    const content = document.querySelector('.cm-content');
    content.focus();
    (content.cmTile ?? content.cmView).view.dispatch({ selection: { anchor: 0 } });
  })()`);
  signal('typing');
  let typed = '';
  for (const letter of 'typed here while the other Mac wrote ') {
    typed += letter;
    await web.insertText(letter);
    await delay(60);
  }
  await signalled('appended');
  await waitFor(() => {
    const disk = readFileSync(note, 'utf8');
    return disk.startsWith(typed) && disk.includes('appended remotely');
  }, 'both edits in the file');
  await waitFor(
    async () => (await editorText()) === readFileSync(note, 'utf8'),
    'editor matches file',
  );
  assert.deepEqual(
    readdirSync(vault)
      .filter((entry) => !entry.startsWith('.'))
      .sort(),
    ['From afar.md', 'Sunday.md'],
  );
  await waitFor(async () => (await status()) === 'Synced', 'synced after merge');
  console.log('PASS simultaneous edits to one note were combined, with no extra copy');

  // History lists who changed what, and an old version can be brought back.
  await pick('More options', 'Version history');
  await waitFor(
    () =>
      evaluate(
        'document.querySelectorAll(\'[aria-label="Version history"][role="dialog"] li\').length >= 3',
      ),
    'history list',
  );
  const names = await evaluate('document.querySelector(\'[role="dialog"] ul\').textContent');
  assert.match(names, /Other Mac/);
  await evaluate('[...document.querySelectorAll(\'[role="dialog"] li button\')].at(-1).click()');
  await waitFor(
    () =>
      evaluate(
        `document.querySelector('[role="dialog"] pre').textContent === ${JSON.stringify(original)}`,
      ),
    'oldest version',
  );
  await button('Restore this version');
  await waitFor(() => readFileSync(note, 'utf8') === original, 'restored on disk');
  assert.equal(await editorText(), original);
  await waitFor(async () => (await status()) === 'Synced', 'restore synced');
  writeFileSync(join(shared, 'final'), original);
  signal('restored');
  await signalled('confirmed');
  console.log('PASS version history, and restoring an earlier version reached the host');
  app.exit(0);
})().catch(async (error) => {
  console.error(error);
  // What the person at the keyboard would be looking at.
  const web = BrowserWindow.getAllWindows()[0]?.webContents;
  const seen = await web
    ?.executeJavaScript(
      "[document.querySelector('[aria-label=\"Sync status\"]')?.textContent, document.querySelector('[role=\"dialog\"]')?.textContent, document.querySelector('[role=\"alert\"]')?.textContent].join(' | ')",
    )
    .catch(() => '');
  console.error(`On screen: ${seen}`);
  app.exit(1);
});
setTimeout(() => {
  console.error('Sync test timed out');
  app.exit(1);
}, 90000).unref();
