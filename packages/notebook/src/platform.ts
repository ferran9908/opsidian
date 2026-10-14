/**
 * What a notebook needs from the device it lives on. The Mac supplies Node's file system;
 * the iPhone supplies its own. Paths are absolute and use `/`.
 */
export interface Stats {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  mtimeMs: number;
  size: number;
  /** The same for two paths only when they are the same file. */
  ino: number | string;
}
export interface Dirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}
export interface Platform {
  /** Rejects with `code: 'ENOENT'` when nothing is there, like every call below. */
  lstat(path: string): Promise<Stats>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  readFile(path: string): Promise<Uint8Array>;
  readdir(path: string): Promise<Dirent[]>;
  realpath(path: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  /** Removes a file. With `force`, a missing file is not an error. */
  rm(path: string, options?: { force?: boolean }): Promise<void>;
  /** Removes a folder only if it is empty. */
  rmdir(path: string): Promise<void>;
  /** Creates an empty file, failing if one is already there. */
  create(path: string): Promise<void>;
  /** Replaces a file in one step, so a crash leaves either the old content or the new. */
  atomicWrite(path: string, content: string | Uint8Array): Promise<void>;
  /** Reports the notebook-relative name of anything that changes under `root`. */
  watch(root: string, listener: (name: string) => void): { close(): void };
  sha256(content: string | Uint8Array): string;
}

let platform: Platform | undefined;
/** Chooses the device's file system. Called once, before any notebook is opened. */
export function usePlatform(next: Platform): void {
  platform = next;
}
const current = (): Platform => {
  if (!platform) throw new Error('No platform has been chosen for notebooks.');
  return platform;
};

// Node keeps a leading byte-order mark when it reads text, and so must this.
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const encoder = new TextEncoder();

export const lstat = (path: string) => current().lstat(path);
export const mkdir = (path: string, options?: { recursive?: boolean }) =>
  current().mkdir(path, options);
export function readFile(path: string): Promise<Uint8Array>;
export function readFile(path: string, encoding: 'utf8'): Promise<string>;
export function readFile(path: string, encoding?: 'utf8'): Promise<Uint8Array | string> {
  const bytes = current().readFile(path);
  return encoding ? bytes.then((value) => decoder.decode(value)) : bytes;
}
export function readdir(path: string): Promise<string[]>;
export function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
export function readdir(
  path: string,
  options?: { withFileTypes: true },
): Promise<string[] | Dirent[]> {
  const entries = current().readdir(path);
  return options ? entries : entries.then((list) => list.map((entry) => entry.name));
}
export const realpath = (path: string) => current().realpath(path);
export const rename = (from: string, to: string) => current().rename(from, to);
export const rm = (path: string, options?: { force?: boolean }) => current().rm(path, options);
export const rmdir = (path: string) => current().rmdir(path);
export const unlink = (path: string) => current().rm(path);
export const create = (path: string) => current().create(path);
export const atomicWrite = (path: string, content: string | Uint8Array) =>
  current().atomicWrite(path, content);
export const watch = (root: string, listener: (name: string) => void) =>
  current().watch(root, listener);
export const sha256 = (content: string | Uint8Array) => current().sha256(content);
export const bytesOf = (text: string) => encoder.encode(text);
export const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.byteLength === b.byteLength && a.every((byte, position) => byte === b[position]);

export const join = (...parts: string[]) => {
  const out: string[] = [];
  for (const part of parts.join('/').split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return (parts[0]?.startsWith('/') ? '/' : '') + out.join('/');
};
export const basename = (path: string, extension = '') => {
  const name = path.slice(path.replace(/\/+$/, '').lastIndexOf('/') + 1).replace(/\/+$/, '');
  return extension && name.endsWith(extension) && name !== extension
    ? name.slice(0, -extension.length)
    : name;
};
export const extname = (path: string) => {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
};

/** Ending of hidden temporary files; distinctive enough to delete after a crash. */
export const PENDING = '.opsidian-pending';

export function detectImage(bytes: Uint8Array): string | undefined {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, position) => bytes[position] === value))
    return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  return undefined;
}
