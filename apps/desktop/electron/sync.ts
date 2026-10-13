import { safeStorage } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import type { NoteVersion, SyncInfo } from '@opsidian/core';
import {
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

/** Runs sync for whichever notebook is open, and keeps each device's credential. */
export class SyncService {
  private vault: Vault | undefined;
  private engine: SyncEngine | undefined;
  private transport: Transport | undefined;
  private state: SyncState | undefined;
  private problem: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly userData: string,
    private readonly notify: (info: SyncInfo) => void,
  ) {}

  // Credentials live outside the notebook folder, encrypted with the Mac's keychain, so
  // copying or backing up a notebook never copies the right to sync as this device.
  private get tokensPath(): string {
    return join(this.userData, 'devices.json');
  }
  private async tokens(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.tokensPath, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }
  private async remember(device: string, token: string | undefined): Promise<void> {
    const tokens = await this.tokens();
    if (token === undefined) delete tokens[device];
    else
      tokens[device] = safeStorage.isEncryptionAvailable()
        ? `safe:${safeStorage.encryptString(token).toString('base64')}`
        : `plain:${token}`;
    await mkdir(dirname(this.tokensPath), { recursive: true });
    await writeFile(this.tokensPath, JSON.stringify(tokens), { mode: 0o600 });
  }
  private async token(device: string): Promise<string | undefined> {
    const stored = (await this.tokens())[device];
    if (!stored) return undefined;
    if (stored.startsWith('plain:')) return stored.slice(6);
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(5), 'base64'));
    } catch {
      return undefined;
    }
  }

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
      const token = await this.token(state.device);
      if (!token) this.problem = 'This Mac’s connection to the host was lost. Connect again.';
      else {
        this.transport = httpTransport(state.host, token);
        this.engine = new SyncEngine(vault.syncStore(), this.transport, state, () =>
          this.notify(this.info()),
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

  /** Spends an invitation. The device name is this Mac's. */
  invite(host: string, code: string): Promise<Pairing> {
    return pair(host, code, hostname().replace(/\.(local|lan)$/i, '') || 'Mac');
  }
  /** Ties a notebook folder to the host an invitation was just spent on. */
  async adopt(vault: Vault, host: string, pairing: Pairing): Promise<void> {
    await this.remember(pairing.device.id, pairing.token);
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
    await this.remember(state.device, undefined);
    await this.attach(vault);
  }
  confirmDeletions(): void {
    this.engine?.confirmDeletions();
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
