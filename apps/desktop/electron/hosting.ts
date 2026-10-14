import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import qrcode from 'qrcode-generator';
import type { BackupInfo, HostingInfo, Invitation } from '@opsidian/core';
import type { SyncService, Vault } from '@opsidian/notebook';
import { listBackups, type Host } from '../../host/src/host';
import { invitationLink } from '../../host/src/home';
import type { HostReply, HostRequest } from './host-worker';

interface Saved {
  enabled: boolean;
  port: number;
  keepRunning: boolean;
  backup: { folder?: string; hour?: number; keep: number };
  /** The devices this Mac itself was paired as, one per notebook it hosts and has open. */
  own?: string[];
  /**
   * Which host notebook each notebook folder on this Mac is, by the folder's path. Two
   * folders can share a name; they must never share a host notebook.
   */
  folders?: Record<string, string>;
  failed?: { at: number; message: string };
}
const fresh = (): Saved => ({
  enabled: false,
  // The port can be moved for tests, or when 4810 is taken.
  port: Number(process.env.OPSIDIAN_HOST_PORT) || 4810,
  keepRunning: true,
  backup: { hour: 3, keep: 14 },
});
const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

/** Where other devices can reach this Mac: Tailscale first, then the local network. */
function addresses(port: number): HostingInfo['addresses'] {
  const found: HostingInfo['addresses'] = [];
  for (const [name, list] of Object.entries(networkInterfaces()))
    for (const each of list ?? []) {
      if (each.family !== 'IPv4' || each.internal) continue;
      // Tailscale hands out addresses from 100.64.0.0/10.
      const tailscale = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(each.address);
      // Besides Tailscale, only Wi-Fi and Ethernet are offered: the rest are bridges that
      // virtual machines and containers make, which no other device can reach.
      if (!tailscale && !/^en\d+$/.test(name)) continue;
      found.push({
        kind: tailscale ? 'tailscale' : 'network',
        address: `${each.address}:${port}`,
      });
    }
  return found.sort((a, b) => Number(b.kind === 'tailscale') - Number(a.kind === 'tailscale'));
}

class Failure extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** The host's thread, seen from the app: each call is a message there and back. */
class HostThread {
  private readonly worker = new Worker(join(__dirname, 'host-worker.cjs'));
  private readonly waiting = new Map<number, (reply: HostReply) => void>();
  private next = 0;
  private ended = false;

  constructor(onLost: (reason: string) => void) {
    this.worker.on('message', (reply: HostReply) => {
      this.waiting.get(reply.id)?.(reply);
      this.waiting.delete(reply.id);
    });
    const lost = (reason: string) => {
      if (this.ended) return;
      this.ended = true;
      for (const answer of this.waiting.values())
        answer({ id: -1, ok: false, message: 'Hosting stopped unexpectedly.' });
      this.waiting.clear();
      onLost(reason);
    };
    this.worker.on('error', (error) => lost(error.message));
    this.worker.on('exit', (code) => lost(`Hosting stopped unexpectedly (${code}).`));
  }

  call<T = void>(request: HostRequest): Promise<T> {
    if (this.ended) return Promise.reject(new Failure('Hosting stopped unexpectedly.'));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, (reply) =>
        reply.ok ? resolve(reply.value as T) : reject(new Failure(reply.message, reply.code)),
      );
      this.worker.postMessage({ id, request });
    });
  }
  async end(): Promise<void> {
    if (this.ended) return;
    await this.call({ op: 'close' }).catch(() => {});
    this.ended = true;
    await this.worker.terminate();
  }
}

interface Snapshot {
  notebooks: ReturnType<Host['notebooks']>;
  devices: ReturnType<Host['devices']>;
  invitations: ReturnType<Host['invitations']>;
}

/**
 * Runs a host inside the Mac app, so one Mac can serve a notebook to the others without
 * anything to install. The host's data lives in the app's own folder, apart from every
 * notebook folder.
 */
