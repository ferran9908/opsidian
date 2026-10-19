import { useEffect, useState } from 'react';
import { CircleAlert, CircleCheck, CloudOff, RotateCcw } from 'lucide-react';
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

/** How long a sync round must run before the status bar says so. */
const SYNCING_SHOWN_AFTER = 1000;

/**
 * Sync as the status bar shows it. Typing saves, and every save starts a short sync round, so
 * showing each round would flick the badge as you type. A round only shows once it has run a
 * while; every other state shows straight away.
 */
function useShownSync(sync: SyncInfo): SyncInfo {
  const syncing = sync.connected && sync.state === 'syncing';
  const [settled, setSettled] = useState(sync);
  if (!syncing && settled !== sync) setSettled(sync);
  const [long, setLong] = useState(false);
  useEffect(() => {
    setLong(false);
    if (!syncing) return;
    const timer = setTimeout(() => setLong(true), SYNCING_SHOWN_AFTER);
    return () => clearTimeout(timer);
  }, [syncing]);
  return syncing && !long ? settled : sync;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The few words the bar shows beside the sync icon. Only states that need you get words; when
 * sync is in step or working, the icon alone says so, and the bar keeps still while you type.
 */
function attention(info: SyncInfo): string | undefined {
  if (!info.connected) return undefined;
  if (info.state === 'offline') return info.waiting ? `${info.waiting} waiting` : 'Offline';
  if (info.state === 'error')
    return info.problems ? count(info.problems, 'file', 'files') : 'Sync stopped';
  if (info.held) return 'Deletions held';
  return undefined;
}

/** A faint ring with a slowly turning arc: sync is working and has taken a while. */
function SyncingIcon() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" className="shrink-0" aria-hidden>
      <circle cx={12} cy={12} r={10} className="stroke-border" strokeWidth={2.4} />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        className="stroke-link origin-center animate-[spin_1.4s_linear_infinite]"
        strokeWidth={2.4}
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * The small bar in the bottom-right corner, as in Obsidian: the note's word count and how sync
 * is doing. Saving says nothing while it works; it speaks up only when a save fails.
 */
export function StatusBar({ note, sync: live, onRetrySave, onSyncSettings }: Props) {
  const sync = useShownSync(live);
  const words = attention(sync);
  const problem = sync.connected && (sync.state === 'error' || Boolean(sync.held));
  const label = sync.connected ? syncLabel(sync) : 'Sync is off';
  const icon =
    !sync.connected || sync.state === 'offline' ? (
      <CloudOff size={13} className="text-faint shrink-0" />
    ) : problem ? (
      <CircleAlert size={13} className="text-destructive shrink-0" />
    ) : sync.state === 'syncing' ? (
      <SyncingIcon />
    ) : (
      <CircleCheck size={13} className="text-success shrink-0" />
    );
  const badge = (
    <>
      {icon}
      {words && <span className={cn('truncate', problem && 'text-destructive')}>{words}</span>}
    </>
  );
  return (
    <div
      aria-label="Status bar"
      className="border-border bg-sidebar text-muted-foreground absolute right-0 bottom-0 z-10 flex h-[26px] max-w-[70%] items-center gap-1.5 rounded-tl-lg border-t border-l pr-1 pl-2.5 text-xs tabular-nums"
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
          {note.words.toLocaleString()} {note.words === 1 ? 'word' : 'words'}
        </span>
      )}
      {sync.connected ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              aria-label={`Sync status: ${label}`}
              role="status"
              title={label}
              className={cn(item, 'hover:bg-sidebar-accent hover:text-foreground min-w-0')}
            >
              {badge}
            </button>
          </PopoverTrigger>
          <PopoverContent side="top" align="end" className="w-80 p-0">
            <SyncDetails info={live} onSettings={onSyncSettings} />
          </PopoverContent>
        </Popover>
      ) : (
        <button
          aria-label={`Sync status: ${label}`}
          role="status"
          title="Sync is off · set up sync"
          className={cn(item, 'hover:bg-sidebar-accent hover:text-foreground')}
          onClick={onSyncSettings}
        >
          {badge}
        </button>
      )}
    </div>
  );
}
