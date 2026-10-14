import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import qrcode from 'qrcode-generator';
import type { BackupInfo, HostingInfo, Invitation } from '@opsidian/core';
import type { SyncService, Vault } from '@opsidian/notebook';
import { Host, listBackups, restoreBackup } from '../../host/src/host';

interface Saved {
  enabled: boolean;
  port: number;
  keepRunning: boolean;
  backup: { folder?: string; hour?: number; keep: number };
  /** The devices this Mac itself was paired as, one per notebook it hosts and has open. */
  own?: string[];
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

/**
 * Runs a host inside the Mac app, so one Mac can serve a notebook to the others without
 * anything to install. The host's data lives in the app's own folder, apart from every
 * notebook folder.
 */
export class Hosting {
  private host: Host | undefined;
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
  private tell(): HostingInfo {
    const info = this.info();
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
    let host: Host | undefined;
    try {
      // Opening the host's data can fail too, for example when its disk is full.
      host = new Host({ dataDir: this.data });
      await host.listen(this.saved.port, '0.0.0.0');
      this.host = host;
      this.error = undefined;
    } catch (reason) {
      await host?.close().catch(() => {});
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
      await this.host?.close();
      this.host = undefined;
    });
  }

  info(): HostingInfo {
    const own = new Set([...(this.saved.own ?? []), this.sync.deviceId]);
    return {
      hosting: Boolean(this.host),
      ...(this.error ? { error: this.error } : {}),
      port: this.saved.port,
      addresses: addresses(this.saved.port),
      notebooks: this.host?.notebooks() ?? [],
      devices: (this.host?.devices() ?? [])
        .filter((device) => !device.revoked)
        .map(({ revoked: _revoked, ...device }) => ({ ...device, self: own.has(device.id) })),
      invitations: this.host?.invitations() ?? [],
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
      try {
        if (!this.sync.info().connected) {
          const address = `http://127.0.0.1:${this.saved.port}`;
          const { code } = this.host.invite(vault.name);
          const pairing = await this.sync.invite(address, code);
          this.saved.own = [...(this.saved.own ?? []), pairing.device.id];
          await this.save();
          await this.sync.adopt(vault, address, pairing);
        }
      } finally {
        this.tell();
      }
      return this.info();
    });
  }
  /** Stops serving. Everything the host holds stays on disk, ready to be started again. */
  stop(): Promise<HostingInfo> {
    return this.serial(async () => {
      await this.host?.close();
      this.host = undefined;
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

  invite(notebook: string): Invitation {
    if (!this.host) throw new Error('This Mac is not hosting.');
    const { code, expires } = this.host.invite(notebook);
    const address = addresses(this.saved.port)[0]?.address ?? `127.0.0.1:${this.saved.port}`;
    const link = `opsidian://connect?host=${encodeURIComponent(address)}&code=${encodeURIComponent(code)}`;
    const drawn = qrcode(0, 'M');
    drawn.addData(link);
    drawn.make();
    const size = drawn.getModuleCount();
    const qr = Array.from({ length: size }, (_row, y) =>
      Array.from({ length: size }, (_cell, x) => (drawn.isDark(y, x) ? '1' : '0')).join(''),
    );
    this.tell();
    return { notebook, code, expires, address, link, qr };
  }
  cancelInvitation(id: string): HostingInfo {
    this.host?.cancelInvitation(id);
    return this.tell();
  }
  removeDevice(id: string): HostingInfo {
    if (id === this.sync.deviceId || this.saved.own?.includes(id))
      throw new Error('This Mac is the host. Stop hosting instead of removing it.');
    this.host?.revoke(id);
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
        await this.host.backup(folder, keep);
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
      await this.host.backup(folder, keep + 1);
      await this.host.close();
      this.host = undefined;
      try {
        await restoreBackup(this.data, folder, name);
      } finally {
        await this.open();
        this.tell();
      }
      this.sync.kick();
      return this.backups();
    });
  }
}
