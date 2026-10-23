import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Host } from '../apps/host/src/host';
import { takeOver, type TakeOverProgress } from '../apps/host/src/move';
import { Vault } from '../apps/desktop/electron/vault';
import { SyncService, type Secrets } from '../packages/notebook/src/index';
import { httpTransport } from '../packages/sync/src/index';
import type { SyncInfo } from '../packages/core/src/index';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
async function folder(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'opsidian-move-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
/** A port nothing is listening on, so a host can be told its address before it starts. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  await new Promise((done) => server.close(done));
  return port;
}
async function until(what: string, test: () => boolean | Promise<boolean>, ms = 15000) {
  const by = Date.now() + ms;
  while (!(await test())) {
    if (Date.now() > by) throw new Error(`Timed out waiting until ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A machine that can host: its data folder, and the host while it runs. */
async function machine() {
  const data = await folder();
  const port = await freePort();
  const self = {
    data,
    url: `http://127.0.0.1:${port}`,
    host: undefined as Host | undefined,
    async start() {
      self.host = new Host({ dataDir: data, maxWait: 1 });
      await self.host.listen(port, '127.0.0.1');
    },
    async stop() {
      await self.host?.close();
      self.host = undefined;
    },
  };
  cleanup.push(() => self.stop());
  return self;
}
type Machine = Awaited<ReturnType<typeof machine>>;

/** A device as the apps run one: a notebook folder and the sync service, which follows moves. */
async function device(at: Machine, name: string) {
  const root = await folder();
  const vault = await Vault.open(root);
  const tokens = new Map<string, string>();
  const secrets: Secrets = {
    get: async (id) => tokens.get(id),
    set: async (id, token) => void (token ? tokens.set(id, token) : tokens.delete(id)),
  };
  let info: SyncInfo = { connected: false };
  const sync = new SyncService(
    secrets,
    () => name,
    (next) => (info = next),
  );
  const { code } = at.host!.invite('Notes');
  await sync.adopt(vault, at.url, await sync.invite(at.url, code));
  cleanup.push(async () => {
    await sync.attach(null);
    vault.close();
  });
  return {
    name,
    root,
    sync,
    get info() {
      return info;
    },
    async write(path: string, content: string) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
      sync.kick();
    },
    read: (path: string) => readFile(join(root, path), 'utf8').catch(() => undefined),
    files: async () => Object.keys((await vault.syncState())?.files ?? {}).length,
  };
}

