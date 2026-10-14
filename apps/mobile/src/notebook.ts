import { Directory, Paths } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import * as SecureStore from 'expo-secure-store';
import type { SyncInfo, VaultTree } from '@opsidian/core';
import { SyncService, Vault, hostAddress, usePlatform } from '@opsidian/notebook';
import { pathOf, phonePlatform, recover } from './platform';

usePlatform(phonePlatform);

/** The device's `fetch`, with network failures put in words a person can act on. */
const request = (async (input: string, init?: Parameters<typeof expoFetch>[1]) => {
  try {
    return await expoFetch(input, init);
  } catch (reason) {
    if (init?.signal?.aborted) throw reason;
    throw new Error('The host could not be reached.');
  }
}) as unknown as typeof fetch;

/** The one notebook this iPhone holds, in the app's Documents folder. */
const home = new Directory(Paths.document, 'Opsidian');
const key = (device: string) => `opsidian.device.${device.replace(/[^A-Za-z0-9._-]/g, '_')}`;

export interface Notebook {
  vault: Vault;
  sync: SyncService;
}
type Listener = () => void;

let notebook: Notebook | undefined;
let tree: VaultTree = { notes: [], folders: [], images: [] };
let info: SyncInfo = { connected: false };
/** Counts up with every change to the notes, so screens know to look again. */
let version = 0;
let changedNotes: string[] = [];
const listeners = new Set<Listener>();
/** Counts every announcement, so a screen can tell that something, anything, changed. */
let stamp = 0;
const announce = () => {
  stamp++;
  for (const listener of listeners) listener();
};

export const store = {
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  get notebook() {
    return notebook;
  },
  get tree() {
    return tree;
  },
  get sync() {
    return info;
  },
  get version() {
    return version;
  },
  get stamp() {
    return stamp;
  },
  /** The notes that changed in the latest version, when sync or the app rewrote them. */
  get changed() {
    return changedNotes;
  },
  get exists() {
    return home.exists;
  },
  /** The notebook's name: the host's name for it once connected. */
  get name() {
    return info.notebook ?? 'Notebook';
  },
};

/** Reads the note list again after the app itself changed something. */
export function refresh(paths: string[] = []): void {
  if (!notebook) return;
  tree = notebook.vault.tree();
  changedNotes = paths;
  version++;
  announce();
}

/** Opens the notebook on this iPhone, creating the folder if asked to. */
export function open(create = false): Promise<Notebook | undefined> {
  if (notebook) return Promise.resolve(notebook);
  if (!home.exists && !create) return Promise.resolve(undefined);
  // One opening at a time: two would mean two engines syncing the same folder.
  opening ??= start().finally(() => {
    opening = undefined;
  });
  return opening;
}
let opening: Promise<Notebook> | undefined;
async function start(): Promise<Notebook> {
  home.create({ intermediates: true, idempotent: true });
  const root = pathOf(home.uri);
  recover(root);
  const vault = await Vault.open(root);
  const sync = new SyncService(
    {
      get: async (device) => (await SecureStore.getItemAsync(key(device))) ?? undefined,
      set: async (device, token) => {
        if (token === undefined) await SecureStore.deleteItemAsync(key(device));
        else
          await SecureStore.setItemAsync(key(device), token, {
            keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
          });
      },
    },
    () => Device.deviceName || Device.modelName || 'iPhone',
    (next) => {
      info = next;
      announce();
    },
    request,
    () => Crypto.randomUUID(),
  );
  notebook = { vault, sync };
  tree = vault.tree();
  // Everything that changes the folder, including sync, arrives here.
  vault.watch((paths) => refresh(paths));
  await sync.attach(vault);
  info = sync.info();
  announce();
  return notebook;
}

/** Spends an invitation and ties this iPhone's notebook to that host. */
export async function connect(host: string, code: string): Promise<void> {
  const address = hostAddress(host);
  // Pair before touching the disk, so a wrong code leaves nothing behind.
  const pairing = await new SyncService(
    { get: async () => undefined, set: async () => {} },
    () => Device.deviceName || Device.modelName || 'iPhone',
    () => {},
    request,
  ).invite(address, code.trim());
  const opened = await open(true);
  if (!opened) throw new Error('The notebook could not be opened.');
  if (opened.sync.info().connected) await opened.sync.disconnect();
  await opened.sync.adopt(opened.vault, address, pairing);
}
