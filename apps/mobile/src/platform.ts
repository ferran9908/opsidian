import { Directory, File, Paths } from 'expo-file-system';
import { sha256 } from '@noble/hashes/sha2.js';
import { PENDING, type Dirent, type Platform, type Stats } from '@opsidian/notebook';

const failure = (code: string, path: string) =>
  Object.assign(new Error(`${code}: ${path}`), { code, path });
const uri = (path: string) => `file://${path.split('/').map(encodeURIComponent).join('/')}`;
/** A notebook path from a `file://` address. */
export const pathOf = (address: string) =>
  decodeURIComponent(address.replace(/^file:\/\//, '')).replace(/\/+$/, '');
const parent = (path: string) => path.slice(0, path.lastIndexOf('/'));
const name = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const kind = (path: string): 'file' | 'directory' | undefined => {
  const info = Paths.info(uri(path));
  return info.exists ? (info.isDirectory ? 'directory' : 'file') : undefined;
};
const hex = (bytes: Uint8Array) => {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
};
const encoder = new TextEncoder();

/** A write that finished but had not yet replaced its file. */
const READY = PENDING;
/** A write still in progress; never trusted after a crash. */
const PARTIAL = `.partial${PENDING}`;

// The phone's disk tells letter case apart; the simulator's, like a Mac's, does not.
let foldsCase: boolean | undefined;
function ignoresCase(): boolean {
  if (foldsCase === undefined) {
    const probe = new File(Paths.cache, 'Opsidian-Case-Probe');
    try {
      probe.create({ overwrite: true });
      foldsCase = new File(Paths.cache, 'opsidian-case-probe').exists;
      probe.delete();
    } catch {
      foldsCase = false;
    }
  }
  return foldsCase;
}

const watchers = new Set<{ root: string; listener: (name: string) => void }>();
/**
 * iOS reports file times to the second, too coarse to notice two saves in a row. Only this
 * app writes here, so each change it makes is counted instead.
 */
const generations = new Map<string, number>();
function changed(...paths: string[]) {
  for (const path of paths) {
    generations.set(path, (generations.get(path) ?? 0) + 1);
    for (const watcher of watchers)
      if (path.startsWith(`${watcher.root}/`)) {
        const relative = path.slice(watcher.root.length + 1);
        setTimeout(() => watcher.listener(relative), 0);
      }
  }
}

function move(from: string, to: string) {
  const type = kind(from);
  if (!type) throw failure('ENOENT', from);
  const sameName = from !== to && from.toLowerCase() === to.toLowerCase() && ignoresCase();
  const step = (a: string, b: string) =>
    type === 'directory'
      ? new Directory(uri(a)).moveSync(new Directory(uri(b)))
      : new File(uri(a)).moveSync(new File(uri(b)));
  if (sameName) {
    // A change of letter case alone needs a detour where the disk ignores case.
    const detour = `${parent(from)}/.${name(from)}.${Date.now()}.respell`;
    step(from, detour);
    step(detour, to);
    return;
  }
  // Nothing is ever moved onto something else: on this disk that would destroy it.
  if (kind(to)) throw failure('EEXIST', to);
  step(from, to);
}

/** The iPhone's file system, as notebooks use it. */
export const phonePlatform: Platform = {
  async lstat(path): Promise<Stats> {
    const type = kind(path);
    if (!type) throw failure('ENOENT', path);
    const file = type === 'file' ? new File(uri(path)) : undefined;
    return {
      isDirectory: () => type === 'directory',
      isFile: () => type === 'file',
      isSymbolicLink: () => false,
      mtimeMs: (file?.modificationTime ?? 0) + (generations.get(path) ?? 0) / 1000,
      size: file?.size ?? 0,
      ino: ignoresCase() ? path.normalize('NFC').toLowerCase() : path,
    };
  },
  async mkdir(path, options) {
    if (kind(path) === 'directory' && options?.recursive) return;
    if (kind(path)) throw failure('EEXIST', path);
    new Directory(uri(path)).create({ intermediates: Boolean(options?.recursive) });
    changed(path);
  },
  async readFile(path) {
    if (kind(path) !== 'file') throw failure('ENOENT', path);
    return new File(uri(path)).bytes();
  },
  async readdir(path) {
    if (kind(path) !== 'directory') throw failure('ENOENT', path);
    return new Directory(uri(path)).list().map((entry): Dirent => {
      const directory = entry instanceof Directory;
      return { name: entry.name, isDirectory: () => directory, isFile: () => !directory };
    });
  },
  realpath: async (path) => path,
  async rename(from, to) {
    move(from, to);
    changed(from, to);
  },
  async rm(path, options) {
    const type = kind(path);
    if (!type) {
      if (options?.force) return;
      throw failure('ENOENT', path);
    }
    if (type === 'directory') throw failure('EISDIR', path);
    new File(uri(path)).delete();
    changed(path);
  },
  async rmdir(path) {
    if (kind(path) !== 'directory') throw failure('ENOENT', path);
    const directory = new Directory(uri(path));
    if (directory.list().length) throw failure('ENOTEMPTY', path);
    directory.delete();
    changed(path);
  },
  async create(path) {
    if (kind(path)) throw failure('EEXIST', path);
    new File(uri(path)).create();
    changed(path);
  },
  async atomicWrite(path, content) {
    // iOS offers no single step that replaces a file, so the new content is first written
    // out in full beside it and marked ready. A crash after that point is finished by
    // `recover` the next time the app starts; a crash before it leaves the old file.
    if (kind(path) === 'directory') throw failure('EISDIR', path);
    const partial = `${parent(path)}/.${name(path)}${PARTIAL}`;
    const ready = `${parent(path)}/.${name(path)}${READY}`;
    for (const stale of [partial, ready]) if (kind(stale)) new File(uri(stale)).delete();
    const file = new File(uri(partial));
    file.create();
    file.write(typeof content === 'string' ? encoder.encode(content) : content);
    file.moveSync(new File(uri(ready)));
    if (kind(path) === 'file') new File(uri(path)).delete();
    new File(uri(ready)).moveSync(new File(uri(path)));
    changed(path);
  },
  watch(root, listener) {
    const watcher = { root, listener };
    watchers.add(watcher);
    return { close: () => watchers.delete(watcher) };
  },
  sha256: (content) => hex(sha256(typeof content === 'string' ? encoder.encode(content) : content)),
};

/** Finishes or discards writes that a crash interrupted. Run before opening the notebook. */
export function recover(root: string): void {
  const walk = (directory: Directory) => {
    for (const entry of directory.list()) {
      // One leftover that cannot be finished must not keep the notebook from opening.
      try {
        if (entry instanceof Directory) walk(entry);
        else if (entry.name.endsWith(PARTIAL)) entry.delete();
        else if (entry.name.startsWith('.') && entry.name.endsWith(READY)) {
          const target = new File(directory, entry.name.slice(1, -READY.length));
          if (Paths.info(target.uri).isDirectory) entry.delete();
          else {
            if (target.exists) target.delete();
            entry.moveSync(target);
          }
        }
      } catch {
        // Left where it is; the notebook's own tidy-up removes it.
      }
    }
  };
  if (kind(root) === 'directory') walk(new Directory(uri(root)));
}

/** Removes a file or folder permanently. Only the trash is ever emptied this way. */
export function deleteForGood(path: string): void {
  const type = kind(path);
  if (type === 'directory') new Directory(uri(path)).delete();
  else if (type === 'file') new File(uri(path)).delete();
}
/** The `file://` address of a notebook path, for reading it with the device's own tools. */
export const addressOf = uri;
