// Runs inside Electron against the production app and its real preload/IPC.
const { app, BrowserWindow, dialog } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const assert = require('node:assert/strict');
app.setPath('userData', join(process.env.OPSIDIAN_VAULT_DIR, 'profile'));
require('../apps/desktop/dist-electron/main.cjs');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check) {
  for (let n = 0; n < 200; n++) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error('Timed out waiting for native editor');
}
(async () => {
  await app.whenReady();
  await waitFor(() => BrowserWindow.getAllWindows().length);
  const win = BrowserWindow.getAllWindows()[0];
  win.show();
  win.focus();
  const web = win.webContents;
  web.focus();
  const evaluate = (code) => web.executeJavaScript(code);
  await waitFor(() =>
    evaluate("Boolean(document.querySelector('.cm-content'))").catch(() => false),
  );
  const snapshot = await evaluate('window.opsidian.load()');
  assert.match(snapshot.location, /Sunday\.md$/);
  assert.equal(await evaluate('typeof window.require'), 'undefined');
  if (process.env.OPSIDIAN_SMOKE_PHASE === 'read') {
    assert.equal(snapshot.content, '# Close flush\n\nLast keystroke survives.');
    console.log('PASS native restart restored final edit');
    win.close();
    return;
  }
  const replace = async (text) => {
    win.focus();
    web.focus();
    await evaluate("document.querySelector('.cm-content').focus()");
    web.selectAll();
    await web.insertText(text);
  };
  await replace('');
  for (const keyCode of '[[Week') {
    web.sendInputEvent({ type: 'keyDown', keyCode });
    web.sendInputEvent({ type: 'char', keyCode });
    web.sendInputEvent({ type: 'keyUp', keyCode });
    await delay(100);
  }
  await waitFor(() => evaluate("Boolean(document.querySelector('.cm-tooltip-autocomplete'))"));
  await delay(150); // CodeMirror suppresses accidental acceptance just after opening.
  web.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  web.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await waitFor(() => readFileSync(snapshot.location, 'utf8') === '[[Weekend plans]]');
  await replace('```md\n[[Weekend plans]]\n- [ ] code only\n```');
  await evaluate("document.querySelector('.cm-content').blur()");
  assert.equal(await evaluate("document.querySelectorAll('.op-wikilink, .op-task').length"), 0);
  const imagePath = join(process.env.OPSIDIAN_VAULT_DIR, 'test.png');
  writeFileSync(
    imagePath,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [imagePath] });
  await replace('# Picture\n\n');
  await evaluate('document.querySelector(\'[aria-label="Attach image"]\').click()');
  await waitFor(() => readFileSync(snapshot.location, 'utf8').includes('attachments/'));
  await evaluate("document.querySelector('.cm-content').blur()");
  await waitFor(() => evaluate("Boolean(document.querySelector('.op-image img')?.naturalWidth)"));
  const started = Date.now();
  await replace(
    '# Long note\n\n' + 'A paragraph with **bold** and [[Weekend plans]].\n\n'.repeat(2000),
  );
  await waitFor(() => readFileSync(snapshot.location, 'utf8').length > 90000);
  console.log(
    `PASS wiki completion, fenced code, native image import; 96KB note insert/save ${Date.now() - started}ms`,
  );
  await replace('# Native smoke\n\n- [ ] Try a task\n\n[[Weekend plans]]\n\n**Real Markdown**');
  await waitFor(() => readFileSync(snapshot.location, 'utf8').startsWith('# Native smoke'));
  await evaluate("document.querySelector('.cm-content').blur()");
  await waitFor(() => evaluate("Boolean(document.querySelector('.op-task'))"));
  await evaluate("document.querySelector('.op-task').click()");
  await waitFor(() => readFileSync(snapshot.location, 'utf8').includes('- [x]'));
  await evaluate(
    "Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Source').click()",
  );
  assert.equal(await evaluate("document.querySelectorAll('.op-task').length"), 0);
  assert.match(
    await evaluate("document.querySelector('.cm-content').textContent"),
    /\[\[Weekend plans\]\]/,
  );
  await replace('# Close flush\n\nLast keystroke survives.');
  // Close immediately, before the normal autosave debounce expires.
  win.on('closed', () => {
    try {
      assert.equal(
        readFileSync(snapshot.location, 'utf8'),
        '# Close flush\n\nLast keystroke survives.',
      );
      console.log('PASS native typing, task toggle, source mode, close flush');
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
  win.close();
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
setTimeout(() => {
  console.error('Native smoke timed out');
  app.exit(1);
}, 30000).unref();
