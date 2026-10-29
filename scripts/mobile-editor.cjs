// Runs inside Electron: loads the iPhone app's editor page, as generated, with a stand-in for the
// app that keeps notes in memory, and edits the title the way a person would.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { editorHtml } = require('../apps/mobile/generated/editor-html.cjs');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pass = (label) => console.log(`PASS ${label}`);

// The app's side, in the page: notes in memory, and answers to the editor's requests.
const APP = `(() => {
  const files = new Map();
  const out = [];
  const answer = (message, result, error) =>
    setTimeout(() => window.OpsidianHost.receive({ session: message.session, id: message.id, result, error }), 5);
  const methods = {
    read: (path) => ({ content: files.get(path) ?? '', revision: String(files.get(path)?.length ?? 0) }),
    save: (path, content) => { files.set(path, content); return { revision: String(content.length) }; },
    rename: (from, name) => {
      if (/[\\\\/]/.test(name)) throw new Error('A name cannot contain / or \\\\.');
      const to = (from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '') + name + '.md';
      if (files.has(to)) throw new Error('A note named “' + name + '” is already here.');
      files.set(to, files.get(from) ?? ''); files.delete(from); return to;
    },
  };
  window.ReactNativeWebView = { postMessage(value) {
    const message = JSON.parse(value);
    out.push(message);
    if (message.method) {
      try { answer(message, methods[message.method](...message.args)); }
      catch (error) { answer(message, undefined, error.message); }
    }
  } };
  window.test = { files, out };
})()`;

