import { useEffect, useRef, useState } from 'react';
import { FilePlus2, FileText, Search } from 'lucide-react';
import { noteFolder, noteTitle, resolveLink, type SearchResult } from '@opsidian/core';
import { bridge } from './bridge';
import { cn } from '@/lib/utils';

interface Props {
  notes: string[];
  /** Most recently opened first; shown before anything is typed. */
  recent: string[];
  /** What the search starts with, for example `#tag`. */
  initial?: string;
  onOpen(path: string): void;
  onCreate(name: string): void;
  onClose(): void;
}
type Row = SearchResult | { create: string };

export function QuickSwitcher({ notes, recent, initial, onOpen, onCreate, onClose }: Props) {
  const [query, setQuery] = useState(initial ?? '');
  const [found, setFound] = useState<SearchResult[]>([]);
  const [selected, setSelected] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const trimmed = query.trim();
  useEffect(() => {
    if (!trimmed) return setFound([]);
    let stale = false;
    const timer = setTimeout(() => {
      void bridge.search(trimmed).then((results) => {
        if (!stale) setFound(results);
      });
    }, 60);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [trimmed]);
  const idle = [...new Set([...recent, ...notes])]
    .filter((path) => notes.includes(path))
    .slice(0, 30)
    .map((path): Row => ({ path }));
  // A search by tag does not offer to create a note called `#tag`.
  const creatable = trimmed && !trimmed.startsWith('#') && !resolveLink(trimmed, notes);
  const rows: Row[] = trimmed ? [...found, ...(creatable ? [{ create: trimmed }] : [])] : idle;
  useEffect(() => setSelected(0), [query, found.length]);
  useEffect(() => {
    list.current?.children[selected]?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  const choose = (row: Row | undefined) => {
    if (!row) return;
    if ('create' in row) onCreate(row.create);
    else onOpen(row.path);
  };
  return (
    <div
      className="fixed inset-0 z-20 flex items-start justify-center bg-black/30 pt-[14vh]"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-label="Find a note"
        className="border-border bg-popover text-popover-foreground w-[min(600px,90vw)] overflow-hidden rounded-xl border shadow-2xl"
      >
        <div className="border-border flex items-center gap-3 border-b px-4">
          <Search size={16} className="text-muted-foreground shrink-0" />
          <input
            autoFocus
            value={query}
            placeholder="Find or create a note, or #tag…"
            aria-label="Find or create a note"
            className="placeholder:text-faint h-12 flex-1 bg-transparent outline-none"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose();
              else if (event.key === 'Enter') choose(rows[selected]);
              else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const step = event.key === 'ArrowDown' ? 1 : -1;
                setSelected((selected + step + rows.length) % Math.max(rows.length, 1));
              }
            }}
          />
        </div>
        <ul ref={list} className="max-h-[50vh] overflow-auto p-1.5">
          {rows.map((row, position) => (
            <li key={'create' in row ? '\u0000create' : row.path}>
              <button
                data-selected={position === selected}
                className={cn(
                  'flex w-full items-start gap-3 rounded-md px-3 py-2 text-left text-sm',
                  position === selected && 'bg-accent text-accent-foreground',
                )}
                onMouseEnter={() => setSelected(position)}
                onClick={() => choose(row)}
              >
                {'create' in row ? (
                  <>
                    <FilePlus2 size={16} className="text-muted-foreground mt-0.5 shrink-0" />
                    <span>
                      Create <strong className="font-medium">{row.create}</strong>
                    </span>
                  </>
                ) : (
                  <>
                    <FileText size={16} className="text-muted-foreground mt-0.5 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">
                        {noteTitle(row.path)}
                        {noteFolder(row.path) && (
                          <span className="text-faint pl-2 text-xs">{noteFolder(row.path)}</span>
                        )}
                      </span>
                      {row.excerpt && (
                        <span className="text-muted-foreground block truncate text-xs leading-5">
                          {row.excerpt}
                        </span>
                      )}
                    </span>
                  </>
                )}
              </button>
            </li>
          ))}
          {!rows.length && (
            <li className="text-muted-foreground px-3 py-6 text-center text-sm">
              {trimmed.startsWith('#') ? 'No note carries that tag.' : 'No notes yet.'}
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
