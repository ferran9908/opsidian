import { safeStorage } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import type { SyncInfo } from '@opsidian/core';
import { SyncService, type Connection, type Connections, type Secrets } from '@opsidian/notebook';

export { hostAddress } from '@opsidian/notebook';

/** Device credentials in `devices.json`, encrypted with the Mac's keychain. */
function keychain(userData: string): Secrets {
  const path = join(userData, 'devices.json');
  const all = async (): Promise<Record<string, string>> => {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  };
  return {
    async get(device) {
      const stored = (await all())[device];
      if (!stored) return undefined;
      if (stored.startsWith('plain:')) return stored.slice(6);
      try {
        return safeStorage.decryptString(Buffer.from(stored.slice(5), 'base64'));
      } catch {
        return undefined;
      }
    },
    async set(device, token) {
      const tokens = await all();
      if (token === undefined) delete tokens[device];
      else
        tokens[device] = safeStorage.isEncryptionAvailable()
          ? `safe:${safeStorage.encryptString(token).toString('base64')}`
          : `plain:${token}`;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(tokens), { mode: 0o600 });
    },
  };
}

/**
 * Which host each notebook folder syncs with, in `notebooks.json`. Holds no credential: those
 * stay in `devices.json`. Kept so a notebook whose folder was deleted can be downloaded again.
 */
function folders(userData: string): Connections {
  const path = join(userData, 'notebooks.json');
  const all = async (): Promise<Record<string, Connection>> => {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as Record<string, Connection>;
    } catch {
      return {};
    }
  };
  return {
    get: async (root) => (await all())[root],
    async set(root, connection) {
      const known = await all();
      if (JSON.stringify(known[root]) === JSON.stringify(connection)) return;
      if (connection) known[root] = connection;
      else delete known[root];
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(known), { mode: 0o600 });
    },
  };
}

/** Every notebook folder this Mac remembers a host for, for starting over. */
export async function rememberedFolders(userData: string): Promise<string[]> {
  try {
    return Object.keys(JSON.parse(await readFile(join(userData, 'notebooks.json'), 'utf8')));
  } catch {
    return [];
  }
}

/** Sync for the Mac app. The device is named after the Mac. */
export const desktopSync = (userData: string, notify: (info: SyncInfo) => void) =>
  new SyncService(
    keychain(userData),
    () => hostname().replace(/\.(local|lan)$/i, '') || 'Mac',
    notify,
    undefined,
    undefined,
    folders(userData),
  );
