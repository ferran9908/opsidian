import type { Backlink, SearchResult } from './note-index';

export interface VaultInfo {
  name: string;
  location: string;
}
/** Vault-relative paths using `/`, sorted. Notes keep their `.md` extension. */
export interface VaultTree {
  notes: string[];
  folders: string[];
}
export interface NoteDocument {
  content: string;
  /** Identifies the on-disk content this text was read from or written as. */
  revision: string;
}
/** A save either lands, or the edit is kept beside a file that changed underneath it. */
export type SaveResult = { revision: string } | { conflict: string };

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
  rename(path: string, name: string): Promise<string>;
  trash(path: string): Promise<void>;
  backlinks(path: string): Promise<Backlink[]>;
  search(query: string): Promise<SearchResult[]>;
  /** Copies a chosen image into the vault and returns its vault-relative path. */
  importImage(): Promise<string | null>;
  imageUrl(path: string): string | undefined;
  reveal(path: string): Promise<void>;
  /** Called with the notes whose content changed outside this window. */
  onChange(callback: (paths: string[]) => void): () => void;
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
