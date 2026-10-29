import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { lstat, readlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  MAX_FILE_BYTES,
  pathKey,
  validPath,
  type Changes,
  type Op,
  type OpResult,
  type Pairing,
  type RemoteFile,
} from '@opsidian/sync';

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const HASH = /^[0-9a-f]{64}$/;
// No 0/O or 1/I/L, so a code survives being read aloud or typed from a phone.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export interface HostOptions {
  /** Where the database and file contents are kept. */
  dataDir: string;
  /** Longest a request for changes is held open, seconds. */
  maxWait?: number;
  /** Most a notebook's stored versions may add up to. Default 50 GB. */
  maxNotebookBytes?: number;
}

interface Device {
  id: string;
  notebook: string;
  name: string;
}
type Row = Record<string, string | number | null>;
const remote = (row: Row): RemoteFile => ({
  seq: row.seq as number,
  file: row.file as string,
  path: row.path as string,
  hash: row.hash as string | null,
  size: row.size as number,
  device: (row.device_name as string | null) ?? 'Unknown device',
  at: row.at as number,
});

/**
 * The host for one or more notebooks. It keeps every version of every file and the order
 * changes were accepted in. It never merges: a device whose change is out of date is told
 * so, and reconciles on its side.
 */
export interface HostDevice {
  id: string;
  notebook: string;
  name: string;
  created: number;
  revoked: boolean;
  /** When it last asked the host for anything, milliseconds. */
  seen?: number;
}
export interface HostNotebook {
  name: string;
  head: number;
  /** Files that currently exist. */
  files: number;
  /** Every change ever recorded. */
  versions: number;
  bytes: number;
}
/** How a copy of a notebook in a git repository is doing. */
export interface MirrorStatus {
  state: 'syncing' | 'synced' | 'offline' | 'error';
  message?: string;
  /** When the repository last matched the notebook, milliseconds. */
  at?: number;
  /** The commit the repository was at then. */
  commit?: string;
  /** Deletions held back because most of the notebook vanished from the repository at once. */
  held?: number;
  /** When the next round is planned: the next scheduled one, or the next try after a failure. */
  next?: number;
}
export interface MirrorRecord {
  /** The notebook's id. */
  notebook: string;
  name: string;
  /** Where the repository is, as git takes it. */
  remote: string;
  /** The device the copy syncs as, and its credential. */
  device?: string;
  token?: string;
  status?: MirrorStatus;
}
/** Where a host went when it moved to another machine, and which devices have heard. */
export interface Moved {
  /** The new host's address, as devices are told it: `http://100.64.0.9:4810`. */
  to: string;
  at: number;
  /** Every device that still syncs, except the host's own copies kept on GitHub. */
  devices: (HostDevice & { told?: number })[];
}
/** One thing in the host's data folder that a machine taking it over copies. */
export interface MovableFile {
  /** Relative to the data folder, with `/` between names. */
  path: string;
  kind: 'file' | 'dir' | 'link';
  size: number;
  mode: number;
  /** Where a link points. */
  target?: string;
}
/**
 * How long a move may go without the new machine asking for anything before it is given up,
 * and the host takes changes again. Each request renews it.
 */
const MOVE_LEASE = 5 * 60_000;
/** Only these folders hold data worth moving; the database is sent separately, consistent. */
const MOVABLE = ['blobs', 'mirrors'];
/** Work in progress that a move must not copy: uploads, half-finished clones, locks. */
const UNFINISHED = /\.(tmp|partial|lock|cloning)$/;

export interface Backup {
  /** Names the snapshot; also its file name. */
  name: string;
  at: number;
  notebooks: HostNotebook[];
}

/** Copies files that `to` does not have yet. Stored content never changes once written. */
async function copyTree(from: string, to: string): Promise<void> {
  for (const entry of await readdir(from, { withFileTypes: true }).catch(() => [])) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) await copyTree(source, target);
    // Only finished content, which is named by its hash; uploads in progress are passed over.
    else if (entry.isFile() && /^[0-9a-f]{64}$/.test(entry.name) && !existsSync(target)) {
      await mkdir(dirname(target), { recursive: true });
      // Copied under another name first, so an interrupted copy is never mistaken for content.
      await copyFile(source, `${target}.partial`);
      await rename(`${target}.partial`, target);
    }
  }
}

/** The backups in a folder, newest first. */
export async function listBackups(folder: string): Promise<Backup[]> {
  const snapshots = join(folder, 'snapshots');
  const found: Backup[] = [];
  for (const name of await readdir(snapshots).catch(() => [] as string[])) {
    if (!name.endsWith('.json')) continue;
    try {
      const backup = JSON.parse(await readFile(join(snapshots, name), 'utf8')) as Backup;
      if (existsSync(join(snapshots, `${backup.name}.sqlite`))) found.push(backup);
    } catch {
      // A manifest that cannot be read is not offered.
    }
  }
  return found.sort((a, b) => b.at - a.at);
}

/**
 * Puts a host's data back to a backup. The host must not be running. Devices notice the
 * new history, keep their notes, and send up again whatever the backup lacks.
 */
