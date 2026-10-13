import { useEffect, useState } from 'react';
import { History, X } from 'lucide-react';
import { noteTitle, type NoteVersion } from '@opsidian/core';
import { bridge, message } from './bridge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Props {
  path: string;
  /** Called with the text of the version to bring back. */
  onRestore(content: string): void;
  onClose(): void;
}

export function HistoryDialog({ path, onRestore, onClose }: Props) {
  const [versions, setVersions] = useState<NoteVersion[]>();
  const [chosen, setChosen] = useState<NoteVersion>();
  const [content, setContent] = useState<string>();
  const [error, setError] = useState('');
  useEffect(() => {
    void bridge
      .history(path)
      .then((found) => {
        setVersions(found);
        setChosen(found.find((version) => version.hash));
      })
      .catch((reason) => setError(message(reason)));
    const keys = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, []);
  useEffect(() => {
    setContent(undefined);
    if (!chosen?.hash) return;
    let stale = false;
    void bridge
      .versionText(chosen.hash)
      .then((loaded) => !stale && setContent(loaded))
      .catch((reason) => !stale && setError(message(reason)));
    return () => {
      stale = true;
    };
  }, [chosen]);
  return (
    <div
      className="fixed inset-0 z-20 flex items-start justify-center bg-black/30 pt-[8vh]"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-label="Version history"
        className="border-border bg-popover text-popover-foreground flex h-[76vh] w-[min(860px,92vw)] flex-col overflow-hidden rounded-xl border shadow-2xl"
      >
        <div className="border-border flex h-12 shrink-0 items-center gap-3 border-b pr-2 pl-4">
          <History size={16} className="text-muted-foreground" />
          <h2 className="flex-1 truncate text-sm font-medium">History of {noteTitle(path)}</h2>
          <Button
            size="sm"
            disabled={content === undefined || chosen === versions?.[0]}
            onClick={() => content !== undefined && onRestore(content)}
          >
            Restore this version
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
            <X />
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-destructive px-4 pt-3 text-[13px]">
            {error}
          </p>
        )}
        <div className="flex min-h-0 flex-1">
          <ul className="border-border w-[250px] shrink-0 overflow-auto border-r p-1.5">
            {versions?.map((version, position) => (
              <li key={version.seq}>
                <button
                  disabled={!version.hash}
                  className={cn(
                    'w-full rounded-md px-3 py-2 text-left text-[13px] disabled:opacity-60',
                    version === chosen && 'bg-accent text-accent-foreground',
                  )}
                  onClick={() => setChosen(version)}
                >
                  <span className="block">
                    {new Date(version.at).toLocaleString([], {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                    {position === 0 && <span className="text-muted-foreground"> · current</span>}
                  </span>
                  <span className="text-muted-foreground block truncate text-xs leading-5">
                    {version.hash ? version.device : `Deleted on ${version.device}`}
                    {version.path !== path && version.hash
                      ? ` · as ${noteTitle(version.path)}`
                      : ''}
                  </span>
                </button>
              </li>
            ))}
            {versions?.length === 0 && (
              <li className="text-muted-foreground px-3 py-6 text-[13px] leading-5">
                No history yet. Versions appear once this note has synced.
              </li>
            )}
          </ul>
          <pre className="min-w-0 flex-1 overflow-auto p-5 font-sans text-sm leading-6 whitespace-pre-wrap">
            {content}
          </pre>
        </div>
      </div>
    </div>
  );
}
