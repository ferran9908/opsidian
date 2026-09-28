import { mkdir, open, readFile, rename, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  initialMarkdown,
  validateContent,
  MAX_IMAGE_BYTES,
  type NoteSnapshot,
  type ImportedImage,
} from '@opsidian/core';

export async function atomicWrite(path: string, content: string | Uint8Array): Promise<void> {
  const temporary = `${path}.pending`;
  // Never follow a pre-existing temporary symlink.
  try {
    if ((await lstat(temporary)).isSymbolicLink()) throw new Error('Unsafe temporary file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const file = await open(temporary, 'w', 0o600);
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(join(path, '..'), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export class PrototypeStore {
  private diskContent: string | undefined;
  private queue: Promise<void> = Promise.resolve();
  readonly notePath: string;
  constructor(readonly directory: string) {
    this.notePath = join(directory, 'Sunday.md');
  }

  async load(): Promise<NoteSnapshot> {
    await mkdir(join(this.directory, 'attachments'), { recursive: true });
    try {
      if ((await lstat(this.notePath)).isSymbolicLink())
        throw new Error('The prototype note must not be a symlink.');
      this.diskContent = await readFile(this.notePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A first save interrupted before rename can be recovered safely.
      const pending = await readFile(`${this.notePath}.pending`, 'utf8').catch(
        () => initialMarkdown,
      );
      validateContent(pending);
      await atomicWrite(this.notePath, pending);
      this.diskContent = pending;
    }
    const assets: Record<string, string> = {};
    for (const name of await readdir(join(this.directory, 'attachments'))) {
      if (!/^[a-zA-Z0-9-]+\.(png|jpg|jpeg|gif|webp)$/.test(name)) continue;
      const path = join(this.directory, 'attachments', name);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) continue;
      const mime =
        name.endsWith('.jpg') || name.endsWith('.jpeg') ? 'jpeg' : name.split('.').at(-1);
      assets[`attachments/${name}`] =
        `data:image/${mime};base64,${(await readFile(path)).toString('base64')}`;
    }
    return { content: this.diskContent, assets, location: this.notePath };
  }

  save(content: string): Promise<void> {
    validateContent(content);
    const task = this.queue.then(async () => {
      if (this.diskContent === undefined) throw new Error('Open the note before saving.');
      const stat = await lstat(this.notePath);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error('The note file has moved or changed type.');
      const actual = await readFile(this.notePath, 'utf8');
      if (actual !== this.diskContent) {
        const recovery = join(this.directory, `Recovered-${randomUUID()}.md`);
        await atomicWrite(recovery, content);
        throw new Error(
          `The file changed outside Opsidian. Your edit is safe in ${recovery}. Reopen the app to load the external version.`,
        );
      }
      await atomicWrite(this.notePath, content);
      this.diskContent = content;
    });
    this.queue = task.catch(() => {});
    return task;
  }

  async importImage(filePath: string): Promise<ImportedImage> {
    const stat = await lstat(filePath);
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES)
      throw new Error('Choose an image smaller than 5 MB.');
    const bytes = await readFile(filePath);
    const type = detectImage(bytes);
    if (!type) throw new Error('Supported images: PNG, JPEG, GIF, and WebP.');
    const name = `${randomUUID()}.${type === 'jpeg' ? 'jpg' : type}`;
    await mkdir(join(this.directory, 'attachments'), { recursive: true });
    await atomicWrite(join(this.directory, 'attachments', name), bytes);
    return {
      path: `attachments/${name}`,
      url: `data:image/${type};base64,${bytes.toString('base64')}`,
    };
  }
}
export function detectImage(bytes: Uint8Array): string | undefined {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'jpeg';
  if (['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString())) return 'gif';
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP')
    return 'webp';
  return undefined;
}
