import type { Backlink, SearchResult } from './note-index';

export interface VaultInfo {
  name: string;
  location: string;
}
/** Vault-relative paths using `/`, sorted. Notes keep their `.md` extension. */
export interface VaultTree {
  notes: string[];
  folders: string[];
  /** Images anywhere in the vault, so `![[photo.png]]` can find one by name. */
  images: string[];
}
export interface NoteDocument {
  content: string;
  /** Identifies the on-disk content this text was read from or written as. */
  revision: string;
}
/** A save either lands, or the edit is kept beside a file that changed underneath it. */
export type SaveResult =
  /** `merged` is what the file now holds when the edit was combined with a newer version. */
  { revision: string; merged?: string } | { conflict: string };

/** Where a note or folder ended up, and the notes whose links were rewritten to follow it. */
export interface MoveResult {
  path: string;
  rewritten: string[];
  /** Notes that link to it but could not be updated, for example read-only ones. */
  missed: string[];
}
export interface TrashEntry {
  /** Name inside the trash, unique there. */
  name: string;
  /** Where it was before, when known. Items trashed by other programs have no record. */
  from?: string;
  folder: boolean;
  /** Milliseconds since the epoch. */
  at: number;
}

/** Whether this copy of the notebook is connected to a host, and how that is going. */
export interface SyncInfo {
  connected: boolean;
  host?: string;
  notebook?: string;
  device?: string;
  state?: 'syncing' | 'synced' | 'offline' | 'error';
  /** Changes made here that the host has not accepted yet. */
  waiting?: number;
  message?: string;
  /** Files that could not be synced; `message` describes the first. */
  problems?: number;
  /** Deletions held back until confirmed, because so many arrived at once. */
  held?: number;
  /** When this copy last matched the host, milliseconds. */
  at?: number;
}
export interface NoteVersion {
  seq: number;
  path: string;
  /** Null for the version in which the note was deleted. */
  hash: string | null;
  size: number;
  device: string;
  at: number;
}

/** What the desktop interface needs from whatever stores the vault. */
export interface VaultBridge {
  current(): Promise<VaultInfo | null>;
  defaultParent(): Promise<string>;
  chooseParent(): Promise<string | null>;
  createVault(name: string, parent?: string): Promise<VaultInfo>;
  openVault(): Promise<VaultInfo | null>;
  tree(): Promise<VaultTree>;
  read(path: string): Promise<NoteDocument>;
  save(path: string, content: string, revision: string): Promise<SaveResult>;
  createNote(folder: string, name?: string): Promise<string>;
  createFolder(parent: string, name: string): Promise<string>;
  /** Renames a note or folder in place and rewrites the links that pointed at it. */
  rename(path: string, name: string): Promise<MoveResult>;
  /** Moves a note or folder into another folder (`''` is the top level). */
  move(path: string, folder: string): Promise<MoveResult>;
  /** Moves a note, or a folder and everything in it, to the notebook's trash. */
  trash(path: string): Promise<void>;
  trashed(): Promise<TrashEntry[]>;
  /** Puts a trashed item back and returns where it now is. */
  restore(name: string): Promise<string>;
  /** Moves everything in the notebook's trash to the system Trash. False if cancelled. */
  emptyTrash(): Promise<boolean>;
  backlinks(path: string): Promise<Backlink[]>;
  search(query: string): Promise<SearchResult[]>;
  /** Copies a chosen image into the vault and returns its vault-relative path. */
  importImage(): Promise<string | null>;
  /** Stores pasted or dropped image bytes in the vault and returns the vault-relative path. */
  saveImage(bytes: Uint8Array): Promise<string>;
  imageUrl(path: string): string | undefined;
  reveal(path: string): Promise<void>;
  /** Called with the notes whose content changed outside this window. */
  onChange(callback: (paths: string[]) => void): () => void;
  syncInfo(): Promise<SyncInfo>;
  /** Connects the open notebook to a host using a single-use invitation. */
  connect(host: string, code: string): Promise<SyncInfo>;
  /** Stops syncing. The notes stay on this device and on the host. */
  disconnect(): Promise<void>;
  confirmDeletions(): Promise<void>;
  /** Creates a folder for a notebook that lives on a host, and downloads it. */
  joinVault(host: string, code: string, parent?: string): Promise<VaultInfo>;
  /** Earlier versions of a note, newest first. Empty when the notebook is not synced. */
  history(path: string): Promise<NoteVersion[]>;
  versionText(hash: string): Promise<string>;
  onSync(callback: (info: SyncInfo) => void): () => void;
}

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
/** Whether a Markdown image destination is a local raster image inside the vault. */
export function isVaultImage(path: string): boolean {
  return (
    IMAGE.test(path) &&
    !/^[a-z][a-z0-9+.-]*:/i.test(path) &&
    !path.split('/').some((part) => !part || part.startsWith('.'))
  );
}
