import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
  copyFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Host, listBackups, restoreBackup } from '../apps/host/src/host';
import { Vault } from '../apps/desktop/electron/vault';
import {
  SyncEngine,
  Unauthorized,
  httpTransport,
  pair,
  type SyncState,
  type SyncStatus,
  type SyncStore,
} from '../packages/sync/src/index';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
async function folder() {
  const directory = await mkdtemp(join(tmpdir(), 'opsidian-sync-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function startHost(maxWait = 1) {
  const host = new Host({ dataDir: await folder(), maxWait });
  const url = await host.listen(0, '127.0.0.1');
  cleanup.push(() => host.close());
  return { host, url };
}
type Server = Awaited<ReturnType<typeof startHost>>;

interface Device {
  name: string;
  root: string;
  vault: Vault;
  engine: SyncEngine;
  statuses: SyncStatus[];
  token: string;
  /** A new engine over the same folder and saved state, as after the app restarts. */
  restart(options?: {
    fetch?: typeof fetch;
    store?: (store: SyncStore) => SyncStore;
  }): Promise<void>;
  write(path: string, content: string | Uint8Array): Promise<void>;
  read(path: string): Promise<string>;
  remove(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
}
async function device(
  server: Server,
  name: string,
  options: { notebook?: string; root?: string; fetch?: typeof fetch } = {},
): Promise<Device> {
  const { code } = server.host.invite(options.notebook ?? 'Notes');
  const paired = await pair(server.url, code, name);
  const root = options.root ?? (await folder());
  const fresh: SyncState = {
    version: 1,
    host: server.url,
    notebook: paired.notebook.id,
    device: paired.device.id,
    deviceName: name,
    cursor: 0,
    files: {},
  };
  const self = { name, root, token: paired.token, statuses: [] as SyncStatus[] } as Device;
  self.restart = async (changed = {}) => {
    self.vault?.close();
    self.vault = await Vault.open(root);
    cleanup.push(() => self.vault.close());
    const store = self.vault.syncStore();
    self.engine = new SyncEngine(
      changed.store ? changed.store(store) : store,
      httpTransport(server.url, paired.token, changed.fetch ?? options.fetch ?? fetch),
      (await self.vault.syncState()) ?? structuredClone(fresh),
      (status) => self.statuses.push(status),
      { wait: 1 },
    );
    self.vault.onRelocate((from, to) => void self.engine.moved(from, to));
  };
  await self.restart();
  self.write = async (path, content) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  self.read = (path) => readFile(join(root, path), 'utf8');
  self.remove = (path) => rm(join(root, path), { recursive: true });
  self.move = async (from, to) => {
    await mkdir(dirname(join(root, to)), { recursive: true });
    await rename(join(root, from), join(root, to));
  };
  return self;
}

/** Every visible file in a notebook folder, with its content. */
async function tree(root: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  const walk = async (directory: string, relative: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(directory, entry.name), path);
      else found[path] = (await readFile(join(directory, entry.name))).toString('latin1');
    }
  };
  await walk(root, '');
  return Object.fromEntries(Object.entries(found).sort(([a], [b]) => (a < b ? -1 : 1)));
}
/** Syncs every device, in turn, until a whole pass changes nothing. */
async function settle(...devices: Device[]) {
  for (let pass = 0; pass < 20; pass++) {
    const before = JSON.stringify(await Promise.all(devices.map((each) => tree(each.root))));
    for (const each of devices) await each.engine.sync();
    for (const each of devices) await each.engine.sync();
    const after = await Promise.all(devices.map((each) => tree(each.root)));
    if (
      JSON.stringify(after) === before &&
      after.every((one) => JSON.stringify(one) === JSON.stringify(after[0]))
    )
      return after[0]!;
  }
  throw new Error('The devices did not converge.');
}
const conflicted = (files: Record<string, string>) =>
  Object.keys(files).filter((path) => path.includes('conflicted copy'));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('sync between two devices', () => {
  it('carries new notes, edits, renames, folders, attachments and deletions across', async () => {
    const server = await startHost();
    const a = await device(server, 'Mac A');
    const b = await device(server, 'Mac B');
    await a.write('Sunday.md', 'Walk by the water.\n');
    await a.write('Travel/Japan.md', 'Ramen.\n');
    await a.write('attachments/photo.png', new Uint8Array([137, 80, 78, 71, 0, 255, 254, 10]));
    expect(await settle(a, b)).toEqual(await tree(a.root));
    expect(await b.read('Travel/Japan.md')).toBe('Ramen.\n');
    expect([...(await readFile(join(b.root, 'attachments/photo.png')))]).toEqual([
      137, 80, 78, 71, 0, 255, 254, 10,
    ]);

    await b.write('Sunday.md', 'Walk by the water.\nThen lunch.\n');
    await b.move('Travel/Japan.md', 'Trips/Asia/Japan.md');
    await b.remove('attachments/photo.png');
    const files = await settle(a, b);
    expect(Object.keys(files)).toEqual(['Sunday.md', 'Trips/Asia/Japan.md']);
    expect(await a.read('Sunday.md')).toBe('Walk by the water.\nThen lunch.\n');
    // What sync removes is recoverable, and emptied folders do not linger.
    expect(await readdir(join(a.root, '.trash'))).toContain('photo.png');
    expect(await readdir(a.root)).not.toContain('Travel');
    expect(a.engine.status.state).toBe('synced');
  });

  it('keeps a file’s identity and history through a rename', async () => {
    const server = await startHost();
    const a = await device(server, 'Mac A');
    const b = await device(server, 'Mac B');
    // Empty notes all have the same content, so only the app can say which one moved.
    await a.vault.createNote('', 'One');
    await a.vault.createNote('', 'Two');
    await settle(a, b);
    const id = a.engine.fileAt('One.md')!;
    await a.vault.rename('One.md', 'First');
    await pause(50);
    await settle(a, b);
    expect(a.engine.fileAt('First.md')).toBe(id);
    expect(b.engine.fileAt('First.md')).toBe(id);
    await b.write('First.md', 'now with text');
    await settle(a, b);
    const history = await httpTransport(server.url, a.token).history(id);
    expect(history.map((version) => [version.path, version.device])).toEqual([
      ['First.md', 'Mac B'],
      ['First.md', 'Mac A'],
      ['One.md', 'Mac A'],
    ]);
  });

  it('combines offline edits to different parts of a note', async () => {
    const server = await startHost();
    const a = await device(server, 'Mac A');
    const b = await device(server, 'Mac B');
    await a.write('Plan.md', 'one\ntwo\nthree\nfour\nfive\n');
    await settle(a, b);
    await a.write('Plan.md', 'ONE\ntwo\nthree\nfour\nfive\n');
    await b.write('Plan.md', 'one\ntwo\nthree\nfour\nFIVE\nsix\n');
    const files = await settle(a, b);
    expect(files).toEqual({ 'Plan.md': 'ONE\ntwo\nthree\nfour\nFIVE\nsix\n' });
  });

  it('keeps both versions when the same lines were edited', async () => {
    const server = await startHost();
    const a = await device(server, 'Mac A');
    const b = await device(server, 'Mac B');
    await a.write('Plan.md', 'one\ntwo\n');
    await a.write('pic.png', 'original');
    await settle(a, b);
    await a.write('Plan.md', 'one from A\ntwo\n');
    await b.write('Plan.md', 'one from B\ntwo\n');
    await a.write('pic.png', 'A’s picture');
    await b.write('pic.png', 'B’s picture');
    await a.engine.sync();
    const files = await settle(b, a);
    // A reached the host first, so its versions are the files; B's sit beside them.
    expect(files['Plan.md']).toBe('one from A\ntwo\n');
    const copies = conflicted(files);
    expect(copies).toHaveLength(2);
    expect(copies.every((path) => path.includes('Mac B'))).toBe(true);
    expect(copies.map((path) => files[path]).sort()).toEqual(
      [Buffer.from('B’s picture').toString('latin1'), 'one from B\ntwo\n'].sort(),
    );
  });

  it('lets an edit win over a deletion, in either direction', async () => {
    const server = await startHost();
    const a = await device(server, 'Mac A');
    const b = await device(server, 'Mac B');
    await a.write('First.md', 'v1');
    await a.write('Second.md', 'v1');
    await settle(a, b);
    // A deletes First and edits Second; B does the opposite. A syncs first.
    await a.remove('First.md');
    await a.write('Second.md', 'edited on A');
    await b.write('First.md', 'edited on B');
    await b.remove('Second.md');
    await a.engine.sync();
    expect(await settle(b, a)).toEqual({ 'First.md': 'edited on B', 'Second.md': 'edited on A' });
  });

  it('resolves two notes created under one name, and one note renamed two ways', async () => {
    const server = await startHost();
    const a = await device(server, 'Mac A');
    const b = await device(server, 'Mac B');
    await a.write('Shared.md', 'shared');
    await settle(a, b);
    await a.write('Idea.md', 'from A');
    await b.write('idea.md', 'from B');
    await a.move('Shared.md', 'Named by A.md');
    await b.move('Shared.md', 'Named by B.md');
    await a.engine.sync();
    const files = await settle(b, a);
    expect(Object.values(files).sort()).toEqual(['from A', 'from B', 'shared']);
    // The first rename to reach the host stands.
    expect(files['Named by A.md']).toBe('shared');
    expect(files['Idea.md']).toBe('from A');
    expect(conflicted(files)).toHaveLength(1);
  });

  it('joins two existing copies without losing or duplicating notes', async () => {
    const server = await startHost();
    const a = await device(server, 'Mac A');
    await a.write('Same.md', 'identical');
    await a.write('Differs.md', 'A’s text');
    await a.write('Only A.md', 'a');
    await a.engine.sync();
    const root = await folder();
    await writeFile(join(root, 'Same.md'), 'identical');
    await writeFile(join(root, 'Differs.md'), 'B’s text');
    await writeFile(join(root, 'Only B.md'), 'b');
    const b = await device(server, 'Mac B', { root });
    const files = await settle(b, a);
    expect(Object.keys(files).filter((path) => !path.includes('conflicted'))).toEqual([
      'Differs.md',
      'Only A.md',
      'Only B.md',
      'Same.md',
    ]);
    expect(Buffer.from(files['Differs.md']!, 'latin1').toString()).toBe('A’s text');
    expect(conflicted(files)).toHaveLength(1);
    expect(server.host.notebooks()[0]!.files).toBe(5);
  });

  it('settles a change of letter case, in a file name or a folder name', async () => {
    const server = await startHost();
    const a = await device(server, 'Mac A');
    const b = await device(server, 'Mac B');
    await a.write('travel/japan.md', 'ramen');
    await a.write('travel/korea.md', 'kimchi');
    await settle(a, b);
    await a.vault.rename('travel', 'Travel');
    await a.vault.rename('Travel/japan.md', 'Japan');
    await pause(50);
    const files = await settle(a, b);
    expect(Object.keys(files)).toEqual(['Travel/Japan.md', 'Travel/korea.md']);
    expect(await readdir(b.root)).toContain('Travel');
    // Nothing is left bouncing between the two.
    const head = server.host.notebooks()[0]!.head;
    await settle(a, b);
    await settle(b, a);
    expect(server.host.notebooks()[0]!.head).toBe(head);

    // The same folder created under two spellings while apart becomes one folder.
    await a.write('Work/a.md', 'a');
    await b.write('work/b.md', 'b');
    const merged = await settle(a, b);
    expect(Object.keys(merged).filter((path) => /^work\//i.test(path))).toHaveLength(2);
    expect(new Set(Object.keys(merged).map((path) => path.split('/')[0]))).toEqual(
      new Set([
        'Travel',
        Object.keys(merged)
          .find((path) => /^work\//i.test(path))!
          .split('/')[0],
      ]),
    );
  });

  it('carries two notes trading names, whether seen one step at a time or all at once', async () => {
    const server = await startHost();
    const a = await device(server, 'Mac A');
    const b = await device(server, 'Mac B');
    const c = await device(server, 'Mac C');
    await a.write('x.md', 'was x');
    await a.write('y.md', 'was y');
    await settle(a, b, c);
    // A syncs between each step; B sees the whole trade in one batch.
    for (const [from, to] of [
      ['x.md', 'tmp.md'],
      ['y.md', 'x.md'],
      ['tmp.md', 'y.md'],
    ]) {
      await a.vault.rename(from!, to!.slice(0, -3));
      await pause(30);
      await a.engine.sync();
    }
    expect(await settle(a, b)).toEqual({ 'x.md': 'was y', 'y.md': 'was x' });
    // C makes the same trade back while offline, so its first push holds both renames.
    await c.engine.sync();
    for (const [from, to] of [
      ['x.md', 'tmp.md'],
      ['y.md', 'x.md'],
      ['tmp.md', 'y.md'],
    ])
      await c.vault.rename(from!, to!.slice(0, -3));
    await pause(50);
    expect(await settle(c, a, b)).toEqual({ 'x.md': 'was x', 'y.md': 'was y' });
    expect(c.engine.status.state).toBe('synced');
  });

  it('keeps syncing everything else when one file cannot be', async () => {
    const server = await startHost();
    const a = await device(server, 'Mac A');
    const b = await device(server, 'Mac B');
    await a.write('Inbox/todo.md', 'in a folder');
    await a.engine.sync();
    // On B, "Inbox" is a file, so A's note cannot be put inside it.
    await b.write('Inbox', 'a file, not a folder');
    await b.write('other.md', 'still travels');
    await b.write(' spaced.md', 'a name the host will not take');
    await b.engine.sync();
    expect(b.engine.status.state).toBe('error');
    expect(b.engine.status.problems).toBeGreaterThanOrEqual(1);
    await a.engine.sync();
    expect(await a.read('other.md')).toBe('still travels');
    expect(await b.read('Inbox')).toBe('a file, not a folder');
    // Once the obstacle is renamed, the held-back note arrives.
    await b.move('Inbox', 'Inbox file');
    await b.remove(' spaced.md');
    await settle(b, a);
    expect(await b.read('Inbox/todo.md')).toBe('in a folder');
    expect(b.engine.status.state).toBe('synced');
  });

  it('leaves alone a file that has grown too large to sync', async () => {
    const server = await startHost();
    const a = await device(server, 'Mac A');
    const b = await device(server, 'Mac B');
    await a.write('video.bin', 'small for now');
    await settle(a, b);
    await truncate(join(a.root, 'video.bin'), 100 * 1024 * 1024 + 1);
    await a.engine.sync();
    await b.engine.sync();
    expect(await b.read('video.bin')).toBe('small for now');
    expect(existsSync(join(b.root, '.trash'))).toBe(false);
    // Nor is the large copy replaced when the other side changes its small one.
    await b.write('video.bin', 'changed on B');
    await b.engine.sync();
    await a.engine.sync();
    expect((await stat(join(a.root, 'video.bin'))).size).toBe(100 * 1024 * 1024 + 1);
  });

  it('holds back a mass deletion until it is confirmed', async () => {
    const server = await startHost();
    const a = await device(server, 'Mac A');
    const b = await device(server, 'Mac B');
    for (let note = 0; note < 14; note++) await a.write(`Note ${note}.md`, `text ${note}`);
    await settle(a, b);
    // As if the folder's disk had been unmounted, or a restore was half done.
    for (let note = 0; note < 12; note++) await a.remove(`Note ${note}.md`);
    await a.engine.sync();
    expect(a.engine.status).toMatchObject({ state: 'synced', held: 12 });
    await b.engine.sync();
    expect(Object.keys(await tree(b.root))).toHaveLength(14);
    a.engine.confirmDeletions();
    expect(Object.keys(await settle(a, b))).toEqual(['Note 12.md', 'Note 13.md']);
    expect(a.engine.status.held).toBeUndefined();
  });

  it('reaches the other device within two seconds while both are running', async () => {
    const server = await startHost(5);
    const a = await device(server, 'Mac A');
    const b = await device(server, 'Mac B');
    a.engine.start();
    b.engine.start();
    cleanup.push(async () => {
      await a.engine.stop();
      await b.engine.stop();
    });
    await pause(300);
    const started = Date.now();
    await a.write('Live.md', 'hello from A');
    a.engine.kick();
    while (!(await b.read('Live.md').catch(() => '')).includes('hello')) {
      if (Date.now() - started > 2000) throw new Error('B did not hear about the change in time');
      await pause(20);
    }
    await b.write('Live.md', 'hello from A\nand from B');
    b.engine.kick();
    while ((await a.read('Live.md')) !== 'hello from A\nand from B') {
      if (Date.now() - started > 4000) throw new Error('A did not hear about the change in time');
      await pause(20);
    }
  });
});

describe('sync under failure', () => {
  const lcg = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  /** Requests that sometimes never arrive, and sometimes arrive but lose their answer. */
  const flaky =
    (random: () => number, rate: number): typeof fetch =>
    async (input, init) => {
      const roll = random();
      if (roll < rate / 2) throw new Error('connection lost before sending');
      const response = await fetch(input, init);
      if (roll < rate) {
        await response.arrayBuffer();
        throw new Error('connection lost before the answer');
      }
      return response;
    };
  const until = async (task: () => Promise<unknown>) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      try {
        return await task();
      } catch (error) {
        if (error instanceof Unauthorized) throw error;
      }
    }
    throw new Error('It never got through.');
  };

  it('has one effect when a request is sent twice', async () => {
    const server = await startHost();
    const twice: typeof fetch = async (input, init) => {
      if (init?.method === 'POST' || init?.method === 'PUT')
        await (await fetch(input, init)).arrayBuffer();
      return fetch(input, init);
    };
    const a = await device(server, 'Mac A', { fetch: twice });
    const b = await device(server, 'Mac B');
    await a.write('Note.md', 'v1');
    await a.engine.sync();
    await a.move('Note.md', 'Renamed.md');
    await a.engine.sync();
    await a.write('Renamed.md', 'v2');
    await a.engine.sync();
    expect(await settle(a, b)).toEqual({ 'Renamed.md': 'v2' });
    const history = await httpTransport(server.url, b.token).history(
      a.engine.fileAt('Renamed.md')!,
    );
    expect(history.map((version) => version.path)).toEqual(['Renamed.md', 'Renamed.md', 'Note.md']);
  });

  it('converges over a connection that keeps dropping', async () => {
    const server = await startHost();
    const random = lcg(7);
    const a = await device(server, 'Mac A', { fetch: flaky(random, 0.2) });
    const b = await device(server, 'Mac B', { fetch: flaky(random, 0.2) });
    for (let note = 0; note < 12; note++) await a.write(`Folder/Note ${note}.md`, `text ${note}\n`);
    await a.write('attachments/big.bin', Buffer.alloc(300000, 7));
    await until(() => a.engine.sync());
    await until(() => b.engine.sync());
    await b.write('Folder/Note 3.md', 'text 3\nmore\n');
    await b.remove('Folder/Note 4.md');
    await a.move('Folder/Note 5.md', 'Moved.md');
    for (let pass = 0; pass < 6; pass++) {
      await until(() => a.engine.sync());
      await until(() => b.engine.sync());
    }
    const files = await tree(a.root);
    expect(await tree(b.root)).toEqual(files);
    expect(Object.keys(files)).toHaveLength(12);
    expect(conflicted(files)).toEqual([]);
    expect(server.host.notebooks()[0]!.files).toBe(12);
  });

  it('refuses a transfer that arrives damaged', async () => {
    const server = await startHost();
    const a = await device(server, 'Mac A');
    const transport = httpTransport(server.url, a.token);
    const hash = a.vault.syncStore().hash(Buffer.from('whole'));
    await expect(transport.putBlob(hash, Buffer.from('who'))).rejects.toThrow('does not match');
    expect(await transport.hasBlob(hash)).toBe(false);
    // A change naming content the host never received is not accepted.
    const [result] = await transport.push([
      { id: 'x', file: 'f', base: 0, path: 'Note.md', hash, size: 5 },
    ]);
    expect(result).toMatchObject({ status: 'missing-blob' });
    // A download that does not match what was asked for is not written.
    const b = await device(server, 'Mac B', {
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        return String(input).includes('/blobs/') && init?.method !== 'HEAD' && response.ok
          ? new Response('tampered')
          : response;
      },
    });
    await a.write('Note.md', 'whole');
    await a.engine.sync();
    await b.engine.sync();
    expect(b.engine.status).toMatchObject({ state: 'error', problems: 1 });
    expect(b.engine.status.message).toContain('damaged');
    expect(await tree(b.root)).toEqual({});
  });

  it('recovers when the app dies between any two steps', async () => {
    // The scenario exercises every kind of local change sync makes: writing, merging,
    // keeping both versions, moving, and trashing.
    for (let dieAt = 0; dieAt < 40; dieAt++) {
      const server = await startHost();
      const a = await device(server, 'Mac A');
      const b = await device(server, 'Mac B');
      await a.write('Merge.md', '1\n2\n3\n');
      await a.write('Clash.md', 'base');
      await a.write('Move.md', 'move me');
      await a.write('Gone.md', 'delete me');
      await settle(a, b);
      await a.write('Merge.md', 'A\n2\n3\n');
      await a.write('Clash.md', 'A’s');
      await a.move('Move.md', 'Moved/Here.md');
      await a.remove('Gone.md');
      await a.write('New.md', 'new on A');
      await a.engine.sync();
      await b.write('Merge.md', '1\n2\nB\n');
      await b.write('Clash.md', 'B’s');
      await b.write('Local.md', 'new on B');

      // B's process dies at its Nth change to disk, saved state or the host, then restarts.
      let steps = 0;
      const dying = <T extends object>(target: T): T =>
        new Proxy(target, {
          get: (object, key) => {
            const value = object[key as keyof T];
            if (typeof value !== 'function' || key === 'hash' || key === 'list' || key === 'read')
              return value;
            return (...args: unknown[]) => {
              if (steps++ === dieAt) throw new Error('process killed');
              return (value as (...args: unknown[]) => unknown).apply(object, args);
            };
          },
        });
      await b.restart({ store: dying });
      const died = await b.engine.sync().then(
        () => false,
        (error: Error) => error.message === 'process killed',
      );
      await b.restart();
      const files = await settle(b, a);
      const label = `killed at step ${dieAt}`;
      expect(files['Merge.md'], label).toBe('A\n2\nB\n');
      expect(files['Moved/Here.md'], label).toBe('move me');
      expect(files['New.md'], label).toBe('new on A');
      expect(files['Local.md'], label).toBe('new on B');
      expect(files['Gone.md'], label).toBeUndefined();
      expect(files['Move.md'], label).toBeUndefined();
      expect(Buffer.from(files['Clash.md']!, 'latin1').toString(), label).toBe('A’s');
      // B's clashing text is never lost; a crash can at worst leave a second copy of it.
      const copies = conflicted(files).map((path) =>
        Buffer.from(files[path]!, 'latin1').toString(),
      );
      expect(copies.length, label).toBeGreaterThanOrEqual(1);
      expect(new Set(copies), label).toEqual(new Set(['B’s']));
      for (const step of cleanup.splice(0).reverse()) await step();
      if (!died && dieAt > 8) break;
    }
  }, 120000);

  it('converges after random offline activity on three devices', async () => {
    // OPSIDIAN_FUZZ_SEEDS=200 runs a longer search.
    const seeds = Number(process.env.OPSIDIAN_FUZZ_SEEDS ?? 6);
    for (let seed = 1; seed <= seeds; seed++) {
      const random = lcg(seed);
      const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)]!;
      const server = await startHost();
      const devices = [
        await device(server, 'Mac A', { fetch: flaky(random, 0.1) }),
        await device(server, 'Mac B', { fetch: flaky(random, 0.1) }),
        await device(server, 'Mac C', { fetch: flaky(random, 0.1) }),
      ];
      let serial = 0;
      // Every line ever written, and the lines a user deliberately removed or overwrote.
      const written = new Set<string>();
      const discarded = new Set<string>();
      const marks = (content: string) =>
        content.split('\n').filter((line) => /^(created|line) \d+/.test(line));
      const discard = async (each: Device, path: string) => {
        for (const mark of marks(await each.read(path).catch(() => ''))) discarded.add(mark);
      };
      for (let step = 0; step < 120; step++) {
        const each = pick(devices);
        const files = Object.keys(await tree(each.root));
        const action = random();
        if (action < 0.25 || !files.length) {
          const path = `${pick(['', 'Work/', 'Home/Deep/'])}Note ${Math.floor(random() * 8)}.md`;
          await discard(each, path);
          written.add(`created ${serial}`);
          await each.write(path, `created ${serial++}\n`);
        } else if (action < 0.55) {
          const path = pick(files);
          const lines = (await each.read(path)).split('\n');
          written.add(`line ${serial} from ${each.name}`);
          lines.splice(
            Math.floor(random() * lines.length),
            0,
            `line ${serial++} from ${each.name}`,
          );
          await each.write(path, lines.join('\n'));
        } else if (action < 0.7)
          await each.move(
            pick(files),
            `${pick(['', 'Work/', 'Archive/'])}Renamed ${Math.floor(random() * 8)} ${serial++}.md`,
          );
        else if (action < 0.8) {
          const path = pick(files);
          await discard(each, path);
          await each.remove(path);
        } else await each.engine.sync().catch(() => {});
      }
      const reliable = async () => {
        for (const each of devices) await each.restart({ fetch });
      };
      await reliable();
      const files = await settle(...devices);
      expect(server.host.notebooks()[0]!.files, `seed ${seed}`).toBe(Object.keys(files).length);
      // Nothing anyone wrote has vanished unless someone removed it on purpose.
      const kept = new Set(Object.values(files).flatMap(marks));
      const lost = [...written].filter((mark) => !kept.has(mark) && !discarded.has(mark));
      expect(lost, `seed ${seed}`).toEqual([]);
      for (const step of cleanup.splice(0).reverse()) await step();
    }
  }, 900000);
});

