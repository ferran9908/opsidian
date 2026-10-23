import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, open, rename, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { HostNotebook, MovableFile } from './host';

/**
 * Takes a host over from another machine: every notebook with its whole history, every device
 * and its access, and the copies kept on GitHub. Devices then follow by themselves, because
 * the old host tells each one where it went, and the new one already knows its credential.
 *
 * The data is copied while the old host keeps serving; then it pauses changes for the few
 * seconds it takes to copy what changed meanwhile and the database, and hands over. The
 * history keeps its identity (its `generation`), so devices carry on exactly where they were:
 * nothing is sent again, and nothing becomes a conflicted copy.
 */

export interface TakeOverProgress {
  phase: 'connecting' | 'copying' | 'pausing' | 'finishing';
  /** Bytes copied so far, and in all, in this phase. */
  done: number;
  total: number;
}

export interface TakeOverOptions {
  /** The host being taken over, as devices reach it: `100.101.1.2:4810` or a URL. */
  from: string;
  /** The code `host move` printed there. */
  code: string;
  /** Where this machine keeps its host's data. */
  dataDir: string;
  /** Where devices will reach this machine, as they are to be told it. */
  to: string;
  progress?: (progress: TakeOverProgress) => void;
  /**
   * Called once everything is copied, just before it replaces what is here, and again if the
   * move fails after that. Whatever host runs on this machine must have let go of its data by
   * the time it returns.
   */
  beforeInstall?: () => Promise<void>;
  /**
   * Starts serving the copy. It runs before the old host is told, so that devices sent here
   * find the host already answering. Nothing knows this address until then, so serving early
   * cannot split the notebook in two.
   */
  afterInstall?: () => Promise<void>;
  request?: typeof fetch;
}

export interface TakenOver {
  from: string;
  notebooks: HostNotebook[];
  /** Devices that will follow. */
  devices: number;
  /** Notebooks kept in a git repository, with where. */
  mirrors: { name: string; remote: string }[];
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const url = (address: string) => {
  const typed = address.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(typed) ? typed : `http://${typed}`;
};

/**
 * What a host's data folder already holds. A machine that hosts notebooks of its own is never
 * overwritten; one that moved its host elsewhere holds only an old copy, and may be.
 */
export function existingHost(dataDir: string): { notebooks: string[]; moved?: string } {
  const file = join(dataDir, 'host.sqlite');
  if (!existsSync(file)) return { notebooks: [] };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const notebooks = db
      .prepare('select name from notebooks order by name')
      .all()
      .map((row) => row.name as string);
    let moved: string | undefined;
    try {
      moved = db.prepare("select value from meta where name = 'moved_to'").get()?.value as
        string | undefined;
    } catch {
      // A host from before moves existed has no such record.
    }
    return { notebooks, ...(moved ? { moved } : {}) };
  } catch {
    return { notebooks: [] };
  } finally {
    db.close();
  }
}

class MoveRefused extends Error {}

