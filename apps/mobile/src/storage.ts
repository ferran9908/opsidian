import { Directory, File, Paths } from 'expo-file-system';
import * as SQLite from 'expo-sqlite';
import * as DocumentPicker from 'expo-document-picker';
import {
  initialMarkdown,
  validateContent,
  MAX_IMAGE_BYTES,
  type ImportedImage,
  type NoteSnapshot,
} from '@opsidian/core';

const root = new Directory(Paths.document, 'Opsidian');
const attachments = new Directory(root, 'attachments');
const note = new File(root, 'Sunday.md');
let open: Promise<SQLite.SQLiteDatabase> | undefined;
function database() {
  return (open ??= (async () => {
    root.create({ idempotent: true, intermediates: true });
    attachments.create({ idempotent: true, intermediates: true });
    const db = await SQLite.openDatabaseAsync('opsidian-prototype.db');
    await db.execAsync(
      'PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS note (id INTEGER PRIMARY KEY CHECK (id = 1), content TEXT NOT NULL);',
    );
    await db.runAsync(
      'INSERT OR IGNORE INTO note (id, content) VALUES (1, ?)',
      note.exists ? await note.text() : initialMarkdown,
    );
    return db;
  })());
}
export async function loadNote(): Promise<NoteSnapshot> {
  await writes;
  const db = await database();
  const row = await db.getFirstAsync<{ content: string }>('SELECT content FROM note WHERE id = 1');
  if (!row) throw new Error('The saved note could not be read.');
  // Re-materialize after a crash between the durable journal commit and file write.
  note.write(row.content);
  const assets: Record<string, string> = {};
  for (const entry of attachments.list()) {
    if (
      !(entry instanceof File) ||
      !/^[a-zA-Z0-9-]+\.(png|jpg|jpeg|gif|webp)$/.test(entry.name) ||
      entry.size > MAX_IMAGE_BYTES
    )
      continue;
    const type = /\.jpe?g$/.test(entry.name) ? 'jpeg' : entry.extension.slice(1);
    assets[`attachments/${entry.name}`] = `data:image/${type};base64,${await entry.base64()}`;
  }
  return { content: row.content, assets, location: note.uri };
}
let writes: Promise<void> = Promise.resolve();
export function saveNote(content: string): Promise<void> {
  validateContent(content);
  const task = writes.then(async () => {
    const db = await database();
    await db.runAsync('UPDATE note SET content = ? WHERE id = 1', content);
    note.write(content);
  });
  writes = task.catch(() => {});
  return task;
}
export async function importImage(): Promise<ImportedImage | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
    copyToCacheDirectory: true,
  });
  if (result.canceled || !result.assets[0]) return null;
  const item = result.assets[0];
  const file = new File(item.uri);
  if (file.size > MAX_IMAGE_BYTES) throw new Error('Choose an image smaller than 5 MB.');
  const bytes = await file.bytes();
  let type: string | undefined;
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) type = 'png';
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) type = 'jpeg';
  else if (String.fromCharCode(...bytes.slice(0, 6)).match(/^GIF8[79]a$/)) type = 'gif';
  else if (
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  )
    type = 'webp';
  if (!type) throw new Error('Supported images: PNG, JPEG, GIF, and WebP.');
  await database();
  const name = `${Date.now()}-${Math.random().toString(36).slice(2)}.${type === 'jpeg' ? 'jpg' : type}`;
  const target = new File(attachments, name);
  file.copy(target);
  return { path: `attachments/${name}`, url: `data:image/${type};base64,${await target.base64()}` };
}