describe('stopping', () => {
  it('writes nothing after sync is stopped, however a round was interrupted', async () => {
    const server = await startHost();
    const a = await device(server, 'Mac A');
    await a.write('One.md', '');
    await a.engine.sync();
    // Saves from a rename and from a sync round at the same moment do not collide.
    await Promise.all([
      a.vault.rename('One.md', 'Two'),
      a.engine.sync(),
      a.engine.moved('x', 'y'),
      a.engine.sync(),
    ]);
    await a.engine.sync();
    expect(a.engine.fileAt('Two.md')).toBeDefined();

    const round = a.engine.sync();
    await a.engine.stop();
    await round.catch(() => {});
    await a.vault.forgetSync();
    await a.vault.rename('Two.md', 'Three');
    await a.engine.moved('Two.md', 'Three.md');
    await pause(100);
    expect(await a.vault.syncState()).toBeUndefined();
  });
});

describe('the host', () => {
  it('reads nothing from a caller it does not know, and caps what a notebook may store', async () => {
    const host = new Host({ dataDir: await folder(), maxNotebookBytes: 1000 });
    const url = await host.listen(0, '127.0.0.1');
    cleanup.push(() => host.close());
    const server = { host, url };
    for (const [method, path] of [
      ['POST', '/v1/ops'],
      ['PUT', `/v1/blobs/${'a'.repeat(64)}`],
      ['GET', '/v1/changes'],
    ]) {
      const response = await fetch(url + path, {
        method: method!,
        ...(method === 'GET'
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: '{not json' }),
      });
      expect(response.status, path).toBe(401);
    }
    const a = await device(server, 'Mac A');
    const transport = httpTransport(url, a.token);
    const hash = (bytes: Buffer) => a.vault.syncStore().hash(bytes);
    const small = Buffer.alloc(600, 1);
    await transport.putBlob(hash(small), small);
    const more = Buffer.alloc(600, 2);
    await expect(transport.putBlob(hash(more), more)).rejects.toThrow('no room');
    // Wrong codes are counted against the caller; then even a right one has to wait.
    for (let attempt = 0; attempt < 10; attempt++)
      await expect(pair(url, 'AAAA-AAAA-AAAA', 'x')).rejects.toThrow('not valid');
    await expect(pair(url, host.invite('Notes').code, 'x')).rejects.toThrow('Too many');
  });

  it('pairs a device once per invitation and can revoke it', async () => {
    const server = await startHost();
    const { code } = server.host.invite('Notes');
    const paired = await pair(server.url, code.toLowerCase().replaceAll('-', ' '), 'Mac A');
    await expect(pair(server.url, code, 'Mac B')).rejects.toThrow('not valid');
    await expect(pair(server.url, 'AAAA-BBBB-CCCC', 'Mac B')).rejects.toThrow('not valid');
    const expired = server.host.invite('Notes', -1);
    await expect(pair(server.url, expired.code, 'Mac B')).rejects.toThrow('not valid');
    const transport = httpTransport(server.url, paired.token);
    expect(await transport.changes(0, 0)).toMatchObject({ changes: [], head: 0 });
    await expect(httpTransport(server.url, 'guess').changes(0, 0)).rejects.toBeInstanceOf(
      Unauthorized,
    );
    expect(server.host.revoke(paired.device.id)).toBe(true);
    await expect(transport.changes(0, 0)).rejects.toBeInstanceOf(Unauthorized);
  });

  it('keeps notebooks apart and refuses names that could escape a folder', async () => {
    const server = await startHost();
    const mine = await device(server, 'Mac A', { notebook: 'Mine' });
    const theirs = await device(server, 'Mac X', { notebook: 'Theirs' });
    await mine.write('Secret.md', 'private');
    await mine.engine.sync();
    const outsider = httpTransport(server.url, theirs.token);
    const hash = mine.vault.syncStore().hash(Buffer.from('private'));
    expect(await outsider.hasBlob(hash)).toBe(false);
    await expect(outsider.getBlob(hash)).rejects.toThrow();
    expect((await outsider.changes(0, 0)).changes).toEqual([]);
    expect(await outsider.history(mine.engine.fileAt('Secret.md')!)).toEqual([]);

    const transport = httpTransport(server.url, mine.token);
    await transport.putBlob(hash, Buffer.from('private'));
    for (const path of [
      '../escape.md',
      '/etc/passwd',
      '.obsidian/app.json',
      'a//b.md',
      'a\\b.md',
      '',
    ])
      expect(
        (await transport.push([{ id: `bad ${path}`, file: 'f', base: 0, path, hash, size: 7 }]))[0],
        path,
      ).toMatchObject({ status: 'invalid' });
    await expect(outsider.getBlob('../../host.sqlite')).rejects.toThrow();
    // A device that has been sent such a path anyway does not act on it.
    expect(await tree(mine.root)).toEqual({ 'Secret.md': 'private' });
  });

  it('stops a revoked device and leaves its notes where they are', async () => {
    const server = await startHost();
    const a = await device(server, 'Mac A');
    await a.write('Note.md', 'mine');
    await a.engine.sync();
    server.host.revoke(server.host.devices()[0]!.id);
    await a.write('Note.md', 'still mine');
    a.engine.start();
    cleanup.push(() => a.engine.stop());
    await pause(300);
    expect(a.engine.status).toMatchObject({ state: 'error' });
    expect(a.engine.status.message).toContain('no longer connected');
    expect(await a.read('Note.md')).toBe('still mine');
  });
});

