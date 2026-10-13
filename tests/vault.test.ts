import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectImage } from '../apps/desktop/electron/storage';
import { Vault } from '../apps/desktop/electron/vault';

const directories: string[] = [];
async function folder() {
  const directory = await mkdtemp(join(tmpdir(), 'opsidian-test-'));
  directories.push(directory);
  return directory;
}
const vaults: Vault[] = [];
async function open(directory?: string) {
  const vault = await Vault.open(directory ?? (await folder()));
  vaults.push(vault);
  return vault;
}
afterEach(async () => {
  for (const vault of vaults.splice(0)) vault.close();
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('vault notes', () => {
  it('lists Markdown notes and folders, skipping hidden entries and other files', async () => {
    const directory = await folder();
    await mkdir(join(directory, 'Travel'));
    await mkdir(join(directory, '.obsidian'));
    await writeFile(join(directory, 'Travel', 'Japan.md'), 'Ramen');
    await writeFile(join(directory, '.obsidian', 'Hidden.md'), 'x');
    await writeFile(join(directory, 'picture.png'), 'x');
    const vault = await open(directory);
    expect(vault.tree()).toEqual({ notes: ['Travel/Japan.md'], folders: ['Travel'] });
  });
  it('creates notes with free names and keeps them as plain files', async () => {
    const vault = await open();
    expect(await vault.createNote('')).toBe('Untitled.md');
    expect(await vault.createNote('')).toBe('Untitled 1.md');
    expect(await vault.createFolder('', 'Travel')).toBe('Travel');
    expect(await vault.createNote('Travel', 'Japan')).toBe('Travel/Japan.md');
    const { revision } = await vault.read('Travel/Japan.md');
    await vault.save('Travel/Japan.md', 'Ramen', revision);
    expect(await readFile(join(vault.root, 'Travel', 'Japan.md'), 'utf8')).toBe('Ramen');
  });
  it('persists across a restart, including empty content', async () => {
    const first = await open();
    const path = await first.createNote('', 'Note');
    let { revision } = await first.read(path);
    const saved = await first.save(path, 'hello', revision);
    revision = 'revision' in saved ? saved.revision : '';
    await first.save(path, '', revision);
    expect((await (await open(first.root)).read(path)).content).toBe('');
  });
  it('serializes concurrent saves', async () => {
    const vault = await open();
    const path = await vault.createNote('', 'Note');
    const { revision } = await vault.read(path);
    const [one, two] = await Promise.all([
      vault.save(path, 'one', revision),
      vault.save(path, 'two', revision),
    ]);
    // The second save started from text the first had already replaced.
    expect(one).toHaveProperty('revision');
    expect(two).toHaveProperty('conflict');
    expect(await readFile(join(vault.root, path), 'utf8')).toBe('one');
  });
  it('keeps an external change and saves the conflicting edit beside it', async () => {
    const vault = await open();
    const path = await vault.createNote('', 'Note');
    const { revision } = await vault.read(path);
    await writeFile(join(vault.root, path), 'external');
    const result = await vault.save(path, 'my pending edit', revision);
    expect(await readFile(join(vault.root, path), 'utf8')).toBe('external');
    if (!('conflict' in result)) throw new Error('expected a conflict');
    expect(result.conflict).toMatch(/^Note \(conflicted copy .+\)\.md$/);
    expect(await readFile(join(vault.root, result.conflict), 'utf8')).toBe('my pending edit');
    expect(vault.tree().notes).toContain(result.conflict);
  });
  it('puts a note back when it was deleted while being edited', async () => {
    const vault = await open();
    const path = await vault.createNote('', 'Note');
    const { revision } = await vault.read(path);
    await rm(join(vault.root, path));
    expect(await vault.save(path, 'still here', revision)).toHaveProperty('revision');
    expect(await readFile(join(vault.root, path), 'utf8')).toBe('still here');
  });
  it('renames without overwriting, and tracks links to the new name', async () => {
    const vault = await open();
    const a = await vault.createNote('', 'Alpha');
    const b = await vault.createNote('', 'Beta');
    await vault.save(b, 'See [[Gamma]].', (await vault.read(b)).revision);
    await expect(vault.rename(a, 'Beta')).rejects.toThrow('already exists');
    expect(await vault.rename(a, 'Gamma')).toBe('Gamma.md');
    expect(await vault.rename('Gamma.md', 'gamma')).toBe('gamma.md');
    expect(vault.backlinks('gamma.md').map((link) => link.path)).toEqual(['Beta.md']);
    expect(vault.tree().notes).toEqual(['Beta.md', 'gamma.md']);
  });
  it('moves trashed notes into .trash without losing an earlier one', async () => {
    const vault = await open();
    for (const text of ['first', 'second']) {
      const path = await vault.createNote('', 'Note');
      await vault.save(path, text, (await vault.read(path)).revision);
      await vault.trash(path);
    }
    expect(vault.tree().notes).toEqual([]);
    expect((await readdir(join(vault.root, '.trash'))).sort()).toEqual(['Note 1.md', 'Note.md']);
    expect(await readFile(join(vault.root, '.trash', 'Note.md'), 'utf8')).toBe('first');
  });
  it('refuses paths that leave the vault or pass through a symlink', async () => {
    const outside = await folder();
    await writeFile(join(outside, 'Secret.md'), 'secret');
    const vault = await open();
    await symlink(outside, join(vault.root, 'Linked'));
    await symlink(join(outside, 'Secret.md'), join(vault.root, 'Alias.md'));
    expect(vault.tree()).toEqual({ notes: [], folders: [] });
    for (const path of ['../Secret.md', 'Linked/Secret.md', 'Alias.md', '.trash/x.md', '/etc/x.md'])
      await expect(vault.read(path), path).rejects.toThrow();
    await expect(vault.save('Linked/New.md', 'x', '')).rejects.toThrow();
    await expect(vault.createNote('Linked', 'New')).rejects.toThrow();
    await expect(vault.image('Linked/a.png')).rejects.toThrow();
    expect(await readdir(outside)).toEqual(['Secret.md']);
  });
  it('notices notes edited, added and removed by other programs', async () => {
    const vault = await open();
    const path = await vault.createNote('', 'Note');
    const seen: string[][] = [];
    vault.watch((paths) => seen.push(paths));
    await vault.save(path, 'mine', (await vault.read(path)).revision);
    await pause(400);
    // The vault's own writes are not reported back.
    expect(seen).toEqual([]);
    await writeFile(join(vault.root, path), 'theirs');
    await writeFile(join(vault.root, 'Added.md'), 'See [[Note]].');
    await pause(600);
    expect(seen.flat().sort()).toEqual(['Added.md', 'Note.md']);
    expect(vault.backlinks('Note.md').map((link) => link.path)).toEqual(['Added.md']);
    await rm(join(vault.root, 'Added.md'));
    await pause(600);
    expect(vault.tree().notes).toEqual(['Note.md']);
  });
  it('rejects active SVG content disguised as an image', () => {
    expect(detectImage(Buffer.from('<svg onload="alert(1)"></svg>'))).toBeUndefined();
  });
});
