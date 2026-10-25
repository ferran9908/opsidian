import {
  MAX_NOTE_LENGTH,
  MAX_VAULT_IMAGE_BYTES,
  NoteIndex,
  isVaultImage,
  noteFolder,
  noteTitle,
  validateContent,
  validateName,
  type Backlink,
  type MoveResult,
  type NoteDocument,
  type NoteGraph,
  type SaveResult,
  type SearchResult,
  type TrashEntry,
  mergeText,
  type VaultTree,
} from '@opsidian/core';
import {
  FolderGone,
  MAX_FILE_BYTES,
  type LocalFile,
  type SyncState,
  type SyncStore,
} from '@opsidian/sync';
import {
  PENDING,
  atomicWrite,
  basename,
  bytesOf,
  create,
  detectImage,
  extname,
  join,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  sameBytes,
  sha256,
  unlink,
  watch,
  type Stats,
} from './platform';

const revisionOf = (content: string) => sha256(content);
const digest = (bytes: Uint8Array) => sha256(bytes);
/** Hidden folder holding what this copy of the notebook knows about its host. */
const SYNC = '.opsidian';
const missing = (error: unknown) => (error as { code?: string } | null)?.code === 'ENOENT';
const child = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);
const sorted = (paths: Iterable<string>) => [...paths].sort((a, b) => a.localeCompare(b));
const isNote = (path: string) => /\.md$/i.test(path);
/**
 * Whether a file may have changed since it was last read. A rename keeps the time and size,
 * so two notes of one length saved in the same moment could trade names unnoticed; which
 * file it is on disk tells them apart.
 */
const stampOf = (info: Stats) => `${info.mtimeMs}:${info.size}:${info.ino}`;
/** Where each trashed item came from. Hidden, so other programs leave it alone. */
const ORIGINS = '.opsidian-origins.json';
type Origins = Record<string, { from: string; at: number }>;

/**
 * A folder of Markdown notes. Paths are vault-relative and use `/`. Hidden entries and
 * symlinks are never listed, read or written, so a note cannot reach outside the vault.
 */
export class Vault {
  private readonly index = new NoteIndex();
  /** mtime, size and file of each indexed note, so a rescan only rereads what changed. */
  private readonly stamps = new Map<string, string>();
  private folders: string[] = [];
  private images: string[] = [];
  private work: Promise<unknown> = Promise.resolve();
  private watcher: { close(): void } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** External changes a scan has absorbed but the watcher has not yet passed on. */
  private readonly unreported = new Set<string>();
  private stale = false;

  /** Text recently handed to or taken from the editor, by revision: the base for a merge. */
  private readonly recent = new Map<string, string>();
  /** Content hash of each file as of its last change, so listing does not reread them all. */
  private readonly hashes = new Map<string, { stamp: string; hash: string }>();
  private relocated: ((from: string, to: string) => void) | undefined;
  private touched: (() => void) | undefined;
  /** Polls for the folder going away or coming back; see `watchPresence`. */
  private presence: ReturnType<typeof setInterval> | undefined;

  private constructor(
    readonly root: string,
    /** Which folder on disk the notebook is, so one put in its place is not taken for it. */
    private readonly identity: number | string,
  ) {}

  private remember(content: string): string {
    const revision = revisionOf(content);
    this.recent.delete(revision);
    this.recent.set(revision, content);
    if (this.recent.size > 40) this.recent.delete(this.recent.keys().next().value!);
    return revision;
  }

  /**
   * Opens the notebook in `directory`. Without `create`, a folder that is not there is an
   * error rather than a new, empty notebook: it may have been moved, deleted or unmounted.
   */
  static async open(directory: string, { create = true } = {}): Promise<Vault> {
    if (create) await mkdir(directory, { recursive: true });
    const root = await realpath(directory).catch((error) => {
      if (missing(error)) throw new FolderGone();
      throw error;
    });
    const info = await lstat(root);
    if (!info.isDirectory()) throw new FolderGone();
    const vault = new Vault(root, info.ino);
    await vault.scan(true);
    return vault;
  }

