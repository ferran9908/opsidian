import { useEffect, useState, type FormEvent } from 'react';
import { RefreshCw, X } from 'lucide-react';
import type { SyncInfo } from '@opsidian/core';
import { bridge, message } from './bridge';
import { Button } from '@/components/ui/button';

const field =
  'border-input bg-card focus:border-ring mt-1.5 h-10 w-full rounded-md border px-3 text-sm outline-none';

/** One line saying how sync is doing, in the words the status bar also uses. */
export function syncLabel(info: SyncInfo): string {
  if (!info.connected) return 'Sync is off';
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

/**
 * What the status bar's sync button opens: what this notebook is connected to, whether anything
 * is waiting, and the one thing that may need a decision here, deletions held back.
 */
export function SyncDetails({ info, onSettings }: { info: SyncInfo; onSettings(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="text-[13px]">
      <div className="space-y-1 px-4 pt-3.5 pb-3">
        <p className="text-foreground text-sm font-semibold">{syncLabel(info)}</p>
        {info.message && info.state !== 'synced' ? (
          <p className="text-muted-foreground leading-5">{info.message}</p>
        ) : info.at ? (
          <p className="text-muted-foreground">
            In step at{' '}
            {new Date(info.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </p>
        ) : null}
      </div>
      <dl className="border-border text-muted-foreground grid grid-cols-[88px_1fr] gap-y-1.5 border-t px-4 py-3">
        <dt>Notebook</dt>
        <dd className="text-foreground truncate">{info.notebook}</dd>
        <dt>Host</dt>
        <dd className="text-foreground truncate">{info.host?.replace(/^https?:\/\//, '')}</dd>
        <dt>This device</dt>
        <dd className="text-foreground truncate">{info.device}</dd>
        <dt>Waiting</dt>
        <dd className="text-foreground">
          {info.waiting
            ? `${info.waiting} ${info.waiting === 1 ? 'change' : 'changes'}`
            : 'Nothing'}
        </dd>
      </dl>
      {info.held ? (
        <div className="border-border space-y-2.5 border-t px-4 py-3 leading-5">
          <p>
            {info.held} notes are missing from this Mac. They have not been deleted from the host or
            your other devices, in case the folder was only moved or unavailable.
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void bridge
                .confirmDeletions()
                .catch((reason) => setError(message(reason)))
                .finally(() => setBusy(false));
            }}
          >
            Delete them everywhere
          </Button>
        </div>
      ) : null}
      {error && (
        <p role="alert" className="text-destructive px-4 pb-2">
          {error}
        </p>
      )}
      <div className="border-border border-t p-1">
        <button
          className="hover:bg-accent w-full rounded-sm px-3 py-1.5 text-left"
          onClick={onSettings}
        >
          Sync settings…
        </button>
      </div>
    </div>
  );
}

interface Props {
  info: SyncInfo;
  onClose(): void;
}

/** Joins a host that already exists, with the address and code from its invitation. */
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
  // Once joined, the status bar says so; there is nothing left to do here.
  useEffect(() => {
    if (info.connected) onClose();
  }, [info.connected]);
  const connect = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    void bridge
      .connect(host, code)
      .catch((reason) => setError(message(reason)))
      .finally(() => setBusy(false));
  };
  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 pt-[12vh]"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-label="Join a host"
        className="border-border bg-popover text-popover-foreground w-[min(480px,90vw)] overflow-hidden rounded-xl border shadow-2xl"
      >
        <div className="border-border flex h-12 items-center gap-3 border-b pr-2 pl-4">
          <RefreshCw size={16} className="text-muted-foreground" />
          <h2 className="flex-1 text-sm font-medium">Join a host</h2>
          <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
            <X />
          </Button>
        </div>
        <form onSubmit={connect} className="p-5 text-sm">
          <p className="text-muted-foreground text-[13px] leading-5">
            On the Mac that hosts, open Settings → Sync and choose Add a device. On a server, run{' '}
            <code className="text-foreground">npx opsidian host invite "Name"</code>. Either gives
            you an address and a code.
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
      </div>
    </div>
  );
}
