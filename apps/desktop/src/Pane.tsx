import { useEffect, useRef, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  Code,
  Columns2,
  Copy,
  Ellipsis,
  FolderInput,
  FolderSearch,
  History,
  PanelLeft,
  Pencil,
  Rows2,
  Share2,
  Trash2,
  Waypoints,
  X,
} from 'lucide-react';
import { noteFolder, noteTitle } from '@opsidian/core';
import type { Direction, PaneState } from './panes';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export const iconButton =
  'no-drag text-muted-foreground hover:bg-accent hover:text-accent-foreground flex size-7 items-center justify-center rounded-md disabled:opacity-40 disabled:hover:bg-transparent';

/** The bar above a pane, or above the graph. `traffic` leaves room for the window's buttons. */
export function HeaderBar(props: { traffic: boolean; label: string; children: ReactNode }) {
  return (
    <header
      aria-label={props.label}
      className={cn(
        'drag flex h-11 shrink-0 items-center gap-0.5 pr-2.5',
        props.traffic ? 'pl-[84px]' : 'pl-2.5',
      )}
    >
      {props.children}
    </header>
  );
}

export function ShowSidebar({ onShow }: { onShow(): void }) {
  return (
    <button aria-label="Show sidebar" title="Show sidebar" className={iconButton} onClick={onShow}>
      <PanelLeft size={17} />
    </button>
  );
}

/** Where the note is: its folders, then its title, bright only in the pane in use. */
export function Crumbs({ path, active }: { path: string | null; active: boolean }) {
  return (
    <div
      aria-label="Where this note is"
      className="text-muted-foreground flex min-w-0 flex-1 justify-center truncate px-3 text-[13.5px]"
    >
      {path && (
        <span className="truncate">
          {noteFolder(path) &&
            noteFolder(path)
              .split('/')
              .map((part, position) => (
                <span key={position}>
                  {part}
                  <span className="text-faint px-1.5">/</span>
                </span>
              ))}
          <span className={active ? 'text-foreground' : 'text-muted-foreground'}>
            {noteTitle(path)}
          </span>
        </span>
      )}
    </div>
  );
}

interface Props {
  pane: PaneState;
  focused: boolean;
  /** The top-left pane, which sits beside the window's buttons when the sidebar is hidden. */
  first: boolean;
  sidebar: boolean;
  /** More than one pane is open, so this one can be closed. */
  closable: boolean;
  /** Version history is offered: the notebook syncs with a host. */
  history: boolean;
  /** A message for the pane in use, shown under its header. */
  notice: ReactNode;
  /** The note's editor, when one is open. */
  children: ReactNode;
  onFocus(): void;
  /** Puts the keyboard in this pane's editor; false when it has none. */
  onFocusEditor(): boolean;
  onFocusTitle(): void;
  onShowSidebar(): void;
  onStep(by: 1 | -1): void;
  onToggleGraph(): void;
  onToggleReading(): void;
  onSourceMode(): void;
  onShare(): void;
  onHistory(): void;
  /** Leaves reading view, so the title can be edited. */
  onRename(): void;
  onDuplicate(): void;
  onMove(): void;
  onReveal(): void;
  onTrash(): void;
  onSplit(direction: Direction): void;
  onClose(): void;
  onNewNote(): void;
  onFind(): void;
}

