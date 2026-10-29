import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Host, listBackups, restoreBackup } from '../apps/host/src/host';
import { Mirrors } from '../apps/host/src/mirror';
import { Vault } from '../apps/desktop/electron/vault';
import { SyncEngine, httpTransport, pair, type SyncState } from '../packages/sync/src/index';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
async function folder() {
  const directory = await mkdtemp(join(tmpdir(), 'opsidian-delete-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function startHost(maxWait = 1) {
  const data = await folder();
  const host = new Host({ dataDir: data, maxWait });
  const url = await host.listen(0, '127.0.0.1');
  cleanup.push(() => host.close());
  return { host, url, data };
}
type Server = Awaited<ReturnType<typeof startHost>>;

/** A device with its own notebook folder, synced by hand. */
async function device(server: Server, name: string, notebook: string) {
  const { code } = server.host.invite(notebook);
  const paired = await pair(server.url, code, name);
  const root = await folder();
  const vault = await Vault.open(root);
  cleanup.push(() => vault.close());
  const state: SyncState = {
    version: 1,
    host: server.url,
    notebook: paired.notebook.id,
    device: paired.device.id,
    deviceName: name,
    cursor: 0,
    files: {},
  };
  const engine = new SyncEngine(
    vault.syncStore(),
    httpTransport(server.url, paired.token),
    state,
    () => {},
    { wait: 1 },
  );
  return {
    root,
    id: paired.device.id,
    notebook: paired.notebook.id,
    token: paired.token,
    engine,
    write: async (path: string, content: string) => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    },
    read: (path: string) => readFile(join(root, path), 'utf8'),
  };
}

/** Rows anywhere in the host's database that still belong to a notebook. */
function rowsOf(data: string, notebook: string): Record<string, number> {
  const db = new DatabaseSync(join(data, 'host.sqlite'), { readOnly: true });
  try {
    const count = (sql: string, ...args: string[]) => db.prepare(sql).get(...args)!.n as number;
    return {
      notebooks: count('select count(*) as n from notebooks where id = ?', notebook),
      ...Object.fromEntries(
        ['files', 'log', 'ops', 'blobs', 'invites', 'mirrors'].map((table) => [
          table,
          count(`select count(*) as n from ${table} where notebook = ?`, notebook),
        ]),
      ),
      meta: count('select count(*) as n from meta where name = ?', `floor:${notebook}`),
      devicesLetIn: count(
        'select count(*) as n from devices where notebook = ? and revoked = 0',
        notebook,
      ),
    };
  } finally {
    db.close();
  }
}

describe('deleting a notebook from the host', () => {
  it('takes its files, history and content, and nothing of another notebook', async () => {
    const server = await startHost();
    const { host, data } = server;
    const mac = await device(server, 'Mac', 'Notes');
    const phone = await device(server, 'Phone', 'Work');
    await mac.write('Note.md', 'first');
    await mac.engine.sync();
    await mac.write('Note.md', 'second');
    await mac.write('Folder/Other.md', 'more');
    await mac.engine.sync();
    await phone.write('Plan.md', 'work');
    await phone.engine.sync();
    host.invite('Notes');

    // Named in any letter case, as `host remove` takes device names.
    const deleted = await host.deleteNotebook('notes');
    expect(deleted).toMatchObject({ name: 'Notes', files: 2, versions: 3 });

    expect(host.notebooks().map((each) => each.name)).toEqual(['Work']);
    expect(host.devices().map((each) => each.name)).toEqual(['Phone']);
    expect(host.invitations()).toEqual([]);
    expect(rowsOf(data, mac.notebook)).toEqual({
      notebooks: 0,
      files: 0,
      log: 0,
      ops: 0,
      blobs: 0,
      invites: 0,
      mirrors: 0,
      meta: 0,
      devicesLetIn: 0,
    });
    expect(existsSync(join(data, 'blobs', mac.notebook))).toBe(false);
    expect(existsSync(join(data, 'blobs', phone.notebook))).toBe(true);

    // The Mac is told why, and keeps every note it has.
    await expect(mac.engine.sync()).rejects.toThrow('This notebook was deleted from the host');
    expect(await mac.read('Note.md')).toBe('second');
    expect(await mac.read('Folder/Other.md')).toBe('more');

    // The other notebook carries on as before.
    await phone.write('Plan.md', 'work, later');
    await phone.engine.sync();
    expect(host.notebooks()).toMatchObject([{ name: 'Work', files: 1, versions: 2 }]);

    // The name is free again, for a new and empty notebook the old devices are not part of.
    const again = await device(server, 'New Mac', 'Notes');
    expect(again.notebook).not.toBe(mac.notebook);
    expect(host.notebooks().find((each) => each.name === 'Notes')).toMatchObject({ files: 0 });
    await expect(mac.engine.sync()).rejects.toThrow('deleted from the host');
  });

  it('tells a device waiting for changes at once', async () => {
    const server = await startHost(25);
    const mac = await device(server, 'Mac', 'Notes');
    await mac.write('Note.md', 'text');
    await mac.engine.sync();
    const waiting = httpTransport(server.url, mac.token).changes(1, 25);
    const outcome = waiting.then(
      () => 'answered',
      (error: Error) => error.message,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const started = Date.now();
    await server.host.deleteNotebook('Notes');
    expect(await outcome).toContain('deleted from the host');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('is undone by restoring a backup, which does not let its old devices back in', async () => {
    const server = await startHost();
    const mac = await device(server, 'Mac', 'Notes');
    await mac.write('Note.md', 'kept');
    await mac.engine.sync();
    const backups = await folder();
    const backup = await server.host.backup(backups);
    await server.host.deleteNotebook('Notes');

    await server.host.close();
    await restoreBackup(server.data, backups, backup.name);
    const host = new Host({ dataDir: server.data, maxWait: 1 });
    const url = await host.listen(0, '127.0.0.1');
    cleanup.push(() => host.close());

    expect(host.notebooks()).toMatchObject([{ name: 'Notes', files: 1 }]);
    // Its content came back with it: a new device gets the note.
    const restored = { host, url, data: server.data };
    const fresh = await device(restored, 'New Mac', 'Notes');
    await fresh.engine.sync();
    expect(await fresh.read('Note.md')).toBe('kept');
    // The old device was removed with the notebook, and stays removed.
    expect(host.devices().find((each) => each.name === 'Mac')).toMatchObject({ revoked: true });
    await expect(httpTransport(url, mac.token).changes(0, 0)).rejects.toThrow(
      'removed from the host',
    );
  });

  it('refuses a name it does not have, and a host that moved away', async () => {
    const server = await startHost();
    await device(server, 'Mac', 'Notes');
    await expect(server.host.deleteNotebook('Nope')).rejects.toThrow('no notebook called “Nope”');
    const db = new DatabaseSync(join(server.data, 'host.sqlite'));
    db.prepare(
      "insert into meta (name, value) values ('moved_to', 'http://100.64.0.9:4810')",
    ).run();
    db.close();
    await expect(server.host.deleteNotebook('Notes')).rejects.toThrow(
      'moved to 100.64.0.9:4810. Delete notebooks there.',
    );
    expect(server.host.notebooks()).toHaveLength(1);
  });
});

describe('deleting a notebook kept on GitHub', () => {
  const IDENTITY = ['-c', 'user.name=Someone', '-c', 'user.email=someone@example.com'];
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', [...IDENTITY, '-c', 'init.defaultBranch=main', ...args], {
      cwd,
      encoding: 'utf8',
    });

  it('stops its copy and removes its checkout, leaving the repository as it is', async () => {
    const server = await startHost();
    const remote = join(await folder(), 'notes.git');
    await mkdir(remote);
    git(remote, 'init', '--bare', '--quiet');
    const mirrors = new Mirrors({ host: server.host, dataDir: server.data, quiet: 50 });
    cleanup.push(() => mirrors.stop());
    const mac = await device(server, 'Mac', 'Notes');
    await mac.write('Note.md', 'on GitHub too');
    await mac.engine.sync();
    await mirrors.connect('Notes', remote);
    mirrors.start();
    const checkout = join(server.data, 'mirrors', mac.notebook);
    expect(existsSync(checkout)).toBe(true);

    await mirrors.deleteNotebook('Notes');
    expect(server.host.mirrors()).toEqual([]);
    expect(server.host.devices()).toEqual([]);
    expect(existsSync(checkout)).toBe(false);
    expect(git(remote, 'show', 'main:Note.md')).toBe('on GitHub too');
    // Nothing starts it again.
    mirrors.refresh();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(existsSync(checkout)).toBe(false);
  });

  it('leaves no checkout when another process, such as `host delete`, deletes the notebook', async () => {
    const server = await startHost();
    const remote = join(await folder(), 'notes.git');
    await mkdir(remote);
    git(remote, 'init', '--bare', '--quiet');
    const mirrors = new Mirrors({ host: server.host, dataDir: server.data, quiet: 50 });
    cleanup.push(() => mirrors.stop());
    await mirrors.connect('Notes', remote);
    mirrors.start();
    const id = server.host.notebookId('Notes')!;
    expect(existsSync(join(server.data, 'mirrors', id))).toBe(true);
    // As `host delete` does from the command line: the database is the same, the copy is not.
    const elsewhere = new Host({ dataDir: server.data });
    await elsewhere.deleteNotebook('Notes');
    await elsewhere.close();
    mirrors.refresh();
    await expect
      .poll(() => existsSync(join(server.data, 'mirrors', id)), { timeout: 3000 })
      .toBe(false);
  });
});

describe('host delete, on the command line', () => {
  let cli: string;
  beforeAll(async () => {
    cli = join(await mkdtemp(join(tmpdir(), 'opsidian-cli-')), 'opsidian.mjs');
    await build({
      entryPoints: ['apps/host/src/cli.ts'],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      outfile: cli,
      banner: {
        js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
      },
      logLevel: 'warning',
    });
  });
  afterAll(() => rm(dirname(cli), { recursive: true, force: true }));

  const run = (home: string, ...args: string[]) => {
    const done = spawnSync(process.execPath, [cli, 'host', ...args], {
      env: { ...process.env, OPSIDIAN_HOME: home },
      encoding: 'utf8',
    });
    return { code: done.status, out: done.stdout + done.stderr };
  };

  it('says what goes and deletes nothing until --yes; backs up first when backups are on', async () => {
    const home = await folder();
    const data = join(home, 'host');
    const host = new Host({ dataDir: data });
    const url = await host.listen(0, '127.0.0.1');
    cleanup.push(() => host.close());
    const server = { host, url, data };
    const mac = await device(server, 'Mac', 'Personal');
    await device(server, 'Phone', 'Personal');
    await device(server, 'Laptop', 'Work');
    await mac.write('Note.md', 'text');
    await mac.engine.sync();

    const asked = run(home, 'delete', 'personal');
    expect(asked.code).toBe(1);
    expect(asked.out).toContain('Deleting “Personal” takes from this host:');
    expect(asked.out).toContain('1 file, and their whole history: 1 version');
    expect(asked.out).toContain('Mac, Phone, which stop syncing it and keep the notes they have');
    expect(asked.out).toContain('Backups are off, so it cannot be brought back.');
    expect(asked.out).toContain('host delete "Personal" --yes');
    expect(host.notebooks()).toHaveLength(2);

    const missing = run(home, 'delete', 'Nope', '--yes');
    expect(missing.code).toBe(1);
    expect(missing.out).toContain('There is no notebook called “Nope” here.');

    const backups = join(home, 'backups');
    await writeFile(
      join(home, 'host.json'),
      JSON.stringify({
        port: 4810,
        address: '127.0.0.1',
        backup: { folder: backups, keep: 3, hour: 3 },
      }),
    );
    expect(run(home, 'delete', 'Personal').out).toContain(
      `The host is backed up first, to ${backups}; restoring that backup brings it back.`,
    );
    const done = run(home, 'delete', 'Personal', '--yes');
    expect(done.out).toContain('Backed up the host first');
    expect(done.out).toContain('Deleted “Personal” from the host.');
    expect(done.code).toBe(0);
    // The running host sees it at once: the database is shared.
    expect(host.notebooks().map((each) => each.name)).toEqual(['Work']);
    await expect(mac.engine.sync()).rejects.toThrow('deleted from the host');
    const [backup] = await listBackups(backups);
    expect(backup!.notebooks.map((each) => each.name)).toEqual(['Personal', 'Work']);
    expect(await readdir(join(data, 'blobs'))).toHaveLength(0);
  });
});
