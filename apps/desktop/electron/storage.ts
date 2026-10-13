import { open, rename, lstat } from 'node:fs/promises';
import { join } from 'node:path';

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

export function detectImage(bytes: Uint8Array): string | undefined {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'jpeg';
  if (['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString())) return 'gif';
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP')
    return 'webp';
  return undefined;
}