export async function restoreBackup(dataDir: string, folder: string, name: string): Promise<void> {
  if (!/^[\w-]+$/.test(name)) throw new Error('That is not a backup.');
  const snapshot = join(folder, 'snapshots', `${name}.sqlite`);
  if (!existsSync(snapshot)) throw new Error('That backup is no longer in the folder.');
  await mkdir(dataDir, { recursive: true });
  const live = join(dataDir, 'host.sqlite');
  // Devices removed since the backup stay removed: going back in time must not hand a lost
  // phone its access back.
  const removed: string[] = [];
  if (existsSync(live)) {
    const current = new DatabaseSync(live);
    try {
      for (const row of current.prepare('select id from devices where revoked = 1').all())
        removed.push(row.id as string);
    } catch {
      // A host too damaged to read has no say; that is what the restore is for.
    } finally {
      current.close();
    }
  }
  await copyTree(join(folder, 'blobs'), join(dataDir, 'blobs'));
  const staged = `${live}.restoring`;
  await copyFile(snapshot, staged);
  // The copy is given its new identity before it goes live, so there is never a moment when
  // old history is served under the name devices already trust.
  const db = new DatabaseSync(staged);
  try {
    if (db.prepare('pragma integrity_check').get()?.integrity_check !== 'ok')
      throw new Error('That backup is damaged and cannot be restored.');
    db.exec('create table if not exists meta (name text primary key, value text not null)');
    const set = db.prepare(
      'insert into meta (name, value) values (?, ?) on conflict (name) do update set value = excluded.value',
    );
    set.run('generation', randomUUID());
    for (const row of db.prepare('select id, head from notebooks').all())
      set.run(`floor:${row.id as string}`, String(row.head));
    const revoke = db.prepare('update devices set revoked = 1 where id = ?');
    for (const id of removed) revoke.run(id);
  } catch (error) {
    db.close();
    await rm(staged, { force: true });
    throw error;
  }
  db.close();
  for (const ending of ['-wal', '-shm']) await rm(live + ending, { force: true });
  await rename(staged, live);
}

export class Host {
  readonly app: FastifyInstance;
  private readonly db: DatabaseSync;
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly attempts = new Map<string, number[]>();
  private readonly maxBytes: number;
  private readonly maxWait: number;
  /** Identifies this history; a restore from backup gives the host a new one. */
  private readonly generation: string;
  /** When each device last asked for anything, kept in memory between writes. */
  private readonly seen = new Map<string, number>();
  /**
   * Another machine taking this host over: its credential's hash, whether changes are paused
   * while the last of the data is copied, and when the move is given up if it goes quiet.
   */
  private moving:
    | { token: string; frozen: boolean; lease: number; active: number; timer: NodeJS.Timeout }
    | undefined;
  /**
   * What runs beside the host and writes to its data, such as the copies kept on GitHub:
   * paused while another machine copies the data, and resumed if that move is given up.
   */
  moveHooks: { pause?(): Promise<void>; resume?(): void } = {};

  constructor(private readonly options: HostOptions) {
    this.maxWait = options.maxWait ?? 25;
    this.maxBytes = options.maxNotebookBytes ?? 50 * 1024 ** 3;
    mkdirSync(options.dataDir, { recursive: true });
    this.db = new DatabaseSync(join(options.dataDir, 'host.sqlite'));
    this.db.exec(`
      pragma journal_mode = wal;
      pragma synchronous = full;
      pragma busy_timeout = 5000;
      create table if not exists notebooks (id text primary key, name text not null unique, head integer not null default 0);
      create table if not exists files (
        notebook text not null, file text not null, seq integer not null, path text not null,
        key text not null, hash text, size integer not null, device text not null, at integer not null,
        primary key (notebook, file));
      create index if not exists files_seq on files (notebook, seq);
      create table if not exists log (
        notebook text not null, seq integer not null, file text not null, path text not null,
        hash text, size integer not null, device text not null, at integer not null,
        primary key (notebook, seq));
      create index if not exists log_file on log (notebook, file, seq);
      create table if not exists ops (notebook text not null, id text not null, result text not null, primary key (notebook, id));
      create table if not exists devices (
        id text primary key, notebook text not null, name text not null,
        token text not null unique, created integer not null, revoked integer not null default 0);
      create table if not exists blobs (notebook text not null, hash text not null, size integer not null, primary key (notebook, hash));
      create table if not exists invites (code text primary key, notebook text not null, expires integer not null);
      create table if not exists meta (name text primary key, value text not null);
      create table if not exists mirrors (
        notebook text primary key, remote text not null, device text, token text, status text);
      create table if not exists handoffs (code text primary key, expires integer not null);
      create table if not exists told (device text primary key, at integer not null);
    `);
    if (!this.db.prepare("select 1 from pragma_table_info('devices') where name = 'seen'").get())
      this.db.exec('alter table devices add column seen integer');
    this.db
      .prepare("insert into meta (name, value) values ('generation', ?) on conflict do nothing")
      .run(randomUUID());
    this.generation = this.db.prepare("select value from meta where name = 'generation'").get()!
      .value as string;
    // Shutting down must not wait for devices to let go of connections they keep open.
    this.app = Fastify({ bodyLimit: 16 * 1024 * 1024, forceCloseConnections: true });
    this.routes();
  }

  // Administration. Used by the command line on the host machine, never over the network.