app.whenReady().then(async () => {
  // Shown and focused: a window without focus gets no focus or blur events, as a phone would.
  const win = new BrowserWindow({ width: 400, height: 800 });
  const web = win.webContents;
  // Errors in the page would otherwise be reported only as "Script failed to execute".
  web.on('console-message', (_event, level, text) => {
    if (level >= 2) console.error(`page: ${text}`);
  });
  const run = (code) => web.executeJavaScript(code);
  const open = async (path, content, others = {}) => {
    await win.loadURL(`data:text/html;base64,${Buffer.from(editorHtml).toString('base64')}`);
    await run(APP);
    await run(`(() => {
      test.files.set(${JSON.stringify(path)}, ${JSON.stringify(content)});
      for (const [p, c] of Object.entries(${JSON.stringify(others)})) test.files.set(p, c);
      window.OpsidianHost.receive({ event: 'open', path: ${JSON.stringify(path)}, content: ${JSON.stringify(content)},
        revision: '${content.length}', notes: [...test.files.keys()], mode: 'live' });
    })()`);
    win.focus();
    web.focus();
    await delay(150);
  };
  const title = () => run(`document.getElementById('title').textContent`);
  const files = () => run(`Object.fromEntries(test.files)`);
  const notices = () => run(`test.out.filter((m) => m.note === 'notice').map((m) => m.text)`);
  const renames = () => run(`test.out.filter((m) => m.method === 'rename').length`);
  // Types into the title as a person would: focus it, select what is there, type, press Return.
  const retitle = async (text) => {
    await run(`(() => { const t = document.getElementById('title'); t.focus();
      const r = document.createRange(); r.selectNodeContents(t); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
    if (text) await web.insertText(text);
    else await run(`document.execCommand('delete')`);
    web.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    web.sendInputEvent({ type: 'char', keyCode: '\r' });
    web.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await delay(250);
  };
  try {
    await open('Ideas/Draft.md', 'some text\n');
    assert.equal(await run(`document.getElementById('title').isContentEditable`), true);
    await retitle('Plans for spring');
    assert.equal(await title(), 'Plans for spring');
    assert.deepEqual(await files(), { 'Ideas/Plans for spring.md': 'some text\n' });
    assert.equal(await run(`document.activeElement === document.getElementById('title')`), false);
    pass('Return renames the note, in its folder, and leaves the title');

    await run(`document.querySelector('.cm-content').focus()`);
    await web.insertText('more ');
    await run(`document.querySelector('.cm-content').blur()`);
    await delay(250);
    assert.equal((await files())['Ideas/Plans for spring.md'].startsWith('more '), true);
    pass('typing after a rename saves under the new name');

    const before = await renames();
    await retitle('');
    assert.equal(await title(), 'Plans for spring');
    await retitle('Plans for spring');
    assert.equal(await renames(), before);
    pass('an empty or unchanged title puts the name back, and renames nothing');

    await open('Draft.md', 'mine\n', { 'Taken.md': 'theirs\n' });
    await retitle('Taken');
    assert.equal(await title(), 'Draft');
    assert.deepEqual(await files(), { 'Draft.md': 'mine\n', 'Taken.md': 'theirs\n' });
    assert.match((await notices()).at(-1), /already here/);
    await retitle('a/b');
    assert.equal(await title(), 'Draft');
    assert.match((await notices()).at(-1), /cannot contain/);
    pass('a name that is taken or not allowed is refused, said, and the old one kept');

    await open('Draft.md', 'old\n');
    await run(`document.querySelector('.cm-content').focus()`);
    await web.insertText('typed just before ');
    await retitle('Renamed');
    assert.deepEqual(await files(), { 'Renamed.md': 'typed just before old\n' });
    pass('typing not yet saved when the title changes moves with the note');

    await open('Draft.md', 'body\n');
    const focused = () => run(`document.activeElement === document.getElementById('title')`);
    await run(`(() => { const t = document.getElementById('title'); t.focus();
      const r = document.createRange(); r.selectNodeContents(t); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
    const typedBefore = await renames();
    for (const letter of 'Weekly') {
      await web.insertText(letter);
      await delay(60);
    }
    assert.deepEqual(Object.keys(await files()), ['Draft.md']);
    await delay(1200);
    assert.deepEqual(await files(), { 'Weekly.md': 'body\n' });
    assert.equal(await renames(), typedBefore + 1);
    assert.equal(await focused(), true);
    assert.equal(await title(), 'Weekly');
    await web.insertText(' review');
    await delay(1200);
    assert.deepEqual(await files(), { 'Weekly review.md': 'body\n' });
    assert.equal(await title(), 'Weekly review');
    assert.equal(await focused(), true);
    pass(
      'the note is renamed a moment after typing stops, once per pause, without leaving the title',
    );

    const noticesBefore = (await notices()).length;
    await web.insertText('/');
    await delay(1200);
    assert.equal(await title(), 'Weekly review/');
    assert.deepEqual(Object.keys(await files()), ['Weekly review.md']);
    assert.equal((await notices()).length, noticesBefore);
    await run(`window.OpsidianHost.receive({ event: 'blur' })`);
    await delay(300);
    assert.equal(await title(), 'Weekly review');
    assert.match((await notices()).at(-1), /cannot contain/);
    pass(
      'a name that cannot be used stays as typed, quietly, until the title is left, then is refused',
    );

    await run(`(() => { const t = document.getElementById('title'); t.focus();
      const r = document.createRange(); r.selectNodeContents(t); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
    await web.insertText('Done at once');
    await run(`window.OpsidianHost.receive({ event: 'blur' })`);
    await delay(300);
    assert.deepEqual(await files(), { 'Done at once.md': 'body\n' });
    pass('Done renames at once, without waiting for the pause');

    await open('Untitled 2.md', '');
    assert.equal(await run(`document.activeElement === document.getElementById('title')`), true);
    assert.equal(await run(`getSelection().toString()`), 'Untitled 2');
    await open('Untitled 3.md', 'already written\n');
    assert.equal(await run(`document.activeElement === document.getElementById('title')`), false);
    pass('a new, empty Untitled note opens with its name selected; a written one does not');

    await open('Read me.md', 'Just reading.\n');
    await run(`window.OpsidianHost.receive({ event: 'mode', mode: 'reading' })`);
    assert.equal(await run(`document.getElementById('title').isContentEditable`), false);
    assert.equal(await run(`document.querySelector('.cm-content').isContentEditable`), false);
    await run(`window.OpsidianHost.receive({ event: 'mode', mode: 'live' })`);
    assert.equal(await run(`document.getElementById('title').isContentEditable`), true);
    assert.equal(await run(`document.querySelector('.cm-content').isContentEditable`), true);
    pass('reading view locks the name and the text, and editing unlocks both');

    const note =
      '---\ntitle: Japan trip\ntags: [travel, food]\n---\nRamen with #noodles and `#code`.\n';
    await open('Japan.md', note);
    const properties = () =>
      run(`[...document.querySelectorAll('.op-property')].map((row) =>
      row.querySelector('.op-property-key').textContent + '=' +
      [...row.querySelectorAll('.op-property-value > *')].map((e) => e.textContent).join(','))`);
    assert.deepEqual(await properties(), ['title=Japan trip', 'tags=#travel,#food']);
    assert.deepEqual(
      await run(`[...document.querySelectorAll('.cm-content .op-tag')].map((e) => e.textContent)`),
      ['#travel', '#food', '#noodles'],
    );
    assert.equal(await run(`document.querySelector('.op-frontmatter')`), null);
    // The cursor starts in the text, not in the properties.
    await run(`document.querySelector('.cm-content').focus()`);
    await web.insertText('Hot ');
    await delay(400);
    assert.equal((await files())['Japan.md'], note.replace('Ramen', 'Hot Ramen'));
    pass('frontmatter is drawn as properties, with tags as pills, and typing lands below it');

    await run(
      `document.querySelector('.op-properties').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`,
    );
    await delay(100);
    assert.equal(await run(`document.querySelector('.op-properties')`), null);
    assert.equal(await run(`document.querySelectorAll('.op-frontmatter').length`), 4);
    await run(`document.querySelector('.cm-content').blur()`);
    await delay(100);
    assert.notEqual(await run(`document.querySelector('.op-properties')`), null);
    pass('clicking the properties shows their Markdown; leaving them draws them again');

    await run(
      `document.querySelector('.cm-content .op-tag[data-tag="noodles"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`,
    );
    await delay(200);
    assert.deepEqual(await run(`test.out.filter((m) => m.note === 'tag').map((m) => m.tag)`), [
      'noodles',
    ]);
    await run(`document.querySelector('.op-tag').click()`);
    await delay(200);
    assert.deepEqual(await run(`test.out.filter((m) => m.note === 'tag').map((m) => m.tag)`), [
      'noodles',
      'travel',
    ]);
    pass('a tag in the text or the properties tells the app which tag was tapped');

    await run(`window.OpsidianHost.receive({ event: 'mode', mode: 'reading' })`);
    await delay(100);
    assert.deepEqual(await properties(), ['title=Japan trip', 'tags=#travel,#food']);
    await run(`window.OpsidianHost.receive({ event: 'mode', mode: 'source' })`);
    await delay(100);
    assert.equal(await run(`document.querySelector('.op-properties')`), null);
    await run(`window.OpsidianHost.receive({ event: 'mode', mode: 'live' })`);
    pass('reading view draws the properties; source mode shows the Markdown');

    await run(`document.querySelector('.cm-content').focus()`);
    // The editor's Mod key is ⌘ on a Mac and Control elsewhere, as it is for ⌘B.
    const mod = process.platform === 'darwin' ? 'meta' : 'control';
    web.sendInputEvent({ type: 'keyDown', keyCode: 'f', modifiers: [mod, 'alt'] });
    web.sendInputEvent({ type: 'keyUp', keyCode: 'f', modifiers: [mod, 'alt'] });
    await delay(200);
    assert.equal(
      await run(`document.querySelector('.op-find [aria-expanded]').getAttribute('aria-expanded')`),
      'true',
    );
    assert.equal(await run(`document.activeElement.placeholder`), 'Replace with');
    await run(`(() => { const p = document.querySelector('.op-find'); const [find, replace] = p.querySelectorAll('input');
      find.value = 'Ramen'; find.dispatchEvent(new Event('input')); replace.value = 'Udon'; replace.dispatchEvent(new Event('input'));
      p.querySelector('[aria-label="Replace all matches"]').click(); })()`);
    await delay(300);
    assert.equal((await files())['Japan.md'].includes('Hot Udon with'), true);
    pass('⌥⌘F opens find and replace with the replacement field focused, and replace all replaces');
    app.exit(0);
  } catch (error) {
    console.error(`FAIL ${error.stack ?? error}`);
    app.exit(1);
  }
});
