import { createContext, useContext } from 'react';
import type { NoteVersion, SyncInfo } from '@opsidian/core';
import type { Colors } from './ui';

export type Route =
  | { name: 'home' }
  | { name: 'folder'; path: string }
  | { name: 'all' }
  | { name: 'note'; path: string; heading?: string }
  | { name: 'search' }
  | { name: 'trash' }
  | { name: 'sync' }
  | { name: 'connect' }
  | { name: 'history'; path: string }
  | { name: 'version'; path: string; version: NoteVersion };

export interface Navigation {
  push(route: Route): void;
  pop(): void;
  /** Swaps the screen on top, for example when the open note is renamed. */
  replace(route: Route): void;
  /** What the back button should say. */
  back: string;
}
export const NavigationContext = createContext<Navigation>({
  push() {},
  pop() {},
  replace() {},
  back: '‹ Back',
});
export const useNavigation = () => useContext(NavigationContext);

/** The one-line summary of sync shown under the notebook's name. */
export function syncLine(info: SyncInfo, colors: Colors): { color: string; text: string } {
  if (!info.connected) return { color: colors.faint, text: 'Only on this iPhone · Connect' };
  if (info.held) return { color: '#d98a00', text: 'Sync is waiting for you' };
  if (info.state === 'synced') return { color: colors.success, text: 'In step with the host' };
  if (info.state === 'offline') {
    const waiting = info.waiting
      ? ` · ${info.waiting} ${info.waiting === 1 ? 'change' : 'changes'} waiting`
      : '';
    return { color: colors.faint, text: `Offline${waiting}` };
  }
  if (info.state === 'error') return { color: colors.destructive, text: 'Sync needs attention' };
  return { color: colors.ring, text: 'Syncing…' };
}
/** Whether the host has stopped accepting this iPhone. */
export const rejected = (info: SyncInfo) =>
  info.connected &&
  info.state === 'error' &&
  /no longer connected|was lost/i.test(info.message ?? '');
