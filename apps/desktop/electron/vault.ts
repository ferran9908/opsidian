import { lstat, mkdir, open, readFile, readdir, realpath, rename } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, join, sep } from 'node:path';
import {
  MAX_IMAGE_BYTES,
  MAX_NOTE_LENGTH,
  NoteIndex,
  isVaultImage,
  noteFolder,
  noteTitle,
  validateContent,
  validateName,
  type Backlink,
  type NoteDocument,
  type SaveResult,
  type SearchResult,
  type VaultTree,
} from '@opsidian/core';
import { atomicWrite, detectImage } from './storage';

const revisionOf = (content: string) => createHash('sha256').update(content).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const child = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

/**
 * A folder of Markdown notes. Paths are vault-relative and use `/`. Hidden entries and
 * symlinks are never listed, read or written, so a note cannot reach outside the vault.
 */
export class Vault {
  private readonly index = new NoteIndex();
  /** mtime and size of each indexed note, so a rescan only rereads what changed. */
  private readonly stamps = new Map<string, string>();
  private folders: string[] = [];
  private work: Promise<unknown> = Promise.resolve();
  private watcher: FSWatcher | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  private constructor(readonly root: string) {}

  static async open(directory: string): Promise<Vault> {
    await mkdir(directory, { recursive: true });
    const vault = new Vault(await realpath(directory));
    await vault.scan();
    return vault;
  }

  get name(): string {
    return basename(this.root);
  }

