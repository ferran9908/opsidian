import type { NoteVersion, SyncInfo } from '@opsidian/core';
import {
  diagnose,
  type Check,
  SyncEngine,
  httpTransport,
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

/** Runs sync for whichever notebook is open. */
export class SyncService {
  private vault: Vault | undefined;
  private engine: SyncEngine | undefined;
  private transport: Transport | undefined;
  private state: SyncState | undefined;
  private problem: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly secrets: Secrets,
    /** What the host should call this device. */
    private readonly deviceName: () => string,
    private readonly notify: (info: SyncInfo) => void,
    /** How requests reach the host; the device's own `fetch` unless given. */
    private readonly request?: typeof fetch,
    /** Stands in for `crypto.randomUUID` on devices that lack it. */
    private readonly newId?: () => string,
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
    };
  }

  /** Follows the app to another notebook, or to none. */
  async attach(vault: Vault | null): Promise<void> {
    clearTimeout(this.timer);
    this.vault?.onRelocate(undefined);
    this.vault?.onActivity(undefined);
    // Nothing of the old notebook's sync may still be writing when the next one starts.
    await this.engine?.stop();
    this.engine = this.transport = this.state = this.problem = undefined;
    this.vault = vault ?? undefined;
    const state = await vault?.syncState();
    if (vault && state) {
      this.state = state;
      const token = await this.secrets.get(state.device);
      if (!token) this.problem = 'This device’s connection to the host was lost. Connect again.';
      else {
        this.transport = httpTransport(state.host, token, this.request);
        this.engine = new SyncEngine(
          vault.syncStore(),
          this.transport,
          state,
          () => this.notify(this.info()),
          this.newId ? { newId: this.newId } : {},
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
  async disconnect(): Promise<void> {
    const { vault, state } = this;
    if (!vault || !state) return;
    vault.onRelocate(undefined);
    vault.onActivity(undefined);
    await this.engine?.stop();
    await vault.forgetSync();
    await this.secrets.set(state.device, undefined);
    await this.attach(vault);
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