  /** Creates a single-use invitation, and the notebook itself if it is new. */
  invite(notebook: string, minutes = 15): { code: string; expires: number } {
    const moved = this.movedTo();
    if (moved)
      throw new Error(
        `This host moved to ${moved.to.replace(/^https?:\/\//, '')}. Invite devices from there.`,
      );
    const id = this.notebook(notebook);
    const raw = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    const expires = Date.now() + minutes * 60000;
    this.db.prepare('delete from invites where expires < ?').run(Date.now());
    this.db
      .prepare('insert into invites (code, notebook, expires) values (?, ?, ?)')
      .run(sha(raw), id, expires);
    return { code: raw.replace(/(.{4})(?=.)/g, '$1-'), expires };
  }
  devices(): HostDevice[] {
    return this.db
      .prepare(
        `select d.id, n.name as notebook, d.name, d.created, d.revoked, d.seen
         from devices d join notebooks n on n.id = d.notebook order by d.created`,
      )
      .all()
      .map((row) => {
        const seen = this.seen.get(row.id as string) ?? (row.seen as number | null);
        return {
          id: row.id as string,
          notebook: row.notebook as string,
          name: row.name as string,
          created: row.created as number,
          revoked: row.revoked === 1,
          ...(seen ? { seen } : {}),
        };
      });
  }
  /** Invitations nobody has used yet. `id` names one without revealing its code. */
  invitations(): { id: string; notebook: string; expires: number }[] {
    return this.db
      .prepare(
        `select i.code as id, n.name as notebook, i.expires from invites i
         join notebooks n on n.id = i.notebook where i.expires > ? order by i.expires`,
      )
      .all(Date.now()) as never;
  }
  cancelInvitation(id: string): boolean {
    return this.db.prepare('delete from invites where code = ?').run(id).changes > 0;
  }
  /** Stops a device syncing. Its copy of the notebook stays on it. */
  revoke(id: string): boolean {
    const done = this.db.prepare('update devices set revoked = 1 where id = ?').run(id);
    return done.changes > 0;
  }
  /**
   * The devices still syncing that `query` names: its id, the start of its id, or its name
   * in any letter case. More than one means the name is shared and the id must be given.
   */
  findDevices(query: string): HostDevice[] {
    const wanted = query.trim();
    if (!wanted) return [];
    const active = this.devices().filter((device) => !device.revoked);
    const exact = active.filter((device) => device.id === wanted);
    if (exact.length) return exact;
    const named = active.filter((device) => device.name.toLowerCase() === wanted.toLowerCase());
    if (named.length) return named;
    return wanted.length >= 4 ? active.filter((device) => device.id.startsWith(wanted)) : [];
  }
  notebooks(): HostNotebook[] {
    return this.db
      .prepare(
        `select n.name, n.head,
           (select count(*) from files f where f.notebook = n.id and f.hash is not null) as files,
           (select count(*) from log l where l.notebook = n.id) as versions,
           (select coalesce(sum(b.size), 0) from blobs b where b.notebook = n.id) as bytes
         from notebooks n order by n.name`,
      )
      .all() as never;
  }