export async function takeOver(options: TakeOverOptions): Promise<TakenOver> {
  const request = options.request ?? fetch;
  const from = url(options.from);
  const to = url(options.to);
  const { dataDir } = options;
  const tell = (progress: TakeOverProgress) => options.progress?.(progress);

  const here = existingHost(dataDir);
  if (here.notebooks.length && !here.moved)
    throw new Error(
      `This machine already hosts ${here.notebooks.map((name) => `“${name}”`).join(', ')}. ` +
        'Taking over another host here would replace them. Move or remove this host first.',
    );

  tell({ phase: 'connecting', done: 0, total: 0 });
  const call = async (path: string, init: RequestInit & { token?: string } = {}) => {
    const { token, ...rest } = init;
    let response: Response;
    try {
      response = await request(`${from}/v1${path}`, {
        ...rest,
        headers: {
          ...(rest.body ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
    } catch {
      throw new Error(
        `The host at ${from.replace(/^https?:\/\//, '')} did not answer. Check the address, and that this machine can reach it (Tailscale on, both awake).`,
      );
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
      throw new MoveRefused(body?.error ?? `The host answered ${response.status}.`);
    }
    return response;
  };

  const hello = await call('').then(
    (response) => response.json() as Promise<{ opsidian?: string }>,
    () => ({}) as { opsidian?: string },
  );
  if (hello.opsidian !== 'host')
    throw new Error(`Nothing at ${from.replace(/^https?:\/\//, '')} answers as an Opsidian host.`);

  const begun = (await (
    await call('/move', { method: 'POST', body: JSON.stringify({ code: options.code }) })
  ).json()) as { token: string; generation: string; notebooks: HostNotebook[] };
  const { token } = begun;

  const incoming = join(dataDir, 'incoming');
  let installed = false;
  try {
    await rm(incoming, { recursive: true, force: true });
    await mkdir(incoming, { recursive: true });

    /**
     * Copies what is not here yet. Stored content is named by its hash, so content this
     * machine already has, as when a host moves back, is not sent again.
     */
    const copy = async (phase: TakeOverProgress['phase']) => {
      const { files } = (await (await call('/move/files', { token })).json()) as {
        files: MovableFile[];
      };
      const wanted = files.filter((each) => {
        if (each.kind !== 'file') return false;
        if (!each.path.startsWith('blobs/')) return !existsSync(join(incoming, each.path));
        return !existsSync(join(dataDir, each.path));
      });
      const total = wanted.reduce((sum, each) => sum + each.size, 0);
      let done = 0;
      tell({ phase, done, total });
      for (const each of files.filter((entry) => entry.kind === 'dir'))
        if (each.path.startsWith('mirrors/'))
          await mkdir(join(incoming, each.path), { recursive: true });
      for (const each of files.filter((entry) => entry.kind === 'link'))
        if (each.path.startsWith('mirrors/') && each.target) {
          const target = join(incoming, each.path);
          if (existsSync(target)) continue;
          await mkdir(dirname(target), { recursive: true });
          await symlink(each.target, target);
        }
      const queue = [...wanted];
      const worker = async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          const response = await call(`/move/file?path=${encodeURIComponent(next.path)}`, {
            token,
          });
          const bytes = new Uint8Array(await response.arrayBuffer());
          const blob = next.path.startsWith('blobs/');
          // Stored content is checked against its name, so a damaged copy never becomes a version.
          if (blob && sha(bytes) !== next.path.split('/').at(-1))
            throw new Error('A file arrived damaged. Try again.');
          const target = blob ? join(dataDir, next.path) : join(incoming, next.path);
          await mkdir(dirname(target), { recursive: true });
          const partial = `${target}.partial`;
          const file = await open(partial, 'w', 0o600);
          try {
            await file.writeFile(bytes);
            await file.sync();
          } finally {
            await file.close();
          }
          if (!blob) await chmod(partial, next.mode);
          await rename(partial, target);
          done += next.size;
          tell({ phase, done, total });
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
    };

    // Most of it, while the old host keeps serving.
    await copy('copying');
    // Then changes pause, and what changed meanwhile is copied with the database.
    await call('/move/freeze', { method: 'POST', token });
    await copy('pausing');
    const staged = join(incoming, 'host.sqlite');
    const database = await call('/move/database', { token });
    {
      const file = await open(staged, 'w', 0o600);
      try {
        await file.writeFile(new Uint8Array(await database.arrayBuffer()));
        await file.sync();
      } finally {
        await file.close();
      }
    }
    const summary = prepare(staged, begun.generation);

    tell({ phase: 'finishing', done: 0, total: 0 });
    await options.beforeInstall?.();
    installed = true;
    await install(dataDir, incoming);
    await options.afterInstall?.();
    await finish(call, token, to);
    await rm(incoming, { recursive: true, force: true });
    await rm(join(dataDir, 'host.sqlite.replaced'), { force: true });
    await rm(join(dataDir, 'mirrors.replaced'), { recursive: true, force: true });
    return { from, notebooks: begun.notebooks, ...summary };
  } catch (error) {
    // Nothing is left half done here, and the old host goes back to taking changes.
    if (installed) {
      await options.beforeInstall?.().catch(() => {});
      await uninstall(dataDir).catch(() => {});
    }
    await rm(incoming, { recursive: true, force: true }).catch(() => {});
    await call('/move/cancel', { method: 'POST', token }).catch(() => {});
    throw error;
  }
}

/** Checks the copied database and readies it to be served here. */
function prepare(
  file: string,
  generation: string,
): { devices: number; mirrors: { name: string; remote: string }[] } {
  const db = new DatabaseSync(file);
  try {
    if (db.prepare('pragma integrity_check').get()?.integrity_check !== 'ok')
      throw new Error('The database arrived damaged. Try again.');
    const same = db.prepare("select value from meta where name = 'generation'").get()?.value;
    if (same !== generation) throw new Error('The host changed while it was being copied.');
    // The history keeps its identity, so devices carry on where they were. What only made
    // sense on the old machine goes.
    db.exec(`
      delete from meta where name in ('moved_to', 'moved_at', 'move_session');
      delete from invites;
      create table if not exists handoffs (code text primary key, expires integer not null);
      create table if not exists told (device text primary key, at integer not null);
      delete from handoffs;
      delete from told;
    `);
    const devices = db.prepare('select count(*) as n from devices where revoked = 0').get()!
      .n as number;
    const mirrors = db
      .prepare(
        'select n.name, m.remote from mirrors m join notebooks n on n.id = m.notebook order by n.name',
      )
      .all() as { name: string; remote: string }[];
    // The copies on GitHub are devices too, but the host's own: they come along, not follow.
    return { devices: devices - mirrors.length, mirrors };
  } finally {
    db.close();
  }
}

/** Puts the copy in place, keeping what was here aside until the old host confirms. */
async function install(dataDir: string, incoming: string): Promise<void> {
  const live = join(dataDir, 'host.sqlite');
  await rm(`${live}.replaced`, { force: true });
  if (existsSync(live)) await rename(live, `${live}.replaced`);
  for (const ending of ['-wal', '-shm']) await rm(live + ending, { force: true });
  await rename(join(incoming, 'host.sqlite'), live);
  const mirrors = join(dataDir, 'mirrors');
  await rm(`${mirrors}.replaced`, { recursive: true, force: true });
  if (existsSync(mirrors)) await rename(mirrors, `${mirrors}.replaced`);
  if (existsSync(join(incoming, 'mirrors'))) await rename(join(incoming, 'mirrors'), mirrors);
}
async function uninstall(dataDir: string): Promise<void> {
  const live = join(dataDir, 'host.sqlite');
  await rm(live, { force: true });
  if (existsSync(`${live}.replaced`)) await rename(`${live}.replaced`, live);
  const mirrors = join(dataDir, 'mirrors');
  await rm(mirrors, { recursive: true, force: true });
  if (existsSync(`${mirrors}.replaced`)) await rename(`${mirrors}.replaced`, mirrors);
}

/**
 * Tells the old host it has moved. If its answer is lost, asking again is safe; and if it
 * cannot be reached at all, its own `/v1` says whether the move went through.
 */
async function finish(
  call: (path: string, init?: RequestInit & { token?: string }) => Promise<Response>,
  token: string,
  to: string,
): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await call('/move/finish', { method: 'POST', token, body: JSON.stringify({ to }) });
      return;
    } catch (error) {
      if (error instanceof MoveRefused) throw error;
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw new Error(
    `The old host stopped answering before it confirmed the move, so nothing was changed here. Once it answers again it carries on as the host; then take it over again. (${(last as Error)?.message ?? 'No answer'})`,
  );
}
