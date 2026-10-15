import { createEditor, type EditorCommand, type EditorMode } from './index';
import {
  SaveQueue,
  linkResolver,
  mergeText,
  noteFolder,
  noteTitle,
  type NoteDocument,
  type SaveResult,
  type SaveStatus,
} from '@opsidian/core';
import '@opsidian/theme/tokens.css';
import './style.css';
import './mobile.css';

/** What the app sends when a note should be shown. */
interface Opening {
  path: string;
  content: string;
  revision: string;
  notes: string[];
  mode: EditorMode;
  heading?: string;
}
type Incoming =
  | { id: number; session: string; result?: unknown; error?: string }
  | ({ event: 'open' } & Opening)
  | { event: 'notes'; notes: string[] }
  | { event: 'changed'; path: string }
  | { event: 'moved'; path: string | null }
  | { event: 'mode'; mode: EditorMode }
  | { event: 'insert'; text: string }
  | { event: 'blur' }
  | { event: 'flush'; ask: number };

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(value: string): void };
    OpsidianHost?: { receive(message: Incoming): void };
  }
}
const session = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const post = (value: object) => window.ReactNativeWebView?.postMessage(JSON.stringify(value));
let nextId = 0;
const pending = new Map<
  number,
  {
    resolve(value: unknown): void;
    reject(reason: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
/** Asks the app to do something with the notebook, which only it can reach. */
function call<T>(method: string, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(
      () => {
        pending.delete(id);
        reject(new Error('The device has not confirmed this save.'));
      },
      method === 'attach' ? 600000 : 15000,
    );
    pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
    post({ session, id, method, args });
  });
}
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tell = (note: string, detail: object = {}) => post({ session, note, ...detail });

const scheme = matchMedia('(prefers-color-scheme: dark)');
const paint = () => document.documentElement.classList.toggle('dark', scheme.matches);
paint();
scheme.addEventListener('change', paint);

let editor: ReturnType<typeof createEditor> | undefined;
let saves: SaveQueue | undefined;
/** The note being edited; null once it has been trashed. */
let target: string | null = null;
let revision = '';
let notes: string[] = [];
let resolve = linkResolver([]);
const images = new Map<string, string | null>();
const doc = () => editor?.view.state.doc.toString();
const words = () =>
  tell('words', { count: (doc() ?? '').trim().split(/\s+/).filter(Boolean).length });

/**
 * Saves whatever is in the editor into `copy` until the two match, and returns with no await
 * after the last look, so the caller can replace the editor's text without a keystroke
 * falling in between.
 */
async function keepAside(copy: string, holds: string) {
  for (let saved = holds; ;) {
    const typed = doc();
    if (typed === undefined || typed === saved) return;
    const current = await call<NoteDocument>('read', copy);
    const result = await call<SaveResult>('save', copy, typed, current.revision);
    if ('revision' in result) saved = typed;
  }
}
/** Settles when a rename of this note has finished; saves wait for it, to land on the new name. */
let moving: Promise<void> = Promise.resolve();

/** Saves one snapshot. A string result is what the file holds instead. */
async function write(content: string): Promise<void | string> {
  await moving;
  const path = target;
  // Trashed while this edit was waiting: there is no note left to write it to.
  if (path === null) return;
  const result = await call<SaveResult>('save', path, content, revision);
  if ('revision' in result) {
    if (result.merged === undefined) {
      revision = result.revision;
      return;
    }
    // The file had moved on (another device) and the two were combined. Show the result,
    // keeping anything typed since this save began.
    const typed = doc() ?? content;
    let next = typed === content ? result.merged : mergeText(content, typed, result.merged);
    if (next === undefined) {
      // The newest keystrokes touch the very lines that changed elsewhere: keep them apart.
      const copy = await call<string>(
        'createNote',
        noteFolder(path),
        `${noteTitle(path).slice(0, 150)} (my edit)`,
      );
      await keepAside(copy, '');
      tell('notice', {
        text: `This note changed on another device while you were typing. Your latest text is in “${noteTitle(copy)}”.`,
        copy,
      });
      next = result.merged;
    } else tell('notice', { text: 'Another device added to this note. Both edits are here.' });
    revision = result.revision;
    editor?.setContent(next);
    setTimeout(() => {
      const now = doc();
      if (now !== undefined && now !== result.merged) saves?.update(now);
    }, 0);
    return result.merged;
  }
  // The file changed underneath this edit. The edit is in a copy; show what is on disk.
  const disk = await call<NoteDocument>('read', path);
  await keepAside(result.conflict, content);
  revision = disk.revision;
  editor?.setContent(disk.content);
  tell('notice', {
    text: `This note changed elsewhere, so the newer text was kept. Yours is saved as “${noteTitle(result.conflict)}”.`,
    copy: result.conflict,
  });
  return disk.content;
}
const report = (status: SaveStatus) => tell('status', status);

