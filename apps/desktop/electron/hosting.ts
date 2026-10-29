import { app, clipboard, safeStorage, shell } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import qrcode from 'qrcode-generator';
import type {
  BackupInfo,
  GitHubInfo,
  GitHubRepository,
  GitHubSchedule,
  Handoff,
  HostingInfo,
  Invitation,
  RepositoryChoice,
  TakeOverProgress,
} from '@opsidian/core';
import { hostAddress, type SyncService, type Vault } from '@opsidian/notebook';
import { listBackups, type Host, type MirrorRecord, type Moved } from '../../host/src/host';
import {
  createRepository,
  findRepository,
  finishSignIn,
  parseRepository,
  repositories,
  repositoryLabel,
  repositoryName,
  startSignIn,
  type DeviceCode,
  type GitHubAccount,
} from '../../host/src/github';
import {
  DEFAULT_SCHEDULE,
  gitVersion,
  isBehind,
  isSchedule,
  type Schedule,
} from '../../host/src/mirror';
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
  // The port can be moved for tests, or when 4810 is taken. A development run uses 4811, so
  // it can host beside the installed app, or a host already running on this Mac.
  port: Number(process.env.OPSIDIAN_HOST_PORT) || (app.isPackaged ? 4810 : 4811),
  keepRunning: true,
  backup: { hour: 3, keep: 14 },
});
const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
/** Why a backup failed, in words that point at the usual cause. */
const backupProblem = (reason: unknown) =>
  (reason as NodeJS.ErrnoException).code === 'ENOENT' ||
  /unable to open database/i.test(message(reason))
    ? 'The backup folder could not be reached. Is its disk connected?'
    : message(reason);

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

type Answer = Exclude<HostReply, { progress: unknown }>;

/** The host's thread, seen from the app: each call is a message there and back. */
class HostThread {
  private readonly worker = new Worker(join(__dirname, 'host-worker.cjs'));
  private readonly waiting = new Map<number, (reply: Answer) => void>();
  private readonly progress = new Map<number, (progress: TakeOverProgress) => void>();
  private next = 0;
  private ended = false;

  constructor(onLost: (reason: string) => void) {
    this.worker.on('message', (reply: HostReply) => {
      if ('progress' in reply) return this.progress.get(reply.id)?.(reply.progress);
      this.waiting.get(reply.id)?.(reply);
      this.waiting.delete(reply.id);
      this.progress.delete(reply.id);
    });
    const lost = (reason: string) => {
      if (this.ended) return;
      this.ended = true;
      for (const answer of this.waiting.values())
        answer({ id: -1, ok: false, message: 'Hosting stopped unexpectedly.' });
      this.waiting.clear();
      this.progress.clear();
      onLost(reason);
    };
    this.worker.on('error', (error) => lost(error.message));
    this.worker.on('exit', (code) => lost(`Hosting stopped unexpectedly (${code}).`));
  }

  call<T = void>(
    request: HostRequest,
    progress?: (progress: TakeOverProgress) => void,
  ): Promise<T> {
    if (this.ended) return Promise.reject(new Failure('Hosting stopped unexpectedly.'));
    const id = this.next++;
    if (progress) this.progress.set(id, progress);
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, (reply) =>
        reply.ok ? resolve(reply.value as T) : reject(new Failure(reply.message, reply.code)),
      );
      this.worker.postMessage({ id, request });
    });
  }
  /** `flush`: how long GitHub copies may take to send their last changes. */
  async end(flush = 0): Promise<void> {
    if (this.ended) return;
    await this.call({ op: 'close', flush }).catch(() => {});
    this.ended = true;
    await this.worker.terminate();
  }
}

interface Snapshot {
  notebooks: ReturnType<Host['notebooks']>;
  devices: ReturnType<Host['devices']>;
  invitations: ReturnType<Host['invitations']>;
  mirrors: Omit<MirrorRecord, 'token'>[];
  every: Schedule;
  moved?: Moved;
  moving: boolean;
}