  /** The id of the notebook with this name, made now if it is new. */
  notebook(notebook: string): string {
    const name = notebook.trim();
    if (!name || name.length > 200) throw new Error('Give the notebook a name.');
    // The name becomes a folder on each device.
    if (/[\\/:*?"<>|#^[\]\u0000-\u001f]/.test(name) || /^\.|\.$/.test(name))
      throw new Error(
        'A notebook name cannot contain \\ / : * ? " < > | # ^ [ ] or start or end with a dot.',
      );
    this.db
      .prepare('insert into notebooks (id, name) values (?, ?) on conflict (name) do nothing')
      .run(randomUUID(), name);
    return this.notebookId(name)!;
  }
  /** The id of the notebook with this name, if there is one. */
  notebookId(name: string): string | undefined {
    return this.db.prepare('select id from notebooks where name = ?').get(name.trim())?.id as
      string | undefined;
  }
  /** The notebook `name` names, as typed or in any letter case. */
  findNotebook(name: string): (HostNotebook & { id: string }) | undefined {
    const all = this.notebooks();
    const found =
      all.find((each) => each.name === name.trim()) ??
      all.find((each) => each.name.toLowerCase() === name.trim().toLowerCase());
    return found && { ...found, id: this.notebookId(found.name)! };
  }

  /**
   * Deletes a notebook from the host: its files, their whole history and their content. Its
   * devices are removed and keep the notes they have; its copy on GitHub stops, and the
   * repository stays as it is. Backups made before keep it, so restoring one brings it back.
   */
  async deleteNotebook(name: string): Promise<HostNotebook> {
    const moved = this.movedTo();
    if (moved)
      throw new Error(
        `This host moved to ${moved.to.replace(/^https?:\/\//, '')}. Delete notebooks there.`,
      );
    if (this.moving)
      throw new Error('Another machine is taking this host over. Try again once it is done.');
    const found = this.findNotebook(name);
    if (!found) throw new Error(`There is no notebook called “${name.trim()}” on this host.`);
    const { id, ...notebook } = found;
    this.db.exec('begin immediate');
    try {
      // Devices are kept, removed, so a restore from an older backup does not let them back in.
      this.db.prepare('update devices set revoked = 1 where notebook = ?').run(id);
      for (const table of ['files', 'log', 'ops', 'blobs', 'invites', 'mirrors'])
        this.db.prepare(`delete from ${table} where notebook = ?`).run(id);
      this.db.prepare('delete from meta where name = ?').run(`floor:${id}`);
      this.db.prepare('delete from notebooks where id = ?').run(id);
      this.db.exec('commit');
    } catch (error) {
      this.db.exec('rollback');
      throw error;
    }
    // Devices waiting for news hear at once that they are no longer let in.
    for (const wake of [...(this.waiters.get(id) ?? [])]) wake();
    const mirror = join(this.options.dataDir, 'mirrors', id);
    for (const path of [join(this.options.dataDir, 'blobs', id), mirror, `${mirror}.lock`])
      await rm(path, { recursive: true, force: true });
    return notebook;
  }

  // Moving the host to another machine. See move.ts for the machine taking over.

  /**
   * A single-use code that lets another machine take this host over: every notebook, its
   * history, and every device, which then follow it there by themselves.
   */
  handoff(minutes = 15): { code: string; expires: number } {
    const moved = this.movedTo();
    if (moved) throw new Error(`This host has already moved to ${moved.to}.`);
    const raw = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    const expires = Date.now() + minutes * 60000;
    this.db.prepare('delete from handoffs where expires < ?').run(Date.now());
    this.db.prepare('insert into handoffs (code, expires) values (?, ?)').run(sha(raw), expires);
    return { code: raw.replace(/(.{4})(?=.)/g, '$1-'), expires };
  }
  /** Where this host went, if it moved. */
  movedTo(): { to: string; at: number } | undefined {
    const to = this.meta('moved_to');
    return to ? { to, at: Number(this.meta('moved_at')) || 0 } : undefined;
  }
  /** Where this host went, and which devices have been told so far. */
  moved(): Moved | undefined {
    const moved = this.movedTo();
    if (!moved) return undefined;
    const told = new Map(
      this.db
        .prepare('select device, at from told')
        .all()
        .map((row) => [row.device, row.at]),
    );
    const github = new Set(this.mirrors().map((each) => each.device));
    return {
      ...moved,
      devices: this.devices()
        .filter((device) => !device.revoked && !github.has(device.id))
        .map((device) => {
          const at = told.get(device.id) as number | undefined;
          return at ? { ...device, told: at } : device;
        }),
    };
  }
  /** Whether another machine is copying this host right now. */
  get busyMoving(): boolean {
    return Boolean(this.moving);
  }
  private meta(name: string): string | undefined {
    return this.db.prepare('select value from meta where name = ?').get(name)?.value as
      string | undefined;
  }
  /** Gives up a move that did not finish. Changes are taken again; nothing was lost. */
  private endMove(): void {
    if (!this.moving) return;
    clearInterval(this.moving.timer);
    this.moving = undefined;
    this.moveHooks.resume?.();
  }
  /** Everything a machine taking over copies besides the database, with what it needs to. */
  private async movable(): Promise<MovableFile[]> {
    const found: MovableFile[] = [];
    const walk = async (relative: string): Promise<void> => {
      const entries = await readdir(join(this.options.dataDir, relative), {
        withFileTypes: true,
      }).catch(() => []);
      for (const entry of entries) {
        if (UNFINISHED.test(entry.name)) continue;
        const path = `${relative}/${entry.name}`;
        const info = await lstat(join(this.options.dataDir, path)).catch(() => undefined);
        if (!info) continue;
        if (info.isSymbolicLink())
          found.push({
            path,
            kind: 'link',
            size: 0,
            mode: info.mode & 0o777,
            target: await readlink(join(this.options.dataDir, path)),
          });
        else if (info.isDirectory()) {
          found.push({ path, kind: 'dir', size: 0, mode: info.mode & 0o777 });
          await walk(path);
        } else if (info.isFile())
          found.push({ path, kind: 'file', size: info.size, mode: info.mode & 0o777 });
      }
    };
    for (const top of MOVABLE) if (existsSync(join(this.options.dataDir, top))) await walk(top);
    return found;
  }

  // Copies of notebooks kept in git repositories. See mirror.ts.

  mirrors(): MirrorRecord[] {
    return this.db
      .prepare(
        `select m.notebook, n.name, m.remote, m.device, m.token, m.status
         from mirrors m join notebooks n on n.id = m.notebook order by n.name`,
      )
      .all()
      .map((row) => ({
        notebook: row.notebook as string,
        name: row.name as string,
        remote: row.remote as string,
        ...(row.device ? { device: row.device as string } : {}),
        ...(row.token ? { token: row.token as string } : {}),
        ...(row.status ? { status: JSON.parse(row.status as string) as MirrorStatus } : {}),
      }));
  }
  /** Keeps notebook `name` in `remote`, a git repository. Makes the notebook if it is new. */
  addMirror(name: string, remote: string): MirrorRecord {
    const notebook = this.notebook(name);
    const before = this.mirrors().find((each) => each.notebook === notebook);
    if (before && before.remote !== remote)
      throw new Error(`“${before.name}” is already kept in ${before.remote}. Disconnect it first.`);
    this.db
      .prepare('insert into mirrors (notebook, remote) values (?, ?) on conflict do nothing')
      .run(notebook, remote);
    return this.mirrors().find((each) => each.notebook === notebook)!;
  }
  /** Remembers the device a copy syncs as. */
  setMirrorDevice(notebook: string, device: string, token: string): void {
    this.db
      .prepare('update mirrors set device = ?, token = ? where notebook = ?')
      .run(device, token, notebook);
  }
  setMirrorStatus(notebook: string, status: MirrorStatus): void {
    this.db
      .prepare('update mirrors set status = ? where notebook = ?')
      .run(JSON.stringify(status), notebook);
  }
  /**
   * How often copies go to their repositories, one setting for every copy on this host. Kept
   * here rather than in a settings file so that every way of running a host honours it: the
   * service, `host run` in Docker (which has no settings file), and the Mac app's thread; and
   * so the command line can change it while the host runs. See mirror.ts for the values.
   */
  mirrorSchedule(): string | undefined {
    return this.db.prepare("select value from meta where name = 'mirror-schedule'").get()?.value as
      string | undefined;
  }
  setMirrorSchedule(schedule: string): void {
    this.db
      .prepare(
        "insert into meta (name, value) values ('mirror-schedule', ?) on conflict (name) do update set value = excluded.value",
      )
      .run(schedule);
  }
  /** Stops keeping a copy. Its device is removed; the repository is left as it is. */
  removeMirror(notebook: string): boolean {
    const row = this.db
      .prepare('delete from mirrors where notebook = ? returning device')
      .get(notebook);
    if (row?.device) this.revoke(row.device as string);
    return Boolean(row);
  }

  /**
   * Talks to this host without the network, for what runs beside it in the same process.
   * Same requests, same checks: only the wire is missing.
   */
  readonly local: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const payload = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    const response = await this.app.inject({
      method: request.method as 'GET',
      url: url.pathname + url.search,
      headers: Object.fromEntries(request.headers),
      ...(payload ? { payload } : {}),
    });
    const empty = request.method === 'HEAD' || [204, 304].includes(response.statusCode);
    return new Response(empty ? null : new Uint8Array(response.rawPayload), {
      status: response.statusCode,
      headers: response.headers as Record<string, string>,
    });
  };

  /**
   * Copies everything the host holds into `folder`: a snapshot of the database, and any
   * stored content the folder does not have yet. Content is only ever added there, so each
   * backup after the first is quick. Keeps the newest `keep` snapshots.
   */
  async backup(folder: string, keep = 14): Promise<Backup> {
    const at = Date.now();
    const name = new Date(at).toISOString().replace(/[:.]/g, '-');
    const snapshots = join(folder, 'snapshots');
    await mkdir(snapshots, { recursive: true });
    const file = join(snapshots, `${name}.sqlite`);
    // A consistent copy, taken while devices keep syncing.
    this.db.exec(`vacuum into '${file.replaceAll("'", "''")}'`);
    await copyTree(join(this.options.dataDir, 'blobs'), join(folder, 'blobs'));
    const backup: Backup = { name, at, notebooks: this.notebooks() };
    await writeFile(join(snapshots, `${name}.json`), JSON.stringify(backup));
    const all = (await listBackups(folder)).slice(Number.isFinite(keep) ? Math.max(keep, 1) : 14);
    for (const old of all)
      if (/^[\w-]+$/.test(old.name))
        for (const ending of ['.sqlite', '.json'])
          await rm(join(snapshots, old.name + ending), { force: true });
    return backup;
  }

  async listen(port: number, address: string): Promise<string> {
    return this.app.listen({ port, host: address });
  }
  async close(): Promise<void> {
    if (!this.db.isOpen) return;
    if (this.moving) clearInterval(this.moving.timer);
    this.moving = undefined;
    for (const waiting of this.waiters.values()) for (const wake of waiting) wake();
    await this.app.close();
    this.db.close();
  }

  private blob(notebook: string, hash: string): string {
    return join(this.options.dataDir, 'blobs', notebook, hash.slice(0, 2), hash);
  }
  private async hasBlob(notebook: string, hash: string): Promise<boolean> {
    return stat(this.blob(notebook, hash)).then(
      () => true,
      () => false,
    );
  }

  /**
   * Whether the request carries the credential of a device that was removed, alone or with
   * its whole notebook.
   */
  private removed(request: FastifyRequest): 'device' | 'notebook' | undefined {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const row =
      token &&
      this.db
        .prepare(
          `select n.id as notebook from devices d left join notebooks n on n.id = d.notebook
           where d.token = ? and d.revoked = 1`,
        )
        .get(sha(token));
    return row ? (row.notebook ? 'device' : 'notebook') : undefined;
  }

  private device(request: FastifyRequest): Device | undefined {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) return undefined;
    const device = this.db
      .prepare('select id, notebook, name from devices where token = ? and revoked = 0')
      .get(sha(token)) as Device | undefined;
    if (device) {
      const now = Date.now();
      // Written at most once a minute per device; the rest is remembered in memory.
      if (now - (this.seen.get(device.id) ?? 0) > 60000)
        this.db.prepare('update devices set seen = ? where id = ?').run(now, device.id);
      this.seen.set(device.id, now);
    }
    return device;
  }

