import type { NoteGraph } from './graph';
import type { TagCount } from './note-index';
import type { Backlink, SearchResult } from './note-index';
import type { AppUpdate, UpdateCheck } from './update';

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
/** A notebook whose folder is not where it was: deleted, moved, or on a disk not attached. */
export interface MissingNotebook {
  name: string;
  /** Where the folder was. */
  location: string;
  /** Present when it synced, so its notes can be downloaded again from this host. */
  host?: string;
  notebook?: string;
}

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
  /** The host no longer accepts this device: it was removed there. Its notes stay here. */
  removed?: boolean;
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

/** One step of the connection check. Mirrors the sync package's own type. */
export interface ConnectionCheck {
  id: 'online' | 'reach' | 'accepted';
  state: 'ok' | 'failed' | 'skipped';
  title: string;
  detail?: string;
  tailscale?: true;
}
export interface HostedNotebook {
  name: string;
  files: number;
  versions: number;
  bytes: number;
}
export interface HostedDevice {
  id: string;
  notebook: string;
  name: string;
  created: number;
  seen?: number;
  /** This very Mac. */
  self: boolean;
  /** The repository, when this is the device that keeps a notebook on GitHub. */
  github?: string;
}
/** Whether this Mac hosts notebooks for other devices, and what it is hosting. */
export interface HostingInfo {
  hosting: boolean;
  /** Why hosting could not start, for example the port being in use. */
  error?: string;
  port: number;
  /** Where other devices reach this Mac. */
  addresses: { kind: 'tailscale' | 'network'; address: string }[];
  notebooks: HostedNotebook[];
  devices: HostedDevice[];
  invitations: { id: string; notebook: string; expires: number }[];
  /** Keep hosting from the menu bar after the window is closed. */
  keepRunning: boolean;
  /** Another machine is copying this host to take it over. */
  moving?: boolean;
  /** This Mac's host moved to another machine; it now only points devices there. */
  moved?: {
    to: string;
    at: number;
    devices: { id: string; name: string; notebook: string; seen?: number; told?: number }[];
  };
}
/** What another machine needs to take this Mac's host over. */
export interface Handoff {
  code: string;
  expires: number;
  /** This Mac's address, as the other machine reaches it. */
  address: string;
  /** What to run on a server to take over. */
  command: string;
}
/** How far taking a host over has got. */
export interface TakeOverProgress {
  phase: 'connecting' | 'copying' | 'pausing' | 'finishing';
  done: number;
  total: number;
}
export interface Invitation {
  notebook: string;
  code: string;
  expires: number;
  /** The address to type on another device; the first of `HostingInfo.addresses`. */
  address: string;
  /** `opsidian://connect?…`, which the iPhone app reads from a QR code. */
  link: string;
  /** The link as a QR code: one string per row, `1` for a dark square. */
  qr: string[];
}
/** A notebook this Mac hosts, kept in a GitHub repository too. */
export interface GitHubMirror {
  notebook: string;
  /** `owner/name`, or the address for a repository elsewhere. */
  repository: string;
  /** The repository's page. */
  url?: string;
  state: 'syncing' | 'synced' | 'offline' | 'error' | 'waiting';
  message?: string;
  /** When the repository last matched the notebook. */
  at?: number;
  /** Deletions waiting to be confirmed, because most of the notebook vanished from GitHub. */
  held?: number;
  /** When the host plans the next round: the next scheduled one, or the next try. */
  next?: number;
  /** Not in step for twice as long as the schedule allows: the copy is no recent backup. */
  behind?: boolean;
}
/** How often the host copies notebooks to GitHub: following each change, or on a schedule. */
export type GitHubSchedule = 'live' | '15m' | '1h' | '6h' | '24h';
export interface GitHubInfo {
  /** Who is signed in to GitHub on this Mac. */
  account?: { login: string; name?: string };
  /** Why GitHub cannot be used here, such as git not being installed. */
  problem?: string;
  mirrors: GitHubMirror[];
  /** For every notebook hosted here. */
  every: GitHubSchedule;
}
/**
 * The open notebook's copy on GitHub, as its host tells any device, whichever machine hosts
 * it. Mirrors the sync package's own type.
 */
