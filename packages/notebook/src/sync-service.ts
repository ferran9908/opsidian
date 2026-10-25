import type { NoteVersion, SyncInfo } from '@opsidian/core';
import {
  diagnose,
  type Check,
  SyncEngine,
  httpTransport,
  leave,
  pair,
  type Pairing,
  type SyncState,
  type Transport,
} from '@opsidian/sync';
import type { Vault } from './vault';

/** `192.168.1.4:4810` and `http://host/` both become `http://host…` without a trailing slash. */
export function hostAddress(value: string): string {
  const typed = value.trim();
  const url = new URL(/^[a-z]+:\/\//i.test(typed) ? typed : `http://${typed}`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('The host address should start with http:// or https://');
  return `${url.protocol}//${url.host}`;
}

/**
 * Where a device keeps its credentials: outside the notebook folder and protected by the
 * system, so copying or backing up a notebook never copies the right to sync as this device.
 */
export interface Secrets {
  get(device: string): Promise<string | undefined>;
  set(device: string, token: string | undefined): Promise<void>;
}

/** What a device needs to sync a notebook folder again, without the folder itself. */
export type Connection = Pick<
  SyncState,
  'host' | 'notebook' | 'notebookName' | 'device' | 'deviceName'
>;

/**
 * Which host each notebook folder syncs with, kept outside the folders. A folder's own record
 * goes with it if it is deleted, and this is what lets its notes be downloaded again, or this
 * device be removed from the host, afterwards.
 */
export interface Connections {
  get(root: string): Promise<Connection | undefined>;
  set(root: string, connection: Connection | undefined): Promise<void>;
}

/** Runs sync for whichever notebook is open. */
export class SyncService {
  private vault: Vault | undefined;
  private engine: SyncEngine | undefined;
  private transport: Transport | undefined;
  private state: SyncState | undefined;
  private problem: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Tries again to follow a host that moved, while its new address does not answer yet. */
  private retry: ReturnType<typeof setTimeout> | undefined;
  private retries = 0;
  /** The credential is gone from this device, so only a new invitation helps. */
  private lost = false;

  constructor(
    private readonly secrets: Secrets,
    /** What the host should call this device. */
    private readonly deviceName: () => string,
    private readonly notify: (info: SyncInfo) => void,
    /** How requests reach the host; the device's own `fetch` unless given. */
    private readonly request?: typeof fetch,
    /** Stands in for `crypto.randomUUID` on devices that lack it. */
    private readonly newId?: () => string,
    /** Where each folder's host is remembered; without it, only the folder knows. */
    private readonly connections?: Connections,
  ) {}

  info(): SyncInfo {
    if (!this.state) return { connected: false };
    const status = this.engine?.status;
    return {
      connected: true,
      host: this.state.host,
      device: this.state.deviceName,
      ...(this.state.notebookName ? { notebook: this.state.notebookName } : {}),
      ...(status ?? { state: 'error' as const, waiting: 0 }),
      ...(this.problem ? { state: 'error' as const, message: this.problem } : {}),
      ...(this.lost ? { removed: true } : {}),
    };
  }

  /** Follows the app to another notebook, or to none. */
  async attach(vault: Vault | null): Promise<void> {
    clearTimeout(this.timer);
    clearTimeout(this.retry);
    this.vault?.onRelocate(undefined);
    this.vault?.onActivity(undefined);
    // Nothing of the old notebook's sync may still be writing when the next one starts.
    await this.engine?.stop();
    this.engine = this.transport = this.state = this.problem = undefined;
    this.lost = false;
    this.vault = vault ?? undefined;
    const state = await vault?.syncState();
    if (vault && state) {
      this.state = state;
      const token = await this.secrets.get(state.device);
      if (!token) {
        this.problem = 'This device’s connection to the host was lost. Connect again.';
        this.lost = true;
      } else {
        await this.connections?.set(vault.root, connectionOf(state)).catch(() => {});
        this.transport = httpTransport(state.host, token, this.request);
        this.engine = new SyncEngine(
          vault.syncStore(),
          this.transport,
          state,
          () => this.notify(this.info()),
          {
            ...(this.newId ? { newId: this.newId } : {}),
            onMoved: (to) => void this.followMove(vault, state.host, to),
          },
        );
        const engine = this.engine;
        vault.onRelocate((from, to) => void engine.moved(from, to).catch(() => {}));
        // Saves, and anything another program does, show up as activity in the folder.
        vault.onActivity(() => {
          clearTimeout(this.timer);
          this.timer = setTimeout(() => engine.kick(), 100);
        });
        engine.start();
      }
    }
    this.notify(this.info());
  }

  /** Spends an invitation. */
  invite(host: string, code: string): Promise<Pairing> {
    return pair(host, code, this.deviceName(), this.request);
  }
  /** Ties a notebook folder to the host an invitation was just spent on. */
  async adopt(vault: Vault, host: string, pairing: Pairing): Promise<void> {
    await this.secrets.set(pairing.device.id, pairing.token);
    await vault.syncStore().save({
      version: 1,
      host,
      notebook: pairing.notebook.id,
      notebookName: pairing.notebook.name,
      device: pairing.device.id,
      deviceName: pairing.device.name,
      cursor: 0,
      files: {},
    });
    await this.attach(vault);
  }
  /**
   * Stops syncing the open notebook. Every file stays; the host is asked to forget this
   * device, so its credential is no use to anyone. Resolves to whether the host heard.
   */
  async disconnect(): Promise<{ hostTold: boolean }> {
    const { vault, state } = this;
    if (!vault || !state) return { hostTold: true };
    vault.onRelocate(undefined);
    vault.onActivity(undefined);
    await this.engine?.stop();
    const hostTold = await this.leave(state);
    await vault.forgetSync().catch(() => {});
    await this.secrets.set(state.device, undefined);
    await this.connections?.set(vault.root, undefined);
    await this.attach(vault);
    return { hostTold };
  }
  private async leave(connection: Connection): Promise<boolean> {
    const token = await this.secrets.get(connection.device);
    return token ? leave(connection.host, token, this.request) : true;
  }

  /** The host a notebook folder synced with, even if the folder is gone. */
  async remembered(root: string): Promise<Connection | undefined> {
    const connection = await this.connections?.get(root);
    return connection && (await this.secrets.get(connection.device)) ? connection : undefined;
  }
  /**
   * Fills an empty folder with the notebook a folder at `root` used to sync, as this same
   * device: for a notebook folder that was deleted. Nothing needs to be invited again.
   */
  async restore(vault: Vault, root: string): Promise<void> {
    const connection = await this.remembered(root);
    if (!connection) throw new Error('This Mac no longer knows the host for that notebook.');
    if ((await vault.syncStore().list()).length || (await vault.syncState()))
      throw new Error('The folder is not empty, so the notebook was not downloaded into it.');
    await vault.syncStore().save({ version: 1, ...connection, cursor: 0, files: {} });
    if (root !== vault.root) await this.connections?.set(root, undefined);
    await this.attach(vault);
  }
  /**
   * Gives up a notebook whose folder is gone: the host forgets this device and this device
   * forgets the host. Resolves to whether the host heard.
   */
  async forget(root: string): Promise<{ hostTold: boolean }> {
    const connection = await this.connections?.get(root);
    if (!connection) return { hostTold: true };
    const hostTold = await this.leave(connection);
    await this.secrets.set(connection.device, undefined);
    await this.connections?.set(root, undefined);
    return { hostTold };
  }
  /**
   * Syncs with the host at another address from now on: the same host, moved to another
   * machine. It is checked first: only the host this device belongs to accepts its credential,
   * so the credential is shown only to something that has already answered as a host.
   */
  follow(address: string): Promise<void> {
    return this.switching((vault, state) => this.moveTo(vault, state, address));
  }
  /** One change of address at a time, so the last one asked for is the one that stands. */
  private switching(task: (vault: Vault, state: SyncState) => Promise<void>): Promise<void> {
    const next = this.moving
      .catch(() => {})
      .then(() => {
        const { vault, state } = this;
        if (!vault || !state) throw new Error('This notebook is not syncing.');
        return task(vault, state);
      });
    this.moving = next;
    return next;
  }
  private moving: Promise<void> = Promise.resolve();
  private async moveTo(vault: Vault, state: SyncState, address: string): Promise<void> {
    const to = hostAddress(address);
    const token = await this.secrets.get(state.device);
    if (!token) throw new Error('This device’s connection to the host was lost. Connect again.');
    await verifyHost(to, token, this.request ?? fetch);
    await this.engine?.stop();
    // What the engine last saved, not what this service was given when it started.
    const saved = (await vault.syncState()) ?? state;
    await vault.syncStore().save({ ...saved, host: to });
    await this.attach(vault);
  }
  /** The host said it moved: follow it, and keep trying while the new address is not ready. */
  private async followMove(vault: Vault, from: string, to: string): Promise<void> {
    try {
      await this.switching(async (current, state) => {
        // Already pointed somewhere else, such as this very machine when it took the host
        // over: that choice stands.
        if (current !== vault || state.host !== from) return;
        await this.moveTo(current, state, to);
      });
      this.retries = 0;
    } catch (error) {
      if (this.vault !== vault || this.state?.host !== from) return;
      this.problem = `The host moved to ${to.replace(/^https?:\/\//, '')}, but ${error instanceof Error ? error.message.charAt(0).toLowerCase() + error.message.slice(1) : 'it does not answer there yet.'}`;
      this.notify(this.info());
      clearTimeout(this.retry);
      // Starting over asks the old host again, which says where it went, which tries again.
      const wait = [2, 5, 15][this.retries++] ?? 30;
      this.retry = setTimeout(() => void this.attach(vault), wait * 1000);
    }
  }
  confirmDeletions(): void {
    this.engine?.confirmDeletions();
  }
  /** Works out why this device and its host are not talking. Empty when not connected. */
  async check(device: string, online: () => Promise<boolean>): Promise<Check[]> {
    if (!this.state) return [];
    return diagnose(this.state.host, await this.secrets.get(this.state.device), {
      device,
      online,
      ...(this.request ? { request: this.request } : {}),
    });
  }
  /** The open notebook's folder. */
  get root(): string | undefined {
    return this.vault?.root;
  }
  /** The id the host knows this device by. */
  get deviceId(): string | undefined {
    return this.state?.device;
  }
  /** Syncs now instead of waiting, for example when the app comes back to the front. */
  kick(): void {
    this.engine?.kick();
  }

  async history(path: string): Promise<NoteVersion[]> {
    const file = this.engine?.fileAt(path);
    if (!file || !this.transport) return [];
    return this.transport.history(file);
  }
  async versionText(hash: string): Promise<string> {
    if (!this.transport) throw new Error('This notebook is not syncing.');
    return new TextDecoder().decode(await this.transport.getBlob(hash));
  }
}

const connectionOf = ({ host, notebook, notebookName, device, deviceName }: SyncState) => ({
  host,
  notebook,
  ...(notebookName ? { notebookName } : {}),
  device,
  deviceName,
});

/** Checks that `host` is an Opsidian host that accepts this device. */
async function verifyHost(host: string, token: string, request: typeof fetch): Promise<void> {
  const short = host.replace(/^https?:\/\//, '');
  const ask = async (path: string, headers: Record<string, string> = {}) => {
    // Not AbortSignal.timeout, which the iPhone's JavaScript engine lacks.
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 8000);
    try {
      return await request(`${host}/v1${path}`, { headers, signal: stop.signal });
    } catch {
      throw new Error(`Nothing answers at ${short} yet.`);
    } finally {
      clearTimeout(timer);
    }
  };
  const hello = (await (await ask('')).json().catch(() => undefined)) as
    { opsidian?: string; moved?: boolean } | undefined;
  if (hello?.opsidian !== 'host')
    throw new Error(`What answers at ${short} is not an Opsidian host.`);
  if (hello.moved) throw new Error(`The host at ${short} has moved on too.`);
  const whoami = await ask('/whoami', { authorization: `Bearer ${token}` });
  if (!whoami.ok)
    throw new Error(
      whoami.status === 401
        ? `The host at ${short} does not know this device. It may be a different host.`
        : `The host at ${short} answered ${whoami.status}.`,
    );
}
