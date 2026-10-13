// Development timing for large-note edits in the production desktop build. Not a release benchmark.
const { app, BrowserWindow, clipboard } = require('electron');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
app.setPath('userData', join(process.env.OPSIDIAN_VAULT_DIR, 'profile'));
require('../apps/desktop/dist-electron/main.cjs');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label) {
  for (let n = 0; n < 2000; n++) {
    if (await check()) return;
    await delay(5);
  }
  throw new Error(`Timed out: ${label}`);
}
const paragraph = 'A paragraph with **bold** and [[Weekend plans]].\n\n';
const note = (kb) =>
  '# Long note\n\n' + paragraph.repeat(Math.ceil((kb * 1024) / paragraph.length));
(async () => {
  await app.whenReady();
  await waitFor(() => BrowserWindow.getAllWindows().length, 'window');
  const win = BrowserWindow.getAllWindows()[0];
  win.show();
  win.focus();
  const web = win.webContents;
  const evaluate = (code) => web.executeJavaScript(code);
  await waitFor(
    () => evaluate("Boolean(document.querySelector('.cm-content'))").catch(() => false),
    'editor',
  );
  const file = (await evaluate('window.opsidian.load()')).location;
  const length = () =>
    evaluate(
      "document.querySelector('.cm-content').cmTile?.view.state.doc.length ?? document.querySelector('.cm-content').cmView?.view.state.doc.length ?? -1",
    );
  const focus = async () => {
    win.focus();
    web.focus();
    await evaluate("document.querySelector('.cm-content').focus()");
  };
  const frame = () =>
    evaluate('new Promise((done) => requestAnimationFrame(() => setTimeout(done)))');
  async function time(label, text, act) {
    await focus();
    web.selectAll();
    await delay(50);
    const started = performance.now();
    await act();
    await waitFor(async () => (await length()) === text.length, `${label} applied`);
    await frame();
    const edited = performance.now() - started;
    await waitFor(() => readFileSync(file, 'utf8').length === text.length, `${label} saved`);
    console.log(
      `${label}: editor ${Math.round(edited)}ms, on disk ${Math.round(performance.now() - started)}ms`,
    );
  }
  for (const kb of [96, 1024]) {
    const text = note(kb);
    await time(`${kb}KB clipboard paste`, text, async () => {
      clipboard.writeText(text);
      web.paste();
    });
    await focus();
    const typed = await evaluate(`(async () => {
      const samples = [];
      for (let n = 0; n < 30; n++) {
        const started = performance.now();
        document.execCommand('insertText', false, 'x');
        await new Promise((done) => requestAnimationFrame(() => setTimeout(done)));
        samples.push(performance.now() - started);
      }
      samples.sort((a, b) => a - b);
      return [samples[15], samples[28]];
    })()`);
    console.log(
      `${kb}KB typing: median ${typed[0].toFixed(1)}ms, p95 ${typed[1].toFixed(1)}ms per keystroke+frame`,
    );
    if (kb === 96)
      await time('96KB native insertText', `${text}!`, () => web.insertText(`${text}!`));
  }
  await evaluate('window.opsidian.closeReady()');
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
setTimeout(() => {
  console.error('Bench timed out');
  app.exit(1);
}, 120000).unref();
