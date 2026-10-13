import { useState, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  FileText,
  Folder,
  FolderPlus,
  Plus,
  Search,
} from 'lucide-react';
import { noteTitle, type VaultInfo, type VaultTree } from '@opsidian/core';
import { cn } from '@/lib/utils';

interface Props {
  vault: VaultInfo;
  tree: VaultTree;
  active: string | null;
  expanded: ReadonlySet<string>;
  onToggle(folder: string): void;
  onOpen(path: string): void;
  onNewNote(folder: string): void;
  onNewFolder(name: string): void;
  onFind(): void;
  onSwitch(): void;
}

const row =
  'group flex h-[30px] w-full items-center gap-2 rounded-md pr-2 text-left text-[13px] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground';
const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf('/'), 0));

export function Sidebar(props: Props) {
  const { vault, tree, active, expanded } = props;
  const [naming, setNaming] = useState(false);
  const children = (folder: string, depth: number): ReactNode => (
    <>
      {tree.folders
        .filter((path) => parentOf(path) === folder)
        .map((path) => (
          <li key={path}>
            <div className={row} style={{ paddingLeft: 8 + depth * 14 }}>
              <button
                className="flex min-w-0 flex-1 items-center gap-2 self-stretch text-left"
                aria-expanded={expanded.has(path)}
                onClick={() => props.onToggle(path)}
              >
                {expanded.has(path) ? (
                  <ChevronDown size={14} className="shrink-0" />
                ) : (
                  <ChevronRight size={14} className="shrink-0" />
                )}
                <Folder size={15} className="shrink-0" />
                <span className="truncate">{path.slice(path.lastIndexOf('/') + 1)}</span>
              </button>
              <button
                aria-label={`New note in ${path}`}
                title="New note here"
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => props.onNewNote(path)}
              >
                <Plus size={14} />
              </button>
            </div>
            {expanded.has(path) && <ul>{children(path, depth + 1)}</ul>}
          </li>
        ))}
      {tree.notes
        .filter((path) => parentOf(path) === folder)
        .map((path) => (
          <li key={path}>
            <button
              className={cn(
                row,
                path === active && 'bg-sidebar-accent text-sidebar-accent-foreground',
              )}
              style={{ paddingLeft: 30 + depth * 14 }}
              aria-current={path === active ? 'page' : undefined}
              onClick={() => props.onOpen(path)}
            >
              <FileText size={15} className="shrink-0" />
              <span className="truncate">{noteTitle(path)}</span>
            </button>
          </li>
        ))}
    </>
  );
  return (
    <aside className="border-sidebar-border bg-sidebar text-sidebar-foreground flex w-[260px] shrink-0 flex-col border-r max-[980px]:w-[220px] max-[650px]:hidden">
      <div className="drag h-12 shrink-0" />
      <button
        className="hover:bg-sidebar-accent mx-3 flex items-center gap-3 rounded-md px-2 py-1.5 text-left"
        title="Switch notebook"
        onClick={props.onSwitch}
      >
        <span className="border-link h-8 w-7 shrink-0 rounded border border-l-4" />
        <span className="min-w-0 flex-1">
          <strong className="text-sidebar-accent-foreground block truncate text-[15px] font-semibold">
            {vault.name}
          </strong>
          <span className="block text-xs">Local notebook</span>
        </span>
        <ChevronsUpDown size={14} className="shrink-0" />
      </button>
      <button
        className="border-sidebar-border bg-background mx-4 mt-4 flex h-9 items-center gap-2.5 rounded-md border px-3 text-[13px]"
        onClick={props.onFind}
      >
        <Search size={15} />
        <span className="flex-1 text-left">Find a note</span>
        <kbd className="font-sans text-xs">⌘ K</kbd>
      </button>
      <button
        className="text-sidebar-accent-foreground hover:bg-sidebar-accent mx-3 mt-3 flex h-9 items-center gap-2.5 rounded-md px-3 text-[13px] font-medium"
        onClick={() => props.onNewNote('')}
      >
        <Plus size={16} />
        <span className="flex-1 text-left">New note</span>
        <kbd className="text-sidebar-foreground font-sans text-xs font-normal">⌘ N</kbd>
      </button>
      <div className="mt-5 flex items-center px-5 pb-1">
        <span className="flex-1 text-[11px] tracking-[0.09em]">NOTES</span>
        <button aria-label="New folder" title="New folder" onClick={() => setNaming(true)}>
          <FolderPlus size={15} />
        </button>
      </div>
      <nav aria-label="Notes" className="min-h-0 flex-1 overflow-auto px-3 pb-3">
        {naming && (
          <input
            autoFocus
            aria-label="Folder name"
            placeholder="Folder name"
            className="border-ring bg-background text-foreground mb-1 h-[30px] w-full rounded-md border px-2 text-[13px] outline-none"
            onBlur={() => setNaming(false)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setNaming(false);
              if (event.key !== 'Enter') return;
              const name = event.currentTarget.value.trim();
              setNaming(false);
              if (name) props.onNewFolder(name);
            }}
          />
        )}
        <ul>{children('', 0)}</ul>
        {!tree.notes.length && !tree.folders.length && (
          <p className="px-2 pt-2 text-[13px] leading-6">
            Nothing here yet. Start with a new note.
          </p>
        )}
      </nav>
      <div className="border-sidebar-border mx-4 border-t py-4 text-xs">
        <p className="text-sidebar-accent-foreground flex items-center gap-2 text-[13px]">
          <span className="bg-success size-1.5 rounded-full" /> On this Mac
        </p>
        <p className="mt-1.5 truncate" title={vault.location}>
          {vault.location}
        </p>
      </div>
    </aside>
  );
}
