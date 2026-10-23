import { useEffect, useState, type FormEvent } from 'react';
import type { RepositoryChoice, VaultInfo } from '@opsidian/core';
import { bridge, message } from './bridge';
import { RepositoryDialog, SignInDialog, useGitHub } from './GitHub';
import { Button } from '@/components/ui/button';

interface Props {
  error: string;
  onOpened(vault: VaultInfo): void;
  /** Present when a notebook is already open and this screen can be dismissed. */
  onCancel?(): void;
  /** Opens on making a notebook from a GitHub repository. */
  mode?: 'github';
}

/** Starts a notebook, or joins one from a host, or makes one from a GitHub repository. */
export function Welcome({ error: initialError, onOpened, onCancel, mode: initial }: Props) {
  const [name, setName] = useState('Personal');
  const [parent, setParent] = useState<string>();
  const [fallback, setFallback] = useState('');
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'start' | 'join' | 'github'>(initial ?? 'start');
  // Joining a notebook that already lives on a host, instead of starting a new one.
  const joining = mode === 'join';
  const [host, setHost] = useState('');
  const [code, setCode] = useState('');
  const [github, setGitHub] = useGitHub();
  const [signingIn, setSigningIn] = useState(false);
  const [picking, setPicking] = useState(false);
  const [repository, setRepository] = useState<RepositoryChoice>({ repository: '' });
  const typed =
    'create' in repository ? `A new repository, ${repository.create}` : repository.repository;
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
    if (mode === 'github' && !github?.account) return setSigningIn(true);
    void run(() =>
      mode === 'github'
        ? bridge.importFromGitHub(repository, parent)
        : joining
          ? bridge.joinVault(host, code, parent)
          : bridge.createVault(name.trim(), parent),
    );
  };
  const field =
    'border-input bg-card focus:border-ring mt-2 h-12 w-full rounded-lg border px-4 outline-none';
  // Where the notebook will be, written as the path it is: the folder, then the notebook's name.
  const folder = parent ?? fallback;
  const leaf =
    mode === 'github' ? 'the repository’s name' : joining ? 'the notebook’s name' : name.trim();
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
          {mode === 'github'
            ? 'Make a notebook from a GitHub repository. Its notes are downloaded into a folder you choose, this Mac hosts it for your other devices, and it stays in step with GitHub both ways.'
            : joining
              ? 'Connect to a notebook on your host. Its notes are downloaded as Markdown files into a folder you choose, and kept in step.'
              : 'Start a notebook. Your notes are saved as Markdown files in a folder you choose.'}
        </p>
        {mode === 'github' ? (
          github?.account ? (
            <>
              <div className="mt-10 flex items-baseline justify-between">
                <label className="block text-[13px] font-medium" htmlFor="github-repository">
                  Repository
                </label>
                <span className="text-muted-foreground text-[13px]">
                  Signed in as {github.account.login}
                </span>
              </div>
              <div className="relative">
                <input
                  id="github-repository"
                  autoFocus
                  value={typed}
                  placeholder="you/notes, or a link to it"
                  spellCheck={false}
                  onChange={(event) => setRepository({ repository: event.target.value })}
                  className={`${field} pr-24`}
                />
                <button
                  type="button"
                  className="text-link absolute top-2 right-4 h-12 text-[13px]"
                  onClick={() => setPicking(true)}
                >
                  Choose…
                </button>
              </div>
            </>
          ) : (
            <p className="text-muted-foreground mt-10 text-sm leading-6">
              First, sign in to GitHub. Opsidian is given access to your repositories, and nothing
              is stored anywhere but this Mac and GitHub.
            </p>
          )
        ) : joining ? (
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
          disabled={
            busy ||
            (mode === 'github'
              ? Boolean(github?.account) && !typed.trim()
              : joining
                ? !host.trim() || !code.trim()
                : !name.trim())
          }
          className="mt-8 h-12 w-full rounded-lg"
        >
          {mode === 'github'
            ? !github?.account
              ? 'Sign in with GitHub'
              : busy
                ? 'Downloading from GitHub…'
                : 'Import and open'
            : joining
              ? busy
                ? 'Connecting…'
                : 'Connect and download'
              : 'Create notebook'}
        </Button>
        <div className="text-muted-foreground mt-5 flex justify-center gap-6 text-[13px]">
          <button type="button" disabled={busy} onClick={() => void run(() => bridge.openVault())}>
            <span className="text-link">Open an existing folder</span>
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setMode(mode === 'start' ? 'join' : 'start')}
          >
            <span className="text-link">
              {mode === 'start' ? 'Connect to a notebook' : 'Start a new notebook'}
            </span>
          </button>
          {mode !== 'github' && (
            <button type="button" disabled={busy} onClick={() => setMode('github')}>
              <span className="text-link">Import from GitHub</span>
            </button>
          )}
          {onCancel && (
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
      </form>
      {signingIn && (
        <SignInDialog
          onDone={(next) => {
            setGitHub(next);
            setSigningIn(false);
          }}
          onCancel={() => setSigningIn(false)}
        />
      )}
      {picking && (
        <RepositoryDialog
          title="Import from GitHub"
          intro="Choose the repository that holds your notes. A new one starts an empty notebook that is kept on GitHub from the start."
          suggested="notes"
          action="Use this repository"
          onPick={async (choice) => {
            setRepository(choice);
            setPicking(false);
          }}
          onCancel={() => setPicking(false)}
        />
      )}
    </div>
  );
}
