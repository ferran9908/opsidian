// Runs inside Electron. "type" writes lines until the parent kills the process outright;
// "verify" reopens the notebook the way a user would after a crash.
const { app, BrowserWindow } = require('electron');
const { existsSync, readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const vault = process.env.OPSIDIAN_VAULT_DIR;
app.setPath('userData', process.env.OPSIDIAN_PROFILE_DIR);
require('../apps/desktop/dist-electron/main.cjs');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label) {
  for (let n = 0; n < 200; n++) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const file = join(vault, 'Crash.md');
(async () => {
  await app.whenReady();
  await waitFor(() => BrowserWindow.getAllWindows().length, 'window');
  const win = BrowserWindow.getAllWindows()[0];
  win.show();
  win.focus();
  const web = win.webContents;
  web.focus();
  const evaluate = (code) => web.executeJavaScript(code);
  const editorText = () =>
    evaluate(
      "(() => { const c = document.querySelector('.cm-content'); return (c?.cmTile ?? c?.cmView)?.view.state.doc.toString(); })()",
    );
  const key = (keyCode, modifiers = []) => {
    web.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    web.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  const editorFocused = () =>
    waitFor(
      () => evaluate("document.activeElement?.classList.contains('cm-content')"),
      'editor focus',
    );

  if (process.env.OPSIDIAN_CRASH_PHASE === 'verify') {
    // The only note reopens with exactly what reached the disk, and editing carries on.
    await waitFor(
      () => evaluate("document.querySelector('[aria-label=\"Note title\"]')?.value === 'Crash'"),
      'note to reopen',
    );
    const saved = readFileSync(file, 'utf8');
    await waitFor(async () => (await editorText()) === saved, 'editor to show the saved text');
    assert.deepEqual(
      readdirSync(vault).filter((entry) => entry.endsWith('.pending')),
      [],
    );
    await evaluate(`(() => {
      const content = document.querySelector('.cm-content');
      const view = (content.cmTile ?? content.cmView).view;
      content.focus();
      view.dispatch({ selection: { anchor: view.state.doc.length } });
    })()`);
    await editorFocused();
    await web.insertText('after the crash');
    await waitFor(
      () => readFileSync(file, 'utf8') === `${saved}after the crash`,
      'save after crash',
    );
    assert.equal(readdirSync(vault).filter((entry) => entry.includes('conflicted')).length, 0);
    app.exit(0);
    return;
  }

  await waitFor(
    () => evaluate("document.body.textContent.includes('No note is open')"),
    'empty state',
  );
  key('N', ['meta']);
  await waitFor(() => existsSync(join(vault, 'Untitled.md')), 'new note');
  await waitFor(
    () => evaluate("document.activeElement?.getAttribute('aria-label') === 'Note title'"),
    'title focus',
  );
  await web.insertText('Crash');
  key('Enter');
  await waitFor(() => existsSync(file), 'named note');
  await editorFocused();
  for (let line = 1; ; line++) {
    await web.insertText(`line ${line}\n`);
    // The parent reads this to know what had been typed, and when.
    process.stdout.write(`typed ${line} ${Date.now()}\n`);
    await delay(25);
  }
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
setTimeout(() => {
  console.error('Crash test timed out');
  app.exit(1);
}, 60000).unref();
