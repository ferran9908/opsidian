import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { X } from 'lucide-react';
import { NO_UPDATE, type AppUpdate } from '@opsidian/core';
import { bridge, message } from './bridge';
import { Button } from '@/components/ui/button';

/** The answer to a check someone asked for, shown until the next one. */
type CheckNote = { kind: 'info' | 'error'; text: string } | undefined;

interface Updates {
  update: AppUpdate;
  version: string;
  checking: boolean;
  note: CheckNote;
  check(): void;
  download(): void;
  restart(): void;
}

const Context = createContext<Updates | null>(null);

/**
 * The app's update, as the main process has it. The notice in the corner and Settings both read
 * this one copy, so they always agree.
 */
export function UpdatesProvider({ children }: { children: ReactNode }) {
  const [update, setUpdate] = useState<AppUpdate>(NO_UPDATE);
  const [version, setVersion] = useState('');
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<CheckNote>();

  const check = useCallback(() => {
    setChecking(true);
    setNote(undefined);
    void bridge
      .checkForUpdate()
      .then(
        (result) => {
          if (result === 'up_to_date')
            setNote({ kind: 'info', text: 'You’re on the latest version.' });
          if (result === 'dev')
            setNote({ kind: 'info', text: 'A copy run from the repository does not update.' });
        },
        (reason) => setNote({ kind: 'error', text: message(reason) }),
      )
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    void bridge.updateState().then(setUpdate);
    void bridge.appVersion().then(setVersion);
    const stopUpdate = bridge.onUpdate(setUpdate);
    const stopAsked = bridge.onUpdateCheckRequested(check);
    return () => {
      stopUpdate();
      stopAsked();
    };
  }, [check]);

  const value = useMemo(
    () => ({
      update,
      version,
      checking,
      note,
      check,
      download: () => void bridge.downloadUpdate(),
      restart: () => void bridge.restartToUpdate(),
    }),
    [update, version, checking, note, check],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useUpdates(): Updates {
  const value = useContext(Context);
  if (!value) throw new Error('useUpdates must be used inside UpdatesProvider');
  return value;
}

function Progress({ percent }: { percent: number }) {
  return (
    <div
      role="progressbar"
      aria-label="Download progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      className="bg-muted mt-3 h-1.5 overflow-hidden rounded-full"
    >
      <div className="bg-primary h-full transition-[width]" style={{ width: `${percent}%` }} />
    </div>
  );
}

/**
 * The notice in the corner of the window. A download in progress and a restart that is waiting
 * always show; an offer or an error can be put away. A check asked for from the menu shows its
 * answer here too, for a few seconds.
 */
export function UpdateNotice() {
  const { update, checking, note, check, download, restart } = useUpdates();
  // What was put away, by what it said, so a new offer or a new error shows again.
  const [dismissed, setDismissed] = useState('');
  const [noteShown, setNoteShown] = useState(false);
  useEffect(() => {
    if (!note && !checking) return;
    setNoteShown(true);
    if (checking) return;
    const timer = setTimeout(() => setNoteShown(false), 5000);
    return () => clearTimeout(timer);
  }, [note, checking]);

  const key = JSON.stringify(update);
  let body: ReactNode;
  let closable = false;
  if (update.kind === 'available') {
    closable = true;
    body = (
      <>
        <h2 className="text-sm font-semibold">A new version is available</h2>
        <p className="text-muted-foreground mt-1 text-[13px]">
          Opsidian {update.version} is ready to download.
        </p>
        <Button size="sm" className="mt-3" onClick={download}>
          Download now
        </Button>
      </>
    );
  } else if (update.kind === 'downloading') {
    body = (
      <>
        <h2 className="text-sm font-semibold">Downloading update</h2>
        <p className="text-muted-foreground mt-1 text-[13px]">
          Opsidian {update.version} · {Math.round(update.percent)}%
        </p>
        <Progress percent={update.percent} />
      </>
    );
  } else if (update.kind === 'ready') {
    body = (
      <>
        <h2 className="text-sm font-semibold">Restart to update</h2>
        <p className="text-muted-foreground mt-1 text-[13px]">
          Opsidian {update.version} installs when Opsidian restarts.
        </p>
        <Button size="sm" className="mt-3" onClick={restart}>
          Restart now
        </Button>
      </>
    );
  } else if (update.kind === 'error') {
    closable = true;
    body = (
      <>
        <h2 className="text-sm font-semibold">The update didn’t work</h2>
        <p className="text-destructive mt-1 text-[13px]">{update.message}</p>
        <Button size="sm" className="mt-3" onClick={update.version ? download : check}>
          Try again
        </Button>
      </>
    );
  } else if (noteShown && (checking || note)) {
    closable = !checking;
    body = (
      <p className={`text-[13px] ${note?.kind === 'error' ? 'text-destructive' : ''}`}>
        {checking ? 'Checking for updates…' : note?.text}
      </p>
    );
  }
  if (!body || (closable && dismissed === key && update.kind !== 'none')) return null;

  return (
    <aside
      role="status"
      className="border-border bg-background text-foreground fixed right-5 bottom-14 z-40 w-80 rounded-xl border p-4 pr-10 shadow-2xl"
    >
      <p className="text-muted-foreground pb-1 text-[11px] font-semibold tracking-[0.08em] uppercase">
        Opsidian
      </p>
      {body}
      {closable && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss"
          className="absolute top-2.5 right-2.5"
          onClick={() => (update.kind === 'none' ? setNoteShown(false) : setDismissed(key))}
        >
          <X />
        </Button>
      )}
    </aside>
  );
}

/** Settings → Updates: the version you have, and the same update as the notice. */
export function UpdateSettings() {
  const { update, version, checking, note, check, download, restart } = useUpdates();
  const checkButton = (
    <Button variant="secondary" disabled={checking} onClick={check}>
      {checking ? 'Checking…' : 'Check for updates'}
    </Button>
  );
  let line: ReactNode;
  let action: ReactNode = checkButton;
  if (update.kind === 'available') {
    line = `Opsidian ${update.version} is ready to download.`;
    action = <Button onClick={download}>Download now</Button>;
  } else if (update.kind === 'downloading') {
    line = (
      <>
        Downloading Opsidian {update.version} · {Math.round(update.percent)}%
        <Progress percent={update.percent} />
      </>
    );
    action = null;
  } else if (update.kind === 'ready') {
    line = `Opsidian ${update.version} is downloaded and installs when Opsidian restarts.`;
    action = <Button onClick={restart}>Restart now</Button>;
  } else if (update.kind === 'error') {
    line = <span className="text-destructive">{update.message}</span>;
    action = update.version ? <Button onClick={download}>Try again</Button> : checkButton;
  } else
    line =
      note?.kind === 'error' ? (
        <span className="text-destructive">{note.text}</span>
      ) : (
        `${note?.text ?? 'Opsidian checks for a new version when it opens and every four hours.'}`
      );
  return (
    <div className="border-border flex items-start justify-between gap-6 border-t py-4">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">Opsidian {version}</p>
        <div className="text-muted-foreground text-[13px] leading-5">{line}</div>
      </div>
      {action}
    </div>
  );
}