function show(opening: Opening) {
  editor?.view.destroy();
  images.clear();
  target = opening.path;
  revision = opening.revision;
  notes = opening.notes;
  resolve = linkResolver(notes);
  title.textContent = noteTitle(opening.path);
  element('loading').hidden = true;
  element('editor').textContent = '';
  saves = new SaveQueue(opening.content, write, report);
  const made = createEditor({
    parent: element('editor'),
    content: opening.content,
    mode: opening.mode,
    suggestions: () => notes.map(noteTitle),
    linkExists: (name) => Boolean(resolve(name)),
    resolveImage(source) {
      const known = images.get(source);
      if (known !== undefined) return known ?? undefined;
      // Asked for once; the picture appears when the app has read it.
      images.set(source, null);
      void call<string | null>('image', source).then(
        (url) => {
          if (!url || editor !== made) return;
          images.set(source, url);
          made.refresh();
        },
        () => {},
      );
      return undefined;
    },
    // The note is left behind when a link opens, so what it holds is saved first.
    onLink: (name, heading) =>
      void (saves?.flush() ?? Promise.resolve())
        .catch(() => {})
        .then(() => tell('link', { target: name, heading })),
    loadEmbed: (name, heading) => call<string | undefined>('embed', target, name, heading),
    onChange: (content) => {
      saves?.update(content);
      words();
    },
    onSave: () => void saves?.flush().catch(() => {}),
  });
  editor = made;
  made.view.contentDOM.addEventListener('focus', () => setEditing(true));
  made.view.contentDOM.addEventListener('blur', () => setEditing(false));
  if (opening.heading) made.scrollToHeading(opening.heading);
  else element('page').scrollTop = 0;
  report({ state: 'saved' });
  words();
  // A new, empty note opens on its name, ready to be typed over, as on the Mac.
  if (!opening.content && /^Untitled( \d+)?$/.test(noteTitle(opening.path))) selectTitle();
}

/**
 * The title is the note's name, edited in place. Return or leaving it renames the note; an
 * empty or unchanged name puts the old one back. The rename itself is the app's, so links to
 * the note are rewritten and the change syncs, as from the note's menu.
 */
const title = element('title');
function selectTitle() {
  title.focus();
  const range = document.createRange();
  range.selectNodeContents(title);
  const selection = getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
async function rename() {
  const from = target;
  if (from === null) return;
  const name = (title.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (!name || name === noteTitle(from)) {
    title.textContent = noteTitle(from);
    return;
  }
  // What was typed is saved under the old name first; saves begun after this wait for the new.
  await saves?.flush().catch(() => {});
  let done = () => {};
  moving = new Promise((settle) => (done = settle));
  try {
    const next = await call<string>('rename', from, name);
    if (target === from) target = next;
    title.textContent = noteTitle(next);
  } catch (reason) {
    title.textContent = noteTitle(from);
    tell('notice', { text: reason instanceof Error ? reason.message : String(reason) });
  } finally {
    done();
  }
}
title.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  title.blur();
});
title.addEventListener('focus', () => tell('editing', { value: true }));
title.addEventListener('blur', () => {
  tell('editing', { value: false });
  void rename();
});
function setEditing(value: boolean) {
  element('bar').hidden = !value;
  tell('editing', { value });
  if (!value) void saves?.flush().catch(() => {});
}
/** Brings in a version written by sync, unless there are edits here still to save. */
async function reload(path: string) {
  if (path !== target || !editor || !saves?.settled) return;
  const disk = await call<NoteDocument>('read', path);
  // Anything typed during the read is merged by the next save instead.
  if (path !== target || !saves.settled || disk.revision === revision) return;
  revision = disk.revision;
  saves.adopt(disk.content);
  editor.setContent(disk.content);
  images.clear();
  editor.refresh();
  tell('notice', { text: 'Updated from another device.' });
  words();
}

window.OpsidianHost = {
  receive(message) {
    if ('event' in message) {
      if (message.event === 'open') show(message);
      else if (message.event === 'notes') {
        notes = message.notes;
        resolve = linkResolver(notes);
        editor?.refresh();
      } else if (message.event === 'changed') void reload(message.path).catch(() => {});
      else if (message.event === 'moved') {
        target = message.path;
        if (message.path) title.textContent = noteTitle(message.path);
      } else if (message.event === 'mode') editor?.setMode(message.mode);
      else if (message.event === 'insert') {
        editor?.insert(message.text);
        void saves?.flush().catch(() => {});
      } else if (message.event === 'blur') (document.activeElement as HTMLElement | null)?.blur();
      else if (message.event === 'flush') {
        const done = (error?: string) => post({ session, answer: message.ask, error });
        (saves?.flush() ?? Promise.resolve()).then(
          () => done(),
          (reason) => done(String(reason instanceof Error ? reason.message : reason)),
        );
      }
      return;
    }
    if (message.session !== session) return;
    const task = pending.get(message.id);
    if (!task) return;
    clearTimeout(task.timer);
    pending.delete(message.id);
    if (message.error) task.reject(new Error(message.error));
    else task.resolve(message.result);
  },
};

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-command]')) {
  // Keeps the keyboard up: the button never takes focus from the note.
  button.addEventListener('pointerdown', (event) => event.preventDefault());
  button.onclick = () => editor?.command(button.dataset.command as EditorCommand);
}
element('attach').addEventListener('pointerdown', (event) => event.preventDefault());
element('attach').onclick = () => {
  void saves?.flush().catch(() => {});
  tell('attach');
};
element('dismiss-keyboard').onclick = () => editor?.view.contentDOM.blur();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) void saves?.flush().catch(() => {});
});
window.addEventListener('pagehide', () => void saves?.flush().catch(() => {}));
tell('ready');
