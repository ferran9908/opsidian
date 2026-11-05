import { useEffect, useState } from 'react';
import { Check, Copy, Link, X } from 'lucide-react';
import { noteTitle, type NoteShare } from '@opsidian/core';
import { bridge, message } from './bridge';
import { copyText } from './clipboard';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** How long a link lasts, as offered. `undefined` is until it is stopped. */
const LENGTHS: { label: string; hours: number | undefined }[] = [
  { label: '1 hour', hours: 1 },
  { label: '1 day', hours: 24 },
  { label: '1 week', hours: 24 * 7 },
  { label: 'Until I stop it', hours: undefined },
];

/** When a link stops working, in words. */
export function until(share: NoteShare): string {
  if (!share.expires) return 'Until stopped';
  const left = share.expires - Date.now();
  if (left <= 0) return 'Run out';
  if (left < 90 * 60_000) return `${Math.max(1, Math.round(left / 60_000))} min left`;
  if (left < 36 * 3600_000) return `${Math.round(left / 3600_000)} h left`;
  return `${Math.round(left / 86400_000)} days left`;
}

/** Copies the link, and says so for a moment. */
function CopyButton({ url, primary }: { url: string; primary?: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      variant={primary ? 'default' : 'secondary'}
      size="sm"
      className="shrink-0"
      onClick={() => void copyText(url).then(() => setCopied(true))}
    >
      {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy link'}
    </Button>
  );
}

interface Props {
  path: string;
  /** Saves what is being written, so the page shows it. */
  flush(): Promise<unknown>;
  onClose(): void;
}

/**
 * Shares one note as a link anyone can open, for a while. The host serves the note as it is
 * at this moment: later edits stay private until the note is shared again.
 */
export function ShareDialog({ path, flush, onClose }: Props) {
  const [existing, setExisting] = useState<NoteShare[]>();
  const [made, setMade] = useState<NoteShare>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    void bridge
      .shares()
      .then((all) => setExisting(all.filter((each) => each.path === path)))
      .catch((reason) => {
        setExisting([]);
        setError(message(reason));
      });
    const keys = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [path]);
  const share = (hours: number | undefined) => {
    setBusy(true);
    setError('');
    void flush()
      .then(() => bridge.share(path, hours))
      .then((share) => {
        setMade(share);
        setExisting((all) => [share, ...(all ?? [])]);
        return copyText(share.url).catch(() => {});
      })
      .catch((reason) => setError(message(reason)))
      .finally(() => setBusy(false));
  };
  const stop = (share: NoteShare) => {
    setBusy(true);
    void bridge
      .unshare(share.id)
      .then(() => {
        setExisting((all) => (all ?? []).filter((each) => each.id !== share.id));
        if (made?.id === share.id) setMade(undefined);
      })
      .catch((reason) => setError(message(reason)))
      .finally(() => setBusy(false));
  };
  return (
    <div
      className="fixed inset-0 z-20 flex items-start justify-center bg-black/30 pt-[14vh]"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-label="Share note"
        className="border-border bg-popover text-popover-foreground w-[min(520px,90vw)] space-y-5 rounded-xl border p-7 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="flex items-center gap-2 text-lg font-bold">
              <Link size={18} /> Share “{noteTitle(path)}”
            </h2>
            <p className="text-muted-foreground text-[13px] leading-5">
              Anyone with the link can read the note as it is right now, with its images. What you
              write afterwards stays private until you share it again.
            </p>
          </div>
          <button aria-label="Close" className="text-muted-foreground" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        {made ? (
          <div className="bg-secondary space-y-2 rounded-lg p-4">
            <p className="text-[13px] font-medium">
              Link copied. It works for {until(made).toLowerCase()}.
            </p>
            <div className="flex items-center gap-3">
              <code className="min-w-0 flex-1 truncate text-[13px] select-all">{made.url}</code>
              <CopyButton url={made.url} primary />
            </div>
          </div>
        ) : (
          <div>
            <p className="text-muted-foreground pb-2 text-xs font-semibold tracking-[0.08em] uppercase">
              For how long
            </p>
            <div className="grid grid-cols-2 gap-2">
              {LENGTHS.map((length) => (
                <Button
                  key={length.label}
                  variant="secondary"
                  disabled={busy || existing === undefined}
                  onClick={() => share(length.hours)}
                >
                  {length.label}
                </Button>
              ))}
            </div>
          </div>
        )}
        {error && <p className="text-destructive text-[13px] leading-5">{error}</p>}
        {existing && existing.filter((each) => each.id !== made?.id).length > 0 && (
          <div>
            <p className="text-muted-foreground pb-1 text-xs font-semibold tracking-[0.08em] uppercase">
              Already shared
            </p>
            {existing
              .filter((each) => each.id !== made?.id)
              .map((each) => (
                <div
                  key={each.id}
                  className={cn('border-border flex items-center gap-3 border-t py-2 text-[13px]')}
                >
                  <code className="min-w-0 flex-1 truncate select-all">{each.url}</code>
                  <span className="text-muted-foreground shrink-0">{until(each)}</span>
                  <CopyButton url={each.url} />
                  <button
                    className="text-destructive shrink-0 disabled:opacity-50"
                    disabled={busy}
                    onClick={() => stop(each)}
                  >
                    Stop
                  </button>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Every note of the open notebook that is shared right now, for Settings. */
export function SharedNotes() {
  const [shares, setShares] = useState<NoteShare[]>();
  const [error, setError] = useState('');
  const load = () =>
    void bridge
      .shares()
      .then(setShares)
      .catch((reason) => {
        setShares([]);
        setError(message(reason));
      });
  useEffect(load, []);
  const stop = (share: NoteShare) =>
    void bridge
      .unshare(share.id)
      .then(load)
      .catch((reason) => setError(message(reason)));
  if (!shares) return <p className="text-muted-foreground text-sm">Loading…</p>;
  return (
    <div>
      {error && <p className="text-destructive pb-2 text-[13px]">{error}</p>}
      {!shares.length && !error && (
        <p className="text-muted-foreground text-sm">
          Nothing is shared right now. Share a note from its ⋯ menu, or with “Share note” in the
          command palette.
        </p>
      )}
      {shares.map((each) => (
        <div
          key={each.id}
          className="border-border flex min-h-11 items-center gap-4 border-t py-2 text-sm last:border-b"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{noteTitle(each.path)}</p>
            <code className="text-muted-foreground block truncate text-[12px] select-all">
              {each.url}
            </code>
          </div>
          <span className="text-muted-foreground shrink-0 text-[13px]">{until(each)}</span>
          <CopyButton url={each.url} />
          <button className="text-destructive shrink-0" onClick={() => stop(each)}>
            Stop
          </button>
        </div>
      ))}
    </div>
  );
}