  private changes(notebook: string, since: number): Changes {
    const head = this.db.prepare('select head from notebooks where id = ?').get(notebook)!
      .head as number;
    const rows = this.db
      .prepare(
        `select f.*, d.name as device_name from files f left join devices d on d.id = f.device
         where f.notebook = ? and f.seq > ? order by f.seq`,
      )
      .all(notebook, since) as Row[];
    const floor = this.db.prepare('select value from meta where name = ?').get(`floor:${notebook}`);
    return {
      changes: rows.map(remote),
      head,
      generation: this.generation,
      ...(floor ? { floor: Number(floor.value) } : {}),
    };
  }

  /** Other live files whose path is this one, or lies inside it, or contains it as a folder. */
  private holders(notebook: string, file: string, key: string): string[] {
    const pattern = "replace(replace(replace(key, '!', '!!'), '%', '!%'), '_', '!_') || '/%'";
    return this.db
      .prepare(
        `select file from files where notebook = ? and hash is not null and file != ?
         and (key = ? or key like ? escape '!' or ? like ${pattern} escape '!')`,
      )
      .all(notebook, file, key, `${key.replace(/[!%_]/g, '!$&')}/%`, key)
      .map((row) => row.file as string);
  }

  /**
   * `path` with each folder spelled the way files already in it spell it. Files changing
   * in the same request are not consulted, so a whole folder can be respelled at once.
   */
  private spelled(notebook: string, path: string): string {
    const parts = path.split('/');
    const sibling = this.db.prepare(
      `select path from files where notebook = ? and hash is not null and key like ? escape '!'
       and file not in (select file from temp.batch) limit 1`,
    );
    for (let depth = 1; depth < parts.length; depth++) {
      const folder = parts.slice(0, depth).join('/');
      const row = sibling.get(notebook, `${pathKey(folder).replace(/[!%_]/g, '!$&')}/%`);
      if (row) parts.splice(0, depth, ...(row.path as string).split('/').slice(0, depth));
    }
    return parts.join('/');
  }