  /** Whether the notebook's folder is still where it was, and is still the same folder. */
  async present(): Promise<boolean> {
    const info = await lstat(this.root).catch(() => undefined);
    return Boolean(info?.isDirectory() && info.ino === this.identity);
  }
  /** Refuses to go on when the folder is gone, so nothing is written in its place. */
  private async ensure(): Promise<void> {
    if (!(await this.present())) throw new FolderGone();
  }
  /**
   * Tells `listener` when the folder goes away (false) and when it is back where it was
   * (true), as when it is put back from the Trash. A different folder made at the same path
   * is not the notebook, so it counts as still gone.
   */
  watchPresence(listener: (present: boolean) => void, every = 2000): void {
    clearInterval(this.presence);
    let last = true;
    const look = async () => {
      const now = await this.present();
      if (now === last) return;
      last = now;
      listener(now);
    };
    this.presence = setInterval(() => void look(), every);
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

  private async absolute(
    path: unknown,
    kind: 'file' | 'directory' | 'existing' | 'new',
  ): Promise<string> {
    if (typeof path !== 'string' || !path || path.length > 1000 || /[\\\u0000]/.test(path))
      throw new Error('Invalid path.');
    const parts = path.split('/');
    if (parts.some((part) => !part || part.startsWith('.'))) throw new Error('Invalid path.');
    await this.ensure();
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
      if (last && kind === 'existing' && !info.isFile() && !info.isDirectory())
        throw new Error('Invalid path.');
    }
    return current;
  }
  private note(path: unknown): asserts path is string {
    if (typeof path !== 'string' || !isNote(path)) throw new Error('Not a note.');
  }
  private async folder(path: unknown): Promise<string> {
    if (path === '') return this.root;
    return this.absolute(path, 'directory');
  }
  private async stamp(path: string, file: string): Promise<void> {
    const info = await lstat(file);
    this.stamps.set(path, stampOf(info));
  }

  /**
   * Brings the index in line with the disk. Returns the notes whose content changed.
   * `tidy` also removes temporary files a crash left half-written.
   */
  private async scan(tidy = false): Promise<{ changed: string[]; dirty: boolean }> {
    const seen = new Set<string>();
    const folders: string[] = [];
    const images: string[] = [];
    const changed: string[] = [];
    const walk = async (directory: string, relative: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) {
          if (tidy && entry.isFile() && entry.name.endsWith(PENDING))
            await unlink(join(directory, entry.name)).catch(() => {});
          continue;
        }
        const path = child(relative, entry.name);
        if (entry.isDirectory()) {
          folders.push(path);
          await walk(join(directory, entry.name), path);
        } else if (entry.isFile() && isNote(entry.name)) {
          const file = join(directory, entry.name);
          const info = await lstat(file).catch(() => undefined);
          if (!info) continue;
          seen.add(path);
          const stamp = stampOf(info);
          if (this.stamps.get(path) === stamp) continue;
          // An oversized file is still listed, but its text is neither indexed nor searched.
          const content = info.size > MAX_NOTE_LENGTH * 4 ? '' : await readFile(file, 'utf8');
          if (this.index.content(path) !== content) changed.push(path);
          this.index.set(path, content);
          this.stamps.set(path, stamp);
        } else if (entry.isFile() && isVaultImage(path)) images.push(path);
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
    const same = (a: string[], b: string[]) =>
      a.length === b.length && a.every((path, position) => path === b[position]);
    const nextFolders = sorted(folders);
    const nextImages = sorted(images);
    dirty ||= !same(nextFolders, this.folders) || !same(nextImages, this.images);
    this.folders = nextFolders;
    this.images = nextImages;
    for (const path of changed) this.unreported.add(path);
    this.stale ||= dirty;
    return { changed, dirty };
  }

