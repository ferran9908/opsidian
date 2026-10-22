import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  GitHubInfo,
  GitHubMirror,
  GitHubRepository,
  HostingInfo,
  RepositoryChoice,
} from '@opsidian/core';
import { bridge, message } from './bridge';
import { Button } from '@/components/ui/button';

/** Where GitHub stands on this Mac, kept fresh while it is on screen. */
export function useGitHub(): [GitHubInfo | undefined, (next: GitHubInfo) => void] {
  const [info, setInfo] = useState<GitHubInfo>();
  useEffect(() => {
    let live = true;
    const load = () => void bridge.github().then((next) => live && setInfo(next));
    load();
    // Copies sync in the background; their state changes without anything being asked.
    const timer = setInterval(load, 4000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  return [info, setInfo];
}

function Modal(props: { label: string; children: ReactNode; onClose(): void; wide?: boolean }) {
  useEffect(() => {
    const keys = (event: KeyboardEvent) => event.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, []);
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}
    >
      <div
        role="dialog"
        aria-label={props.label}
        className={`bg-popover text-popover-foreground ${props.wide ? 'w-[min(640px,92vw)]' : 'w-[min(520px,92vw)]'} space-y-4 rounded-2xl p-9 shadow-2xl`}
      >
        {props.children}
      </div>
    </div>
  );
}

/**
 * Signs in to GitHub. GitHub opens in the browser with the code already copied: paste it,
 * approve, and this closes by itself.
 */
export function SignInDialog(props: { onDone(info: GitHubInfo): void; onCancel(): void }) {
  const [started, setStarted] = useState<{ code: string; url: string }>();
  const [error, setError] = useState('');
  const begin = () => {
    setError('');
    setStarted(undefined);
    bridge.signInToGitHub().then(
      (next) => {
        setStarted(next);
        bridge.finishGitHubSignIn().then(props.onDone, (reason) => {
          // Starting again, or closing this, cancels the attempt before; that is no error.
          if (message(reason) !== 'Signing in was cancelled.') setError(message(reason));
        });
      },
      (reason) => setError(message(reason)),
    );
  };
  useEffect(begin, []);
  const cancel = () => {
    void bridge.cancelGitHubSignIn();
    props.onCancel();
  };
  return (
    <Modal label="Sign in to GitHub" onClose={cancel}>
      <h2 className="text-2xl font-bold tracking-tight">Sign in to GitHub</h2>
      <p className="text-muted-foreground text-sm leading-[22px]">
        GitHub has opened in your browser. Paste this code there and approve Opsidian. It is already
        copied.
      </p>
      <div className="bg-secondary flex h-20 items-center justify-center rounded-xl">
        <code id="github-code" className="text-[28px] font-bold tracking-[0.18em] select-all">
          {started?.code ?? '····-····'}
        </code>
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-sm leading-5">
          {error}
        </p>
      ) : (
        <p className="text-muted-foreground text-[13px] leading-5">
          {started ? (
            <>
              Waiting for GitHub… If the browser did not open, go to{' '}
              <span className="select-all">{started.url}</span>.
            </>
          ) : (
            'Asking GitHub for a code…'
          )}
        </p>
      )}
      <div className="flex justify-end gap-2.5 pt-1">
        {error && (
          <Button variant="secondary" onClick={begin}>
            Try again
          </Button>
        )}
        <Button variant="secondary" onClick={cancel}>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}

/** Picks one of the account's repositories, a typed one, or a new private one. */
export function RepositoryDialog(props: {
  title: string;
  intro: ReactNode;
  /** The name a new repository is given unless changed. */
  suggested: string;
  action: string;
  onPick(choice: RepositoryChoice): Promise<unknown>;
  onCancel(): void;
}) {
  const [all, setAll] = useState<GitHubRepository[]>();
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<RepositoryChoice>({ create: props.suggested });
  // The name GitHub would give it, shown as it will be: “My Notes” becomes my-notes.
  const [name, setName] = useState(slug(props.suggested));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    void bridge.githubRepositories().then(
      (found) => {
        setAll(found);
        // A name already taken on the account is not offered.
        const mine = new Set(found.map((each) => each.fullName.split('/')[1]?.toLowerCase()));
        setName((current) => {
          let free = current;
          for (let n = 2; mine.has(free.toLowerCase()); n++) free = `${current}-${n}`;
          return free;
        });
      },
      (reason) => {
        setAll([]);
        setError(message(reason));
      },
    );
  }, []);
  const typed = search.trim();
  const shown = useMemo(
    () =>
      (all ?? [])
        .filter((each) => each.fullName.toLowerCase().includes(typed.toLowerCase()))
        .slice(0, 50),
    [all, typed],
  );
  // A repository typed in full, such as a link pasted from GitHub, may not be in the list.
  const pasted =
    /\//.test(typed) && !shown.some((each) => each.fullName.toLowerCase() === typed.toLowerCase());
  const is = (choice: RepositoryChoice) => JSON.stringify(choice) === JSON.stringify(chosen);
  const option = (choice: RepositoryChoice, label: ReactNode, detail?: ReactNode) => (
    <button
      type="button"
      role="option"
      aria-selected={is(choice)}
      onClick={() => setChosen(choice)}
      className={`border-border flex min-h-11 w-full items-center gap-3 border-t px-3 py-2 text-left text-sm ${is(choice) ? 'bg-secondary' : 'hover:bg-secondary/60'}`}
    >
      <span className={`size-2 shrink-0 rounded-full ${is(choice) ? 'bg-primary' : ''}`} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail && <span className="text-muted-foreground shrink-0 text-[13px]">{detail}</span>}
    </button>
  );
  const pick = () => {
    setBusy(true);
    setError('');
    const choice = 'create' in chosen ? { create: name.trim() } : chosen;
    props.onPick(choice).catch((reason) => {
      setError(message(reason));
      setBusy(false);
    });
  };
  return (
    <Modal label={props.title} onClose={() => !busy && props.onCancel()} wide>
      <h2 className="text-2xl font-bold tracking-tight">{props.title}</h2>
      <div className="text-muted-foreground text-sm leading-[22px]">{props.intro}</div>
      <input
        aria-label="Find a repository"
        autoFocus
        value={search}
        placeholder="Find a repository, or paste a link to one"
        spellCheck={false}
        onChange={(event) => setSearch(event.target.value)}
        className="border-input bg-card focus:border-ring h-10 w-full rounded-lg border px-3 text-sm outline-none"
      />
      <div role="listbox" className="border-border h-64 overflow-y-auto rounded-lg border-b">
        {!typed &&
          option(
            { create: props.suggested },
            <span className="flex items-center gap-2">
              A new private repository,
              <input
                aria-label="New repository name"
                value={name}
                spellCheck={false}
                onClick={(event) => {
                  event.stopPropagation();
                  setChosen({ create: props.suggested });
                }}
                onChange={(event) => setName(event.target.value)}
                className="bg-card border-input w-48 rounded border px-1.5 py-0.5 text-[13px] outline-none"
              />
            </span>,
          )}
        {pasted && option({ repository: typed }, <>Use {typed}</>)}
        {shown.map((each) =>
          option(
            { repository: each.fullName },
            each.fullName,
            [each.private ? 'Private' : 'Public', each.empty ? 'empty' : '']
              .filter(Boolean)
              .join(' · '),
          ),
        )}
        {!all && <p className="text-muted-foreground p-3 text-sm">Loading your repositories…</p>}
        {all && !shown.length && !pasted && typed && (
          <p className="text-muted-foreground p-3 text-sm">
            None of your repositories matches. Paste its full name, such as you/notes.
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="text-destructive text-sm leading-5">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2.5 pt-1">
        <Button variant="secondary" disabled={busy} onClick={props.onCancel}>
          Cancel
        </Button>
        <Button disabled={busy || ('create' in chosen && !name.trim())} onClick={pick}>
          {busy ? 'Working…' : props.action}
        </Button>
      </div>
    </Modal>
  );
}

/** A repository name from a notebook's: `My Notes` becomes `my-notes`, as GitHub would have it. */
const slug = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 100) || 'notes';

