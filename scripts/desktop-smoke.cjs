// Runs inside Electron against the production app and its real preload/IPC.
const { app, BrowserWindow, clipboard, dialog } = require('electron');
const { existsSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
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
const note = (name) => join(vault, `${name}.md`);
const text = (name) => (existsSync(note(name)) ? readFileSync(note(name), 'utf8') : undefined);
(async () => {
  await app.whenReady();
  await waitFor(() => BrowserWindow.getAllWindows().length, 'window');
  const win = BrowserWindow.getAllWindows()[0];
  win.show();
  win.focus();
  const web = win.webContents;
  web.focus();
  const evaluate = (code) =>
    web.executeJavaScript(code).catch((error) => {
      throw new Error(`${error.message}\n  in: ${code.slice(0, 300)}`);
    });
  const present = (selector) =>
    evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
  const editorText = () =>
    evaluate(
      "(() => { const c = document.querySelector('.cm-content'); return (c?.cmTile ?? c?.cmView)?.view.state.doc.toString(); })()",
    );
  const title = () => evaluate('document.querySelector(\'[aria-label="Note title"]\')?.value');
  const click = (label) =>
    evaluate(`document.querySelector('[aria-label=${JSON.stringify(label)}]').click()`);
  const key = (keyCode, modifiers = []) => {
    web.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    web.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  const openFromSidebar = async (name) => {
    await evaluate(
      `[...document.querySelectorAll('nav button')].find((b) => b.textContent.trim() === ${JSON.stringify(name)}).click()`,
    );
    await waitFor(async () => (await title()) === name, `${name} to open`);
    await waitFor(() => present('.cm-content'), 'editor');
  };
  // Waits for the editor to see the selection, as it would between two real keystrokes.
  const selectAll = async () => {
    win.focus();
    web.focus();
    await evaluate("document.querySelector('.cm-content').focus()");
    web.selectAll();
    await waitFor(
      () =>
        evaluate(
          "(() => { const c = document.querySelector('.cm-content'); const { state } = (c.cmTile ?? c.cmView).view; return state.selection.main.from === 0 && state.selection.main.to === state.doc.length; })()",
        ),
      'select all',
    );
  };
  const replace = async (value) => {
    await selectAll();
    await web.insertText(value);
  };
  const focused = (label) =>
    waitFor(
      () =>
        evaluate(`document.activeElement?.getAttribute('aria-label') === ${JSON.stringify(label)}`),
      `${label} focus`,
    );
  // Right-clicks a sidebar row and picks from its menu.
  const menu = async (row, item) => {
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('nav [data-note], nav [data-folder]')]
        .find((candidate) => candidate.textContent.trim() === ${JSON.stringify(row)});
      const box = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: box.left + 12, clientY: box.top + 12,
      }));
    })()`);
    await waitFor(() => present('[role="menu"]'), `${row} menu`);
    await evaluate(
      `[...document.querySelectorAll('[role="menuitem"]')].find((entry) => entry.textContent.trim() === ${JSON.stringify(item)}).click()`,
    );
  };
  const dragTo = (from, to) =>
    evaluate(`(() => {
      const data = new DataTransfer();
      const source = document.querySelector(${JSON.stringify(from)});
      const target = document.querySelector(${JSON.stringify(to)});
      const fire = (node, type) =>
        node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
      fire(source, 'dragstart');
      fire(target, 'dragover');
      fire(target, 'drop');
      fire(source, 'dragend');
    })()`);
  const cursorLine = () =>
    evaluate(`(() => {
      const content = document.querySelector('.cm-content');
      const state = (content?.cmTile ?? content?.cmView)?.view.state;
      return state?.doc.lineAt(state.selection.main.head).text;
    })()`);
  const blur = () => evaluate("document.querySelector('.cm-content').blur()");
  const name = async (value) => {
    await waitFor(
      () => evaluate("document.activeElement?.getAttribute('aria-label') === 'Note title'"),
      'title field focus',
    );
    await web.insertText(value);
    key('Enter');
    await waitFor(() => existsSync(note(value)), `${value}.md`);
    await waitFor(
      () => evaluate("document.activeElement?.classList.contains('cm-content')"),
      'editor focus',
    );
  };

  assert.equal(await evaluate('typeof window.require'), 'undefined');
  if (process.env.OPSIDIAN_SMOKE_PHASE === 'read') {
    await waitFor(async () => (await title()) === 'Sunday', 'last note to reopen');
    await waitFor(async () => (await editorText()) === '# Close flush\n\nLast keystroke survives.');
    console.log('PASS native restart reopened the last note with its final edit');
    win.close();
    return;
  }

  // An empty vault, a first note, and its name becoming the filename.
  await waitFor(
    () => evaluate("document.body.textContent.includes('No note is open')"),
    'empty state',
  );
  key('N', ['meta']);
  await waitFor(() => existsSync(note('Untitled')), 'Untitled.md');
  await name('Weekend plans');
  assert.equal(existsSync(note('Untitled')), false);
  await web.insertText('Walk by the water.');
  await waitFor(() => text('Weekend plans') === 'Walk by the water.', 'first save');

  // Link completion offers real notes; links navigate and show up as backlinks.
  await evaluate(
    "[...document.querySelectorAll('aside button')].find((b) => b.textContent.includes('New note')).click()",
  );
  await waitFor(() => existsSync(note('Untitled')), 'second note');
  await name('Sunday');
  for (const keyCode of '[[Week') {
    web.sendInputEvent({ type: 'keyDown', keyCode });
    web.sendInputEvent({ type: 'char', keyCode });
    web.sendInputEvent({ type: 'keyUp', keyCode });
    await delay(100);
  }
  await waitFor(() => present('.cm-tooltip-autocomplete'), 'completion');
  await delay(150); // CodeMirror suppresses accidental acceptance just after opening.
  key('Enter');
  await waitFor(() => text('Sunday') === '[[Weekend plans]]', 'completed link');
  await blur();
  await waitFor(() => present('.op-wikilink:not(.op-wikilink-unresolved)'), 'resolved link');
  await evaluate("document.querySelector('.op-wikilink').click()");
  await waitFor(async () => (await title()) === 'Weekend plans', 'link navigation');
  await waitFor(
    () =>
      evaluate(
        "document.querySelector('[aria-label=\"Linked from\"]')?.textContent.includes('Sunday')",
      ),
    'backlink',
  );
  await click('Back');
  await waitFor(async () => (await title()) === 'Sunday', 'back');
  await waitFor(() => present('.cm-content'), 'editor');
  console.log('PASS new notes, rename by title, link completion, navigation, backlinks, back');

  // A link to a note that does not exist is marked, and following it creates the note.
  await replace('[[Brand new]]');
  await blur();
  await waitFor(() => present('.op-wikilink-unresolved'), 'unresolved link');
  await evaluate("document.querySelector('.op-wikilink-unresolved').click()");
  await waitFor(() => existsSync(note('Brand new')), 'note created from link');
  await waitFor(async () => (await title()) === 'Brand new', 'created note to open');

  // The switcher searches note text, not only names.
  key('K', ['meta']);
  await waitFor(() => present('[role="dialog"] input'), 'switcher');
  await web.insertText('water');
  await waitFor(
    () =>
      evaluate(
        "document.querySelector('[role=\"dialog\"] li')?.textContent.includes('Walk by the water.')",
      ),
    'content match',
  );
  key('Enter');
  await waitFor(async () => (await title()) === 'Weekend plans', 'switcher to open the match');
  console.log('PASS create from unresolved link, full-text switcher');

  await openFromSidebar('Sunday');
  await replace('```md\n[[Weekend plans]]\n- [ ] code only\n```');
  await blur();
  assert.equal(await evaluate("document.querySelectorAll('.op-wikilink, .op-task').length"), 0);
  const imagePath = join(process.env.OPSIDIAN_PROFILE_DIR, 'test.png');
  writeFileSync(
    imagePath,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [imagePath] });
  await replace('Picture\n\n');
  await click('Attach image');
  await waitFor(() => text('Sunday').includes('](attachments/'), 'image link');
  await blur();
  await waitFor(
    () => evaluate("Boolean(document.querySelector('.op-image img')?.naturalWidth)"),
    'image served from the vault',
  );
  // A pasted screenshot is stored in the notebook and linked where the cursor is.
  await evaluate(`(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(readFileSync(imagePath).toString('base64'))}), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
    const content = document.querySelector('.cm-content');
    content.focus();
    content.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  })()`);
  await waitFor(() => existsSync(join(vault, 'attachments', 'Pasted image.png')), 'pasted image');
  await waitFor(() => text('Sunday').includes('](attachments/Pasted%20image.png)'), 'pasted link');
  // A real paste. webContents.insertText takes the slow native text-input path instead.
  clipboard.writeText(
    '# Long note\n\n' + 'A paragraph with **bold** and [[Weekend plans]].\n\n'.repeat(2000),
  );
  await selectAll();
  const started = Date.now();
  web.paste();
  await waitFor(() => text('Sunday').length > 90000, 'long note save');
  console.log(
    `PASS fenced code, native image import; 96KB paste and save ${Date.now() - started}ms`,
  );

  await replace('# Native smoke\n\n- [ ] Try a task\n\n[[Weekend plans]]\n\n**Real Markdown**');
  await waitFor(() => text('Sunday').startsWith('# Native smoke'), 'save');
  await blur();
  await waitFor(() => present('.op-task'), 'task box');
  await evaluate("document.querySelector('.op-task').click()");
  await waitFor(() => text('Sunday').includes('- [x]'), 'task toggle');
  await evaluate(
    "Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Source').click()",
  );
  await waitFor(async () => !(await present('.op-task')), 'source mode');
  assert.match(
    await evaluate("document.querySelector('.cm-content').textContent"),
    /\[\[Weekend plans\]\]/,
  );
  await evaluate("document.querySelector('.cm-content').focus()");
  key('F', ['meta']);
  await waitFor(() => present('.op-find'), 'find bar');
  await evaluate(`(() => {
    const field = document.querySelector('.op-find input');
    field.value = 'task'; field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  assert.equal(
    await evaluate("document.querySelector('.cm-searchMatch-selected')?.textContent"),
    'task',
  );
  await evaluate(`(() => {
    document.querySelector('[aria-label="Show replacement options"]').click();
    const field = document.querySelector('[aria-label="Replace with"]');
    field.value = 'check'; field.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[aria-label="Replace all matches"]').click();
  })()`);
  await waitFor(() => text('Sunday').includes('Try a check'), 'replace');
  await evaluate(
    `document.querySelector('.op-find input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
  );
  assert.equal(await present('.op-find'), false);
  console.log('PASS task toggle, source mode, themed find and replace');

  // Another program edits the open note: with nothing unsaved, the editor follows the file.
  await delay(300);
  writeFileSync(note('Sunday'), 'Edited elsewhere.');
  await waitFor(async () => (await editorText()) === 'Edited elsewhere.', 'external reload');
  // With an unsaved edit, the newer file wins and the edit is kept beside it.
  await replace('My unsaved edit.');
  writeFileSync(note('Sunday'), 'Edited elsewhere again.');
  await waitFor(async () => (await editorText()) === 'Edited elsewhere again.', 'conflict reload');
  const copy = readdirSync(vault).find((entry) => entry.startsWith('Sunday (conflicted copy'));
  assert.equal(readFileSync(join(vault, copy), 'utf8'), 'My unsaved edit.');
  assert.equal(text('Sunday'), 'Edited elsewhere again.');
  await waitFor(
    () =>
      evaluate(
        "document.querySelector('[role=\"alert\"]')?.textContent.includes('changed outside Opsidian')",
      ),
    'conflict notice',
  );
  console.log('PASS external edit reload, conflicting edit preserved');

  // Lists, quotes and embeds are drawn; renaming a note rewrites the links to it.
  await evaluate(
    "Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Live Preview').click()",
  );
  await replace(
    'See [[Weekend plans]] and ![[Weekend plans]].\n\n- one\n- two\n\n> quoted\n\n![[pasted IMAGE.png]]',
  );
  await waitFor(() => text('Sunday').startsWith('See [[Weekend plans]]'), 'save');
  await blur();
  await waitFor(
    () =>
      evaluate(
        "document.querySelector('.op-embed .cm-content')?.textContent.includes('Walk by the water.')",
      ),
    'embedded note',
  );
  assert.equal(
    await evaluate("document.querySelectorAll('.cm-content > .cm-line .op-bullet').length"),
    2,
  );
  assert.equal(await present('.cm-line.op-quote'), true);
  // An image embed finds the file by name, wherever it is in the notebook.
  await waitFor(
    () => evaluate("Boolean(document.querySelector('.op-image img')?.naturalWidth)"),
    'image embedded by name',
  );
  // A note dragged out of the sidebar carries a link to itself.
  assert.equal(
    await evaluate(`(() => {
      const data = new DataTransfer();
      const row = document.querySelector('[data-note="Weekend plans.md"]');
      const fire = (type) =>
        row.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
      fire('dragstart');
      fire('dragend');
      return data.getData('text/plain');
    })()`),
    '[[Weekend plans]]',
  );
  await menu('Weekend plans', 'Rename');
  await focused('New name');
  await web.insertText('Saturday plans');
  key('Enter');
  await waitFor(() => existsSync(note('Saturday plans')), 'renamed file');
  assert.equal(existsSync(note('Weekend plans')), false);
  await waitFor(
    () => text('Sunday').startsWith('See [[Saturday plans]] and ![[Saturday plans]].'),
    'links rewritten on disk',
  );
  await waitFor(
    async () => (await editorText()).startsWith('See [[Saturday plans]]'),
    'open note follows the rewrite',
  );
  // The rewritten note saves normally afterwards: no conflict copy appears.
  await replace('Then [[Saturday plans#Far away]].');
  await waitFor(() => text('Sunday') === 'Then [[Saturday plans#Far away]].', 'save after rewrite');
  assert.equal(readdirSync(vault).filter((entry) => entry.includes('conflicted')).length, 1);
  console.log('PASS bullets, quotes, embeds, rename rewrites links in other and open notes');

  // Folders: create, drop a note in, rename, move back out, trash.
  await click('New folder');
  await focused('Folder name');
  await web.insertText('Projects');
  key('Enter');
  await waitFor(() => existsSync(join(vault, 'Projects')), 'new folder');
  await waitFor(() => present('[data-folder="Projects"]'), 'folder row');
  await dragTo('[data-note="Saturday plans.md"]', '[data-folder="Projects"]');
  await waitFor(() => existsSync(join(vault, 'Projects', 'Saturday plans.md')), 'note in folder');
  await menu('Projects', 'Rename');
  await focused('New name');
  await web.insertText('Trips');
  key('Enter');
  await waitFor(() => existsSync(join(vault, 'Trips', 'Saturday plans.md')), 'renamed folder');
  assert.equal(existsSync(join(vault, 'Projects')), false);
  await menu('Trips', 'New folder');
  await focused('Folder name');
  await web.insertText('Nested');
  key('Enter');
  await waitFor(() => existsSync(join(vault, 'Trips', 'Nested')), 'nested folder');
  // A link by name still reaches the note in its folder, and lands on the heading.
  await evaluate('document.querySelector(\'[data-note="Trips/Saturday plans.md"]\').click()');
  await waitFor(async () => (await title()) === 'Saturday plans', 'note inside folder');
  await waitFor(() => present('.cm-content'), 'editor');
  await replace('# Top\n\n' + 'filler line\n\n'.repeat(150) + '## Far away\n\nThe end.');
  await waitFor(() => text('Trips/Saturday plans')?.includes('## Far away'), 'long note save');
  await openFromSidebar('Sunday');
  await blur();
  await waitFor(() => present('.op-wikilink:not(.op-wikilink-unresolved)'), 'heading link');
  await evaluate("document.querySelector('.op-wikilink').click()");
  await waitFor(async () => (await title()) === 'Saturday plans', 'heading link navigation');
  await waitFor(async () => (await cursorLine()) === '## Far away', 'cursor on the heading');
  await waitFor(
    () =>
      evaluate("document.querySelector('.cm-content').closest('.overflow-auto').scrollTop > 1000"),
    'scrolled to the heading',
  );
  await menu('Saturday plans', 'Move to…');
  await focused('Destination folder');
  key('Enter');
  await waitFor(() => existsSync(note('Saturday plans')), 'moved to the top level');
  assert.equal(await title(), 'Saturday plans');
  await menu('Trips', 'Move to trash');
  await waitFor(() => existsSync(join(vault, '.trash', 'Trips', 'Nested')), 'folder in trash');
  assert.equal(existsSync(join(vault, 'Trips')), false);
  console.log('PASS folders: create, drag in, rename, nest, heading link, move out, trash');

  // Typing straight after a rename is saved into the renamed note, not a revived old one.
  await openFromSidebar('Sunday');
  for (const [from, to] of [
    ['Sunday', 'Sunday renamed'],
    ['Sunday renamed', 'Sunday'],
  ]) {
    await evaluate('document.querySelector(\'[aria-label="Note title"]\').select()');
    await focused('Note title');
    await web.insertText(to);
    key('Enter');
    void web.insertText(` typed while becoming ${to}.`);
    await waitFor(() => text(to)?.includes(`typed while becoming ${to}.`), `edit saved in ${to}`);
    assert.equal(existsSync(note(from)), false);
  }
  assert.equal(readdirSync(vault).filter((entry) => entry.includes('conflicted')).length, 1);
  // Text that once broke the preview: a bare list marker above a line starting with a box.
  await replace('-\n[ ] not a task\n\n![[100%.png]] still drawn: [[Saturday plans]]');
  await blur();
  await waitFor(() => present('.op-wikilink'), 'preview survives odd input');
  assert.equal(await present('main [role="alert"] .text-destructive, main p[role="alert"]'), false);
  console.log('PASS typing during a rename, preview survives odd input');

  await openFromSidebar('Brand new');
  await click('Move note to trash');
  await waitFor(() => existsSync(join(vault, '.trash', 'Brand new.md')), 'trash');
  assert.equal(existsSync(note('Brand new')), false);
  await evaluate(
    "[...document.querySelectorAll('aside button')].find((b) => b.textContent.trim() === 'Trash').click()",
  );
  await waitFor(() => present('[aria-label="Restore Brand new"]'), 'trash list');
  await click('Restore Brand new');
  await waitFor(() => existsSync(note('Brand new')), 'restored note');
  await waitFor(async () => (await title()) === 'Brand new', 'restored note opens');
  await click('Close');
  await click('Move note to trash');
  await waitFor(() => !existsSync(note('Brand new')), 'trash again');
  await openFromSidebar('Sunday');
  await replace('# Close flush\n\nLast keystroke survives.');
  // Close immediately, before the normal autosave debounce expires.
  win.on('closed', () => {
    try {
      assert.equal(text('Sunday'), '# Close flush\n\nLast keystroke survives.');
      console.log('PASS trash, close flush');
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
}, 150000).unref();