  /** Watches for edits made by other programs. `notify` receives the affected notes. */
  watch(notify: (paths: string[]) => void): void {
    this.watcher = watch(this.root, (name) => {
      if (name.split('/').some((part) => part.startsWith('.'))) return;
      this.touched?.();
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        // Scans made by other operations may already have absorbed the change being reported.
        void this.serial(() => this.scan())
          .then(() => {
            if (!this.stale) return;
            const changed = [...this.unreported];
            this.unreported.clear();
            this.stale = false;
            notify(changed);
          })
          .catch(() => {});
      }, 150);
    });
  }
  close(): void {
    clearTimeout(this.timer);
    clearInterval(this.presence);
    this.watcher?.close();
  }

  tree(): VaultTree {
    return { notes: this.index.paths(), folders: [...this.folders], images: [...this.images] };
  }
  backlinks(path: string): Backlink[] {
    return this.index.backlinks(path);
  }
  search(query: string): SearchResult[] {
    return this.index.search(query);
  }
  graph(): NoteGraph {
    return this.index.graph();
  }

  /** When each note last changed on this device, in milliseconds. */
  modified(): Map<string, number> {
    return new Map([...this.stamps].map(([path, stamp]) => [path, Number(stamp.split(':')[0])]));
  }
  /** A note's text as last indexed, without reading the disk. */
  text(path: string): string | undefined {
    return this.index.content(path);
  }

  read(path: string): Promise<NoteDocument> {
    return this.serial(async () => {
      this.note(path);
      const file = await this.absolute(path, 'file');
      const content = await readFile(file, 'utf8');
      validateContent(content);
      this.index.set(path, content);
      await this.stamp(path, file);
      return { content, revision: this.remember(content) };
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
        // Changed underneath this edit, by sync or another program. Edits to different lines
        // are combined; only edits to the same lines need a second file.
        const base = this.recent.get(revision);
        const merged = base === undefined ? undefined : mergeText(base, content, actual);
        if (merged !== undefined && merged.length <= MAX_NOTE_LENGTH) {
          if (merged !== actual) await atomicWrite(file, merged);
          this.index.set(path, merged);
          await this.stamp(path, file);
          return { revision: this.remember(merged), merged };
        }
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
      return { revision: this.remember(content) };
    });
  }

  /** First free `name.md`, `name 1.md`, … in a folder. Call inside `serial`. */
  private async available(folder: string, name: string, extension = '.md'): Promise<string> {
    const taken = new Set(
      (await readdir(await this.folder(folder))).map((entry) => entry.toLowerCase()),
    );
    for (let count = 0; ; count++) {
      const candidate = `${count ? `${name} ${count}` : name}${extension}`;
      if (!taken.has(candidate.toLowerCase())) return child(folder, candidate);
    }
  }

  createNote(folder: string, name = 'Untitled'): Promise<string> {
    return this.serial(async () => {
      validateName(name);
      const path = await this.available(folder, name);
      const file = await this.absolute(path, 'new');
      await create(file);
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
      const directory = await this.absolute(path, 'new');
      if (await lstat(directory).catch(() => undefined))
        throw new Error(`“${name}” already exists here.`);
      await mkdir(directory);
      this.folders = sorted([...this.folders, path]);
      return path;
    });
  }

  /** Renames a note or folder in place. Links to it in other notes follow. */
  rename(path: string, name: string): Promise<MoveResult> {
    return this.serial(async () => {
      validateName(name);
      const directory = (await lstat(await this.absolute(path, 'existing'))).isDirectory();
      return this.relocate(path, child(noteFolder(path), directory ? name : `${name}.md`));
    });
  }

  /** Moves a note or folder into `folder`; `''` is the top level. */
  move(path: string, folder: string): Promise<MoveResult> {
    return this.serial(async () => {
      await this.folder(folder);
      return this.relocate(path, child(folder, path.slice(path.lastIndexOf('/') + 1)));
    });
  }

  /** Moves a note or folder and rewrites what pointed at it. Call inside `serial`. */
  private async relocate(path: string, next: string): Promise<MoveResult> {
    const from = await this.absolute(path, 'existing');
    const directory = (await lstat(from)).isDirectory();
    if (!directory) this.note(path);
    if (next === path) return { path, rewritten: [], missed: [] };
    if (directory && within(next, path)) throw new Error('A folder cannot be moved into itself.');
    const to = await this.absolute(next, 'new');
    // A change of letter case alone is the same file on a disk that ignores case; on one
    // that does not, something else may be sitting there.
    const occupant = await lstat(to).catch(() => undefined);
    if (occupant && occupant.ino !== (await lstat(from)).ino)
      throw new Error(`“${next.slice(next.lastIndexOf('/') + 1)}” already exists there.`);
    // The index has to match the disk before it decides which links to rewrite.
    await this.scan();
    const shift = (inside: string) => next + inside.slice(path.length);
    const notes = new Map<string, string>(
      directory
        ? this.index
            .paths()
            .filter((note) => within(note, path))
            .map((note) => [note, shift(note)])
        : [[path, next]],
    );
    const edits = this.index.relink(notes, new Map(directory ? [[path, next]] : []));
    await rename(from, to);
    this.relocated?.(path, next);
    // The move has happened. Nothing below may fail the operation, or the caller would
    // believe it had not.
    for (const [before, after] of notes) {
      this.index.move(before, after);
      this.stamps.delete(before);
      await this.stamp(after, join(this.root, ...after.split('/'))).catch(() => {});
    }
    if (directory) {
      this.folders = sorted(this.folders.map((item) => (within(item, path) ? shift(item) : item)));
      this.images = sorted(this.images.map((item) => (within(item, path) ? shift(item) : item)));
    }
    const rewritten: string[] = [];
    const missed: string[] = [];
    for (const [note, content] of edits) {
      try {
        const file = await this.absolute(note, 'file');
        // Only a file that still holds exactly the indexed text is rewritten. That leaves
        // alone a note changed a moment ago, and one that is not valid UTF-8, whose bytes
        // the index could not represent and a rewrite would damage.
        const indexed = this.index.content(note);
        if (indexed === undefined || !sameBytes(await readFile(file), bytesOf(indexed)))
          throw new Error('changed');
        await atomicWrite(file, content);
        this.index.set(note, content);
        await this.stamp(note, file);
        rewritten.push(note);
      } catch {
        missed.push(note);
      }
    }
    return { path: next, rewritten: sorted(rewritten), missed: sorted(missed) };
  }

  private async bin(): Promise<string> {
    const bin = join(this.root, '.trash');
    await mkdir(bin, { recursive: true });
    if ((await lstat(bin)).isSymbolicLink()) throw new Error('The trash folder is not usable.');
    return bin;
  }
  private async origins(bin: string): Promise<Origins> {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(bin, ORIGINS), 'utf8'));
      return Object.assign(
        Object.create(null) as Origins,
        parsed && typeof parsed === 'object' ? parsed : {},
      );
    } catch {
      return Object.create(null) as Origins;
    }
  }

  /** Hands everything in the trash to `discard`, which is expected to keep it recoverable. */
  emptyTrash(discard: (file: string) => Promise<void>): Promise<void> {
    return this.serial(async () => {
      const bin = await this.bin();
      for (const entry of await readdir(bin, { withFileTypes: true }))
        if (!entry.name.startsWith('.') && (entry.isFile() || entry.isDirectory()))
          await discard(join(bin, entry.name));
      await atomicWrite(join(bin, ORIGINS), '{}');
    });
  }

  /**
   * Moves a note, or a folder with everything in it, into the vault's `.trash` folder,
   * where it stays recoverable.
   */
  trash(path: string): Promise<void> {
    return this.serial(async () => {
      const directory = (await lstat(await this.absolute(path, 'existing'))).isDirectory();
      if (!directory) this.note(path);
      await this.discard(path);
    });
  }
  /** Moves any file or folder into the trash and records where it was. Call inside `serial`. */
  private async discard(path: string): Promise<void> {
    {
      const from = await this.absolute(path, 'existing');
      const directory = (await lstat(from)).isDirectory();
      const bin = await this.bin();
      const taken = new Set((await readdir(bin)).map((entry) => entry.toLowerCase()));
      const extension = directory ? '' : extname(path);
      const name = basename(path, extension);
      let target = name + extension;
      for (let count = 1; taken.has(target.toLowerCase()); count++)
        target = `${name} ${count}${extension}`;
      await rename(from, join(bin, target));
      const origins = await this.origins(bin);
      origins[target] = { from: path, at: Date.now() };
      await atomicWrite(join(bin, ORIGINS), JSON.stringify(origins));
      for (const note of this.index.paths())
        if (within(note, path)) {
          this.index.delete(note);
          this.stamps.delete(note);
        }
      if (directory) {
        this.folders = this.folders.filter((item) => !within(item, path));
        this.images = this.images.filter((item) => !within(item, path));
      }
    }
  }

  /** What is in the trash, newest first. */
  trashed(): Promise<TrashEntry[]> {
    return this.serial(async () => {
      const bin = await this.bin();
      const origins = await this.origins(bin);
      const entries: TrashEntry[] = [];
      for (const entry of await readdir(bin, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isFile())) continue;
        const origin = origins[entry.name];
        const from = typeof origin?.from === 'string' ? origin.from : undefined;
        entries.push({
          name: entry.name,
          ...(from ? { from } : {}),
          folder: entry.isDirectory(),
          at:
            typeof origin?.at === 'number'
              ? origin.at
              : (await lstat(join(bin, entry.name))).mtimeMs,
        });
      }
      return entries.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
    });
  }

  /** Puts a trashed item back where it was, under a free name if that one is now taken. */
  restore(name: string): Promise<string> {
    return this.serial(async () => {
      if (typeof name !== 'string' || !name || name.startsWith('.') || /[/\\\u0000]/.test(name))
        throw new Error('Invalid path.');
      const bin = await this.bin();
      const source = join(bin, name);
      const info = await lstat(source).catch(() => undefined);
      if (!info || (!info.isFile() && !info.isDirectory()))
        throw new Error(`“${name}” is no longer in the trash.`);
      const origins = await this.origins(bin);
      const recorded = origins[name]?.from;
      const from =
        typeof recorded === 'string' &&
        !recorded.split('/').some((part) => !part || part[0] === '.')
          ? recorded
          : name;
      // Recreate the folder it lived in; if that is not possible, it comes back at the top.
      let folder = '';
      for (const part of noteFolder(from).split('/').filter(Boolean)) {
        const next = child(folder, part);
        const directory = await this.absolute(next, 'new').catch(() => undefined);
        if (!directory) break;
        const existing = await lstat(directory).catch(() => undefined);
        if (existing && !existing.isDirectory()) break;
        if (!existing) await mkdir(directory);
        folder = next;
      }
      const extension = info.isDirectory() ? '' : extname(from);
      const path = await this.available(
        folder,
        basename(from.slice(from.lastIndexOf('/') + 1), extension),
        extension,
      );
      await rename(source, await this.absolute(path, 'new'));
      delete origins[name];
      await atomicWrite(join(bin, ORIGINS), JSON.stringify(origins));
      await this.scan();
      return path;
    });
  }

  /** Stores image bytes under `attachments/` and returns the vault-relative path. */
  saveImage(bytes: Uint8Array, name = 'Pasted image'): Promise<string> {
    if (bytes.byteLength > MAX_VAULT_IMAGE_BYTES)
      throw new Error('Choose an image smaller than 25 MB.');
    const type = detectImage(bytes);
    if (!type) throw new Error('Supported images: PNG, JPEG, GIF, and WebP.');
    return this.serial(async () => {
      await mkdir(join(this.root, 'attachments'), { recursive: true });
      const path = await this.available('attachments', name, `.${type === 'jpeg' ? 'jpg' : type}`);
      await atomicWrite(await this.absolute(path, 'new'), bytes);
      this.images = sorted([...this.images, path]);
      return path;
    });
  }

  /** Stores any file under `attachments/`, keeping its name where it is usable. */
  saveFile(bytes: Uint8Array, name: string): Promise<string> {
    if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('Choose a file smaller than 100 MB.');
    const extension = /^\.[A-Za-z0-9]{1,12}$/.test(extname(name)) ? extname(name) : '';
    let stem = basename(name, extension).replace(/^\.+/, '').trim();
    try {
      validateName(stem);
    } catch {
      stem = 'File';
    }
    return this.serial(async () => {
      await mkdir(join(this.root, 'attachments'), { recursive: true });
      const path = await this.available('attachments', stem, extension);
      await atomicWrite(await this.absolute(path, 'new'), bytes);
      await this.scan();
      return path;
    });
  }

  async importImage(source: string): Promise<string> {
    const info = await lstat(source);
    if (!info.isFile() || info.size > MAX_VAULT_IMAGE_BYTES)
      throw new Error('Choose an image smaller than 25 MB.');
    let name = basename(source, extname(source));
    try {
      validateName(name);
    } catch {
      name = 'Image';
    }
    return this.saveImage(await readFile(source), name);
  }

  /** Absolute path of a raster image inside the vault, for the image protocol. */
  async image(path: string): Promise<string> {
    if (!isVaultImage(path)) throw new Error('Not an image.');
    const file = await this.absolute(path, 'file');
    if ((await lstat(file)).size > MAX_VAULT_IMAGE_BYTES) throw new Error('Image is too large.');
    return file;
  }

  file(path: string): Promise<string> {
    return this.absolute(path, 'existing');
  }

  /** Called whenever any visible file in the notebook changes, including by this app. */
  onActivity(listener: (() => void) | undefined): void {
    this.touched = listener;
  }
  /** Called with each move the app makes, so sync can send it as a move. */
  onRelocate(listener: ((from: string, to: string) => void) | undefined): void {
    this.relocated = listener;
  }

  /** Creates the folders above `path` and returns its absolute location. Call inside `serial`. */
  private async reach(path: string, respell = false): Promise<string> {
    let folder = '';
    for (const part of noteFolder(path).split('/').filter(Boolean)) {
      folder = child(folder, part);
      const directory = await this.absolute(folder, 'new');
      if (!(await lstat(directory).catch(() => undefined))) await mkdir(directory);
      else if (respell) {
        // The folder may exist under different letter case. Sync means the case asked for,
        // and a disk that ignores case would otherwise quietly keep the old one.
        const actual = (await readdir(join(directory, '..'))).find(
          (entry) => entry !== part && entry.toLowerCase() === part.toLowerCase(),
        );
        if (actual && !(await readdir(join(directory, '..'))).includes(part))
          await rename(join(directory, '..', actual), directory);
      }
    }
    return this.absolute(path, 'new');
  }
  /** Removes folders a moved or trashed file left empty. Call inside `serial`. */
  private async prune(path: string): Promise<void> {
    for (let folder = noteFolder(path); folder; folder = noteFolder(folder)) {
      const directory = await this.absolute(folder, 'directory').catch(() => undefined);
      if (!directory || (await readdir(directory)).some((entry) => entry !== '.DS_Store')) return;
      await rm(join(directory, '.DS_Store'), { force: true });
      const removed = await rmdir(directory).then(
        () => true,
        () => false,
      );
      if (!removed) return;
    }
  }

  async syncState(): Promise<SyncState | undefined> {
    try {
      const state = JSON.parse(
        await readFile(join(this.root, SYNC, 'sync.json'), 'utf8'),
      ) as SyncState;
      return state?.version === 1 && typeof state.files === 'object' ? state : undefined;
    } catch {
      return undefined;
    }
  }
  /** Forgets the host. Every file stays exactly as it is. */
  async forgetSync(): Promise<void> {
    await rm(join(this.root, SYNC, 'sync.json'), { force: true });
  }

  /** The notebook as sync sees it: every visible file, changed only by conditional writes. */
  syncStore(): SyncStore {
    const current = async (file: string): Promise<string | null> =>
      readFile(file).then(digest, (error) => {
        if (missing(error)) return null;
        throw error;
      });
    return {
      hash: digest,
      list: () =>
        this.serial(async () => {
          await this.ensure();
          const files: LocalFile[] = [];
          const seen = new Set<string>();
          const walk = async (directory: string, relative: string): Promise<void> => {
            for (const entry of await readdir(directory, { withFileTypes: true })) {
              if (entry.name.startsWith('.')) continue;
              const path = child(relative, entry.name);
              if (entry.isDirectory()) await walk(join(directory, entry.name), path);
              else if (entry.isFile()) {
                const file = join(directory, entry.name);
                const info = await lstat(file).catch(() => undefined);
                if (!info) continue;
                if (info.size > MAX_FILE_BYTES) {
                  // Listed, so it is not mistaken for a deletion, but never transferred.
                  files.push({ path, hash: '', size: info.size, skip: true });
                  seen.add(path);
                  continue;
                }
                const stamp = stampOf(info);
                let known = this.hashes.get(path);
                if (known?.stamp !== stamp) {
                  const hash = await current(file);
                  if (hash === null) continue;
                  known = { stamp, hash };
                  this.hashes.set(path, known);
                }
                seen.add(path);
                files.push({ path, hash: known.hash, size: info.size });
              }
            }
          };
          await walk(this.root, '');
          for (const path of this.hashes.keys()) if (!seen.has(path)) this.hashes.delete(path);
          return files;
        }),
      read: (path) =>
        this.serial(async () => new Uint8Array(await readFile(await this.absolute(path, 'file')))),
      write: (path, bytes, expected) =>
        this.serial(async () => {
          const file = await this.reach(path);
          if ((await current(file)) !== expected) return false;
          await atomicWrite(file, bytes);
          return true;
        }),
      move: (from, to) =>
        this.serial(async () => {
          const source = await this.absolute(from, 'file').catch(() => undefined);
          if (!source) return false;
          // Only a move that changes nothing but letter case may respell existing folders;
          // anything else settles into the folders as they are already spelled here.
          const target = await this.reach(to, from.toLowerCase() === to.toLowerCase());
          const existing = await lstat(target).catch(() => undefined);
          // A change of letter case alone is the same file on a disk that ignores case; on
          // one that does not, a different file may be sitting there.
          if (existing && existing.ino !== (await lstat(source)).ino) return false;
          await rename(source, target);
          await this.prune(from);
          return true;
        }),
      trash: (path, expected) =>
        this.serial(async () => {
          const file = await this.absolute(path, 'file').catch(() => undefined);
          if (!file) return true;
          if ((await current(file)) !== expected) return false;
          await this.discard(path);
          await this.prune(path);
          return true;
        }),
      save: (state) =>
        this.serial(async () => {
          // Never `recursive`: that would make the notebook's folder again if it had gone,
          // holding nothing but a record of every file, which the next sync would take for
          // every note deleted.
          await this.ensure();
          const folder = join(this.root, SYNC);
          await mkdir(folder).catch((error) => {
            if ((error as { code?: string }).code !== 'EEXIST') throw error;
          });
          if ((await lstat(folder)).isSymbolicLink())
            throw new Error('The sync folder is not usable.');
          await atomicWrite(join(folder, 'sync.json'), JSON.stringify(state));
        }),
    };
  }
}
