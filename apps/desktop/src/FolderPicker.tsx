import { useEffect, useRef, useState } from 'react';
import { Folder, FolderInput } from 'lucide-react';
import { noteFolder, noteTitle } from '@opsidian/core';
import { useLateFocus } from '@/lib/use-late-focus';
import { cn } from '@/lib/utils';

interface Props {
  /** The note or folder being moved. */
  path: string;
  folders: string[];
  onChoose(folder: string): void;
  onClose(): void;
}

export function FolderPicker({ path, folders, onChoose, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const { field } = useLateFocus();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  // Not where it already is, and never inside itself.
  const rows = ['', ...folders].filter(
    (folder) =>
      folder !== noteFolder(path) &&
      folder !== path &&
      !folder.startsWith(`${path}/`) &&
      terms.every((term) => folder.toLowerCase().includes(term)),
  );
  useEffect(() => setSelected(0), [query]);
  useEffect(() => {
    list.current?.children[selected]?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  const name = /\.md$/i.test(path) ? noteTitle(path) : path.slice(path.lastIndexOf('/') + 1);
  return (
    <div
      className="fixed inset-0 z-20 flex items-start justify-center bg-black/30 pt-[14vh]"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-label={`Move ${name}`}
        className="border-border bg-popover text-popover-foreground w-[min(520px,90vw)] overflow-hidden rounded-xl border shadow-2xl"
      >
        <div className="border-border flex items-center gap-3 border-b px-4">
          <FolderInput size={16} className="text-muted-foreground shrink-0" />
          <input
            ref={field}
            value={query}
            placeholder={`Move “${name}” to…`}
            aria-label="Destination folder"
            className="placeholder:text-faint h-12 flex-1 bg-transparent outline-none"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose();
              else if (event.key === 'Enter') {
                const folder = rows[selected];
                if (folder !== undefined) onChoose(folder);
              } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const step = event.key === 'ArrowDown' ? 1 : -1;
                setSelected((selected + step + rows.length) % Math.max(rows.length, 1));
              }
            }}
          />
        </div>
        <ul ref={list} className="max-h-[50vh] overflow-auto p-1.5">
          {rows.map((folder, position) => (
            <li key={folder}>
              <button
                className={cn(
                  'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm',
                  position === selected && 'bg-accent text-accent-foreground',
                )}
                onMouseEnter={() => setSelected(position)}
                onClick={() => onChoose(folder)}
              >
                <Folder size={16} className="text-muted-foreground shrink-0" />
                <span className="truncate">{folder || 'Top level'}</span>
              </button>
            </li>
          ))}
          {!rows.length && (
            <li className="text-muted-foreground px-3 py-6 text-center text-sm">
              No other folder matches.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