describe('backing up and restoring the host', () => {
  it('reports each device, pending invitations and how much a notebook holds', async () => {
    const server = await startHost();
    const a = await device(server, 'Mac');
    await a.write('Note.md', 'one');
    await a.write('pic.png', new Uint8Array([1, 2, 3, 4]));
    await settle(a);
    await a.write('Note.md', 'two');
    await settle(a);
    const invitation = server.host.invite('Notes');
    expect(server.host.notebooks()).toEqual([
      { name: 'Notes', head: 3, files: 2, versions: 3, bytes: 10 },
    ]);
    const [mac] = server.host.devices();
    expect(mac).toMatchObject({ name: 'Mac', notebook: 'Notes', revoked: false });
    expect(Date.now() - mac!.seen!).toBeLessThan(5000);
    const pending = server.host.invitations();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ notebook: 'Notes', expires: invitation.expires });
    // An invitation is listed without the code that would let someone use it.
    expect(JSON.stringify(pending)).not.toContain(invitation.code.replaceAll('-', ''));
    expect(server.host.cancelInvitation(pending[0]!.id)).toBe(true);
    await expect(pair(server.url, invitation.code, 'Late')).rejects.toThrow('not valid');
    const who = await fetch(`${server.url}/v1/whoami`, {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(await who.json()).toEqual({ device: 'Mac', notebook: 'Notes' });
    expect((await fetch(`${server.url}/v1/whoami`)).status).toBe(401);
  });

  it('keeps the newest backups and adds only content the folder lacks', async () => {
    const server = await startHost();
    const a = await device(server, 'Mac');
    const target = await folder();
    await a.write('Note.md', 'one');
    await settle(a);
    const first = await server.host.backup(target, 2);
    expect(first.notebooks).toMatchObject([{ name: 'Notes', files: 1 }]);
    for (const text of ['two', 'three']) {
      await pause(5);
      await a.write('Note.md', text);
      await settle(a);
      await server.host.backup(target, 2);
    }
    const kept = await listBackups(target);
    expect(kept).toHaveLength(2);
    expect(kept.map((backup) => backup.name)).not.toContain(first.name);
    expect(kept[0]!.at).toBeGreaterThan(kept[1]!.at);
    // Content from the pruned backup is still there, so older snapshots stay restorable.
    const stored = Object.keys(await tree(join(target, 'blobs')));
    expect(stored).toHaveLength(3);
    await expect(restoreBackup(await folder(), target, '../escape')).rejects.toThrow(
      'not a backup',
    );
  });

  it('restores a host, and devices keep what they wrote since without duplicates', async () => {
    const data = await folder();
    let host = new Host({ dataDir: data, maxWait: 1 });
    const url = await host.listen(0, '127.0.0.1');
    cleanup.push(() => host.close());
    const server = { host, url };
    const a = await device(server, 'Mac');
    const b = await device(server, 'Phone');
    await a.write('Kept.md', 'unchanged');
    await a.write('Edited.md', 'before\n');
    await a.write('Renamed.md', 'moves later');
    await a.write('Trashed.md', 'goes later');
    await settle(a, b);
    const target = await folder();
    const backup = await host.backup(target);

    // Life goes on after the backup.
    await b.write('Edited.md', 'before\nand after\n');
    await a.write('New.md', 'made since');
    await a.move('Renamed.md', 'Folder/Renamed again.md');
    await settle(a, b);
    await b.remove('Trashed.md');
    await settle(a, b);
    const late = await device(server, 'Latecomer');
    await settle(a, b, late);

    await host.close();
    await restoreBackup(data, target, backup.name);
    host = new Host({ dataDir: data, maxWait: 1 });
    await host.listen(Number(new URL(url).port), '127.0.0.1');
    server.host = host;

    const files = await settle(a, b);
    // Everything written since the backup is back on the host, once, under its latest name.
    expect(files).toEqual({
      'Kept.md': 'unchanged',
      'Edited.md': 'before\nand after\n',
      'Folder/Renamed again.md': 'moves later',
      'New.md': 'made since',
      // Deleted after the backup: the backup still has it, so it returns. Nothing is lost.
      'Trashed.md': 'goes later',
    });
    expect(host.notebooks()[0]).toMatchObject({ files: 5 });
    // A device that joined after the backup is unknown to the restored host.
    await expect(late.engine.sync()).rejects.toThrow('no longer connected');
    // Sync carries on as usual afterwards.
    await a.write('After.md', 'business as usual');
    expect((await settle(a, b))['After.md']).toBe('business as usual');
  });

  it('does not let a device that was behind the backup undo newer work', async () => {
    const data = await folder();
    let host = new Host({ dataDir: data, maxWait: 1 });
    const url = await host.listen(0, '127.0.0.1');
    cleanup.push(() => host.close());
    const server = { host, url };
    const mac = await device(server, 'Mac');
    const phone = await device(server, 'Phone');
    await mac.write('Note.md', 'monday\n');
    await mac.write('Old name.md', 'renamed on tuesday');
    await mac.write('Gone.md', 'deleted on tuesday');
    await settle(mac, phone);
    // The phone stays in a pocket while the Mac carries on.
    await mac.write('Note.md', 'monday\ntuesday\n');
    await mac.move('Old name.md', 'New name.md');
    await mac.remove('Gone.md');
    await settle(mac);
    const lost = await device(server, 'Lost phone');
    await settle(mac, lost);
    const target = await folder();
    const backup = await host.backup(target);
    // After the backup: one more edit, and the lost phone is removed.
    await mac.write('Later.md', 'wednesday');
    await settle(mac);
    host.revoke(host.devices().find((each) => each.name === 'Lost phone')!.id);

    await host.close();
    await restoreBackup(data, target, backup.name);
    host = new Host({ dataDir: data, maxWait: 1 });
    await host.listen(Number(new URL(url).port), '127.0.0.1');
    server.host = host;

    // The phone, a day behind the backup, is the first to meet the restored host.
    await phone.engine.sync();
    expect(await settle(phone, mac)).toEqual({
      'Note.md': 'monday\ntuesday\n',
      'New name.md': 'renamed on tuesday',
      'Later.md': 'wednesday',
    });
    // Going back in time does not give a removed device its access back.
    await expect(lost.engine.sync()).rejects.toThrow('no longer connected');
    expect(host.devices().find((each) => each.name === 'Lost phone')).toMatchObject({
      revoked: true,
    });
  });

  it('recovers when a host is put back in time without saying so', async () => {
    const data = await folder();
    let host = new Host({ dataDir: data, maxWait: 1 });
    const url = await host.listen(0, '127.0.0.1');
    cleanup.push(() => host.close());
    const server = { host, url };
    const mac = await device(server, 'Mac');
    await mac.write('Kept.md', 'early');
    await settle(mac);
    const target = await folder();
    const backup = await host.backup(target);
    await mac.write('Kept.md', 'early\nlater');
    await mac.write('Added.md', 'new since');
    await settle(mac);
    await host.close();
    // As a disk snapshot would: the old database comes back, with nothing rewritten in it.
    for (const ending of ['', '-wal', '-shm'])
      await rm(join(data, `host.sqlite${ending}`), { force: true });
    await copyFile(join(target, 'snapshots', `${backup.name}.sqlite`), join(data, 'host.sqlite'));
    host = new Host({ dataDir: data, maxWait: 1 });
    await host.listen(Number(new URL(url).port), '127.0.0.1');
    server.host = host;
    expect(await settle(mac)).toEqual({ 'Kept.md': 'early\nlater', 'Added.md': 'new since' });
    expect(host.notebooks()[0]).toMatchObject({ files: 2 });
  });
});