  /** Accepts or refuses one change. Runs inside a transaction with the rest of its batch. */
  private accept(device: Device, op: Op, blobs: Set<string>, together: Set<string>): OpResult {
    const { id } = op;
    const invalid = (reason: string): OpResult => ({ id, status: 'invalid', reason });
    if (typeof id !== 'string' || id.length > 100) return invalid('The change has no identity.');
    const seen = this.db
      .prepare('select result from ops where notebook = ? and id = ?')
      .get(device.notebook, id);
    // Sent before: answer as before, and do nothing twice.
    if (seen) return JSON.parse(seen.result as string) as OpResult;
    if (typeof op.file !== 'string' || !op.file || op.file.length > 100)
      return invalid('The file has no identity.');
    if (!validPath(op.path)) return invalid('That name cannot be synced.');
    if (op.hash !== null && (typeof op.hash !== 'string' || !HASH.test(op.hash)))
      return invalid('The content is not identified.');
    if (!Number.isInteger(op.base) || op.base < 0)
      return invalid('The change has no starting point.');
    const size = op.hash === null ? 0 : op.size;
    if (!Number.isInteger(size) || size < 0 || size > MAX_FILE_BYTES)
      return invalid('Files over 100 MB are not synced.');

    const current = this.db
      .prepare('select * from files where notebook = ? and file = ?')
      .get(device.notebook, op.file) as Row | undefined;
    if ((current?.seq ?? 0) !== op.base) return { id, status: 'stale' };
    if (!current && op.hash === null) return invalid('There is nothing to delete.');
    if (op.hash !== null) {
      if (!blobs.has(op.hash)) return { id, status: 'missing-blob' };
      // A name is taken by another live file at that path, or by one that would have to
      // be both a file and a folder. Files changing in the same request are judged once
      // all of them have moved, so two files can trade names.
      const holders = this.holders(device.notebook, op.file, pathKey(op.path));
      if (holders.some((holder) => !together.has(holder))) return { id, status: 'path-taken' };
    }
    const wanted = op.hash === null ? op.path : this.spelled(device.notebook, op.path);
    const respelled = wanted === op.path ? {} : { path: wanted };
    const result = ((): OpResult => {
      // Nothing would change: agree without adding to the history.
      const path = op.hash === null ? (current!.path as string) : wanted;
      if (current && current.hash === op.hash && current.path === path)
        return { id, status: 'accepted', seq: current.seq as number, ...respelled };
      const seq = this.db
        .prepare('update notebooks set head = head + 1 where id = ? returning head')
        .get(device.notebook)!.head as number;
      const at = Date.now();
      this.db
        .prepare(
          'insert into log (notebook, seq, file, path, hash, size, device, at) values (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(device.notebook, seq, op.file, path, op.hash, size, device.id, at);
      this.db
        .prepare(
          `insert into files (notebook, file, seq, path, key, hash, size, device, at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict (notebook, file) do update set seq = excluded.seq, path = excluded.path, key = excluded.key,
             hash = excluded.hash, size = excluded.size, device = excluded.device, at = excluded.at`,
        )
        .run(device.notebook, op.file, seq, path, pathKey(path), op.hash, size, device.id, at);
      return { id, status: 'accepted', seq, ...respelled };
    })();
    this.db
      .prepare('insert into ops (notebook, id, result) values (?, ?, ?)')
      .run(device.notebook, id, JSON.stringify(result));
    return result;
  }

  /**
   * Lets only the machine taking this host over in, with the credential it was given, and
   * keeps the move alive while it works.
   */
  private async mover(
    request: FastifyRequest,
    reply: { raw: { once(event: 'close', listener: () => void): unknown } },
    path: string,
  ): Promise<void> {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? sha(header.slice(7)) : '';
    const moving = this.moving;
    if (moving && token === moving.token) {
      moving.active++;
      moving.lease = Date.now() + MOVE_LEASE;
      reply.raw.once('close', () => {
        moving.active--;
        moving.lease = Date.now() + MOVE_LEASE;
      });
      return;
    }
    // Finishing is safe to ask twice, in case the answer to the first was lost.
    if (path === '/v1/move/finish' && token && token === this.meta('move_session')) return;
    throw Object.assign(new Error('This move is over, or was never started.'), {
      statusCode: 401,
    });
  }

  private moveRoutes(refuse: (statusCode: number, message: string) => Error): void {
    const { app } = this;
    /** Spends a code from `host move`; the machine taking over gets a credential for the rest. */
    app.post('/v1/move', async (request) => {
      const now = Date.now();
      const tries = (this.attempts.get(request.ip) ?? []).filter((at) => at > now - 60000);
      this.attempts.set(request.ip, tries);
      if (tries.length >= 10) throw refuse(429, 'Too many wrong codes. Wait a minute.');
      const moved = this.movedTo();
      if (moved) throw refuse(409, `This host has already moved to ${moved.to}.`);
      if (this.moving)
        throw refuse(409, 'Another machine is taking this host over. Try again in a few minutes.');
      const body = request.body as { code?: unknown } | undefined;
      const code =
        typeof body?.code === 'string' ? body.code.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
      const found = this.db
        .prepare('delete from handoffs where code = ? and expires > ? returning code')
        .get(sha(code), now);
      if (!found) {
        tries.push(now);
        throw refuse(403, 'That code is not valid. It may have expired or been used.');
      }
      const token = randomBytes(32).toString('base64url');
      const timer = setInterval(() => {
        if (this.moving && !this.moving.active && Date.now() > this.moving.lease) this.endMove();
      }, 5000);
      timer.unref();
      this.moving = { token: sha(token), frozen: false, lease: now + MOVE_LEASE, active: 0, timer };
      // Whatever writes beside the host stops first, so what is copied holds still.
      await this.moveHooks.pause?.();
      return { token, generation: this.generation, notebooks: this.notebooks() };
    });
    app.get('/v1/move/files', async () => ({ files: await this.movable() }));
    app.get('/v1/move/file', async (request, reply) => {
      const path = (request.query as { path?: unknown }).path;
      const parts = typeof path === 'string' ? path.split('/') : [];
      if (
        !MOVABLE.includes(parts[0] ?? '') ||
        parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))
      )
        throw refuse(400, 'That is not part of the host.');
      const file = join(this.options.dataDir, ...parts);
      const info = await lstat(file).catch(() => undefined);
      if (!info?.isFile()) throw refuse(404, 'That is no longer there.');
      return reply.type('application/octet-stream').send(createReadStream(file));
    });
    app.post('/v1/move/freeze', async () => {
      this.moving!.frozen = true;
      return { frozen: true };
    });
    /** The whole database, consistent, once changes are paused. */
    app.get('/v1/move/database', async (_request, reply) => {
      if (!this.moving?.frozen) throw refuse(409, 'Pause changes before copying the database.');
      const file = join(this.options.dataDir, `host.moving-${randomUUID()}.sqlite`);
      this.db.exec(`vacuum into '${file.replaceAll("'", "''")}'`);
      const stream = createReadStream(file);
      stream.once('close', () => void rm(file, { force: true }));
      return reply.type('application/octet-stream').send(stream);
    });
    /**
     * The new machine has everything and is about to serve it. From now on this host only
     * tells devices where it went.
     */
    app.post('/v1/move/finish', async (request) => {
      const to = (request.body as { to?: unknown } | undefined)?.to;
      if (typeof to !== 'string' || !/^https?:\/\/[^\s/?#]+$/.test(to))
        throw refuse(400, 'Say where the host is moving to.');
      const already = this.movedTo();
      if (already) return { moved: already.to };
      if (!this.moving?.frozen) throw refuse(409, 'Pause changes before finishing.');
      const set = this.db.prepare(
        'insert into meta (name, value) values (?, ?) on conflict (name) do update set value = excluded.value',
      );
      this.db.exec('begin immediate');
      try {
        set.run('moved_to', to);
        set.run('moved_at', String(Date.now()));
        set.run('move_session', this.moving.token);
        // Unused invitations name this address; they would only lead to a host that moved.
        this.db.exec('delete from invites; delete from handoffs; delete from told');
        this.db.exec('commit');
      } catch (error) {
        this.db.exec('rollback');
        throw error;
      }
      clearInterval(this.moving.timer);
      this.moving = undefined;
      // Devices waiting for news hear it now: the next thing they ask is answered with the way.
      for (const waiting of this.waiters.values()) for (const wake of [...waiting]) wake();
      return { moved: to };
    });
    app.post('/v1/move/cancel', async () => {
      this.endMove();
      return { cancelled: true };
    });
  }

  private routes(): void {
    const { app } = this;
    app.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: MAX_FILE_BYTES },
      (_request, body, done) => done(null, body),
    );
    app.setErrorHandler(
      (error: Error & { statusCode?: number; moved?: string }, _request, reply) => {
        const status = error.statusCode ?? 500;
        void reply.code(status).send({
          error: status < 500 || status === 503 ? error.message : 'The host failed.',
          ...(error.moved ? { moved: error.moved } : {}),
        });
      },
    );
    const signedIn = (request: FastifyRequest): Device => {
      const device = this.device(request);
      if (!device) {
        const removed = this.removed(request);
        throw Object.assign(
          new Error(
            removed === 'notebook'
              ? 'This notebook was deleted from the host. Its notes stay on this device.'
              : removed
                ? 'This device was removed from the host. Its notes stay on it.'
                : 'This device is no longer connected to the notebook.',
          ),
          { statusCode: 401 },
        );
      }
      return device;
    };
    const refuse = (statusCode: number, message: string) =>
      Object.assign(new Error(message), { statusCode });
    // Checked before a request's body is read, so strangers cannot make the host buffer
    // uploads or parse anything.
    app.addHook('onRequest', async (request, reply) => {
      const path = request.url.split('?')[0]!;
      if (path === '/v1' || path === '/v1/move') return;
      if (path.startsWith('/v1/move/')) return this.mover(request, reply, path);
      const moved = this.movedTo();
      if (moved) {
        // Only a device this host knows is told where it went; anyone else learns nothing.
        if (path === '/v1/pair')
          throw refuse(410, 'This host has moved. Ask for an invitation from its new address.');
        const device = signedIn(request);
        this.db
          .prepare('insert into told (device, at) values (?, ?) on conflict do nothing')
          .run(device.id, Date.now());
        throw Object.assign(
          refuse(410, `This host moved to ${moved.to.replace(/^https?:\/\//, '')}.`),
          { moved: moved.to },
        );
      }
      if (path !== '/v1/pair') signedIn(request);
      // While the last of the data is copied, nothing may change. Devices keep their edits
      // and send them to the new host once they have followed it.
      if (this.moving?.frozen && request.method !== 'GET' && request.method !== 'HEAD')
        throw refuse(
          503,
          'The host is moving to another machine. Changes made here are kept, and sync once the move is done.',
        );
    });

