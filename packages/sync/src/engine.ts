import { mergeText } from '@opsidian/core';
import {
  Unauthorized,
  pathKey,
  validPath,
  type Op,
  type RemoteFile,
  type Transport,
} from './protocol';

export interface LocalFile {
  path: string;
  hash: string;
  size: number;
  /** Present on disk but not synced, for example because it is too large. Left alone. */
  skip?: true;
}

/** What this device last agreed with the host about one file. */
export interface Tracked {
  path: string;
  seq: number;
  /** Null when the host has the file deleted but an edit here is keeping it alive. */
  hash: string | null;
  /** Where the file is on this device, when the app moved it and the host has not heard yet. */
  local?: string;
}

/** Everything a device must remember between runs. Small, and saved atomically. */
export interface SyncState {
  version: 1;
  host: string;
  notebook: string;
  /** The notebook's name on the host, for display. */
  notebookName?: string;
  device: string;
  deviceName: string;
  /** Changes up to here have been applied. */
  cursor: number;
  /** The host history this agreement belongs to. */
  generation?: string;
  files: Record<string, Tracked>;
}

/** The notebook folder, as the engine needs it. Every write is conditional and atomic. */
export interface SyncStore {
  /** Every file that should sync, with its content hash. */
  list(): Promise<LocalFile[]>;
  read(path: string): Promise<Uint8Array>;
  /**
   * Writes only if the file still has the content `expected` (null: does not exist).
   * False means it changed in the meantime and nothing was written.
   */
  write(path: string, bytes: Uint8Array, expected: string | null): Promise<boolean>;
  /** False if the source is gone or the destination is taken. */
  move(from: string, to: string): Promise<boolean>;
  /** Moves a file somewhere recoverable, only if it still has that content. */
  trash(path: string, expected: string): Promise<boolean>;
  save(state: SyncState): Promise<void>;
  hash(bytes: Uint8Array): string;
}

export interface SyncStatus {
  state: 'syncing' | 'synced' | 'offline' | 'error';
  /** Local changes the host has not accepted yet. */
  waiting: number;
  message?: string;
  /** Files that could not be synced this time, with the reason for the first. */
  problems?: number;
  /** Deletions held back until the user confirms them. */
  held?: number;
  /** When the notebook last matched the host, milliseconds. */
  at?: number;
}

interface Options {
  /** Seconds the host may hold a request open waiting for news. */
  wait: number;
  newId(): string;
  now(): number;
}

/** A file changed underneath an operation. Nothing was lost; the cycle starts over. */
class Busy extends Error {}

interface View {
  files: Map<string, LocalFile>;
  /** Case-folded path to the path actually on disk. */
  keys: Map<string, string>;
  /** File id to its path on this device. Absent when the file is gone. */
  where: Map<string, string>;
  /** Path to the file id living there. Absent for files the host has never seen. */
  owner: Map<string, string>;
}