export class Hosting {
  private host: HostThread | undefined;
  private saved = fresh();
  private error: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private work: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly userData: string,
    private readonly sync: SyncService,
    private readonly notify: (info: HostingInfo) => void,
  ) {}

  private get file(): string {
    return join(this.userData, 'hosting.json');
  }
  private get data(): string {
    return join(this.userData, 'host');
  }
  private async save(): Promise<void> {
    await mkdir(this.userData, { recursive: true });
    await writeFile(this.file, JSON.stringify(this.saved), { mode: 0o600 });
  }
  /** One change to the host at a time, so a restore never overlaps a backup or a start. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.work.then(task);
    this.work = result.catch(() => {});
    return result;
  }
  private async tell(): Promise<HostingInfo> {
    const info = await this.info();
    this.notify(info);
    return info;
  }

  get keepRunning(): boolean {
    return Boolean(this.host) && this.saved.keepRunning;
  }

  /** Reads the settings and, if this Mac was hosting, starts hosting again. */
  async load(): Promise<void> {
    try {
      const read = JSON.parse(await readFile(this.file, 'utf8')) as Partial<Saved>;
      this.saved = { ...fresh(), ...read, backup: { ...fresh().backup, ...read.backup } };
    } catch {
      this.saved = fresh();
    }
    if (this.saved.enabled) await this.serial(() => this.open());
    // Often enough to catch the backup hour without the app having to stay awake for it.
    this.timer = setInterval(() => void this.backUpIfDue().catch(() => {}), 10 * 60 * 1000);
    void this.backUpIfDue().catch(() => {});
  }
  private async open(): Promise<void> {
    if (this.host) return;
    const host: HostThread = new HostThread((reason) => {
      if (this.host !== host) return;
      this.host = undefined;
      this.error = reason;
      void this.tell();
    });
    try {
      // Opening the host's data can fail too, for example when its disk is full.
      await host.call({ op: 'open', dataDir: this.data, port: this.saved.port });
      this.host = host;
      this.error = undefined;
    } catch (reason) {
      await host.end().catch(() => {});
      this.error =
        (reason as NodeJS.ErrnoException).code === 'EADDRINUSE'
          ? `Something else on this Mac is already using port ${this.saved.port}. If the host is running in a terminal, stop it there first.`
          : message(reason);
    }
  }
  /** For when the app is certain to quit. Nothing is served or backed up afterwards. */
  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.serial(async () => {
      const host = this.host;
      this.host = undefined;
      await host?.end();
    });
  }

  async info(): Promise<HostingInfo> {
    const own = new Set([...(this.saved.own ?? []), this.sync.deviceId]);
    const seen = await this.host?.call<Snapshot>({ op: 'snapshot' }).catch(() => undefined);
    return {
      hosting: Boolean(this.host),
      ...(this.error ? { error: this.error } : {}),
      port: this.saved.port,
      addresses: addresses(this.saved.port),
      notebooks: seen?.notebooks ?? [],
      devices: (seen?.devices ?? [])
        .filter((device) => !device.revoked)
        .map(({ revoked: _revoked, ...device }) => ({ ...device, self: own.has(device.id) })),
      invitations: seen?.invitations ?? [],
      keepRunning: this.saved.keepRunning,
    };
  }

  /** Starts hosting, and connects the open notebook to this Mac's own host. */
  start(vault: Vault): Promise<HostingInfo> {
    return this.serial(async () => {
      await this.open();
      if (!this.host) throw new Error(this.error ?? 'Hosting could not start.');
      this.saved.enabled = true;
      await this.save();
      const address = `http://127.0.0.1:${this.saved.port}`;
      try {
        const now = this.sync.info();
        if (!now.connected) {
          const notebook = await this.notebookFor(vault);
          const { code } = await this.host.call<{ code: string }>({ op: 'invite', notebook });
          const pairing = await this.sync.invite(address, code);
          this.saved.own = [...(this.saved.own ?? []), pairing.device.id];
          this.saved.folders = { ...this.saved.folders, [vault.root]: notebook };
          await this.save();
          await this.sync.adopt(vault, address, pairing);
        } else if (now.host === address && now.notebook && !this.saved.folders?.[vault.root]) {
          // Hosted before folders were remembered: remember this one now.
          this.saved.folders = { ...this.saved.folders, [vault.root]: now.notebook };
          await this.save();
        }
      } finally {
        await this.tell();
      }
      return this.info();
    });
  }
  /**
   * The host notebook a folder on this Mac is. A folder hosted before keeps its notebook;
   * a new one never joins another folder's notebook just because the names match.
   */
  private async notebookFor(vault: Vault): Promise<string> {
    const known = this.saved.folders?.[vault.root];
    if (known) return known;
    const { notebooks } = await this.host!.call<Snapshot>({ op: 'snapshot' });
    const taken = new Set([
      ...notebooks.map((notebook) => notebook.name.toLowerCase()),
      ...Object.values(this.saved.folders ?? {}).map((name) => name.toLowerCase()),
    ]);
    let name = vault.name;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${vault.name} ${n}`;
    return name;
  }

  /** Stops serving. Everything the host holds stays on disk, ready to be started again. */
  stop(): Promise<HostingInfo> {
    return this.serial(async () => {
      const host = this.host;
      this.host = undefined;
      await host?.end();
      this.saved.enabled = false;
      await this.save();
      return this.tell();
    });
  }
  async setKeepRunning(value: boolean): Promise<HostingInfo> {
    this.saved.keepRunning = value;
    await this.save();
    return this.tell();
  }

  async invite(notebook: string): Promise<Invitation> {
    if (!this.host) throw new Error('This Mac is not hosting.');
    const { code, expires } = await this.host.call<{ code: string; expires: number }>({
      op: 'invite',
      notebook,
    });
    const address = addresses(this.saved.port)[0]?.address ?? `127.0.0.1:${this.saved.port}`;
    const link = invitationLink(address, code);
    const drawn = qrcode(0, 'M');
    drawn.addData(link);
    drawn.make();
    const size = drawn.getModuleCount();
    const qr = Array.from({ length: size }, (_row, y) =>
      Array.from({ length: size }, (_cell, x) => (drawn.isDark(y, x) ? '1' : '0')).join(''),
    );
    void this.tell();
    return { notebook, code, expires, address, link, qr };
  }
  async cancelInvitation(id: string): Promise<HostingInfo> {
    await this.host?.call({ op: 'cancelInvitation', id });
    return this.tell();
  }
  async removeDevice(id: string): Promise<HostingInfo> {
    if (id === this.sync.deviceId || this.saved.own?.includes(id))
      throw new Error('This Mac is the host. Stop hosting instead of removing it.');
    await this.host?.call({ op: 'revoke', id });
    return this.tell();
  }

  async backups(): Promise<BackupInfo> {
    const { folder } = this.saved.backup;
    return {
      ...this.saved.backup,
      backups: folder ? await listBackups(folder) : [],
      ...(this.saved.failed ? { failed: this.saved.failed } : {}),
    };
  }
  async setBackup(change: {
    folder?: string;
    keep?: number;
    /** Null turns the daily backup off. */
    hour?: number | null;
  }): Promise<BackupInfo> {
    const { hour, ...rest } = change;
    Object.assign(this.saved.backup, rest);
    if (hour === null) delete this.saved.backup.hour;
    else if (hour !== undefined) this.saved.backup.hour = hour;
    await this.save();
    return this.backups();
  }
  /** Makes a backup now. A failure is remembered and shown, never thrown away. */
  backUpNow(): Promise<BackupInfo> {
    return this.serial(async () => {
      const { folder, keep } = this.saved.backup;
      if (!folder) throw new Error('Choose where backups are saved first.');
      if (!this.host) throw new Error('This Mac is not hosting, so there is nothing to back up.');
      try {
        await this.host.call({ op: 'backup', folder, keep });
        delete this.saved.failed;
      } catch (reason) {
        this.saved.failed = {
          at: Date.now(),
          message:
            (reason as NodeJS.ErrnoException).code === 'ENOENT' ||
            /unable to open database/i.test(message(reason))
              ? 'The backup folder could not be reached. Is its disk connected?'
              : message(reason),
        };
      }
      await this.save();
      return this.backups();
    });
  }
  private async backUpIfDue(): Promise<void> {
    const { folder, hour } = this.saved.backup;
    if (!this.host || !folder || hour === undefined) return;
    const due = new Date();
    due.setHours(hour, 0, 0, 0);
    if (Date.now() < due.getTime()) return;
    const latest = (await listBackups(folder))[0]?.at ?? 0;
    // One attempt a day, whether it worked or not; the failure is shown in settings.
    if (latest >= due.getTime() || (this.saved.failed?.at ?? 0) >= due.getTime()) return;
    await this.backUpNow();
  }
  /**
   * Puts the host back to a backup. What it holds now is backed up first, so going back is
   * itself undoable; devices then catch up by themselves.
   */
  restore(name: string): Promise<BackupInfo> {
    return this.serial(async () => {
      const { folder, keep } = this.saved.backup;
      if (!folder) throw new Error('Choose where backups are saved first.');
      if (!this.host) throw new Error('This Mac is not hosting.');
      // One more than usual is kept, so the safety copy cannot push out the one being restored.
      await this.host.call({ op: 'backup', folder, keep: keep + 1 });
      // The restore itself runs on the host's thread too, once the host has let go of its data.
      const host = this.host;
      await host.call({ op: 'close' });
      try {
        await host.call({ op: 'restore', dataDir: this.data, folder, name });
      } finally {
        this.host = undefined;
        await host.end();
        await this.open();
        await this.tell();
      }
      this.sync.kick();
      return this.backups();
    });
  }
}
