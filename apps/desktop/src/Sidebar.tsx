import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  FilePlus2,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  FolderSearch,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { noteFolder, noteTitle, type VaultInfo, type VaultTree } from '@opsidian/core';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useLateFocus } from '@/lib/use-late-focus';
import { cn } from '@/lib/utils';

interface Props {
  vault: VaultInfo;
  tree: VaultTree;
  active: string | null;
  expanded: ReadonlySet<string>;
  onToggle(folder: string): void;
  onOpen(path: string): void;
  onNewNote(folder: string): void;
  onNewFolder(parent: string, name: string): void;
  onRename(path: string, name: string): void;
  /** Moves a note or folder into `folder`; `''` is the top level. */
  onMove(path: string, folder: string): void;
  /** Asks where to move a note or folder. */
  onChooseFolder(path: string): void;
  onTrash(path: string): void;
  onReveal(path: string): void;
  onShowTrash(): void;
  onFind(): void;
  onSwitch(): void;
}

const row =
  'group flex h-[30px] w-full items-center gap-2 rounded-md pr-2 text-left text-[13px] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground';
const field =
  'border-ring bg-background text-foreground h-[30px] min-w-0 flex-1 rounded-md border px-2 text-[13px] outline-none';
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const isNote = (path: string) => /\.md$/i.test(path);

function NameField(props: { label: string; initial?: string; onDone(name?: string): void }) {
  const { field: input, settled: ready } = useLateFocus();
  return (
    <input
      ref={input}
      aria-label={props.label}
      placeholder={props.label}
      defaultValue={props.initial}
      className={field}
      onBlur={() => ready.current && props.onDone()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') props.onDone();
        if (event.key !== 'Enter') return;
        const name = event.currentTarget.value.trim();
        props.onDone(name && name !== props.initial ? name : undefined);
      }}
    />
  );
}

export function Sidebar(props: Props) {
  const { vault, tree, active, expanded } = props;
  const [renaming, setRenaming] = useState<string | null>(null);
  // The folder a new folder is being named in; '' is the top level.
  const [creating, setCreating] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const dragged = useRef<string | null>(null);

  const accepts = (folder: string) => {
    const path = dragged.current;
    if (!path || noteFolder(path) === folder) return false;
    return isNote(path) || (folder !== path && !folder.startsWith(`${path}/`));
  };
  const drop = (folder: string) => ({
    onDragOver: (event: DragEvent) => {
      if (!accepts(folder)) return;
      event.preventDefault();
      event.stopPropagation();
      setTarget(folder);
    },
    onDragLeave: () => setTarget((current) => (current === folder ? null : current)),
    onDrop: (event: DragEvent) => {
      if (!accepts(folder)) return;
      event.preventDefault();
      event.stopPropagation();
      props.onMove(dragged.current!, folder);
      dragged.current = null;
      setTarget(null);
    },
  });
  const drag = (path: string) => ({
    draggable: true,
    onDragStart: (event: DragEvent) => {
      dragged.current = path;
      event.dataTransfer.effectAllowed = 'move';
      // Dropped into a note, a dragged note becomes a link to it.
      event.dataTransfer.setData('text/plain', isNote(path) ? `[[${noteTitle(path)}]]` : '');
    },
    onDragEnd: () => {
      dragged.current = null;
      setTarget(null);
    },
  });
  const shared = (path: string) => (
    <>
      <ContextMenuItem onSelect={() => setRenaming(path)}>
        <Pencil /> Rename
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => props.onChooseFolder(path)}>
        <FolderInput /> Move to…
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => props.onReveal(path)}>
        <FolderSearch /> Show in Finder
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" onSelect={() => props.onTrash(path)}>
        <Trash2 /> Move to trash
      </ContextMenuItem>
    </>
  );
  const renameField = (path: string) => (
    <NameField
      label="New name"
      initial={isNote(path) ? noteTitle(path) : nameOf(path)}
      onDone={(name) => {
        setRenaming(null);
        if (name) props.onRename(path, name);
      }}
    />
  );
  const children = (folder: string, depth: number): ReactNode => (
    <>
      {creating === folder && (
        <li className="flex py-px" style={{ paddingLeft: 8 + depth * 14 }}>
          <NameField
            label="Folder name"
            onDone={(name) => {
              setCreating(null);
              if (name) props.onNewFolder(folder, name);
            }}
          />
        </li>
      )}
      {tree.folders
        .filter((path) => noteFolder(path) === folder)
        .map((path) => (
          <li key={path} {...drop(path)}>
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div
                  className={cn(row, target === path && 'bg-sidebar-accent ring-ring ring-1')}
                  style={{ paddingLeft: 8 + depth * 14 }}
                  data-folder={path}
                  {...(renaming === path ? {} : drag(path))}
                >
                  {renaming === path ? (
                    renameField(path)
                  ) : (
                    <>
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
                        <span className="truncate">{nameOf(path)}</span>
                      </button>
                      <button
                        aria-label={`New note in ${path}`}
                        title="New note here"
                        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        onClick={() => props.onNewNote(path)}
                      >
                        <Plus size={14} />
                      </button>
                    </>
                  )}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => props.onNewNote(path)}>
                  <FilePlus2 /> New note
                </ContextMenuItem>
                <ContextMenuItem
                  onSelect={() => {
                    if (!expanded.has(path)) props.onToggle(path);
                    setCreating(path);
                  }}
                >
                  <FolderPlus /> New folder
                </ContextMenuItem>
                <ContextMenuSeparator />
                {shared(path)}
              </ContextMenuContent>
            </ContextMenu>
            {expanded.has(path) && <ul>{children(path, depth + 1)}</ul>}
          </li>
        ))}
      {tree.notes
        .filter((path) => noteFolder(path) === folder)
        .map((path) => (
          <li key={path}>
            {renaming === path ? (
              <div className="flex py-px" style={{ paddingLeft: 30 + depth * 14 }}>
                {renameField(path)}
              </div>
            ) : (
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <button
                    className={cn(
                      row,
                      path === active && 'bg-sidebar-accent text-sidebar-accent-foreground',
                    )}
                    style={{ paddingLeft: 30 + depth * 14 }}
                    aria-current={path === active ? 'page' : undefined}
                    data-note={path}
                    onClick={() => props.onOpen(path)}
                    {...drag(path)}
                  >
                    <FileText size={15} className="shrink-0" />
                    <span className="truncate">{noteTitle(path)}</span>
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent>{shared(path)}</ContextMenuContent>
              </ContextMenu>
            )}
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
        <button aria-label="New folder" title="New folder" onClick={() => setCreating('')}>
          <FolderPlus size={15} />
        </button>
      </div>
      <nav
        aria-label="Notes"
        className={cn(
          'min-h-0 flex-1 overflow-auto px-3 pb-3',
          target === '' && 'bg-sidebar-accent/50',
        )}
        {...drop('')}
      >
        <ul>{children('', 0)}</ul>
        {!tree.notes.length && !tree.folders.length && creating === null && (
          <p className="px-2 pt-2 text-[13px] leading-6">
            Nothing here yet. Start with a new note.
          </p>
        )}
      </nav>
      <div className="border-sidebar-border mx-4 border-t py-3 text-xs">
        <button
          className="hover:bg-sidebar-accent hover:text-sidebar-accent-foreground -mx-2 mb-2 flex h-[30px] w-[calc(100%+16px)] items-center gap-2 rounded-md px-2 text-[13px]"
          onClick={props.onShowTrash}
        >
          <Trash2 size={15} /> Trash
        </button>
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
