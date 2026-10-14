// Runs inside Electron against the production app: opens one screen, then quits the way Cmd+Q
// does. test-quit.mjs requires the process to end, whatever screen it was on.
const { app, BrowserWindow } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const screen = process.env.OPSIDIAN_QUIT_SCREEN;
const vault = process.env.OPSIDIAN_VAULT_DIR;
app.setPath('userData', process.env.OPSIDIAN_PROFILE_DIR);
if (vault) {
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, 'Note.md'), 'start\n');
}
require('../apps/desktop/dist-electron/main.cjs');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label) {
  for (let n = 0; n < 300; n++) {
    if (await check().catch(() => false)) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
(async () => {
  await app.whenReady();
  await waitFor(async () => BrowserWindow.getAllWindows().length, 'window');
  const win = BrowserWindow.getAllWindows()[0];
  win.show();
  const web = win.webContents;
  const evaluate = (code) => web.executeJavaScript(code);
  if (screen === 'welcome') {
    await waitFor(
      () => evaluate("document.body.textContent.includes('Create notebook')"),
      'welcome',
    );
  } else {
    await waitFor(() => evaluate("Boolean(document.querySelector('.cm-content'))"), 'editor');
    // Something typed and not yet saved: quitting must save it, not lose it or hang on it.
    await evaluate("document.querySelector('.cm-content').focus()");
    await web.insertText('typed just before quitting');
    if (screen === 'settings') {
      await evaluate("document.querySelector('[aria-label=Settings]').click()");
      await waitFor(() => evaluate("Boolean(document.querySelector('[role=dialog]'))"), 'settings');
    }
    if (screen === 'frozen') {
      // The page stops answering for good; quitting must still end the app.
      void evaluate('setTimeout(() => { for (;;) {} }, 50)').catch(() => {});
      await delay(300);
    }
  }
  console.log(`quitting from the ${screen} screen`);
  app.quit();
})().catch((error) => {
  console.error(`FAIL ${error.stack ?? error}`);
  app.exit(1);
});
