import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { basename, detectImage, extname, join, sameBytes } from '../packages/notebook/src/index';
import { Vault } from '../apps/desktop/electron/vault';

const directories: string[] = [];
const vaults: Vault[] = [];
async function open() {
  const directory = await mkdtemp(nodePath.join(tmpdir(), 'opsidian-notebook-'));
  directories.push(directory);
  const vault = await Vault.open(directory);
  vaults.push(vault);
  return vault;
}
afterEach(async () => {
  for (const vault of vaults.splice(0)) vault.close();
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

describe('path helpers shared by every device', () => {
  const paths = [
    '/a/b/c.md',
    '/a/b/',
    '/a/.hidden',
    '/a/b.c.md',
    'note.md',
    '/a/b/no extension',
    '/a/b/.x.y',
  ];
  it('agree with the Mac’s own', () => {
    for (const path of paths) {
      expect(basename(path), path).toBe(nodePath.basename(path));
      expect(extname(path), path).toBe(nodePath.extname(path));
      expect(basename(path, extname(path)), path).toBe(
        nodePath.basename(path, nodePath.extname(path)),
      );
    }
    expect(basename('Drafts', '')).toBe('Drafts');
    expect(join('/a', 'b', 'c.md')).toBe(nodePath.join('/a', 'b', 'c.md'));
    expect(join('/a/b', '..')).toBe(nodePath.join('/a/b', '..'));
    expect(join('/a/b', '..', 'B')).toBe(nodePath.join('/a/b', '..', 'B'));
    expect(join('/a', '.trash')).toBe('/a/.trash');
  });
  it('compare bytes and recognise images without Node', () => {
    expect(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(sameBytes(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
    expect(detectImage(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]))).toBe('png');
    expect(detectImage(new Uint8Array([255, 216, 255, 224]))).toBe('jpeg');
    expect(detectImage(new TextEncoder().encode('GIF89a..'))).toBe('gif');
    expect(detectImage(new TextEncoder().encode('RIFFxxxxWEBPVP8 '))).toBe('webp');
    expect(detectImage(new TextEncoder().encode('<svg/>'))).toBeUndefined();
  });
});

describe('what the iPhone app asks of a notebook', () => {
  it('stores any attached file under attachments, keeping a usable name', async () => {
    const vault = await open();
    const bytes = new TextEncoder().encode('%PDF-1.7');
    expect(await vault.saveFile(bytes, 'Boarding pass.pdf')).toBe('attachments/Boarding pass.pdf');
    expect(await vault.saveFile(bytes, 'Boarding pass.pdf')).toBe(
      'attachments/Boarding pass 1.pdf',
    );
    expect(await vault.saveFile(bytes, '../../.ssh/config')).toBe('attachments/config');
    expect(await vault.saveFile(bytes, '.hidden.txt')).toBe('attachments/hidden.txt');
    expect(
      new TextDecoder().decode(
        await readFile(nodePath.join(vault.root, 'attachments/Boarding pass.pdf')),
      ),
    ).toBe('%PDF-1.7');
  });
  it('knows when each note changed and what it says without reading the disk', async () => {
    const vault = await open();
    const first = await vault.createNote('', 'First');
    await vault.save(first, 'one', (await vault.read(first)).revision);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = await vault.createNote('', 'Second');
    await vault.save(second, 'two', (await vault.read(second)).revision);
    const times = vault.modified();
    expect(times.get(second)!).toBeGreaterThan(times.get(first)!);
    expect(vault.text(first)).toBe('one');
    expect(vault.text('Missing.md')).toBeUndefined();
  });
});