    app.get('/v1', async () => {
      const moved = this.movedTo();
      return { opsidian: 'host', protocol: 1, ...(moved ? { moved: true } : {}) };
    });

    this.moveRoutes(refuse);

    app.post('/v1/pair', async (request): Promise<Pairing> => {
      // Slow down anyone guessing codes. Only wrong codes count, and they count against
      // the address that sent them, so one caller cannot lock everyone else out.
      const now = Date.now();
      const tries = (this.attempts.get(request.ip) ?? []).filter((at) => at > now - 60000);
      this.attempts.set(request.ip, tries);
      if (tries.length >= 10) throw refuse(429, 'Too many wrong codes. Wait a minute.');
      const body = request.body as { code?: unknown; device?: unknown } | undefined;
      const code =
        typeof body?.code === 'string' ? body.code.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
      const name = typeof body?.device === 'string' ? body.device.trim().slice(0, 100) : '';
      if (!code || !name) throw refuse(400, 'An invitation code and a device name are needed.');
      // Deleting is what makes the code single-use, even if two devices race for it.
      const invite = this.db
        .prepare('delete from invites where code = ? and expires > ? returning notebook')
        .get(sha(code), now);
      if (!invite) {
        tries.push(now);
        if (this.attempts.size > 10000) this.attempts.clear();
        throw refuse(403, 'That invitation is not valid. It may have expired or been used.');
      }
      const notebook = this.db
        .prepare('select id, name from notebooks where id = ?')
        .get(invite.notebook as string) as { id: string; name: string };
      const token = randomBytes(32).toString('base64url');
      const device = { id: randomUUID(), name };
      this.db
        .prepare('insert into devices (id, notebook, name, token, created) values (?, ?, ?, ?, ?)')
        .run(device.id, notebook.id, name, sha(token), now);
      return { notebook, device, token };
    });

    /** A device that stops syncing removes itself, so its credential is no use to anyone. */
    app.delete('/v1/device', async (request, reply) => {
      const device = signedIn(request);
      this.revoke(device.id);
      return reply.code(204).send();
    });

