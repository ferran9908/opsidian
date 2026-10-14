/**
 * Where the Mac app's own update stands. The app's main process owns it and every surface reads
 * it — the notice in the window, Settings, the menus, the menu bar icon — so none of them can
 * contradict another.
 */
export type AppUpdate =
  | { kind: 'none' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'ready'; version: string }
  | { kind: 'error'; version: string | null; message: string };

export type AppUpdateEvent =
  | { type: 'available'; version: string }
  | { type: 'up_to_date' }
  | { type: 'download_started' }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'failed'; message: string };

export const NO_UPDATE: AppUpdate = { kind: 'none' };

const clamp = (percent: number) =>
  Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;

export function nextUpdate(update: AppUpdate, event: AppUpdateEvent): AppUpdate {
  switch (event.type) {
    case 'available':
      // A later check never interrupts a download or a restart that is waiting.
      return update.kind === 'downloading' || update.kind === 'ready'
        ? update
        : { kind: 'available', version: event.version };
    case 'up_to_date':
      // Only an offer, or an error, is taken back; never a download or a restart.
      return update.kind === 'available' || update.kind === 'error' ? NO_UPDATE : update;
    case 'download_started':
      return update.kind === 'available' || (update.kind === 'error' && update.version)
        ? { kind: 'downloading', version: update.version!, percent: 0 }
        : update;
    case 'progress':
      return update.kind === 'downloading' ? { ...update, percent: clamp(event.percent) } : update;
    case 'downloaded':
      return { kind: 'ready', version: event.version };
    case 'failed':
      // A check that fails with nothing in hand stays quiet, and a failure never takes away a
      // version that is ready to install.
      if (update.kind === 'none' || update.kind === 'ready') return update;
      return { kind: 'error', version: update.version, message: event.message };
  }
}

/** What a check someone asked for found, said once. */
export type UpdateCheck = 'available' | 'up_to_date' | 'busy' | 'dev';