/** One note's place in the window: its header and its editor, or a way to open one. */
export function Pane(props: Props) {
  const { pane, focused } = props;
  const { open, trail, mode } = pane;
  const root = useRef<HTMLElement>(null);
  const renaming = useRef(false);
  const latest = useRef(props);
  latest.current = props;

  // Focus moved here from elsewhere (a split, a shortcut, a note already open here): the
  // keyboard follows, so typing goes where the window says it will.
  useEffect(() => {
    if (!focused || root.current?.contains(document.activeElement)) return;
    if (document.querySelector('[role="dialog"]')) return;
    if (!latest.current.onFocusEditor()) root.current?.focus();
  }, [focused]);

  return (
    <section
      ref={root}
      data-pane={pane.id}
      data-focused={focused}
      tabIndex={-1}
      className="flex h-full min-h-0 min-w-0 flex-col outline-none"
      onFocusCapture={props.onFocus}
      // Pointer, not mouse: menus take the press on pointer down and no mouse event follows.
      onPointerDownCapture={props.onFocus}
    >
      <HeaderBar label="Pane header" traffic={props.first && !props.sidebar}>
        {props.first && !props.sidebar && <ShowSidebar onShow={props.onShowSidebar} />}
        <button
          aria-label="Back"
          title="Back (⌥⌘←)"
          className={iconButton}
          disabled={trail.at <= 0}
          onClick={() => props.onStep(-1)}
        >
          <ArrowLeft size={17} />
        </button>
        <button
          aria-label="Forward"
          title="Forward (⌥⌘→)"
          className={iconButton}
          disabled={trail.at >= trail.paths.length - 1}
          onClick={() => props.onStep(1)}
        >
          <ArrowRight size={17} />
        </button>
        <Crumbs path={open?.path ?? null} active={focused} />
        <button
          aria-label="Open graph"
          title="Open local graph (⌘G)"
          className={iconButton}
          onClick={props.onToggleGraph}
        >
          <Waypoints size={17} />
        </button>
        {open && (
          <>
            <button
              aria-label={mode === 'reading' ? 'Edit' : 'Reading view'}
              title={mode === 'reading' ? 'Edit (⌘E)' : 'Reading view (⌘E)'}
              className={iconButton}
              onClick={props.onToggleReading}
            >
              {mode === 'reading' ? <Pencil size={17} /> : <BookOpen size={17} />}
            </button>
            <button
              aria-label="Share as a link"
              title="Share as a link"
              className={iconButton}
              onClick={props.onShare}
            >
              <Share2 size={17} />
            </button>
          </>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button aria-label="More options" title="More options" className={iconButton}>
              <Ellipsis size={17} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-56"
            onCloseAutoFocus={(event) => {
              // Rename hands focus to the title instead of back to the button.
              if (!renaming.current) return;
              renaming.current = false;
              event.preventDefault();
              props.onFocusTitle();
            }}
          >
            {open && (
              <>
                <DropdownMenuItem onSelect={props.onSourceMode}>
                  <Code /> <span className="flex-1">Source mode</span>
                  {mode === 'source' && <Check className="text-primary" />}
                </DropdownMenuItem>
                {props.history && (
                  <DropdownMenuItem onSelect={props.onHistory}>
                    <History /> Version history
                  </DropdownMenuItem>
                )}
              </>
            )}
            <DropdownMenuItem onSelect={() => props.onSplit('row')}>
              <Columns2 /> Split right
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => props.onSplit('column')}>
              <Rows2 /> Split down
            </DropdownMenuItem>
            {open && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => {
                    props.onRename();
                    renaming.current = true;
                  }}
                >
                  <Pencil /> Rename
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={props.onDuplicate}>
                  <Copy /> Duplicate
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={props.onMove}>
                  <FolderInput /> Move to…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={props.onReveal}>
                  <FolderSearch /> Show in Finder
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={props.onTrash}>
                  <Trash2 /> Move to trash
                </DropdownMenuItem>
              </>
            )}
            {props.closable && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={props.onClose}>
                  <X /> Close pane
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {props.closable && (
          <button
            aria-label="Close pane"
            title="Close pane"
            className={iconButton}
            onClick={props.onClose}
          >
            <X size={17} />
          </button>
        )}
      </HeaderBar>
      {props.notice}
      {open ? (
        props.children
      ) : (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-5">
          <p className="text-foreground text-lg">No note is open</p>
          <div className="flex gap-6 text-sm">
            <button className="text-link" onClick={props.onNewNote}>
              New note <kbd className="text-muted-foreground pl-1 font-sans text-xs">⌘ N</kbd>
            </button>
            <button className="text-link" onClick={props.onFind}>
              Find a note <kbd className="text-muted-foreground pl-1 font-sans text-xs">⌘ K</kbd>
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
