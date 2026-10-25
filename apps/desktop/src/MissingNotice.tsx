import { useState } from 'react';
import type { MissingNotebook, VaultInfo } from '@opsidian/core';
import { bridge, message } from './bridge';
import { Button } from '@/components/ui/button';

interface Props {
  missing: MissingNotebook;
  /** A notebook was opened instead: downloaded again, or found elsewhere. */
  onOpened(vault: VaultInfo): void;
  /** Nothing more to do about it: given up, or put out of mind. `warning` is worth showing. */
  onDone(warning?: string): void;
  /** Present over an open notebook: leaves it for the welcome screen. */
  onClose?(): void;
  /** Text typed into the open note that could not be saved, to copy before leaving. */
  unsaved?: { note: string; copy(): Promise<void> } | undefined;
}

/**
 * Says that a notebook's folder is not where it was, and offers the ways back: wait for it to
 * be put back, download it again from its host, find where it went, or give it up. Nothing is
 * deleted from the host or the other devices whichever is chosen.
 */
export function MissingNotice({ missing, onOpened, onDone, onClose, unsaved }: Props) {
  // What is under way, if anything: only that button says so.
  const [doing, setDoing] = useState<'download' | 'find' | 'forget' | 'dismiss'>();
  const busy = doing !== undefined;
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const host = missing.host?.replace(/^https?:\/\//, '');
  const run = async (what: typeof doing, task: () => Promise<void>) => {
    setDoing(what);
    setError('');
    try {
      await task();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setDoing(undefined);
    }
  };
  const open = (what: 'download' | 'find', task: () => Promise<VaultInfo | null>) =>
    run(what, async () => {
      const vault = await task();
      if (vault) onOpened(vault);
    });
  return (
    <div role="alertdialog" aria-label={`“${missing.name}” is missing`} className="text-sm">
      <h2 className="text-foreground text-lg font-semibold">“{missing.name}” is missing</h2>
      <p className="text-muted-foreground mt-2 leading-6">
        Its folder is no longer at{' '}
        <code className="text-foreground text-[13px]">{missing.location}</code>. It may have been
        moved, deleted, or be on a disk that is not connected.{' '}
        {host
          ? `Sync has stopped, so nothing was deleted from ${host} or your other devices.`
          : 'Nothing else has been changed.'}{' '}
        {onClose && 'If it is put back there, from the Trash for example, it carries on by itself.'}
      </p>
      {unsaved && (
        <p className="border-border mt-4 rounded-md border px-3 py-2.5 leading-5">
          “{unsaved.note}” has changes that could not be saved. They stay on screen until you leave
          this notebook.{' '}
          <button
            className="text-link"
            onClick={() =>
              void unsaved.copy().then(
                () => setNote('Copied.'),
                () => {},
              )
            }
          >
            Copy them
          </button>
          {note && <span className="text-muted-foreground"> {note}</span>}
        </p>
      )}
      <div className="mt-6 flex flex-wrap gap-3">
        {host && (
          <Button
            disabled={busy}
            onClick={() => void open('download', () => bridge.restoreVault())}
          >
            {doing === 'download' ? 'Downloading…' : 'Download it again'}
          </Button>
        )}
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => void open('find', () => bridge.openVault())}
        >
          Find it…
        </Button>
        {onClose ? (
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Close notebook
          </Button>
        ) : (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void run('dismiss', () => bridge.dismissMissing().then(() => onDone()))}
          >
            Start something else
          </Button>
        )}
      </div>
      {host && (
        <p className="text-muted-foreground mt-3 text-[13px] leading-5">
          Download it again puts every note from {host} back into that folder, as this same Mac. No
          invitation is needed.
        </p>
      )}
      {host &&
        (confirming ? (
          <div className="border-border mt-5 space-y-3 border-t pt-4 text-[13px] leading-5">
            <p>
              Stop syncing “{missing.notebook ?? missing.name}” on this Mac? This Mac is removed
              from
              {` ${host}`}. The notebook stays on the host and your other devices; to have it here
              again, you would need a new invitation.
            </p>
            <div className="flex gap-3">
              <Button
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run('forget', async () => {
                    const { hostTold } = await bridge.forgetMissing();
                    onDone(
                      hostTold
                        ? undefined
                        : `${host} could not be reached, so it still lists this Mac. Remove it there, in Settings → Devices or with “host remove”.`,
                    );
                  })
                }
              >
                {doing === 'forget' ? 'Stopping…' : 'Stop syncing'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <button
            className="text-muted-foreground hover:text-foreground mt-5 text-[13px]"
            onClick={() => setConfirming(true)}
          >
            Deleted it on purpose? Stop syncing it on this Mac…
          </button>
        ))}
      {error && (
        <p role="alert" className="text-destructive mt-4 text-[13px] leading-5">
          {error}
        </p>
      )}
    </div>
  );
}