export interface GitHubCopy {
  /** `you/notes`, or the repository's address when it is not on GitHub. */
  repository: string;
  state: 'syncing' | 'synced' | 'offline' | 'error';
  message?: string;
  /** When the repository last matched the notebook, milliseconds. */
  at?: number;
  /** When the host plans its next round. */
  next?: number;
  /** Deletions held back until confirmed on the host. */
  held?: number;
}
export interface GitHubRepository {
  fullName: string;
  private: boolean;
  /** Has no commits yet. */
  empty: boolean;
  pushedAt?: string;
}
/** A repository that exists, by `owner/name` or address; or a new private one to make. */
export type RepositoryChoice = { repository: string } | { create: string };
export interface BackupSettings {
  folder?: string;
  /** Hour of the day, 0–23, at which a daily backup is made. Absent: only by hand. */
  hour?: number;
  keep: number;
}
export interface BackupInfo extends BackupSettings {
  backups: { name: string; at: number; notebooks: HostedNotebook[] }[];
  /** The latest attempt that did not work. Cleared by the next one that does. */
  failed?: { at: number; message: string };
}

/** What the desktop interface needs from whatever stores the vault. */
export interface VaultBridge {
  current(): Promise<VaultInfo | null>;
  /** The notebook whose folder is no longer where it was, if any. */
  missing(): Promise<MissingNotebook | null>;
  /** Downloads the missing notebook again into its old place, and opens it. */
  restoreVault(): Promise<VaultInfo>;
  /** Stops syncing the missing notebook and removes this device from its host. */
  forgetMissing(): Promise<{ hostTold: boolean }>;
  /** Puts the missing notebook out of mind without touching its host. */
  dismissMissing(): Promise<void>;
  /** Closes the open notebook, for one whose folder is gone. */
  closeVault(): Promise<void>;
  /** The open notebook's folder went away (the notebook) or came back (null). */
  onPresence(callback: (missing: MissingNotebook | null) => void): () => void;
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
  /** The notebook's link graph: notes, unresolved targets, and unique directed edges. */
  graph(options?: { tags?: boolean }): Promise<NoteGraph>;
  /** Every tag in the notebook, most used first. */
  tags(): Promise<TagCount[]>;
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
  /**
   * Stops syncing here. `hostTold` is false when the host could not be reached to forget it.
   * With `trash`, the folder then goes to the system Trash, but only if every note in it had
   * reached the host (`trashed`); otherwise it stays as it is.
   */
  disconnect(options?: { trash?: boolean }): Promise<{ hostTold: boolean; trashed?: boolean }>;
  confirmDeletions(): Promise<void>;
  /** Creates a folder for a notebook that lives on a host, and downloads it. */
  joinVault(host: string, code: string, parent?: string): Promise<VaultInfo>;
  /** Earlier versions of a note, newest first. Empty when the notebook is not synced. */
  history(path: string): Promise<NoteVersion[]>;
  versionText(hash: string): Promise<string>;
  onSync(callback: (info: SyncInfo) => void): () => void;
  /** The open notebook's copy on GitHub, from its host. Null when it is not kept there. */
  githubCopy(): Promise<GitHubCopy | null>;
  /**
   * Has the host copy the open notebook to GitHub now, whatever the schedule and whichever
   * machine hosts it. This device's edits reach the host first, so they are in the copy.
   */
  syncWithGitHub(): Promise<GitHubCopy>;
  /** Why sync is not working, one step at a time. Empty when not connected. */
  checkConnection(): Promise<ConnectionCheck[]>;
  openTailscale(): Promise<void>;
  hosting(): Promise<HostingInfo>;
  /** Makes this Mac the host for the open notebook, and connects the notebook to it. */
  startHosting(): Promise<HostingInfo>;
  stopHosting(): Promise<HostingInfo>;
  setKeepRunning(value: boolean): Promise<HostingInfo>;
  invite(notebook: string): Promise<Invitation>;
  cancelInvitation(id: string): Promise<HostingInfo>;
  removeDevice(id: string): Promise<HostingInfo>;
  /**
   * Deletes a notebook this Mac hosts, with its whole history, after backing the host up if
   * backups are set up. Devices keep their notes; the open notebook stops syncing with it.
   */
  deleteHostedNotebook(name: string): Promise<HostingInfo>;
  /**
   * Puts Opsidian on this Mac back as it was when first installed: the host and everything it
   * holds, settings, the GitHub sign-in, and every connection to a host. Notebook folders and
   * their notes stay. Backs the host up first when backups are set up; then the app restarts.
   */
  resetApp(): Promise<void>;
  backups(): Promise<BackupInfo>;
  /** Asks for a folder. Null if cancelled. */
  chooseBackupFolder(): Promise<BackupInfo | null>;
  setBackupSchedule(hour: number | null, keep: number): Promise<BackupInfo>;
  backUpNow(): Promise<BackupInfo>;
  restoreBackup(name: string): Promise<BackupInfo>;
  onHosting(callback: (info: HostingInfo) => void): () => void;
  /** Lets another machine take this Mac's host over. */
  moveHosting(): Promise<Handoff>;
  /**
   * Makes this Mac the host, taking everything over from the host at `address`; devices,
   * this Mac's own notebook included, follow by themselves.
   */
  takeOverHosting(address: string, code: string): Promise<HostingInfo>;
  onTakeOver(callback: (progress: TakeOverProgress) => void): () => void;
  /** Syncs with the same host at a new address, after it moved to another machine. */
  followHost(address: string): Promise<SyncInfo>;
  github(): Promise<GitHubInfo>;
  /** Starts signing in: opens GitHub in the browser and returns the code to enter there. */
  signInToGitHub(): Promise<{ code: string; url: string }>;
  /** Resolves once the code has been entered on GitHub. */
  finishGitHubSignIn(): Promise<GitHubInfo>;
  cancelGitHubSignIn(): Promise<void>;
  signOutOfGitHub(): Promise<GitHubInfo>;
  githubRepositories(): Promise<GitHubRepository[]>;
  /** Keeps a hosted notebook in a repository from now on, in both directions. */
  keepOnGitHub(notebook: string, choice: RepositoryChoice): Promise<GitHubInfo>;
  /** Makes a notebook from a repository, hosted on this Mac, in a new folder, and opens it. */
  importFromGitHub(choice: RepositoryChoice, parent?: string): Promise<VaultInfo>;
  syncGitHub(notebook: string, confirmDeletions?: boolean): Promise<GitHubInfo>;
  setGitHubSchedule(every: GitHubSchedule): Promise<GitHubInfo>;
  /** Stops keeping a notebook on GitHub. The repository and the notebook stay as they are. */
  stopGitHub(notebook: string): Promise<GitHubInfo>;
  /** This app's own update: where it stands, and what can be done about it. */
  updateState(): Promise<AppUpdate>;
  /** Rejects with a readable message when the update server cannot be reached. */
  checkForUpdate(): Promise<UpdateCheck>;
  downloadUpdate(): Promise<void>;
  restartToUpdate(): Promise<void>;
  appVersion(): Promise<string>;
  /** Opens the guide to Opsidian in the browser. */
  openHelp(): Promise<void>;
  /** Cut, copy or paste where the cursor is, as the Edit menu would. */
  clipboard(action: 'cut' | 'copy' | 'paste'): Promise<void>;
  onUpdate(callback: (update: AppUpdate) => void): () => void;
  /** The app menu's Check for Updates…, asking the window to check where it can be seen. */
  onUpdateCheckRequested(callback: () => void): () => void;
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
