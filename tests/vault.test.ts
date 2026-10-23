import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
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
async function write(vault: Vault, path: string, content: string) {
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const created = await vault.createNote(folder, path.slice(folder ? folder.length + 1 : 0, -3));
  expect(created).toBe(path);
  await vault.save(path, content, (await vault.read(path)).revision);
}
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
    expect(vault.tree()).toEqual({
      notes: ['Travel/Japan.md'],
      folders: ['Travel'],
      images: ['picture.png'],
    });
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
    expect((await vault.rename(a, 'Gamma')).path).toBe('Gamma.md');
    expect((await vault.rename('Gamma.md', 'gamma')).path).toBe('gamma.md');
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
    expect((await readdir(join(vault.root, '.trash'))).sort()).toEqual([
      '.opsidian-origins.json',
      'Note 1.md',
      'Note.md',
    ]);
    expect(await readFile(join(vault.root, '.trash', 'Note.md'), 'utf8')).toBe('first');
  });
  it('rewrites links when a note is renamed, keeping headings and aliases', async () => {
    const vault = await open();
    await write(vault, 'Japan.md', 'Self [[Japan#Food]].');
    await write(
      vault,
      'Plans.md',
      'Go to [[Japan]], [[japan#Food|eat]] and ![[Japan]].\n`[[Japan]]`\n```\n[[Japan]]\n```\n[[Other]]',
    );
    await write(vault, 'Quiet.md', 'No links here.');
    const result = await vault.rename('Japan.md', 'Nippon');
    expect(result).toEqual({
      path: 'Nippon.md',
      rewritten: ['Nippon.md', 'Plans.md'],
      missed: [],
    });
    expect(await readFile(join(vault.root, 'Plans.md'), 'utf8')).toBe(
      'Go to [[Nippon]], [[Nippon#Food|eat]] and ![[Nippon]].\n`[[Japan]]`\n```\n[[Japan]]\n```\n[[Other]]',
    );
    expect(await readFile(join(vault.root, 'Nippon.md'), 'utf8')).toBe('Self [[Nippon#Food]].');
    expect(vault.backlinks('Nippon.md').map((link) => link.path)).toEqual(['Plans.md']);
    // A rewritten note is a normal save: the next edit starts from its new revision.
    const { revision, content } = await vault.read('Plans.md');
    expect(await vault.save('Plans.md', `${content}!`, revision)).toHaveProperty('revision');
  });
  it('rewrites links from the file as another program last left it', async () => {
    const vault = await open();
    await write(vault, 'Japan.md', '');
    await write(vault, 'Plans.md', '[[Japan]]');
    await writeFile(join(vault.root, 'Plans.md'), 'Edited elsewhere: [[Japan]]');
    await vault.rename('Japan.md', 'Nippon');
    expect(await readFile(join(vault.root, 'Plans.md'), 'utf8')).toBe(
      'Edited elsewhere: [[Nippon]]',
    );
  });
  it('completes a rename even when a linking note cannot be rewritten', async () => {
    const vault = await open();
    await write(vault, 'Old.md', '');
    await write(vault, 'Fine.md', '[[Old]]');
    await vault.createFolder('', 'Locked');
    await write(vault, 'Locked/Stuck.md', '[[Old]]');
    // Not valid UTF-8: rewriting it from decoded text would damage the other bytes.
    const latin = Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from(' [[Old]]')]);
    await writeFile(join(vault.root, 'Legacy.md'), latin);
    await chmod(join(vault.root, 'Locked'), 0o500);
    try {
      expect(await vault.rename('Old.md', 'New')).toEqual({
        path: 'New.md',
        rewritten: ['Fine.md'],
        missed: ['Legacy.md', 'Locked/Stuck.md'],
      });
    } finally {
      await chmod(join(vault.root, 'Locked'), 0o700);
    }
    expect(vault.tree().notes).toContain('New.md');
    expect(await readFile(join(vault.root, 'Fine.md'), 'utf8')).toBe('[[New]]');
    expect((await readFile(join(vault.root, 'Legacy.md'))).equals(latin)).toBe(true);
    expect(await readFile(join(vault.root, 'Locked/Stuck.md'), 'utf8')).toBe('[[Old]]');
  });
  it('still reports an outside edit that a rename happened to notice first', async () => {
    const vault = await open();
    await write(vault, 'A.md', 'mine');
    await write(vault, 'B.md', '');
    const seen: string[][] = [];
    vault.watch((paths) => seen.push(paths));
    await pause(300);
    await writeFile(join(vault.root, 'A.md'), 'theirs');
    await vault.rename('B.md', 'C');
    await pause(600);
    expect(seen.flat()).toContain('A.md');
  });
  it('renames a folder whose name looks like a note, and trashes odd names safely', async () => {
    const vault = await open();
    await vault.createFolder('', 'x.md');
    expect((await vault.rename('x.md', 'y')).path).toBe('y');
    await vault.createFolder('y', '__proto__');
    await vault.trash('y/__proto__');
    expect((await vault.trashed())[0]).toMatchObject({ name: '__proto__', from: 'y/__proto__' });
    expect(await vault.restore('__proto__')).toBe('y/__proto__');
    await vault.trash('y');
    const moved: string[] = [];
    await vault.emptyTrash(async (file) => void moved.push(file));
    expect(moved).toEqual([join(vault.root, '.trash', 'y')]);
  });
  it('refuses to empty a trash that is a link to somewhere else', async () => {
    const outside = await folder();
    await writeFile(join(outside, 'Precious.md'), 'keep');
    const vault = await open();
    await symlink(outside, join(vault.root, '.trash'));
    const moved: string[] = [];
    await expect(vault.emptyTrash(async (file) => void moved.push(file))).rejects.toThrow();
    expect(moved).toEqual([]);
  });
  it('moves notes between folders and keeps links unambiguous', async () => {
    const vault = await open();
    await vault.createFolder('', 'Travel');
    await vault.createFolder('', 'Work');
    await write(vault, 'Travel/Japan.md', 'trip');
    await write(vault, 'Work/Japan.md', 'client');
    await write(vault, 'Index.md', '[[Travel/Japan]] and [[Work/Japan]]');
    expect(await vault.move('Travel/Japan.md', '')).toEqual({
      path: 'Japan.md',
      rewritten: ['Index.md'],
      missed: [],
    });
    // The moved note is now the shallowest "Japan"; the other still needs its folder.
    expect(await readFile(join(vault.root, 'Index.md'), 'utf8')).toBe(
      '[[Japan]] and [[Work/Japan]]',
    );
    await expect(vault.move('Japan.md', 'Work')).rejects.toThrow('already exists');
    await expect(vault.move('Japan.md', 'Missing')).rejects.toThrow();
    expect(vault.tree().notes).toEqual(['Index.md', 'Japan.md', 'Work/Japan.md']);
  });
  it('renames and moves folders with their notes, links and images', async () => {
    const vault = await open();
    await vault.createFolder('', 'Travel');
    await vault.createFolder('Travel', 'Asia');
    await vault.createFolder('', 'Archive');
    await write(vault, 'Travel/Asia/Japan.md', 'x');
    await writeFile(join(vault.root, 'Travel', 'map one.png'), 'png');
    await write(
      vault,
      'Index.md',
      '[[Travel/Asia/Japan]] [[Japan]] ![map](Travel/map%20one.png) [site](https://a.b/Travel/x)',
    );
    const renamed = await vault.rename('Travel', 'Trips');
    expect(renamed).toEqual({ path: 'Trips', rewritten: ['Index.md'], missed: [] });
    expect(await readFile(join(vault.root, 'Index.md'), 'utf8')).toBe(
      '[[Japan]] [[Japan]] ![map](Trips/map%20one.png) [site](https://a.b/Travel/x)',
    );
    expect(vault.tree()).toEqual({
      notes: ['Index.md', 'Trips/Asia/Japan.md'],
      folders: ['Archive', 'Trips', 'Trips/Asia'],
      images: ['Trips/map one.png'],
    });
    await expect(vault.move('Trips', 'Trips/Asia')).rejects.toThrow('into itself');
    expect((await vault.move('Trips', 'Archive')).path).toBe('Archive/Trips');
    expect(vault.tree().notes).toEqual(['Archive/Trips/Asia/Japan.md', 'Index.md']);
    expect(await readFile(join(vault.root, 'Archive/Trips/Asia/Japan.md'), 'utf8')).toBe('x');
    expect(vault.backlinks('Archive/Trips/Asia/Japan.md').map((link) => link.path)).toEqual([
      'Index.md',
    ]);
    await expect(vault.createFolder('', 'Archive')).rejects.toThrow('already exists');
  });
  it('restores trashed notes and folders to where they were', async () => {
    const vault = await open();
    await vault.createFolder('', 'Travel');
    await write(vault, 'Travel/Japan.md', 'ramen');
    await write(vault, 'Loose.md', 'loose');
    await vault.trash('Travel/Japan.md');
    await vault.trash('Travel');
    await vault.trash('Loose.md');
    expect(vault.tree()).toEqual({ notes: [], folders: [], images: [] });
    const listed = await vault.trashed();
    expect(
      listed
        .map(({ name, from, folder }) => ({ name, from, folder }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual([
      { name: 'Japan.md', from: 'Travel/Japan.md', folder: false },
      { name: 'Loose.md', from: 'Loose.md', folder: false },
      { name: 'Travel', from: 'Travel', folder: true },
    ]);
    // Its folder is gone, so restoring the note brings the folder back too.
    expect(await vault.restore('Japan.md')).toBe('Travel/Japan.md');
    expect(await readFile(join(vault.root, 'Travel/Japan.md'), 'utf8')).toBe('ramen');
    // The name is taken again, so the trashed folder returns beside it.
    expect(await vault.restore('Travel')).toBe('Travel 1');
    await write(vault, 'Loose.md', 'newer');
    expect(await vault.restore('Loose.md')).toBe('Loose 1.md');
    expect(await readFile(join(vault.root, 'Loose 1.md'), 'utf8')).toBe('loose');
    expect(await vault.trashed()).toEqual([]);
    for (const name of ['../Loose.md', '.opsidian-origins.json', 'Missing.md', 'a/b'])
      await expect(vault.restore(name), name).rejects.toThrow();
    // Something another program put in the trash has no record and comes back at the top.
    await writeFile(join(vault.root, '.trash', 'Foreign.md'), 'theirs');
    expect(await vault.restore('Foreign.md')).toBe('Foreign.md');
    expect(vault.tree().notes).toContain('Foreign.md');
  });
  it('stores pasted images under readable names and clears crash leftovers', async () => {
    const directory = await folder();
    await writeFile(join(directory, '.Note.md.opsidian-pending'), 'half-written');
    await writeFile(join(directory, '.theirs.pending'), 'another program’s file');
    await writeFile(join(directory, 'Note.md'), 'whole');
    const vault = await open(directory);
    expect((await readdir(directory)).sort()).toEqual(['.theirs.pending', 'Note.md']);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    );
    expect(await vault.saveImage(png)).toBe('attachments/Pasted image.png');
    expect(await vault.saveImage(png)).toBe('attachments/Pasted image 1.png');
    expect(vault.tree().images).toEqual([
      'attachments/Pasted image 1.png',
      'attachments/Pasted image.png',
    ]);
    expect(() => vault.saveImage(Buffer.from('<svg/>'))).toThrow('Supported images');
    expect((await readdir(directory)).sort()).toEqual([
      '.theirs.pending',
      'Note.md',
      'attachments',
    ]);
  });
  it('refuses paths that leave the vault or pass through a symlink', async () => {
    const outside = await folder();
    await writeFile(join(outside, 'Secret.md'), 'secret');
    const vault = await open();
    await symlink(outside, join(vault.root, 'Linked'));
    await symlink(join(outside, 'Secret.md'), join(vault.root, 'Alias.md'));
    expect(vault.tree()).toEqual({ notes: [], folders: [], images: [] });
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
  // A rename keeps a file's time and size, so these two look alike to anything that checks
  // only those, before and after they trade names.
  async function twins() {
    const directory = await folder();
    await writeFile(join(directory, 'x.md'), 'alpha');
    await writeFile(join(directory, 'y.md'), 'bravo');
    const moment = new Date('2026-01-01T00:00:00Z');
    await utimes(join(directory, 'x.md'), moment, moment);
    await utimes(join(directory, 'y.md'), moment, moment);
    return open(directory);
  }
  async function trade(vault: Vault) {
    await rename(join(vault.root, 'x.md'), join(vault.root, 'tmp.md'));
    await rename(join(vault.root, 'y.md'), join(vault.root, 'x.md'));
    await rename(join(vault.root, 'tmp.md'), join(vault.root, 'y.md'));
  }
  it('tells sync about two notes that traded names, though time and size stayed', async () => {
    const vault = await twins();
    const store = vault.syncStore();
    const listed = async () =>
      Object.fromEntries((await store.list()).map((file) => [file.path, file.hash]));
    const hash = (text: string) => store.hash(Buffer.from(text));
    expect(await listed()).toEqual({ 'x.md': hash('alpha'), 'y.md': hash('bravo') });
    await trade(vault);
    expect(await listed()).toEqual({ 'x.md': hash('bravo'), 'y.md': hash('alpha') });
  });
  it('searches the right note after two notes trade names in another program', async () => {
    const vault = await twins();
    vault.watch(() => {});
    expect(vault.search('alpha').map((result) => result.path)).toEqual(['x.md']);
    await trade(vault);
    await pause(600);
    expect(vault.search('alpha').map((result) => result.path)).toEqual(['y.md']);
  });
  it('rejects active SVG content disguised as an image', () => {
    expect(detectImage(Buffer.from('<svg onload="alert(1)"></svg>'))).toBeUndefined();
  });
});
