import { useEffect, useState } from 'react';
import { FileText, Folder, Trash2, X } from 'lucide-react';
import { noteFolder, type TrashEntry } from '@opsidian/core';
import { bridge, message } from './bridge';
import { Button } from '@/components/ui/button';

interface Props {
  /** Called with the path a restored item came back to. */
  onRestored(path: string): void;
  onClose(): void;
}

const ago = (at: number) => {
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
  return new Date(at).toLocaleDateString();
};

export function TrashDialog({ onRestored, onClose }: Props) {
  const [entries, setEntries] = useState<TrashEntry[]>();
  const [error, setError] = useState('');
  const load = () =>
    bridge
      .trashed()
      .then(setEntries)
      .catch((reason) => setError(message(reason)));
  useEffect(() => {
    void load();
    const keys = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, []);
  return (
    <div
      className="fixed inset-0 z-20 flex items-start justify-center bg-black/30 pt-[12vh]"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-label="Trash"
        className="border-border bg-popover text-popover-foreground flex max-h-[70vh] w-[min(560px,90vw)] flex-col overflow-hidden rounded-xl border shadow-2xl"
      >
        <div className="border-border flex h-12 shrink-0 items-center gap-3 border-b pr-2 pl-4">
          <Trash2 size={16} className="text-muted-foreground" />
          <h2 className="flex-1 text-sm font-medium">Trash</h2>
          {entries && entries.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                void bridge
                  .emptyTrash()
                  .then((emptied) => {
                    if (emptied) return load();
                  })
                  .catch((reason) => setError(message(reason)))
              }
            >
              Empty trash
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
            <X />
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-destructive px-4 pt-3 text-[13px]">
            {error}
          </p>
        )}
        <ul className="min-h-0 flex-1 overflow-auto p-1.5">
          {entries?.map((entry) => (
            <li key={entry.name} className="flex items-center gap-3 rounded-md px-3 py-2 text-sm">
              {entry.folder ? (
                <Folder size={16} className="text-muted-foreground shrink-0" />
              ) : (
                <FileText size={16} className="text-muted-foreground shrink-0" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{entry.name.replace(/\.md$/i, '')}</span>
                <span className="text-muted-foreground block truncate text-xs leading-5">
                  {entry.from && noteFolder(entry.from) ? `${noteFolder(entry.from)} · ` : ''}
                  {ago(entry.at)}
                </span>
              </span>
              <Button
                variant="outline"
                size="sm"
                aria-label={`Restore ${entry.name.replace(/\.md$/i, '')}`}
                onClick={() =>
                  void bridge
                    .restore(entry.name)
                    .then((path) => {
                      onRestored(path);
                      return load();
                    })
                    .catch((reason) => setError(message(reason)))
                }
              >
                Restore
              </Button>
            </li>
          ))}
          {entries?.length === 0 && (
            <li className="text-muted-foreground px-3 py-8 text-center text-sm">
              The trash is empty.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