function since(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 36) return `${Math.round(minutes / 60)} h ago`;
  return new Date(at).toLocaleDateString();
}
export function mirrorLabel(mirror: GitHubMirror): string {
  if (mirror.held) return `${mirror.held} deletions are waiting for you to confirm`;
  switch (mirror.state) {
    case 'synced':
      return `Up to date${mirror.at ? ` · ${since(mirror.at)}` : ''}`;
    case 'syncing':
      return 'Syncing…';
    case 'waiting':
      return 'Starting…';
    case 'offline':
      return mirror.message ?? 'GitHub cannot be reached right now';
    case 'error':
      return mirror.message ?? 'Not syncing';
  }
}

/** Settings → GitHub. */
export function GitHubSettings(props: {
  hosting: HostingInfo;
  /** Notebook open in this window. */
  notebook: string;
  /** Turns hosting on for the open notebook. */
  onHost(): void;
  /** Opens the screen that makes a notebook from a repository. */
  onImport(): void;
  heading(sub: string, action: ReactNode): ReactNode;
}) {
  const [info, setInfo] = useGitHub();
  const [signingIn, setSigningIn] = useState(false);
  const [keeping, setKeeping] = useState<string>();
  const [stopping, setStopping] = useState<string>();
  const [error, setError] = useState('');
  const run = (task: () => Promise<GitHubInfo>) => {
    setError('');
    void task().then(setInfo, (reason) => setError(message(reason)));
  };
  if (!info) return <p className="text-muted-foreground">Loading…</p>;
  const signedIn = info.account;
  return (
    <>
      {props.heading(
        signedIn
          ? `Signed in as ${signedIn.login}${signedIn.name ? ` (${signedIn.name})` : ''}`
          : 'Keep your notebooks in a GitHub repository.',
        signedIn ? (
          <Button
            variant="secondary"
            className="shrink-0"
            onClick={() => run(() => bridge.signOutOfGitHub())}
          >
            Sign out
          </Button>
        ) : (
          <Button className="shrink-0" onClick={() => setSigningIn(true)}>
            Sign in with GitHub
          </Button>
        ),
      )}
      <p className="text-muted-foreground text-sm leading-[22px]">
        A notebook is kept in a repository of yours as ordinary Markdown files. Changes made on any
        device reach it within a minute, and edits made on GitHub come back to every device. When
        both sides change the same lines, both versions are kept.
      </p>
      {(error || info.problem) && (
        <p role="alert" className="text-destructive text-sm leading-5">
          {error || info.problem}
        </p>
      )}
      {!props.hosting.hosting ? (
        <div className="border-border flex items-center justify-between gap-6 rounded-xl border px-5 py-4 text-sm">
          <span>
            GitHub is kept up to date by the Mac that hosts the notebook. This Mac is not hosting.
          </span>
          <Button size="sm" className="shrink-0" onClick={props.onHost}>
            Turn on hosting
          </Button>
        </div>
      ) : (
        <section>
          <h3 className="text-muted-foreground pb-2 text-xs font-semibold tracking-[0.08em] uppercase">
            Notebooks hosted here
          </h3>
          {props.hosting.notebooks.map((notebook) => {
            const mirror = info.mirrors.find((each) => each.notebook === notebook.name);
            return (
              <div
                key={notebook.name}
                data-github={notebook.name}
                className="border-border flex min-h-14 items-center gap-4 border-t py-2.5 text-sm last:border-b"
              >
                <span
                  className={`size-2 shrink-0 rounded-full ${!mirror ? 'bg-faint' : mirror.state === 'synced' && !mirror.held ? 'bg-success' : mirror.state === 'error' || mirror.held ? 'bg-destructive' : 'bg-amber-500'}`}
                />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="font-semibold">{notebook.name}</p>
                  <p
                    className={`text-[13px] leading-5 ${mirror?.state === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}
                  >
                    {mirror ? (
                      <>
                        {mirror.repository} · {mirrorLabel(mirror)}
                      </>
                    ) : (
                      'Only on your devices'
                    )}
                  </p>
                </div>
                {mirror ? (
                  <span className="flex shrink-0 gap-3.5">
                    {mirror.held ? (
                      <button
                        className="text-link"
                        onClick={() => run(() => bridge.syncGitHub(notebook.name, true))}
                      >
                        Confirm deletions
                      </button>
                    ) : (
                      <button
                        className="text-link"
                        onClick={() => run(() => bridge.syncGitHub(notebook.name))}
                      >
                        Sync now
                      </button>
                    )}
                    <button
                      className="text-muted-foreground"
                      onClick={() => setStopping(notebook.name)}
                    >
                      Stop…
                    </button>
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="shrink-0"
                    onClick={() => (signedIn ? setKeeping(notebook.name) : setSigningIn(true))}
                  >
                    Keep on GitHub…
                  </Button>
                )}
              </div>
            );
          })}
        </section>
      )}
      <div className="border-border flex items-center justify-between gap-6 border-t py-4">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium">Import from GitHub</p>
          <p className="text-muted-foreground text-[13px] leading-5">
            Make a notebook on this Mac from a repository of notes, such as one written in Obsidian,
            and keep the two in step.
          </p>
        </div>
        <Button variant="secondary" className="shrink-0" onClick={props.onImport}>
          Import…
        </Button>
      </div>
      {signingIn && (
        <SignInDialog
          onDone={(next) => {
            setSigningIn(false);
            setInfo(next);
          }}
          onCancel={() => setSigningIn(false)}
        />
      )}
      {keeping && (
        <RepositoryDialog
          title={`Keep “${keeping}” on GitHub`}
          intro={
            <>
              Choose a repository. If it already has notes, the two are combined: nothing on either
              side is deleted, and a note that differs is kept twice.
            </>
          }
          suggested={keeping}
          action="Keep on GitHub"
          onPick={(choice) =>
            bridge.keepOnGitHub(keeping, choice).then((next) => {
              setInfo(next);
              setKeeping(undefined);
            })
          }
          onCancel={() => setKeeping(undefined)}
        />
      )}
      {stopping && (
        <Modal
          label={`Stop keeping “${stopping}” on GitHub?`}
          onClose={() => setStopping(undefined)}
        >
          <h2 className="text-2xl font-bold tracking-tight">
            Stop keeping “{stopping}” on GitHub?
          </h2>
          <p className="text-muted-foreground text-sm leading-[22px]">
            Changes stop going to the repository. Nothing is deleted: the repository keeps every
            note and its history, and the notebook stays on your devices.
          </p>
          <div className="flex justify-end gap-2.5 pt-1">
            <Button variant="secondary" onClick={() => setStopping(undefined)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                const notebook = stopping;
                setStopping(undefined);
                run(() => bridge.stopGitHub(notebook));
              }}
            >
              Stop
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