describe('moving a host to another machine', () => {
  it('takes every notebook, device and version along; devices follow by themselves', async () => {
    const mini = await machine();
    await mini.start();
    const laptop = await device(mini, 'MacBook');
    const phone = await device(mini, 'iPhone');
    await laptop.write('Plan.md', 'one\n');
    await laptop.write('Ideas/Garden.md', 'tomatoes\n');
    await until(
      'the phone has the notes',
      async () => (await phone.read('Ideas/Garden.md')) === 'tomatoes\n',
    );
    const before = mini.host!.devices().map((each) => each.id);
    const head = mini.host!.notebooks()[0]!.head;

    const vps = await machine();
    const { code } = mini.host!.handoff();
    const phases: TakeOverProgress['phase'][] = [];
    let paused = false;
    const moved = await takeOver({
      from: mini.url,
      code,
      dataDir: vps.data,
      to: vps.url,
      progress: (progress) => {
        phases.push(progress.phase);
        // An edit made while the last of the data is copied waits on the device, then follows.
        if (progress.phase === 'pausing' && !paused) {
          paused = true;
          void laptop.write('Plan.md', 'one\ntwo, written mid-move\n');
        }
      },
      afterInstall: () => vps.start(),
    });
    expect(moved.notebooks.map((each) => each.name)).toEqual(['Notes']);
    expect(moved.devices).toBe(2);
    expect(phases).toEqual(expect.arrayContaining(['copying', 'pausing', 'finishing']));

    await until('both devices follow', () =>
      [laptop, phone].every((each) => each.info.host === vps.url),
    );
    await until(
      'the edit made mid-move arrives',
      async () => (await phone.read('Plan.md')) === 'one\ntwo, written mid-move\n',
    );
    // Nothing was sent again and nothing was doubled: one more version, for the one edit.
    expect(vps.host!.notebooks()[0]!.head).toBe(head + 1);
    expect(vps.host!.devices().map((each) => each.id)).toEqual(before);
    for (const each of [laptop, phone]) {
      expect(each.info.state).not.toBe('error');
      expect(await each.files()).toBe(2);
    }
    const told = mini.host!.moved()!;
    expect(told.to).toBe(vps.url);
    expect(told.devices.every((each) => each.told)).toBe(true);
    // The old host only points the way now, and makes no new invitations.
    expect(() => mini.host!.invite('Notes')).toThrow(/moved/);
    expect(() => mini.host!.handoff()).toThrow(/already moved/);
  });

  it('keeps the history’s identity, so a device carries on rather than starting again', async () => {
    const mini = await machine();
    await mini.start();
    const laptop = await device(mini, 'MacBook');
    await laptop.write('Plan.md', 'one\n');
    await until('the note is on the host', () => mini.host!.notebooks()[0]!.files === 1);
    const generation = async (url: string, token: string) =>
      (await httpTransport(url, token).changes(0, 0)).generation;
    const vps = await machine();
    // A device's credential is only known to its host, so pair one to read the generation with.
    const { code: invite } = mini.host!.invite('Notes');
    const reader = await laptop.sync.invite(mini.url, invite);
    const old = await generation(mini.url, reader.token);
    await takeOver({
      from: mini.url,
      code: mini.host!.handoff().code,
      dataDir: vps.data,
      to: vps.url,
      afterInstall: () => vps.start(),
    });
    expect(await generation(vps.url, reader.token)).toBe(old);
  });

  it('is refused with a wrong or spent code, and never overwrites a machine that hosts', async () => {
    const mini = await machine();
    await mini.start();
    await device(mini, 'MacBook');
    const vps = await machine();
    await expect(
      takeOver({ from: mini.url, code: 'AAAA-BBBB-CCCC', dataDir: vps.data, to: vps.url }),
    ).rejects.toThrow(/not valid/);

    const office = await machine();
    await office.start();
    office.host!.invite('Work');
    await office.stop();
    const { code } = mini.host!.handoff();
    await expect(
      takeOver({ from: mini.url, code, dataDir: office.data, to: office.url }),
    ).rejects.toThrow(/already hosts “Work”/);
    // Refused before the code was spent, so it still works for the right machine.
    await takeOver({ from: mini.url, code, dataDir: vps.data, to: vps.url });
    await expect(
      takeOver({ from: mini.url, code, dataDir: (await machine()).data, to: vps.url }),
    ).rejects.toThrow(/already moved/);
  });

  it('gives a move up cleanly when it fails part-way, and the old host carries on', async () => {
    const mini = await machine();
    await mini.start();
    const laptop = await device(mini, 'MacBook');
    await laptop.write('Plan.md', 'one\n');
    await until('the note is on the host', () => mini.host!.notebooks()[0]!.files === 1);
    const vps = await machine();
    let resumed = 0;
    mini.host!.moveHooks = { pause: async () => {}, resume: () => resumed++ };
    // The connection drops just as the database is being sent.
    const flaky: typeof fetch = async (input, init) => {
      if (String(input).includes('/move/database')) throw new TypeError('fetch failed');
      return fetch(input, init);
    };
    await expect(
      takeOver({
        from: mini.url,
        code: mini.host!.handoff().code,
        dataDir: vps.data,
        to: vps.url,
        request: flaky,
      }),
    ).rejects.toThrow();
    expect(mini.host!.movedTo()).toBeUndefined();
    expect(mini.host!.busyMoving).toBe(false);
    expect(resumed).toBe(1);
    expect(existsSync(join(vps.data, 'host.sqlite'))).toBe(false);
    // Changes are taken again at once.
    await laptop.write('Plan.md', 'one\ntwo\n');
    await until('the edit reaches the old host', () => mini.host!.notebooks()[0]!.head === 2);
  });

  it('moves back to a machine that hosted before, sending only what it lacks', async () => {
    const mini = await machine();
    await mini.start();
    const laptop = await device(mini, 'MacBook');
    await laptop.write('Big.md', 'x'.repeat(200_000));
    await until('the note is on the host', () => mini.host!.notebooks()[0]!.files === 1);

    const vps = await machine();
    await takeOver({
      from: mini.url,
      code: mini.host!.handoff().code,
      dataDir: vps.data,
      to: vps.url,
      afterInstall: () => vps.start(),
    });
    await until('the laptop follows to the server', () => laptop.info.host === vps.url);
    await laptop.write('Small.md', 'hello\n');
    await until('the new note is on the server', () => vps.host!.notebooks()[0]!.files === 2);

    // Back to the Mac mini. What it held is an old copy, so it may be replaced.
    let copied = 0;
    await takeOver({
      from: vps.url,
      code: vps.host!.handoff().code,
      dataDir: mini.data,
      to: mini.url,
      progress: (progress) => {
        if (progress.phase === 'copying') copied = Math.max(copied, progress.total);
      },
      beforeInstall: () => mini.stop(),
      afterInstall: () => mini.start(),
    });
    expect(copied).toBeLessThan(1000);
    await until('the laptop follows back', () => laptop.info.host === mini.url);
    expect(mini.host!.movedTo()).toBeUndefined();
    expect(mini.host!.notebooks()[0]!.files).toBe(2);
    await laptop.write('Small.md', 'hello again\n');
    await until('edits reach it', () => mini.host!.notebooks()[0]!.head === 3);
  });

  it('brings the copies kept on GitHub, exactly, and pauses them while it copies', async () => {
    const mini = await machine();
    await mini.start();
    const checkout = join(mini.data, 'mirrors', 'some-notebook');
    await mkdir(join(checkout, '.git', 'refs', 'tags'), { recursive: true });
    await writeFile(join(checkout, 'run.sh'), '#!/bin/sh\n');
    await chmod(join(checkout, 'run.sh'), 0o755);
    await symlink('run.sh', join(checkout, 'link'));
    await writeFile(join(mini.data, 'mirrors', 'some-notebook.lock'), 'held');
    let paused = 0;
    mini.host!.moveHooks = { pause: async () => void paused++ };
    mini.host!.invite('Notes');

    const vps = await machine();
    await takeOver({
      from: mini.url,
      code: mini.host!.handoff().code,
      dataDir: vps.data,
      to: vps.url,
    });
    expect(paused).toBe(1);
    const copy = join(vps.data, 'mirrors', 'some-notebook');
    expect((await lstat(join(copy, 'run.sh'))).mode & 0o777).toBe(0o755);
    expect(await readlink(join(copy, 'link'))).toBe('run.sh');
    expect(existsSync(join(copy, '.git', 'refs', 'tags'))).toBe(true);
    expect(existsSync(join(vps.data, 'mirrors', 'some-notebook.lock'))).toBe(false);
  });

  it('lets only the machine with the code copy anything', async () => {
    const mini = await machine();
    await mini.start();
    for (const path of ['/v1/move/files', '/v1/move/file?path=blobs', '/v1/move/database'])
      expect((await fetch(`${mini.url}${path}`)).status).toBe(401);
    const response = await fetch(`${mini.url}/v1/move/finish`, {
      method: 'POST',
      headers: { authorization: 'Bearer guess', 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'http://evil:4810' }),
    });
    expect(response.status).toBe(401);
    expect(mini.host!.movedTo()).toBeUndefined();
  });
});
