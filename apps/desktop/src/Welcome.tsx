import { useEffect, useState, type FormEvent } from 'react';
import type { VaultInfo } from '@opsidian/core';
import { bridge, message } from './bridge';
import { Button } from '@/components/ui/button';

interface Props {
  error: string;
  onOpened(vault: VaultInfo): void;
  /** Present when a notebook is already open and this screen can be dismissed. */
  onCancel?(): void;
}

export function Welcome({ error: initialError, onOpened, onCancel }: Props) {
  const [name, setName] = useState('Personal');
  const [parent, setParent] = useState<string>();
  const [fallback, setFallback] = useState('');
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  // Joining a notebook that already lives on a host, instead of starting a new one.
  const [joining, setJoining] = useState(false);
  const [host, setHost] = useState('');
  const [code, setCode] = useState('');
  useEffect(() => {
    void bridge.defaultParent().then(setFallback);
  }, []);
  const run = async (task: () => Promise<VaultInfo | null>) => {
    setBusy(true);
    setError('');
    try {
      const vault = await task();
      if (vault) onOpened(vault);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };
  const create = (event: FormEvent) => {
    event.preventDefault();
    void run(() =>
      joining ? bridge.joinVault(host, code, parent) : bridge.createVault(name.trim(), parent),
    );
  };
  const field =
    'border-input bg-card focus:border-ring mt-2 h-12 w-full rounded-lg border px-4 outline-none';
  // Where the notebook will be, written as the path it is: the folder, then the notebook's name.
  const folder = parent ?? fallback;
  const leaf = joining ? 'the notebook’s name' : name.trim();
  const location =
    folder && leaf ? `${folder}${folder.endsWith('/') ? '' : '/'}${leaf}` : folder || leaf;
  return (
    <div className="bg-secondary flex h-full flex-col">
      <div className="drag h-14 shrink-0" />
      <form onSubmit={create} className="mx-auto w-full max-w-[520px] px-6 pt-10">
        <p className="text-muted-foreground text-xs tracking-[0.1em]">YOUR OWN LITTLE CORNER</p>
        <h1 className="mt-4 text-[38px] leading-tight font-medium tracking-tight">
          A place for your thoughts.
        </h1>
        <p className="text-muted-foreground mt-3 max-w-[400px] leading-6">
          {joining
            ? 'Connect to a notebook on your host. Its notes are downloaded as Markdown files into a folder you choose, and kept in step.'
            : 'Start a notebook. Your notes are saved as Markdown files in a folder you choose.'}
        </p>
        {joining ? (
          <>
            <label className="mt-10 block text-[13px] font-medium" htmlFor="join-host">
              Host address
            </label>
            <input
              id="join-host"
              autoFocus
              value={host}
              placeholder="192.168.1.4:4810"
              spellCheck={false}
              onChange={(event) => setHost(event.target.value)}
              className={field}
            />
            <label className="mt-5 block text-[13px] font-medium" htmlFor="join-code">
              Invitation code
            </label>
            <input
              id="join-code"
              value={code}
              placeholder="ABCD-EFGH-JKMN"
              spellCheck={false}
              onChange={(event) => setCode(event.target.value)}
              className={field}
            />
          </>
        ) : (
          <>
            <label className="mt-10 block text-[13px] font-medium" htmlFor="notebook-name">
              Notebook name
            </label>
            <input
              id="notebook-name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              className={field}
            />
          </>
        )}
        <div className="text-muted-foreground mt-4 flex items-center gap-4 text-[13px]">
          <span className="min-w-0 flex-1 truncate" title={location}>
            {location}
          </span>
          <button
            type="button"
            className="text-link shrink-0"
            onClick={() => void bridge.chooseParent().then((chosen) => chosen && setParent(chosen))}
          >
            Choose folder…
          </button>
        </div>
        {error && (
          <p role="alert" className="text-destructive mt-5 text-[13px] leading-5">
            {error}
          </p>
        )}
        <Button
          type="submit"
          size="lg"
          disabled={busy || (joining ? !host.trim() || !code.trim() : !name.trim())}
          className="mt-8 h-12 w-full rounded-lg"
        >
          {joining ? (busy ? 'Connecting…' : 'Connect and download') : 'Create notebook'}
        </Button>
        <div className="text-muted-foreground mt-5 flex justify-center gap-6 text-[13px]">
          <button type="button" disabled={busy} onClick={() => void run(() => bridge.openVault())}>
            <span className="text-link">Open an existing folder</span>
          </button>
          <button type="button" disabled={busy} onClick={() => setJoining(!joining)}>
            <span className="text-link">
              {joining ? 'Start a new notebook' : 'Connect to a notebook'}
            </span>
          </button>
          {onCancel && (
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
