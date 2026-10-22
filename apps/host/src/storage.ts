import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
} from 'node:fs/promises';
import { watch } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, sep } from 'node:path';
import { PENDING, usePlatform, type Platform } from '@opsidian/notebook';

export { PENDING, detectImage } from '@opsidian/notebook';

/**
 * Replaces a file in one step, so a crash leaves either the old content or the new.
 * The temporary file is hidden: other programs, the watcher and the note list skip it.
 */
export async function atomicWrite(path: string, content: string | Uint8Array): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}${PENDING}`);
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
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Node’s file system, as notebooks use it: the Mac app’s, and the host’s copy for GitHub. */
export const nodePlatform: Platform = {
  lstat,
  mkdir,
  readFile: (path) => readFile(path),
  readdir: (path) => readdir(path, { withFileTypes: true }),
  realpath,
  rename,
  rm,
  rmdir,
  create: async (path) => (await open(path, 'wx', 0o600)).close(),
  atomicWrite,
  watch(root, listener) {
    const watcher = watch(root, { recursive: true }, (_event, filename) =>
      listener((filename?.toString() ?? '').split(sep).join('/')),
    );
    watcher.on('error', () => {});
    return watcher;
  },
  sha256: (content) => createHash('sha256').update(content).digest('hex'),
};
usePlatform(nodePlatform);