/**
 * How long quitting, or turning hosting off, waits for GitHub copies to send what they have
 * not yet. Short, so quitting never seems to hang; whatever misses it goes at the next start.
 */
const FLUSH = 8000;

/** The GitHub sign-in, kept in the app's data with its token encrypted by the keychain. */
interface SavedAccount extends Omit<GitHubAccount, 'token'> {
  token: string;
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
  private account: GitHubAccount | undefined;
  private signingIn: { started: DeviceCode; abort: AbortController } | undefined;
  /** Why git cannot be used, from the last time it was needed. */
  private gitProblem: string | undefined;

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
  /** The address this Mac's own notebooks sync with its host at. */
  get localAddress(): string {
    return `http://127.0.0.1:${this.saved.port}`;
  }

  /** Reads the settings and, if this Mac was hosting, starts hosting again. */
  async load(): Promise<void> {
    this.account = await this.readAccount();
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
  private thread(): HostThread {
    const host: HostThread = new HostThread((reason) => {
      if (this.host !== host) return;
      this.host = undefined;
      this.error = reason;
      void this.tell();
    });
    return host;
  }
  private async open(): Promise<void> {
    if (this.host) return;
    const host = this.thread();
    try {
      // Opening the host's data can fail too, for example when its disk is full.
      await host.call({ op: 'open', dataDir: this.data, port: this.saved.port });
      this.host = host;
      this.error = undefined;
      await host.call({ op: 'account', account: this.account });
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
      await host?.end(FLUSH);
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
        .map(({ revoked: _revoked, ...device }) => {
          const mirror = seen?.mirrors.find((each) => each.device === device.id);
          return {
            ...device,
            self: own.has(device.id),
            ...(mirror ? { github: repositoryLabel(mirror.remote) } : {}),
          };
        }),
      invitations: seen?.invitations ?? [],
      keepRunning: this.saved.keepRunning,
      ...(seen?.moving ? { moving: true } : {}),
      ...(seen?.moved
        ? {
            moved: {
              to: seen.moved.to,
              at: seen.moved.at,
              devices: seen.moved.devices.map(({ id, name, notebook, seen: last, told }) => ({
                id,
                name: own.has(id) ? `${name} (this Mac)` : name,
                notebook,
                ...(last ? { seen: last } : {}),
                ...(told ? { told } : {}),
              })),
            },
          }
        : {}),
    };
  }

  /** A code that lets another machine take this Mac's host over. */
  async moveHosting(): Promise<Handoff> {
    if (!this.host) throw new Error('This Mac is not hosting.');
    const address = addresses(this.saved.port)[0]?.address;
    if (!address)
      throw new Error(
        'This Mac is not on a network, so no other machine can reach it to take over.',
      );
    const { code, expires } = await this.host.call<{ code: string; expires: number }>({
      op: 'handoff',
    });
    return { code, expires, address, command: `npx opsidian host take-over ${address} ${code}` };
  }
  /**
   * Makes this Mac the host, taking everything over from the host at `from`. This Mac's own
   * notebook was one of that host's devices; it is hosted here from now on.
   */
  takeOver(
    from: string,
    code: string,
    progress: (progress: TakeOverProgress) => void,
  ): Promise<HostingInfo> {
    return this.serial(async () => {
      const port = this.saved.port;
      const to = addresses(port)[0]?.address;
      if (!to)
        throw new Error(
          'This Mac is not on a network other devices can reach. Connect it, ideally to Tailscale, and try again.',
        );
      // A host already here, such as an old copy left when it moved away, hands over its thread.
      const thread = this.host ?? this.thread();
      try {
        await thread.call(
          {
            op: 'takeOver',
            dataDir: this.data,
            port,
            from: hostAddress(from),
            code,
            to: `http://${to}`,
          },
          progress,
        );
      } catch (reason) {
        if (thread !== this.host) await thread.end().catch(() => {});
        throw reason;
      }
      this.host = thread;
      this.error = undefined;
      await thread.call({ op: 'account', account: this.account });
      this.saved.enabled = true;
      const { devices } = await thread.call<Snapshot>({ op: 'snapshot' });
      const now = this.sync.info();
      const mine = this.sync.deviceId;
      if (mine && devices.some((device) => device.id === mine)) {
        // The open notebook belonged to the host that moved here: it syncs with it on this
        // Mac now, the way a hosting Mac's own notebook does.
        this.saved.own = [...new Set([...(this.saved.own ?? []), mine])];
        const root = this.sync.root;
        if (root && now.notebook)
          this.saved.folders = { ...this.saved.folders, [root]: now.notebook };
        await this.save();
        await this.sync.follow(`http://127.0.0.1:${port}`).catch(() => {});
      } else await this.save();
      return this.tell();
    });
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
      await host?.end(FLUSH);
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

  /**
   * Deletes a notebook hosted here, with its whole history. The host is backed up first when
   * backups are set up, so restoring brings it back; nothing is deleted if that fails. The
   * open notebook, if it is this one, stops syncing and keeps its folder as it is.
   */
  deleteNotebook(name: string): Promise<HostingInfo> {
    return this.serial(async () => {
      const host = this.running();
      const { notebooks, devices } = await host.call<Snapshot>({ op: 'snapshot' });
      const notebook = notebooks.find((each) => each.name === name);
      if (!notebook) throw new Error(`“${name}” is not hosted here.`);
      const { folder, keep } = this.saved.backup;
      if (folder)
        // One more than usual is kept, so this copy never pushes out an older one.
        await host.call({ op: 'backup', folder, keep: keep + 1 }).catch((reason: unknown) => {
          throw new Error(
            `Nothing was deleted: the backup made first failed. ${backupProblem(reason)}`,
          );
        });
      const now = this.sync.info();
      if (now.notebook === name && now.host === `http://127.0.0.1:${this.saved.port}`)
        await this.sync.disconnect();
      await host.call({ op: 'deleteNotebook', notebook: name });
      const gone = new Set(devices.filter((each) => each.notebook === name).map((each) => each.id));
      this.saved.own = (this.saved.own ?? []).filter((id) => !gone.has(id));
      this.saved.folders = Object.fromEntries(
        Object.entries(this.saved.folders ?? {}).filter(([, each]) => each !== name),
      );
      await this.save();
      return this.tell();
    });
  }

  /**
   * Wipes the host and everything kept beside it, as before the app was first used. The host
   * is backed up first when backups are set up, and nothing is wiped if that fails. `between`
   * runs once the backup is made and while the host still serves, for the app to let go of
   * the notebooks that sync with it.
   */
  reset(between: () => Promise<void>): Promise<void> {
    return this.serial(async () => {
      const { folder, keep } = this.saved.backup;
      if (folder && existsSync(this.data)) {
        if (!this.host)
          throw new Error(
            'Nothing was reset. Turn hosting on first, so the host can be backed up before it goes.',
          );
        await this.host.call({ op: 'backup', folder, keep: keep + 1 }).catch((reason: unknown) => {
          throw new Error(
            `Nothing was reset: the backup made first failed. ${backupProblem(reason)}`,
          );
        });
      }
      await between();
      clearInterval(this.timer);
      this.signingIn?.abort.abort();
      const host = this.host;
      this.host = undefined;
      // What GitHub does not have yet is sent first: its repositories stay.
      await host?.end(FLUSH);
      for (const path of [this.data, this.file, this.githubFile])
        await rm(path, { recursive: true, force: true });
      this.saved = fresh();
      this.account = undefined;
      this.error = undefined;
    });
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
        this.saved.failed = { at: Date.now(), message: backupProblem(reason) };
      }
      await this.save();
      return this.backups();
    });
  }
  private async backUpIfDue(): Promise<void> {
    const { folder, hour } = this.saved.backup;
    if (!this.host || !folder || hour === undefined) return;
    // What a host that moved away holds is an old copy; the new host backs up the real one.
    if ((await this.host.call<Snapshot>({ op: 'snapshot' })).moved) return;
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

  // GitHub.

  private get githubFile(): string {
    return join(this.userData, 'github.json');
  }
  private async readAccount(): Promise<GitHubAccount | undefined> {
    try {
      const saved = JSON.parse(await readFile(this.githubFile, 'utf8')) as SavedAccount;
      const token = saved.token.startsWith('safe:')
        ? safeStorage.decryptString(Buffer.from(saved.token.slice(5), 'base64'))
        : saved.token.replace(/^plain:/, '');
      return { ...saved, token };
    } catch {
      return undefined;
    }
  }
  private async useAccount(account: GitHubAccount | undefined): Promise<void> {
    this.account = account;
    if (account) {
      const token = safeStorage.isEncryptionAvailable()
        ? `safe:${safeStorage.encryptString(account.token).toString('base64')}`
        : `plain:${account.token}`;
      await mkdir(this.userData, { recursive: true });
      await writeFile(
        this.githubFile,
        JSON.stringify({ ...account, token } satisfies SavedAccount),
        {
          mode: 0o600,
        },
      );
    } else await rm(this.githubFile, { force: true });
    await this.host?.call({ op: 'account', account }).catch(() => {});
  }
  private signedIn(): GitHubAccount {
    if (!this.account) throw new Error('Sign in to GitHub first.');
    return this.account;
  }
  /** git is needed for GitHub; asking for it on a Mac without it offers to install it. */
  private async needGit(): Promise<void> {
    try {
      await gitVersion();
      this.gitProblem = undefined;
    } catch (reason) {
      this.gitProblem = message(reason);
      throw reason;
    }
  }

  async github(): Promise<GitHubInfo> {
    const seen = await this.host?.call<Snapshot>({ op: 'snapshot' }).catch(() => undefined);
    return {
      ...(this.account
        ? {
            account: {
              login: this.account.login,
              ...(this.account.name ? { name: this.account.name } : {}),
            },
          }
        : {}),
      ...(this.gitProblem ? { problem: this.gitProblem } : {}),
      every: seen?.every ?? DEFAULT_SCHEDULE,
      mirrors: (seen?.mirrors ?? []).map((each) => {
        const { fullName } = parseRepository(each.remote);
        const status = each.status;
        return {
          notebook: each.name,
          repository: repositoryLabel(each.remote),
          ...(fullName ? { url: `https://github.com/${fullName}` } : {}),
          state: status?.state ?? 'waiting',
          ...(status?.message ? { message: status.message } : {}),
          ...(status?.at ? { at: status.at } : {}),
          ...(status?.held ? { held: status.held } : {}),
          ...(status?.next ? { next: status.next } : {}),
          ...(seen && isBehind(status, seen.every) ? { behind: true } : {}),
        };
      }),
    };
  }

  /** Shows GitHub's sign-in page with the code already on the clipboard. */
  async signInToGitHub(): Promise<{ code: string; url: string }> {
    this.signingIn?.abort.abort();
    const started = await startSignIn();
    this.signingIn = { started, abort: new AbortController() };
    clipboard.writeText(started.code);
    // The dialog shows the page's address too, so a browser that does not open is no failure.
    void shell.openExternal(started.url).catch(() => {});
    return { code: started.code, url: started.url };
  }
  async finishGitHubSignIn(): Promise<GitHubInfo> {
    const signing = this.signingIn;
    if (!signing) throw new Error('Start signing in first.');
    try {
      await this.useAccount(await finishSignIn(signing.started, { signal: signing.abort.signal }));
    } finally {
      if (this.signingIn === signing) this.signingIn = undefined;
    }
    return this.github();
  }
  async cancelGitHubSignIn(): Promise<void> {
    this.signingIn?.abort.abort();
    this.signingIn = undefined;
  }
  async signOutOfGitHub(): Promise<GitHubInfo> {
    await this.useAccount(undefined);
    return this.github();
  }
  async githubRepositories(): Promise<GitHubRepository[]> {
    return (await repositories(this.signedIn())).map((each) => ({
      fullName: each.fullName,
      private: each.private,
      empty: each.empty,
      ...(each.pushedAt ? { pushedAt: each.pushedAt } : {}),
    }));
  }
  /** The address git uses for a choice, making the repository if asked to. */
  private async remote(choice: RepositoryChoice): Promise<string> {
    if ('create' in choice)
      return (await createRepository(this.signedIn(), repositoryName(choice.create))).url;
    const parsed = parseRepository(choice.repository);
    // An SSH address, or a server that is not GitHub, uses this Mac's own git credentials.
    if (!parsed.fullName || parsed.url.startsWith('git@')) return parsed.url;
    const found = await findRepository(this.signedIn(), parsed.fullName);
    if (!found.canPush)
      throw new Error(`${this.signedIn().login} cannot make changes to ${found.fullName}.`);
    return found.url;
  }
  private running(): HostThread {
    if (!this.host) throw new Error('This Mac is not hosting.');
    return this.host;
  }

  async keepOnGitHub(notebook: string, choice: RepositoryChoice): Promise<GitHubInfo> {
    await this.needGit();
    const remote = await this.remote(choice);
    try {
      await this.running().call({ op: 'keep', notebook, remote });
    } finally {
      void this.tell();
    }
    return this.github();
  }
  /**
   * Makes a hosted notebook from a repository and returns an invitation to it, for the app to
   * join it from a new folder. Hosting is turned on if it was off.
   */
  importFromGitHub(choice: RepositoryChoice): Promise<{ address: string; code: string }> {
    return this.serial(async () => {
      await this.needGit();
      const remote = await this.remote(choice);
      await this.open();
      if (!this.host) throw new Error(this.error ?? 'Hosting could not start.');
      this.saved.enabled = true;
      await this.save();
      const { notebooks } = await this.host.call<Snapshot>({ op: 'snapshot' });
      const base =
        'create' in choice
          ? choice.create
          : (parseRepository(choice.repository).fullName?.split('/')[1] ??
            remote
              .replace(/\.git$/, '')
              .split(/[/:]/)
              .at(-1) ??
            'Notes');
      const taken = new Set([
        ...notebooks.map((each) => each.name.toLowerCase()),
        ...Object.values(this.saved.folders ?? {}).map((name) => name.toLowerCase()),
      ]);
      let name = base;
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
      try {
        await this.host.call({ op: 'keep', notebook: name, remote });
      } finally {
        void this.tell();
      }
      const { code } = await this.host.call<{ code: string }>({ op: 'invite', notebook: name });
      return { address: `http://127.0.0.1:${this.saved.port}`, code };
    });
  }
  /** Remembers that a folder on this Mac is a notebook hosted here, joined as `device`. */
  async adopt(folder: string, notebook: string, device: string): Promise<void> {
    this.saved.own = [...(this.saved.own ?? []), device];
    this.saved.folders = { ...this.saved.folders, [folder]: notebook };
    await this.save();
    void this.tell();
  }
  async syncGitHub(notebook: string, confirmDeletions = false): Promise<GitHubInfo> {
    await this.running().call({ op: 'mirror', notebook, confirm: confirmDeletions });
    return this.github();
  }
  /** How often every notebook hosted here goes to GitHub. */
  async setGitHubSchedule(every: GitHubSchedule): Promise<GitHubInfo> {
    if (!isSchedule(every)) throw new Error('That is not a choice of how often.');
    await this.running().call({ op: 'schedule', every });
    return this.github();
  }
  async stopGitHub(notebook: string): Promise<GitHubInfo> {
    await this.running().call({ op: 'unmirror', notebook });
    void this.tell();
    return this.github();
  }
}
