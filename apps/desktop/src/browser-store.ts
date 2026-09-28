import {
  initialMarkdown,
  MAX_IMAGE_BYTES,
  type NotebookBridge,
  type NoteSnapshot,
} from '@opsidian/core';

// A browser-only preview adapter. The Electron app never uses this database.
const database = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('opsidian-preview', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('data');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
async function read(): Promise<NoteSnapshot> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('data');
    const request = tx.objectStore('data').get('note');
    tx.oncomplete = () => {
      db.close();
      resolve(
        request.result ?? {
          content: initialMarkdown,
          assets: {},
          location: 'Browser preview · IndexedDB',
        },
      );
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
async function write(value: NoteSnapshot): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('data', 'readwrite', { durability: 'strict' });
    tx.objectStore('data').put(value, 'note');
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error('Browser save failed'));
    };
  });
}
let changes: Promise<unknown> = Promise.resolve();
function change(update: (note: NoteSnapshot) => NoteSnapshot): Promise<void> {
  const task = changes.then(async () => write(update(await read())));
  changes = task.catch(() => {});
  return task;
}
export const browserStore: NotebookBridge = {
  load: read,
  async save(content) {
    await change((note) => ({ ...note, content }));
  },
  async importImage() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif,image/webp';
    const file = await new Promise<File | null>((resolve) => {
      input.onchange = () => resolve(input.files?.[0] ?? null);
      input.oncancel = () => resolve(null);
      input.click();
    });
    if (!file) return null;
    if (file.size > MAX_IMAGE_BYTES || !/^image\/(png|jpeg|gif|webp)$/.test(file.type))
      throw new Error('Choose a PNG, JPEG, GIF, or WebP smaller than 5 MB.');
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const path = `attachments/${crypto.randomUUID()}.${file.type === 'image/jpeg' ? 'jpg' : file.type.split('/')[1]}`;
    await change((note) => ({ ...note, assets: { ...note.assets, [path]: url } }));
    return { path, url };
  },
};
