import { CircleAlert, CircleCheck, CloudOff, RefreshCw, RotateCcw } from 'lucide-react';
import type { SaveStatus, SyncInfo } from '@opsidian/core';
import { SyncDetails, syncLabel } from './SyncDialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/** What the open note reports for the status bar. */
export interface NoteStatus {
  words: number;
  save: SaveStatus;
}

interface Props {
  note: NoteStatus | undefined;
  sync: SyncInfo;
  onRetrySave(): void;
  onSyncSettings(): void;
}

const item = 'flex h-[22px] items-center gap-1.5 rounded px-1.5';

/**
 * The small bar in the bottom-right corner, as in Obsidian: the note's word count and how sync
 * is doing. Saving says nothing while it works; it speaks up only when a save fails.
 */
export function StatusBar({ note, sync, onRetrySave, onSyncSettings }: Props) {
  const problem = sync.connected && (sync.state === 'error' || Boolean(sync.held));
  const Icon = !sync.connected
    ? CloudOff
    : sync.state === 'syncing'
      ? RefreshCw
      : sync.state === 'offline'
        ? CloudOff
        : problem
          ? CircleAlert
          : CircleCheck;
  const label = sync.connected ? syncLabel(sync) : 'Sync is off';
  const badge = (
    <>
      <Icon
        size={13}
        className={cn(
          'shrink-0',
          sync.connected && sync.state === 'synced' && !sync.held && 'text-success',
          sync.state === 'syncing' && 'animate-spin',
          problem && 'text-destructive',
        )}
      />
      <span className="truncate">{label}</span>
    </>
  );
  return (
    <div
      aria-label="Status bar"
      className="border-border bg-sidebar text-muted-foreground absolute right-0 bottom-0 z-10 flex h-[26px] max-w-[70%] items-center gap-2 rounded-tl-lg border-t border-l px-2 text-xs"
    >
      {note?.save.state === 'error' && (
        <span role="alert" className="text-destructive flex min-w-0 items-center gap-2">
          <span className="truncate">{note.save.message}</span>
          <button
            className="hover:text-foreground flex shrink-0 items-center gap-1"
            onClick={onRetrySave}
          >
            <RotateCcw size={12} /> Retry save
          </button>
        </span>
      )}
      {note && (
        <span className="whitespace-nowrap">
          {note.words} {note.words === 1 ? 'word' : 'words'}
        </span>
      )}
      {sync.connected ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              aria-label="Sync status"
              role="status"
              className={cn(item, 'hover:bg-sidebar-accent hover:text-foreground min-w-0')}
            >
              {badge}
            </button>
          </PopoverTrigger>
          <PopoverContent side="top" align="end" className="w-80 p-0">
            <SyncDetails info={sync} onSettings={onSyncSettings} />
          </PopoverContent>
        </Popover>
      ) : (
        <button
          aria-label="Sync status"
          role="status"
          title="Set up sync"
          className={cn(item, 'hover:bg-sidebar-accent hover:text-foreground')}
          onClick={onSyncSettings}
        >
          {badge}
        </button>
      )}
    </div>
  );
}
