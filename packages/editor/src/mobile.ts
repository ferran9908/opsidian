import { createEditor, type EditorCommand, type EditorMode } from './index';
import {
  SaveQueue,
  imageMarkdown,
  noteSuggestions,
  type ImportedImage,
  type NoteSnapshot,
  type SaveStatus,
} from '@opsidian/core';
import '@opsidian/theme/tokens.css';
import './style.css';
import './mobile.css';

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(value: string): void };
    OpsidianHost?: {
      receive(message: {
        id?: number;
        session?: string;
        result?: unknown;
        error?: string;
        event?: string;
      }): void;
    };
  }
}
const session = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let nextId = 0;
const pending = new Map<
  number,
  {
    resolve(value: unknown): void;
    reject(reason: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
function request<T>(method: string, content?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(
      () => {
        pending.delete(id);
        reject(new Error('The device has not confirmed this save. Tap Retry.'));
      },
      method === 'image' ? 600000 : 15000,
    );
    pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
    window.ReactNativeWebView?.postMessage(JSON.stringify({ session, id, method, content }));
  });
}
let saves: SaveQueue | undefined;
window.OpsidianHost = {
  receive(message) {
    if (message.event === 'flush') {
      void saves?.flush().catch(() => {});
      return;
    }
    if (message.session !== session || message.id === undefined) return;
    const task = pending.get(message.id);
    if (!task) return;
    clearTimeout(task.timer);
    pending.delete(message.id);
    if (message.error) task.reject(new Error(message.error));
    else task.resolve(message.result);
  },
};
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
function report(status: SaveStatus) {
  element('save-status').textContent =
    status.state === 'saved'
      ? 'Saved on this iPhone'
      : status.state === 'saving'
        ? 'Saving…'
        : status.message;
  element('retry').hidden = status.state !== 'error';
  element('save-status').setAttribute('data-state', status.state);
}
let dark = matchMedia('(prefers-color-scheme: dark)').matches;
function setTheme() {
  document.documentElement.classList.toggle('dark', dark);
  element('theme').textContent = dark ? 'Light' : 'Dark';
}
setTheme();
element('theme').onclick = () => {
  dark = !dark;
  setTheme();
};
async function start() {
  const note = await request<NoteSnapshot>('load');
  const assets = note.assets;
  saves = new SaveQueue(note.content, (content) => request<void>('save', content), report, 80);
  const editor = createEditor({
    parent: element('editor'),
    content: note.content,
    suggestions: noteSuggestions,
    resolveImage: (path) => assets[path],
    onLink: (name) => {
      element('link-detail').textContent =
        `“${name}” is saved as a link. Opening other notes arrives with the full notebook.`;
      element('link-notice').hidden = false;
    },
    onChange: (content) => saves?.update(content),
    onSave: () => {
      void saves?.flush().catch(() => {});
    },
  });
  element('loading').hidden = true;
  element('retry').onclick = () => void saves?.flush().catch(() => {});
  element('dismiss-link').onclick = () => {
    element('link-notice').hidden = true;
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-command]')) {
    button.disabled = false;
    button.addEventListener('pointerdown', (event) => event.preventDefault());
    button.onclick = () => editor.command(button.dataset.command as EditorCommand);
  }
  element<HTMLSelectElement>('mode').disabled = false;
  element<HTMLSelectElement>('mode').onchange = (event) =>
    editor.setMode((event.target as HTMLSelectElement).value as EditorMode);
  element<HTMLButtonElement>('attach').disabled = false;
  element('attach').onclick = async () => {
    try {
      await saves?.flush();
      const image = await request<ImportedImage | null>('image');
      if (image) {
        assets[image.path] = image.url;
        editor.insert(imageMarkdown(image.path));
        await saves?.flush();
      }
    } catch (error) {
      element('link-detail').textContent = error instanceof Error ? error.message : String(error);
      element('link-notice').hidden = false;
    }
  };
  element('dismiss-keyboard').onclick = () => editor.view.contentDOM.blur();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) void saves?.flush().catch(() => {});
  });
  window.addEventListener('pagehide', () => void saves?.flush().catch(() => {}));
  report({ state: 'saved' });
}
void start().catch((error) => {
  element('loading').textContent =
    `Could not open your note: ${String(error)}. Close and reopen the app to retry.`;
});
