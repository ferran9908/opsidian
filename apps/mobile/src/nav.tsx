import { createContext, useContext } from 'react';
import type { NoteVersion, SyncInfo } from '@opsidian/core';
import type { Colors } from './ui';

export type Route =
  /** The notes themselves: the open note, the files drawer, and the bar at the bottom. */
  | { name: 'notes' }
  | { name: 'search' }
  | { name: 'settings' }
  | { name: 'trash' }
  | { name: 'sync' }
  | { name: 'connect' }
  | { name: 'check' }
  | { name: 'history'; path: string }
  | { name: 'version'; path: string; version: NoteVersion };

export interface Navigation {
  push(route: Route): void;
  pop(): void;
  /** Swaps the screen on top, for example when the open note is renamed. */
  replace(route: Route): void;
  /** What the back button should say. */
  back: string;
  /** Opens a note, as a step back and forward can return to, over whatever else is showing. */
  openNote(path: string, heading?: string): void;
  /** The open note was renamed or moved: the same note, somewhere else. */
  replaceNote(path: string): void;
  /** The open note is gone: shows the one before it, if any. */
  dropNote(): void;
  /** Goes back (-1) or forward (1) through the notes opened. */
  step(by: -1 | 1): void;
  canStep(by: -1 | 1): boolean;
}
export const NavigationContext = createContext<Navigation>({
  push() {},
  pop() {},
  replace() {},
  back: '‹ Back',
  openNote() {},
  replaceNote() {},
  dropNote() {},
  step() {},
  canStep: () => false,
});
export const useNavigation = () => useContext(NavigationContext);

/** Reads an `opsidian://connect?host=…&code=…` link, as a QR code or a tapped link carries. */
export function parseInvitation(link: string): { host: string; code: string } | undefined {
  const match = link.trim().match(/^opsidian:\/\/connect\/?\?(.*)$/);
  if (!match) return undefined;
  try {
    const query = new Map(
      match[1]!.split('&').map((pair) => {
        const [name = '', value = ''] = pair.split('=');
        return [name, decodeURIComponent(value)] as const;
      }),
    );
    const host = query.get('host') ?? '';
    const code = query.get('code') ?? '';
    return host && code && host.length < 300 && code.length < 60 ? { host, code } : undefined;
  } catch {
    return undefined;
  }
}

/** The one-line summary of sync shown under the notebook's name. */
export function syncLine(info: SyncInfo, colors: Colors): { color: string; text: string } {
  if (!info.connected) return { color: colors.faint, text: 'Sync is off' };
  if (info.held) return { color: '#d98a00', text: 'Sync is waiting for you' };
  if (info.state === 'synced') return { color: colors.success, text: 'Synced' };
  if (info.state === 'offline') {
    const waiting = info.waiting
      ? ` · ${info.waiting} ${info.waiting === 1 ? 'change' : 'changes'} waiting`
      : '';
    return { color: colors.faint, text: `Offline${waiting}` };
  }
  if (info.state === 'error') return { color: colors.destructive, text: 'Sync needs attention' };
  return { color: colors.ring, text: 'Syncing…' };
}
/** Whether the host has stopped accepting this iPhone, or its credential was lost. */
export const rejected = (info: SyncInfo) => info.connected && Boolean(info.removed);