  /** One vault operation at a time, so a rescan never interleaves with a write. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.work.then(task);
    this.work = result.catch(() => {});
    return result;
  }

  private async absolute(path: unknown, kind: 'file' | 'directory' | 'new'): Promise<string> {
    if (typeof path !== 'string' || !path || path.length > 1000 || /[\\\u0000]/.test(path))
      throw new Error('Invalid path.');
    const parts = path.split('/');
    if (parts.some((part) => !part || part.startsWith('.'))) throw new Error('Invalid path.');
    let current = this.root;
    for (const [position, part] of parts.entries()) {
      current = join(current, part);
      const last = position === parts.length - 1;
      const info = await lstat(current).catch((error) => {
        if (missing(error)) return undefined;
        throw error;
      });
      if (!info) {
        if (last && kind === 'new') break;
        throw new Error(`“${path}” is no longer in this notebook.`);
      }
      if (info.isSymbolicLink()) throw new Error('Links to other folders are not followed.');
      if (!last && !info.isDirectory()) throw new Error('Invalid path.');
      if (last && kind === 'file' && !info.isFile()) throw new Error('Invalid path.');
      if (last && kind === 'directory' && !info.isDirectory()) throw new Error('Invalid path.');
    }
    return current;
  }
  private note(path: unknown): asserts path is string {
    if (typeof path !== 'string' || !/\.md$/i.test(path)) throw new Error('Not a note.');
  }
  private async folder(path: unknown): Promise<string> {
    if (path === '') return this.root;
    return this.absolute(path, 'directory');
  }
  private async stamp(path: string, file: string): Promise<void> {
    const info = await lstat(file);
    this.stamps.set(path, `${info.mtimeMs}:${info.size}`);
  }

  /** Brings the index in line with the disk. Returns the notes whose content changed. */
  private async scan(): Promise<{ changed: string[]; dirty: boolean }> {
    const seen = new Set<string>();
    const folders: string[] = [];
    const changed: string[] = [];
    const walk = async (directory: string, relative: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const path = child(relative, entry.name);
        if (entry.isDirectory()) {
          folders.push(path);
          await walk(join(directory, entry.name), path);
        } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
          const file = join(directory, entry.name);
          const info = await lstat(file).catch(() => undefined);
          if (!info) continue;
          seen.add(path);
          const stamp = `${info.mtimeMs}:${info.size}`;
          if (this.stamps.get(path) === stamp) continue;
          // An oversized file is still listed, but its text is neither indexed nor searched.
          const content = info.size > MAX_NOTE_LENGTH * 4 ? '' : await readFile(file, 'utf8');
          if (this.index.content(path) !== content) changed.push(path);
          this.index.set(path, content);
          this.stamps.set(path, stamp);
        }
      }
    };
    await walk(this.root, '');
    let dirty = changed.length > 0;
    for (const path of this.index.paths()) {
      if (seen.has(path)) continue;
      this.index.delete(path);
      this.stamps.delete(path);
      dirty = true;
    }
    folders.sort((a, b) => a.localeCompare(b));
    dirty ||=
      folders.length !== this.folders.length ||
      folders.some((folder, position) => folder !== this.folders[position]);
    this.folders = folders;
    return { changed, dirty };
  }

  /** Watches for edits made by other programs. `notify` receives the affected notes. */
  watch(notify: (paths: string[]) => void): void {
    this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
      const name = filename?.toString() ?? '';
      if (name.split(sep).some((part) => part.startsWith('.')) || name.endsWith('.pending')) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        void this.serial(() => this.scan())
          .then(({ changed, dirty }) => {
            if (dirty) notify(changed);
          })
          .catch(() => {});
      }, 150);
    });
    this.watcher.on('error', () => {});
  }
  close(): void {
    clearTimeout(this.timer);
    this.watcher?.close();
  }

  tree(): VaultTree {
    return { notes: this.index.paths(), folders: [...this.folders] };
  }
  backlinks(path: string): Backlink[] {
    return this.index.backlinks(path);
  }
  search(query: string): SearchResult[] {
    return this.index.search(query);
  }

  read(path: string): Promise<NoteDocument> {
    return this.serial(async () => {
      this.note(path);
      const file = await this.absolute(path, 'file');
      const content = await readFile(file, 'utf8');
      validateContent(content);
      this.index.set(path, content);
      await this.stamp(path, file);
      return { content, revision: revisionOf(content) };
    });
  }

  /**
   * Writes a note only if the file still holds the content the edit started from.
   * Otherwise the edit is kept as a separate note and the newer file is left alone.
   */
  save(path: string, content: string, revision: string): Promise<SaveResult> {
    return this.serial(async () => {
      this.note(path);
      validateContent(content);
      const file = await this.absolute(path, 'new');
      const actual = await readFile(file, 'utf8').catch((error) => {
        // Deleted elsewhere while open: put the note back rather than lose the edit.
        if (missing(error)) return undefined;
        throw error;
      });
      if (actual !== undefined && revisionOf(actual) !== revision) {
        const time = new Date().toISOString().slice(0, 19).replace('T', ' ').replaceAll(':', '.');
        const copy = await this.available(
          noteFolder(path),
          `${noteTitle(path)} (conflicted copy ${time})`,
        );
        const copyFile = await this.absolute(copy, 'new');
        await atomicWrite(copyFile, content);
        this.index.set(copy, content);
        await this.stamp(copy, copyFile);
        this.index.set(path, actual);
        await this.stamp(path, file);
        return { conflict: copy };
      }
      await atomicWrite(file, content);
      this.index.set(path, content);
      await this.stamp(path, file);
      return { revision: revisionOf(content) };
    });
  }

  /** First free `name.md`, `name 1.md`, … in a folder. Call inside `serial`. */
  private async available(folder: string, name: string): Promise<string> {
    const taken = new Set(
      (await readdir(await this.folder(folder))).map((entry) => entry.toLowerCase()),
    );
    for (let count = 0; ; count++) {
      const candidate = `${count ? `${name} ${count}` : name}.md`;
      if (!taken.has(candidate.toLowerCase())) return child(folder, candidate);
    }
  }

  createNote(folder: string, name = 'Untitled'): Promise<string> {
    return this.serial(async () => {
      validateName(name);
      const path = await this.available(folder, name);
      const file = await this.absolute(path, 'new');
      await (await open(file, 'wx', 0o600)).close();
      this.index.set(path, '');
      await this.stamp(path, file);
      return path;
    });
  }

  createFolder(parent: string, name: string): Promise<string> {
    return this.serial(async () => {
      validateName(name);
      await this.folder(parent);
      const path = child(parent, name);
      await mkdir(await this.absolute(path, 'new'));
      this.folders = [...this.folders, path].sort((a, b) => a.localeCompare(b));
      return path;
    });
  }

  /** Renames a note in place. Links to it in other notes are not rewritten. */
  rename(path: string, name: string): Promise<string> {
    return this.serial(async () => {
      this.note(path);
      validateName(name);
      const from = await this.absolute(path, 'file');
      const next = child(noteFolder(path), `${name}.md`);
      if (next === path) return path;
      const to = await this.absolute(next, 'new');
      // A change of letter case alone is the same file on a case-insensitive disk.
      if (next.toLowerCase() !== path.toLowerCase() && (await lstat(to).catch(() => undefined)))
        throw new Error(`“${name}” already exists in this folder.`);
      await rename(from, to);
      this.index.move(path, next);
      this.stamps.delete(path);
      await this.stamp(next, to);
      return next;
    });
  }

  /** Moves a note into the vault's `.trash` folder, where it stays recoverable. */
  trash(path: string): Promise<void> {
    return this.serial(async () => {
      this.note(path);
      const from = await this.absolute(path, 'file');
      const bin = join(this.root, '.trash');
      await mkdir(bin, { recursive: true });
      if ((await lstat(bin)).isSymbolicLink()) throw new Error('The trash folder is not usable.');
      const taken = new Set(await readdir(bin));
      let target = basename(path);
      for (let count = 1; taken.has(target); count++) target = `${noteTitle(path)} ${count}.md`;
      await rename(from, join(bin, target));
      this.index.delete(path);
      this.stamps.delete(path);
    });
  }

  async importImage(source: string): Promise<string> {
    const info = await lstat(source);
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES)
      throw new Error('Choose an image smaller than 5 MB.');
    const bytes = await readFile(source);
    const type = detectImage(bytes);
    if (!type) throw new Error('Supported images: PNG, JPEG, GIF, and WebP.');
    const path = `attachments/${randomUUID()}.${type === 'jpeg' ? 'jpg' : type}`;
    return this.serial(async () => {
      await mkdir(join(this.root, 'attachments'), { recursive: true });
      await atomicWrite(await this.absolute(path, 'new'), bytes);
      return path;
    });
  }

  /** Absolute path of a raster image inside the vault, for the image protocol. */
  async image(path: string): Promise<string> {
    if (!isVaultImage(path)) throw new Error('Not an image.');
    const file = await this.absolute(path, 'file');
    if ((await lstat(file)).size > MAX_IMAGE_BYTES) throw new Error('Image is too large.');
    return file;
  }

  file(path: string): Promise<string> {
    return this.absolute(path, 'file');
  }
}