    /** Tells a device whether the host still accepts it, for the connection check. */
    app.get('/v1/whoami', async (request) => {
      const device = signedIn(request);
      const notebook = this.db
        .prepare('select name from notebooks where id = ?')
        .get(device.notebook);
      return { device: device.name, notebook: notebook?.name };
    });

    app.get('/v1/changes', async (request): Promise<Changes> => {
      const device = signedIn(request);
      const query = request.query as { since?: string; wait?: string };
      const since = Math.max(0, Number(query.since) || 0);
      const wait = Math.min(Math.max(0, Number(query.wait) || 0), this.maxWait);
      const first = this.changes(device.notebook, since);
      if (first.changes.length || first.head !== since || !wait) return first;
      // Nothing new: hold the request until something changes or the wait runs out.
      await new Promise<void>((resolve) => {
        const waiting = this.waiters.get(device.notebook) ?? new Set();
        this.waiters.set(device.notebook, waiting);
        const done = () => {
          clearTimeout(timer);
          waiting.delete(done);
          resolve();
        };
        const timer = setTimeout(done, wait * 1000);
        waiting.add(done);
        request.raw.on('close', done);
      });
      // The device may have been revoked while it waited.
      return this.changes(signedIn(request).notebook, since);
    });

    app.post('/v1/ops', async (request) => {
      const device = signedIn(request);
      const ops = (request.body as { ops?: unknown } | undefined)?.ops;
      if (!Array.isArray(ops) || ops.length > 5000)
        throw refuse(400, 'Send up to 5,000 changes at once.');
      // Disk checks happen before the transaction, which must not wait on anything.
      const blobs = new Set<string>();
      for (const op of ops as Op[])
        if (
          typeof op?.hash === 'string' &&
          HASH.test(op.hash) &&
          (await this.hasBlob(device.notebook, op.hash))
        )
          blobs.add(op.hash);
      const run = (together: Set<string>) =>
        (ops as Op[]).map((op) =>
          op && typeof op === 'object'
            ? this.accept(device, op, blobs, together)
            : { id: '', status: 'invalid' as const, reason: 'Not a change.' },
        );
      let results: OpResult[];
      this.db.exec('begin immediate');
      try {
        this.db.exec(
          'create temp table if not exists batch (file text primary key); delete from temp.batch',
        );
        const note = this.db.prepare('insert or ignore into temp.batch (file) values (?)');
        for (const op of ops as Op[]) if (typeof op?.file === 'string') note.run(op.file);
        // First as a set, so files can trade names; if that leaves two files on one name,
        // start over and judge each change on its own.
        results = run(new Set((ops as Op[]).map((op) => op?.file).filter(Boolean)));
        const live = this.db.prepare(
          'select key from files where notebook = ? and file = ? and hash is not null',
        );
        const clash = [...new Set((ops as Op[]).map((op) => op?.file))].some((file) => {
          const row = typeof file === 'string' ? live.get(device.notebook, file) : undefined;
          return row && this.holders(device.notebook, file, row.key as string).length > 0;
        });
        if (clash) {
          this.db.exec('rollback');
          this.db.exec('begin immediate');
          this.db.exec('delete from temp.batch');
          results = run(new Set());
        }
        this.db.exec('commit');
      } catch (error) {
        this.db.exec('rollback');
        throw error;
      }
      if (results.some((result) => result.status === 'accepted'))
        for (const wake of [...(this.waiters.get(device.notebook) ?? [])]) wake();
      return { results };
    });

    const hashOf = (request: FastifyRequest) => {
      const { hash } = request.params as { hash: string };
      if (!HASH.test(hash)) throw refuse(400, 'Not a content hash.');
      return hash;
    };
    app.head('/v1/blobs/:hash', async (request, reply) => {
      const device = signedIn(request);
      return reply.code((await this.hasBlob(device.notebook, hashOf(request))) ? 200 : 404).send();
    });
    app.get('/v1/blobs/:hash', async (request, reply) => {
      const device = signedIn(request);
      const bytes = await readFile(this.blob(device.notebook, hashOf(request))).catch(
        () => undefined,
      );
      if (!bytes) throw refuse(404, 'That content is not on the host.');
      return reply.type('application/octet-stream').send(bytes);
    });
    app.put('/v1/blobs/:hash', async (request, reply) => {
      const device = signedIn(request);
      const hash = hashOf(request);
      const body = request.body;
      if (!Buffer.isBuffer(body)) throw refuse(400, 'Send the file content as bytes.');
      // A transfer cut short or corrupted on the way never becomes a stored version.
      if (sha(body) !== hash)
        throw refuse(422, 'The content does not match its hash. Send it again.');
      const target = this.blob(device.notebook, hash);
      if (!(await this.hasBlob(device.notebook, hash))) {
        const used = this.db
          .prepare('select coalesce(sum(size), 0) as used from blobs where notebook = ?')
          .get(device.notebook)!.used as number;
        if (used + body.length > this.maxBytes)
          throw refuse(413, 'The host has no room left for this notebook.');
        await mkdir(join(target, '..'), { recursive: true });
        const temporary = `${target}.${randomUUID()}.tmp`;
        const file = await open(temporary, 'wx', 0o600);
        try {
          await file.writeFile(body);
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, target);
        this.db
          .prepare('insert or ignore into blobs (notebook, hash, size) values (?, ?, ?)')
          .run(device.notebook, hash, body.length);
      }
      return reply.code(204).send();
    });

    app.get('/v1/files/:file/history', async (request) => {
      const device = signedIn(request);
      const { file } = request.params as { file: string };
      const rows = this.db
        .prepare(
          `select l.*, d.name as device_name from log l left join devices d on d.id = l.device
           where l.notebook = ? and l.file = ? order by l.seq desc limit 500`,
        )
        .all(device.notebook, file) as Row[];
      return { versions: rows.map(remote) };
    });
  }
}
