import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SyncInfo } from '@opsidian/core';
import { Host } from '../apps/host/src/host';
import { FolderGone, Vault } from '../apps/desktop/electron/vault';
import { SyncService, type Connection } from '../packages/notebook/src/index';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
async function folder() {
  const directory = await mkdtemp(join(tmpdir(), 'opsidian-leaving-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function startHost() {
  const host = new Host({ dataDir: await folder(), maxWait: 1 });
  const url = await host.listen(0, '127.0.0.1');
  cleanup.push(() => host.close());
  return { host, url };
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The Mac app's sync, with its keychain and its record of folders kept in memory. */
function mac(name: string) {
  const secrets = new Map<string, string>();
  const folders = new Map<string, Connection>();
  let info: SyncInfo = { connected: false };
  const service = new SyncService(
    {
      get: async (device) => secrets.get(device),
      set: async (device, token) =>
        void (token ? secrets.set(device, token) : secrets.delete(device)),
    },
    () => name,
    (next) => void (info = next),
    undefined,
    undefined,
    {
      get: async (root) => folders.get(root),
      set: async (root, connection) =>
        void (connection ? folders.set(root, connection) : folders.delete(root)),
    },
  );
  cleanup.push(() => service.attach(null));
  return {
    service,
    secrets,
    folders,
    get info() {
      return info;
    },
    /** Waits until this Mac is in step with the host. */
    async synced() {
      for (let wait = 0; wait < 100; wait++) {
        if (info.state === 'synced') return;
        await pause(50);
      }
      throw new Error(`Never synced: ${JSON.stringify(info)}`);
    },
  };
}
async function joined(server: Awaited<ReturnType<typeof startHost>>, name: string, root?: string) {
  const one = mac(name);
  const vault = await Vault.open(root ?? (await folder()));
  cleanup.push(() => vault.close());
  const { code } = server.host.invite('Notes');
  await one.service.adopt(vault, server.url, await one.service.invite(server.url, code));
  // Not spread: `info` is read as it is now, each time.
  return Object.assign(one, { vault });
}

describe('stopping syncing on a device', () => {
  it('removes the device from the host and keeps every note', async () => {
    const server = await startHost();
    const a = await joined(server, 'Mac A');
    await writeFile(join(a.vault.root, 'Note.md'), 'mine');
    a.service.kick();
    await a.synced();
    expect(await a.service.disconnect()).toEqual({ hostTold: true });
    expect(server.host.devices()).toMatchObject([{ name: 'Mac A', revoked: true }]);
    expect(a.info).toEqual({ connected: false });
    expect(a.secrets.size).toBe(0);
    expect(a.folders.size).toBe(0);
    expect(await a.vault.syncState()).toBeUndefined();
    expect(await readFile(join(a.vault.root, 'Note.md'), 'utf8')).toBe('mine');
  });

  it('still stops when the host cannot be reached, and says so', async () => {
    const server = await startHost();
    const a = await joined(server, 'Mac A');
    await a.synced();
    await server.host.close();
    expect(await a.service.disconnect()).toEqual({ hostTold: false });
    expect(a.info).toEqual({ connected: false });
    expect(a.secrets.size).toBe(0);
  });

  it('is told plainly when the host removed it', async () => {
    const server = await startHost();
    const a = await joined(server, 'Mac A');
    await a.synced();
    server.host.revoke(server.host.devices()[0]!.id);
    a.service.kick();
    for (let wait = 0; wait < 50 && !a.info.removed; wait++) await pause(50);
    expect(a.info).toMatchObject({ connected: true, state: 'error', removed: true });
    expect(await a.service.disconnect()).toEqual({ hostTold: true });
    expect(a.info).toEqual({ connected: false });
  });
});

describe('a synced notebook whose folder was deleted', () => {
  it('is not made again, empty, when the app next opens it', async () => {
    const root = join(await folder(), 'Notes');
    await expect(Vault.open(root, { create: false })).rejects.toBeInstanceOf(FolderGone);
    expect(existsSync(root)).toBe(false);
  });

  it('is downloaded again as the same device, with no new invitation', async () => {
    const server = await startHost();
    const root = join(await folder(), 'Notes');
    const a = await joined(server, 'Mac A', root);
    const b = await joined(server, 'Mac B');
    await writeFile(join(b.vault.root, 'One.md'), 'one');
    await writeFile(join(b.vault.root, 'Two.md'), 'two');
    b.service.kick();
    await b.synced();
    for (let wait = 0; wait < 50 && !existsSync(join(root, 'Two.md')); wait++) await pause(50);

    await rm(root, { recursive: true });
    await a.service.attach(null);
    expect(await a.service.remembered(a.vault.root)).toMatchObject({ notebookName: 'Notes' });
    const again = await Vault.open(root);
    cleanup.push(() => again.close());
    await a.service.restore(again, a.vault.root);
    for (let wait = 0; wait < 50 && !existsSync(join(root, 'Two.md')); wait++) await pause(50);
    expect(await readFile(join(root, 'One.md'), 'utf8')).toBe('one');
    expect(await readFile(join(root, 'Two.md'), 'utf8')).toBe('two');
    // Still the one device, and nothing was deleted from the other.
    expect(server.host.devices().map((each) => each.name)).toEqual(['Mac A', 'Mac B']);
    expect(existsSync(join(b.vault.root, 'One.md'))).toBe(true);
  });

  it('refuses to download into a folder that already holds notes', async () => {
    const server = await startHost();
    const root = join(await folder(), 'Notes');
    const a = await joined(server, 'Mac A', root);
    await a.synced();
    await a.service.attach(null);
    await rm(join(root, '.opsidian'), { recursive: true });
    await writeFile(join(root, 'Other.md'), 'something else');
    await expect(a.service.restore(a.vault, a.vault.root)).rejects.toThrow('not empty');
  });

  it('can be given up: the host forgets the device and the device forgets the host', async () => {
    const server = await startHost();
    const root = join(await folder(), 'Notes');
    const a = await joined(server, 'Mac A', root);
    await a.synced();
    await rm(root, { recursive: true });
    await a.service.attach(null);
    expect(await a.service.forget(a.vault.root)).toEqual({ hostTold: true });
    expect(server.host.devices()).toMatchObject([{ name: 'Mac A', revoked: true }]);
    expect(a.secrets.size).toBe(0);
    expect(await a.service.remembered(a.vault.root)).toBeUndefined();
  });
});
