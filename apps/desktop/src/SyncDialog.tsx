import { useEffect, useState, type FormEvent } from 'react';
import { RefreshCw, X } from 'lucide-react';
import type { SyncInfo } from '@opsidian/core';
import { bridge, message } from './bridge';
import { Button } from '@/components/ui/button';

const field =
  'border-input bg-card focus:border-ring mt-1.5 h-10 w-full rounded-md border px-3 text-sm outline-none';

/** One line saying how sync is doing, in the words the sidebar also uses. */
export function syncLabel(info: SyncInfo): string {
  if (!info.connected) return 'On this Mac';
  const waiting = info.waiting
    ? ` · ${info.waiting} ${info.waiting === 1 ? 'change' : 'changes'} waiting`
    : '';
  if (info.state === 'synced') return info.held ? 'Synced · deletions waiting' : 'Synced';
  if (info.state === 'syncing') return `Syncing…${waiting}`;
  if (info.state === 'offline') return `Host unreachable${waiting}`;
  if (info.problems)
    return `${info.problems} ${info.problems === 1 ? 'file' : 'files'} could not sync`;
  return 'Sync stopped';
}

interface Props {
  info: SyncInfo;
  onClose(): void;
}

export function SyncDialog({ info, onClose }: Props) {
  const [host, setHost] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const keys = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, []);
  const run = (task: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    void task()
      .catch((reason) => setError(message(reason)))
      .finally(() => setBusy(false));
  };
  const connect = (event: FormEvent) => {
    event.preventDefault();
    run(() => bridge.connect(host, code));
  };
  return (
    <div
      className="fixed inset-0 z-20 flex items-start justify-center bg-black/30 pt-[12vh]"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-label="Sync"
        className="border-border bg-popover text-popover-foreground w-[min(480px,90vw)] overflow-hidden rounded-xl border shadow-2xl"
      >
        <div className="border-border flex h-12 items-center gap-3 border-b pr-2 pl-4">
          <RefreshCw size={16} className="text-muted-foreground" />
          <h2 className="flex-1 text-sm font-medium">Sync</h2>
          <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
            <X />
          </Button>
        </div>
        {info.connected ? (
          <div className="space-y-4 p-5 text-sm">
            <p role="status" className="font-medium">
              {syncLabel(info)}
            </p>
            {info.message && info.state !== 'synced' && (
              <p className="text-muted-foreground text-[13px] leading-5">{info.message}</p>
            )}
            <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
              <dt>Notebook</dt>
              <dd className="text-foreground truncate">{info.notebook}</dd>
              <dt>Host</dt>
              <dd className="text-foreground truncate">{info.host}</dd>
              <dt>This device</dt>
              <dd className="text-foreground truncate">{info.device}</dd>
              {info.at && (
                <>
                  <dt>Last in step</dt>
                  <dd className="text-foreground">{new Date(info.at).toLocaleTimeString()}</dd>
                </>
              )}
            </dl>
            {info.held ? (
              <div className="bg-secondary rounded-md p-3 text-[13px] leading-5">
                <p>
                  {info.held} notes are missing from this Mac. They have not been deleted from the
                  host or your other devices, in case the folder was only moved or unavailable.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => run(() => bridge.confirmDeletions())}
                >
                  Delete them everywhere
                </Button>
              </div>
            ) : null}
            {error && (
              <p role="alert" className="text-destructive text-[13px]">
                {error}
              </p>
            )}
            <div className="flex items-center justify-between gap-4 pt-1">
              <p className="text-muted-foreground text-xs leading-5">
                Stopping keeps every note on this Mac and on the host.
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => run(() => bridge.disconnect())}
              >
                Stop syncing here
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={connect} className="p-5 text-sm">
            <p className="text-muted-foreground text-[13px] leading-5">
              Connect this notebook to a host to keep it in step with your other devices. On the
              host, run <code className="text-foreground">pnpm host invite</code> to get an address
              and a code.
            </p>
            <label className="mt-4 block text-[13px] font-medium" htmlFor="sync-host">
              Host address
            </label>
            <input
              id="sync-host"
              autoFocus
              value={host}
              placeholder="192.168.1.4:4810"
              spellCheck={false}
              className={field}
              onChange={(event) => setHost(event.target.value)}
            />
            <label className="mt-3 block text-[13px] font-medium" htmlFor="sync-code">
              Invitation code
            </label>
            <input
              id="sync-code"
              value={code}
              placeholder="ABCD-EFGH-JKMN"
              spellCheck={false}
              className={field}
              onChange={(event) => setCode(event.target.value)}
            />
            {error && (
              <p role="alert" className="text-destructive mt-3 text-[13px] leading-5">
                {error}
              </p>
            )}
            <Button
              type="submit"
              className="mt-5 w-full"
              disabled={busy || !host.trim() || !code.trim()}
            >
              {busy ? 'Connecting…' : 'Connect'}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