const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
/** Text if these bytes are a note that can be merged line by line. */
function text(path: string, bytes: Uint8Array): string | undefined {
  if (!/\.(md|markdown|txt)$/i.test(path)) return undefined;
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Keeps one notebook folder and the host in step. The host orders changes; this decides what
 * to do when both sides changed. It never deletes: what must go is moved to the trash, and
 * edits that cannot be combined are kept as two files.
 */
export class SyncEngine {
  private readonly options: Options;
  private running = false;
  private waiting: AbortController | undefined;
  private wake: (() => void) | undefined;
  private kicked = false;
  private allowDeletions = false;
  private current: Promise<void> | undefined;
  /** Set for good by `stop`: nothing more is written, to disk or to saved state. */
  private halted = false;
  private last: SyncStatus = { state: 'syncing', waiting: 0 };

  constructor(
    private readonly store: SyncStore,
    private readonly transport: Transport,
    readonly state: SyncState,
    private readonly report: (status: SyncStatus) => void = () => {},
    options: Partial<Options> = {},
  ) {
    this.options = {
      wait: 25,
      newId: () => globalThis.crypto.randomUUID(),
      now: () => Date.now(),
      ...options,
    };
  }

  get status(): SyncStatus {
    return this.last;
  }
  private tell(status: SyncStatus): void {
    this.last = status;
    this.report(status);
  }

  /** Syncs now and after every change here or on the host, until `stop`. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }
  /** Stops for good, and resolves once nothing is in flight. */
  async stop(): Promise<void> {
    this.running = false;
    this.halted = true;
    this.waiting?.abort();
    this.wake?.();
    await this.current?.catch(() => {});
    await this.saving.catch(() => {});
  }
  private saving: Promise<void> = Promise.resolve();
  /** Saves state, one write at a time, and never after `stop`. */
  private persist(): Promise<void> {
    const next = this.saving
      .catch(() => {})
      .then(() => (this.halted ? undefined : this.store.save(this.state)));
    this.saving = next;
    return next;
  }
  /** Something changed here: sync without waiting for the host to speak. */
  kick(): void {
    this.kicked = true;
    this.waiting?.abort();
    this.wake?.();
  }
  /** Lets through the deletions a previous sync held back. */
  confirmDeletions(): void {
    this.allowDeletions = true;
    this.kick();
  }

  /**
   * Tells the engine the app moved a file or folder, so it is sent as a move and keeps its
   * history. Without this, a move is recognised only when the content is unique.
   */
  async moved(from: string, to: string): Promise<void> {
    if (this.halted) return;
    let touched = false;
    for (const tracked of Object.values(this.state.files)) {
      const here = tracked.local ?? tracked.path;
      const next =
        here === from ? to : here.startsWith(`${from}/`) ? to + here.slice(from.length) : undefined;
      if (!next) continue;
      if (next === tracked.path) delete tracked.local;
      else tracked.local = next;
      touched = true;
    }
    if (touched) await this.persist();
    this.kick();
  }

  /** The file id of the note at a path, for looking up its history. */
  fileAt(path: string): string | undefined {
    return Object.entries(this.state.files).find(
      ([, tracked]) => (tracked.local ?? tracked.path) === path,
    )?.[0];
  }

  private async loop(): Promise<void> {
    let delay = 1000;
    while (this.running) {
      this.kicked = false;
      try {
        this.tell({ ...this.last, state: 'syncing' });
        await this.sync();
        if (!this.running) break;
        if (this.kicked) continue;
        if (this.last.problems) {
          // The host still has changes this device could not apply. Asking again at once
          // would spin, so wait as for an unreachable host.
          await this.pause(delay);
          delay = Math.min(delay * 2, 30000);
          continue;
        }
        delay = 1000;
        // Wait for the host to report a change, or for one here.
        this.waiting = new AbortController();
        await this.transport
          .changes(this.state.cursor, this.options.wait, this.waiting.signal)
          .catch((error) => {
            if (!this.waiting?.signal.aborted) throw error;
          });
      } catch (error) {
        if (!this.running) break;
        if (error instanceof Unauthorized) {
          this.running = false;
          this.tell({ ...this.last, state: 'error', message: error.message });
          break;
        }
        this.tell({
          ...this.last,
          state: 'offline',
          message: error instanceof Error ? error.message : String(error),
        });
        await this.pause(delay);
        delay = Math.min(delay * 2, 30000);
      }
    }
  }

  /** Waits, unless something changes here first. */
  private async pause(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.wake = undefined;
  }

  /** One full reconciliation. Calls overlap safely: a second caller joins the first. */
  sync(): Promise<void> {
    this.current ??= this.settle().finally(() => {
      this.current = undefined;
    });
    return this.current;
  }

  private async settle(): Promise<void> {
    let waiting = this.last.waiting;
    try {
      for (let round = 0; round < 12; round++) {
        try {
          const outcome = await this.round();
          waiting = outcome.left;
          if (outcome.quiet) {
            const [first] = outcome.problems;
            this.tell({
              // Everything else is in step, but saying "synced" would hide what is not.
              state: first ? 'error' : 'synced',
              waiting: 0,
              at: this.options.now(),
              ...(outcome.held ? { held: outcome.held } : {}),
              ...(first ? { problems: outcome.problems.length, message: first } : {}),
            });
            return;
          }
        } catch (error) {
          if (!(error instanceof Busy)) throw error;
        }
      }
      throw new Error('The notebook kept changing while it was syncing. It will try again.');
    } catch (error) {
      this.last = { ...this.last, waiting };
      throw error;
    }
  }

  private async look(): Promise<View> {
    const files = new Map((await this.store.list()).map((file) => [file.path, file]));
    const keys = new Map([...files.keys()].map((path) => [pathKey(path), path]));
    const where = new Map<string, string>();
    const owner = new Map<string, string>();
    const claim = (id: string, wanted: string | undefined) => {
      // On a Mac's disk a name that differs only in letter case is the same file.
      const path = wanted === undefined || files.has(wanted) ? wanted : keys.get(pathKey(wanted));
      if (!path || !files.has(path) || owner.has(path)) return false;
      where.set(id, path);
      owner.set(path, id);
      return true;
    };
    const missing: string[] = [];
    for (const [id, tracked] of Object.entries(this.state.files))
      if (!claim(id, tracked.local ?? tracked.path) && !(tracked.local && claim(id, tracked.path)))
        missing.push(id);
    // Renamed outside the app: one missing file and one unknown file with the same content.
    const loose = new Map<string, string[]>();
    for (const file of files.values())
      if (!owner.has(file.path) && !file.skip)
        loose.set(file.hash, [...(loose.get(file.hash) ?? []), file.path]);
    const wanted = new Map<string, string[]>();
    for (const id of missing) {
      const hash = this.state.files[id]!.hash;
      if (hash) wanted.set(hash, [...(wanted.get(hash) ?? []), id]);
    }
    for (const [hash, ids] of wanted) {
      const paths = loose.get(hash);
      if (ids.length === 1 && paths?.length === 1) claim(ids[0]!, paths[0]);
    }
    return { files, keys, where, owner };
  }

  private async put(view: View, path: string, bytes: Uint8Array, expected: string | null) {
    if (!(await this.store.write(path, bytes, expected))) throw new Busy();
    view.files.set(path, { path, hash: this.store.hash(bytes), size: bytes.byteLength });
    view.keys.set(pathKey(path), path);
  }
  private async shift(view: View, from: string, to: string): Promise<void> {
    if (!(await this.store.move(from, to))) throw new Busy();
    const file = view.files.get(from)!;
    view.files.delete(from);
    view.keys.delete(pathKey(from));
    view.files.set(to, { ...file, path: to });
    view.keys.set(pathKey(to), to);
    const id = view.owner.get(from);
    view.owner.delete(from);
    if (id) {
      view.owner.set(to, id);
      view.where.set(id, to);
    }
  }
  /** A free name beside `path` for a version that could not be combined. */
  private aside(view: View, path: string): string {
    const slash = path.lastIndexOf('/') + 1;
    const dot = path.lastIndexOf('.');
    const stem = dot > slash ? path.slice(0, dot) : path;
    const extension = dot > slash ? path.slice(dot) : '';
    const time = new Date(this.options.now())
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ')
      .replaceAll(':', '.');
    const device = this.state.deviceName.replace(/[\\/:*?"<>|#^[\]]/g, ' ').trim() || 'device';
    for (let count = 0; ; count++) {
      const candidate = `${stem} (conflicted copy ${device} ${time}${count ? ` ${count}` : ''})${extension}`;
      if (!view.keys.has(pathKey(candidate))) return candidate;
    }
  }
  /** Makes `path` free for file `keep`, moving aside whatever else is there. */
  private async clear(
    view: View,
    path: string,
    pending: Map<string, RemoteFile>,
    keep?: string,
  ): Promise<void> {
    const held = () => {
      const taken = view.keys.get(pathKey(path));
      const mine = keep !== undefined && taken !== undefined && view.owner.get(taken) === keep;
      return mine ? undefined : taken;
    };
    let taken = held();
    if (!taken) return;
    // Its own change in this batch may be about to move it out of the way.
    const occupant = view.owner.get(taken);
    const change = occupant && pending.get(occupant);
    if (change) {
      await this.apply(change, pending, view);
      taken = held();
      if (!taken) return;
    }
    await this.shift(view, taken, this.aside(view, taken));
  }
  private async fetch(hash: string): Promise<Uint8Array> {
    const bytes = await this.transport.getBlob(hash);
    if (this.store.hash(bytes) !== hash) throw new Error('A download arrived damaged.');
    return bytes;
  }

  /** Brings one file in line with a change from the host. */
  private async apply(
    remote: RemoteFile,
    pending: Map<string, RemoteFile>,
    view: View,
  ): Promise<void> {
    pending.delete(remote.file);
    const tracked = this.state.files[remote.file];
    const settle = (hash: string | null = remote.hash) => {
      this.state.files[remote.file] = { path: remote.path, seq: remote.seq, hash };
    };
    const adopt = (path: string) => {
      view.where.set(remote.file, path);
      view.owner.set(path, remote.file);
    };
    if (!tracked) {
      if (remote.hash === null || !validPath(remote.path)) return;
      const there = view.files.get(remote.path);
      if (there?.skip) return;
      // The same file is already here: a first sync of two copies, or a retry after a crash.
      if (!(there && !view.owner.has(there.path) && there.hash === remote.hash)) {
        await this.clear(view, remote.path, pending);
        await this.put(view, remote.path, await this.fetch(remote.hash), null);
      }
      adopt(remote.path);
      settle();
      return;
    }
    if (remote.seq <= tracked.seq) return;
    const find = () => {
      const here = view.where.get(remote.file);
      return here === undefined ? undefined : view.files.get(here);
    };
    let local = find();
    // A file this device cannot sync is never overwritten, moved or trashed by sync.
    if (local?.skip) return;

    if (remote.hash === null) {
      if (local && local.hash === tracked.hash) {
        if (!(await this.store.trash(local.path, local.hash))) throw new Busy();
        view.files.delete(local.path);
        view.keys.delete(pathKey(local.path));
        view.owner.delete(local.path);
        view.where.delete(remote.file);
        delete this.state.files[remote.file];
      } else if (!local) delete this.state.files[remote.file];
      // Deleted there, edited here: the edit survives and is sent back as the file's return.
      else this.state.files[remote.file] = { path: local.path, seq: remote.seq, hash: null };
      return;
    }
    if (!validPath(remote.path)) return;
    if (!local) {
      // Deleted here, changed there: the change wins and the file comes back.
      await this.clear(view, remote.path, pending);
      await this.put(view, remote.path, await this.fetch(remote.hash), null);
      adopt(remote.path);
      settle();
      return;
    }
    let path = local.path;
    // A rename on the host is followed. A rename made only here stays, and is sent later.
    if (remote.path !== tracked.path && remote.path !== path) {
      await this.clear(view, remote.path, pending, remote.file);
      // Clearing the way can move this very file, when two files are trading names.
      local = find();
      if (!local) throw new Busy();
      await this.shift(view, local.path, remote.path);
      path = remote.path;
    }
    if (remote.hash !== local.hash) {
      const theirs = await this.fetch(remote.hash);
      if (local.hash === tracked.hash) await this.put(view, path, theirs, local.hash);
      else {
        // Changed on both sides since they last agreed.
        const mine = await this.store.read(path);
        if (this.store.hash(mine) !== local.hash) throw new Busy();
        const mineText = text(path, mine);
        const theirText = text(path, theirs);
        const base = tracked.hash ? text(path, await this.fetch(tracked.hash)) : undefined;
        const merged =
          mineText !== undefined && theirText !== undefined && base !== undefined
            ? mergeText(base, mineText, theirText)
            : undefined;
        if (merged !== undefined) await this.put(view, path, encoder.encode(merged), local.hash);
        else {
          // Keep both: the host's version stays the note, this device's goes beside it.
          await this.put(view, this.aside(view, path), mine, null);
          await this.put(view, path, theirs, local.hash);
        }
      }
    }
    settle();
    if (path !== remote.path) this.state.files[remote.file]!.local = path;
  }

  /**
   * Where a file's path here differs from the agreed one only in letter case, and the app
   * did not rename it, the disk is brought into line. A disk that ignores case keeps
   * whatever spelling a folder already had, and the host keeps one spelling per folder, so
   * following the host is what lets every device end up the same.
   */
  private async respell(view: View): Promise<void> {
    for (const [file, tracked] of Object.entries(this.state.files)) {
      const here = view.where.get(file);
      const wanted = tracked.local ?? tracked.path;
      if (here === undefined || here === wanted || pathKey(here) !== pathKey(wanted)) continue;
      if (view.files.get(here)?.skip || !validPath(wanted)) continue;
      await this.shift(view, here, wanted);
      // Respelling a folder respells it for everything inside.
      const from = here.slice(0, here.lastIndexOf('/') + 1);
      const to = wanted.slice(0, wanted.lastIndexOf('/') + 1);
      if (from !== to)
        for (const other of [...view.files.keys()])
          if (other.startsWith(from)) this.rename(view, other, to + other.slice(from.length));
    }
  }
  /** Records that a file is now known under another spelling, without touching the disk. */
  private rename(view: View, from: string, to: string): void {
    const entry = view.files.get(from);
    if (!entry || from === to) return;
    view.files.delete(from);
    view.files.set(to, { ...entry, path: to });
    view.keys.set(pathKey(to), to);
    const id = view.owner.get(from);
    view.owner.delete(from);
    if (id) {
      view.owner.set(to, id);
      view.where.set(id, to);
    }
  }

  /** The changes here that the host has not accepted, in an order it can apply. */
  private plan(view: View, problems: string[]): { op: Op; path?: string }[] {
    const id = (file: string, base: number, path: string, hash: string | null) =>
      this.store.hash(encoder.encode([file, base, path, hash ?? ''].join('\n')));
    const deletions: { op: Op }[] = [];
    const updates: { op: Op; path: string }[] = [];
    for (const [file, tracked] of Object.entries(this.state.files)) {
      const path = view.where.get(file);
      const local = path === undefined ? undefined : view.files.get(path);
      if (local?.skip) continue;
      if (local && !validPath(local.path)) {
        problems.push(`“${local.path}” has a name that cannot be synced.`);
        continue;
      }
      if (!local) {
        // Deleted on both sides: nothing left to say.
        if (tracked.hash === null) delete this.state.files[file];
        else
          deletions.push({
            op: {
              id: id(file, tracked.seq, tracked.path, null),
              file,
              base: tracked.seq,
              path: tracked.path,
              hash: null,
              size: 0,
            },
          });
      } else if (local.hash !== tracked.hash || local.path !== tracked.path)
        updates.push({
          path: local.path,
          op: {
            id: id(file, tracked.seq, local.path, local.hash),
            file,
            base: tracked.seq,
            path: local.path,
            hash: local.hash,
            size: local.size,
          },
        });
    }
    const created: { op: Op; path: string }[] = [];
    for (const local of view.files.values()) {
      if (view.owner.has(local.path) || local.skip) continue;
      if (!validPath(local.path)) {
        problems.push(`“${local.path}” has a name that cannot be synced.`);
        continue;
      }
      const file = this.options.newId();
      created.push({
        path: local.path,
        op: {
          id: id(file, 0, local.path, local.hash),
          file,
          base: 0,
          path: local.path,
          hash: local.hash,
          size: local.size,
        },
      });
    }
    return [...deletions, ...updates, ...created];
  }

  private async round(): Promise<{
    quiet: boolean;
    left: number;
    held: number;
    problems: string[];
  }> {
    const view = await this.look();
    const pulled = await this.transport.changes(this.state.cursor, 0);
    const renewed =
      pulled.generation !== undefined &&
      this.state.generation !== undefined &&
      pulled.generation !== this.state.generation;
    // A host that is behind what this device has already applied was also put back in time,
    // even if nothing announced it.
    if (renewed || pulled.head < this.state.cursor) {
      // The host was restored from a backup. Everything up to `floor` is history both sides
      // still share, so what was agreed about it stands, and anything newer on the host is
      // met in the usual way. What this device agreed after that point no longer exists on
      // the host: those files are taken to stand where the restored host has them, so that
      // what is here counts as a change made here and is sent up. Files the host no longer
      // knows become new ones.
      const restored = await this.transport.changes(0, 0);
      const floor = renewed ? (restored.floor ?? 0) : restored.head;
      const there = new Map(restored.changes.map((change) => [change.file, change]));
      for (const [id, tracked] of Object.entries(this.state.files)) {
        if (tracked.seq <= floor) continue;
        const host = there.get(id);
        const here = tracked.local ?? tracked.path;
        if (!host) delete this.state.files[id];
        else if (host.hash === null)
          this.state.files[id] = { path: here, seq: host.seq, hash: null };
        else
          this.state.files[id] = {
            path: host.path,
            seq: host.seq,
            hash: host.hash,
            ...(here !== host.path ? { local: here } : {}),
          };
      }
      this.state.cursor = 0;
      if (restored.generation) this.state.generation = restored.generation;
      await this.persist();
      return this.round();
    }
    if (pulled.generation) this.state.generation = pulled.generation;
    const { changes, head } = pulled;
    const pending = new Map(changes.map((change) => [change.file, change]));
    const problems: string[] = [];
    try {
      for (const change of changes) {
        if (!pending.has(change.file)) continue;
        try {
          await this.apply(change, pending, view);
        } catch (error) {
          if (error instanceof Busy || error instanceof Unauthorized) throw error;
          // One change this device cannot apply must not hold up all the others.
          problems.push(
            `“${change.path}” could not be updated: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      // The cursor stays put while anything is unapplied, so it is tried again next time.
      if (!problems.length) this.state.cursor = Math.max(this.state.cursor, head);
    } finally {
      // Whatever was applied is remembered, even if the batch was interrupted.
      await this.persist();
    }

    await this.respell(view);
    let plan = this.plan(view, problems);
    // A folder that is suddenly mostly empty is more likely unmounted or mid-restore than
    // deliberately cleared, so mass deletions wait for the user.
    const deletions = plan.filter((entry) => entry.op.hash === null).length;
    const tracked = Object.keys(this.state.files).length;
    let held = 0;
    if (deletions >= 10 && deletions * 2 > tracked && !this.allowDeletions) {
      held = deletions;
      plan = plan.filter((entry) => entry.op.hash !== null);
    }
    if (!plan.length) {
      if (!held) this.allowDeletions = false;
      return { quiet: true, left: 0, held, problems };
    }
    this.tell({ state: 'syncing', waiting: plan.length, ...(held ? { held } : {}) });

    let left = plan.length;
    let quiet = true;
    // Sent together where possible: files trading names can only be accepted as a set.
    for (let start = 0; start < plan.length; start += 4000) {
      const batch = plan.slice(start, start + 4000);
      for (const { op, path } of batch) {
        if (!op.hash || !path || (await this.transport.hasBlob(op.hash))) continue;
        const bytes = await this.store.read(path);
        if (this.store.hash(bytes) !== op.hash) throw new Busy();
        await this.transport.putBlob(op.hash, bytes);
      }
      const results = await this.transport.push(batch.map((entry) => entry.op));
      for (const [position, result] of results.entries()) {
        const { op } = batch[position]!;
        if (result.status === 'invalid') {
          left--;
          problems.push(`“${op.path}” was not accepted: ${result.reason}`);
          continue;
        }
        if (result.status === 'path-taken' && problems.length) {
          // Normally the next pull moves one of the two files aside. Here a change could
          // not be applied, so that will not happen: report it instead of trying forever.
          left--;
          problems.push(`“${op.path}” is waiting for another file to get out of its way.`);
          continue;
        }
        if (result.status !== 'accepted') {
          quiet = false;
          continue;
        }
        left--;
        if (op.hash === null) delete this.state.files[op.file];
        else
          this.state.files[op.file] = {
            path: result.path ?? op.path,
            seq: result.seq,
            hash: op.hash,
          };
      }
      await this.persist();
    }
    if (quiet && !held) this.allowDeletions = false;
    return { quiet, left, held, problems };
  }
}
