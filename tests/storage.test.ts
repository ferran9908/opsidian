import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PrototypeStore, detectImage } from '../apps/desktop/electron/storage';
const directories: string[] = [];
async function store() {
  const directory = await mkdtemp(join(tmpdir(), 'opsidian-test-'));
  directories.push(directory);
  return new PrototypeStore(directory);
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
describe('Markdown persistence', () => {
  it('persists empty content and recovers on a new process/store', async () => {
    const first = await store();
    await first.load();
    await first.save('hello');
    await first.save('');
    const restarted = new PrototypeStore(first.directory);
    expect((await restarted.load()).content).toBe('');
  });
  it('serializes concurrent writes and leaves the latest on disk', async () => {
    const s = await store();
    await s.load();
    await Promise.all([s.save('one'), s.save('two')]);
    expect(await readFile(s.notePath, 'utf8')).toBe('two');
  });
  it('preserves external changes instead of silently overwriting', async () => {
    const s = await store();
    await s.load();
    await writeFile(s.notePath, 'external');
    await expect(s.save('my pending edit')).rejects.toThrow('changed outside Opsidian');
    expect(await readFile(s.notePath, 'utf8')).toBe('external');
    const { readdir } = await import('node:fs/promises');
    const recovered = (await readdir(s.directory)).find((n) => n.startsWith('Recovered-'))!;
    expect(await readFile(join(s.directory, recovered), 'utf8')).toBe('my pending edit');
  });
  it('recovers a first write interrupted before the final rename', async () => {
    const s = await store();
    await mkdir(s.directory, { recursive: true });
    await writeFile(`${s.notePath}.pending`, 'recovered');
    expect((await s.load()).content).toBe('recovered');
  });
  it('rejects active SVG content disguised as an image', () => {
    expect(detectImage(Buffer.from('<svg onload="alert(1)"></svg>'))).toBeUndefined();
  });
});
