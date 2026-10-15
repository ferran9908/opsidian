import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import {
  ArrowDownUp,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleHelp,
  FilePlus2,
  FolderInput,
  FolderPlus,
  FolderSearch,
  PanelLeft,
  Pencil,
  Settings,
  SquarePen,
  Trash2,
} from 'lucide-react';
import { noteFolder, noteTitle, type VaultInfo, type VaultTree } from '@opsidian/core';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  onSwitch(): void;
  sort: TreeSort;
  onSort(sort: TreeSort): void;
  onCollapseAll(): void;
  onHide(): void;
  onHelp(): void;
  onSettings(): void;
}

/** How the files are ordered: folders first, then notes, by name either way round. */
export type TreeSort = 'name' | 'name-desc';

const row =
  'group flex h-7 w-full items-center gap-1 rounded-[5px] pr-2 text-left text-[13.5px] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground';
const icon =
  'no-drag text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex size-7 items-center justify-center rounded-md';
/** Each level of the tree steps in this far, and draws its guide line there. */
const STEP = 16;
const field =
  'border-ring bg-background text-foreground h-7 min-w-0 flex-1 rounded-md border px-2 text-[13.5px] outline-none';
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
  const { vault, tree, active, expanded, sort } = props;
  const order = (a: string, b: string) =>
    sort === 'name-desc'
      ? b.localeCompare(a, undefined, { numeric: true })
      : a.localeCompare(b, undefined, { numeric: true });
  const named = (paths: string[], folder: string, title: (path: string) => string) =>
    paths.filter((path) => noteFolder(path) === folder).sort((a, b) => order(title(a), title(b)));
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
  /** The guide lines down the left of a folder's contents, one per level, like Obsidian. */
  const guides = (depth: number) =>
    Array.from({ length: depth }, (_unused, level) => (
      <span
        key={level}
        aria-hidden
        className="border-sidebar-border absolute top-0 bottom-0 border-l"
        style={{ left: 15 + level * STEP }}
      />
    ));
  const children = (folder: string, depth: number): ReactNode => (
    <>
      {creating === folder && (
        <li className="relative flex py-px" style={{ paddingLeft: 8 + depth * STEP }}>
          {guides(depth)}
          <NameField
            label="Folder name"
            onDone={(name) => {
              setCreating(null);
              if (name) props.onNewFolder(folder, name);
            }}
          />
        </li>
      )}
      {named(tree.folders, folder, nameOf).map((path) => (
        <li key={path} {...drop(path)}>
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                className={cn(
                  row,
                  'relative',
                  target === path && 'bg-sidebar-accent ring-ring ring-1',
                )}
                style={{ paddingLeft: 6 + depth * STEP }}
                data-folder={path}
                {...(renaming === path ? {} : drag(path))}
              >
                {guides(depth)}
                {renaming === path ? (
                  renameField(path)
                ) : (
                  <>
                    <button
                      className="flex min-w-0 flex-1 items-center gap-1 self-stretch text-left"
                      aria-expanded={expanded.has(path)}
                      onClick={() => props.onToggle(path)}
                    >
                      <span className="text-faint flex w-4 shrink-0 justify-center">
                        {expanded.has(path) ? (
                          <ChevronDown size={14} />
                        ) : (
                          <ChevronRight size={14} />
                        )}
                      </span>
                      <span className="truncate">{nameOf(path)}</span>
                    </button>
                    <button
                      aria-label={`New note in ${path}`}
                      title="New note here"
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      onClick={() => props.onNewNote(path)}
                    >
                      <SquarePen size={14} />
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
      {named(tree.notes, folder, noteTitle).map((path) => (
        <li key={path} className="relative">
          {guides(depth)}
          {renaming === path ? (
            <div className="flex py-px" style={{ paddingLeft: 26 + depth * STEP }}>
              {renameField(path)}
            </div>
          ) : (
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <button
                  className={cn(
                    row,
                    path === active &&
                      'bg-sidebar-accent text-sidebar-accent-foreground font-medium',
                  )}
                  style={{ paddingLeft: 26 + depth * STEP }}
                  aria-current={path === active ? 'page' : undefined}
                  data-note={path}
                  onClick={() => props.onOpen(path)}
                  {...drag(path)}
                >
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
      <div className="drag flex h-11 shrink-0 items-center justify-end px-2.5">
        <button
          aria-label="Hide sidebar"
          title="Hide sidebar"
          className={icon}
          onClick={props.onHide}
        >
          <PanelLeft size={17} />
        </button>
      </div>
      <div
        className="flex h-9 shrink-0 items-center justify-center gap-1.5"
        aria-label="File actions"
      >
        <button
          aria-label="New note"
          title="New note (⌘N)"
          className={icon}
          onClick={() => props.onNewNote('')}
        >
          <SquarePen size={17} />
        </button>
        <button
          aria-label="New folder"
          title="New folder"
          className={icon}
          onClick={() => setCreating('')}
        >
          <FolderPlus size={17} />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button aria-label="Sort" title="Change sort order" className={icon}>
              <ArrowDownUp size={17} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center">
            <DropdownMenuRadioGroup
              value={sort}
              onValueChange={(value) => props.onSort(value as TreeSort)}
            >
              <DropdownMenuRadioItem value="name">Name (A to Z)</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="name-desc">Name (Z to A)</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          aria-label="Collapse all"
          title="Collapse all"
          className={icon}
          onClick={props.onCollapseAll}
        >
          <ChevronsDownUp size={17} />
        </button>
      </div>
      <nav
        aria-label="Notes"
        className={cn(
          'min-h-0 flex-1 overflow-auto px-2 pt-1.5 pb-3',
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
      <div className="border-sidebar-border flex h-12 shrink-0 items-center gap-0.5 border-t px-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label="Notebook"
              title={vault.location}
              className="hover:bg-sidebar-accent flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left"
            >
              <span className="text-sidebar-accent-foreground truncate text-[13.5px] font-semibold">
                {vault.name}
              </span>
              <ChevronsUpDown size={13} className="text-faint shrink-0" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-60">
            <DropdownMenuLabel className="truncate" title={vault.location}>
              {vault.location}
            </DropdownMenuLabel>
            <DropdownMenuItem onSelect={props.onSwitch}>Open another notebook…</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={props.onShowTrash}>
              <Trash2 /> Trash
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => props.onReveal('')}>
              <FolderSearch /> Show in Finder
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button aria-label="Help" title="Help" className={icon} onClick={props.onHelp}>
          <CircleHelp size={17} />
        </button>
        <button
          aria-label="Settings"
          title="Settings (⌘,)"
          className={icon}
          onClick={props.onSettings}
        >
          <Settings size={17} />
        </button>
      </div>
    </aside>
  );
}
