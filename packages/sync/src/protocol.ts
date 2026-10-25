/** Version of the wire protocol, carried in every URL as `/v1/…`. */
export const PROTOCOL = 1;

/** The state of one file as the host knows it. A null hash means it has been deleted. */
export interface RemoteFile {
  /** Position in the notebook's change log. Later changes have larger numbers. */
  seq: number;
  /** Identity that stays with the file through renames and moves. */
  file: string;
  path: string;
  hash: string | null;
  size: number;
  /** Name of the device that made the change. */
  device: string;
  /** Host clock, milliseconds. For display only: ordering always uses `seq`. */
  at: number;
}

/** A change a device asks the host to accept. */
export interface Op {
  /** Derived from the op's content, so sending it twice has one effect. */
  id: string;
  file: string;
  /** The `seq` of the version this change was made from; 0 for a new file. */
  base: number;
  path: string;
  /** sha256 of the content, already uploaded. Null deletes the file. */
  hash: string | null;
  size: number;
}

export type OpResult =
  /**
   * `path` is present when the host spelled a folder differently: every file in a folder
   * shares one spelling of its name, and the first one there decides it.
   */
  | { id: string; status: 'accepted'; seq: number; path?: string }
  /** The file moved on since `base`. Pull, reconcile, and send again. */
  | { id: string; status: 'stale' }
  /** Another file holds that path. */
  | { id: string; status: 'path-taken' }
  | { id: string; status: 'missing-blob' }
  | { id: string; status: 'invalid'; reason: string };

export interface Changes {
  /** The latest state of every file changed after the cursor, oldest change first. */
  changes: RemoteFile[];
  /** Cursor to ask from next time. */
  head: number;
  /**
   * Changes whenever the host's history is replaced, as when it is restored from a backup.
   * A device that sees a new one forgets what it had agreed and meets the host afresh.
   */
  generation?: string;
  /**
   * The last change the host still had when it was restored. What a device agreed up to
   * here still holds; what it agreed after is gone from the host.
   */
  floor?: number;
}

export interface Pairing {
  notebook: { id: string; name: string };
  device: { id: string; name: string };
  /** The device's credential. Shown once. */
  token: string;
}

/** How a device talks to the host. Every call may fail; all of them are safe to repeat. */
export interface Transport {
  /** `wait` seconds is how long the host may hold the request until something changes. */
  changes(since: number, wait: number, signal?: AbortSignal): Promise<Changes>;
  push(ops: Op[]): Promise<OpResult[]>;
  hasBlob(hash: string): Promise<boolean>;
  getBlob(hash: string): Promise<Uint8Array>;
  putBlob(hash: string, bytes: Uint8Array): Promise<void>;
  /** Every version of a file, newest first. */
  history(file: string): Promise<RemoteFile[]>;
}

/** Thrown by a transport when the host no longer accepts this device. */
export class Unauthorized extends Error {
  constructor(message = 'This device is no longer connected to the notebook.') {
    super(message);
  }
}

/**
 * Thrown by a store when the notebook's folder is no longer there, or a different folder now
 * stands at its path. Nothing may be read from or written to it: an empty folder in its place
 * would look like every note deleted, and recreating it would bring back an empty notebook.
 */
export class FolderGone extends Error {
  constructor() {
    super('The notebook’s folder is no longer where it was.');
  }
}

/**
 * Thrown by a transport when the host moved to another machine. Only a device the host still
 * accepts is told, so `to` comes from the host it trusted; the device checks it before following.
 */
export class Moved extends Error {
  constructor(readonly to: string) {
    super(`The host moved to ${to.replace(/^https?:\/\//, '')}.`);
  }
}

export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/** Whether a path may be synced: notebook-relative, nothing hidden, no way out of the folder. */
export function validPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= 1000 &&
    !/[\\\u0000-\u001f]/.test(path) &&
    path.split('/').every((part) => part && !part.startsWith('.') && part.trim() === part)
  );
}

/** Paths that differ only in letter case or accent encoding are the same file on a Mac. */
export const pathKey = (path: string) => path.normalize('NFC').toLowerCase();
