import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  Code,
  Ellipsis,
  FolderInput,
  FolderSearch,
  History,
  PanelLeft,
  Pencil,
  Share2,
  Trash2,
  X,
} from 'lucide-react';
import type { EditorMode } from '@opsidian/editor';
import {
  linkResolver,
  noteFolder,
  noteTitle,
  type MoveResult,
  type SyncInfo,
  type VaultInfo,
  type VaultTree,
} from '@opsidian/core';
import { bridge, message } from './bridge';
import type { useTheme } from './theme';
import { NoteEditor, type NoteEditorHandle } from './NoteEditor';
import { FolderPicker } from './FolderPicker';
import { QuickSwitcher } from './QuickSwitcher';
import { TrashDialog } from './TrashDialog';
import { SyncDialog } from './SyncDialog';
import { Settings, type SettingsSection } from './Settings';
import { HistoryDialog } from './HistoryDialog';
import { Sidebar, type TreeSort } from './Sidebar';
import { StatusBar, type NoteStatus } from './StatusBar';
import { GraphView } from './graph/GraphView';
import { defaultMode } from './preferences';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

interface Props {
  vault: VaultInfo;
  theme: ReturnType<typeof useTheme>;
  /** Shows the welcome screen, to open another notebook or, with `github`, import one. */
  onSwitch(mode?: 'github'): void;
}

export function Workspace({ vault, theme, onSwitch }: Props) {
  const storageKey = `opsidian-session:${vault.location}`;
  const [tree, setTree] = useState<VaultTree>();
  // `visit` counts openings, so the editor remounts on a new note but not on a rename.
  const [open, setOpen] = useState<{ path: string; visit: number; heading?: string } | null>(null);
  const [trail, setTrail] = useState<{ paths: string[]; at: number }>({ paths: [], at: -1 });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [sidebar, setSidebar] = useState(true);
  const [finding, setFinding] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [sync, setSync] = useState<SyncInfo>({ connected: false });
  const [syncOpen, setSyncOpen] = useState(false);
  const [settings, setSettings] = useState<SettingsSection>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [mode, setMode] = useState<EditorMode>(defaultMode);
  // What editing mode to go back to when leaving reading view.
  const editing = useRef<EditorMode>(defaultMode() === 'reading' ? 'live' : defaultMode());
  const [sort, setSort] = useState<TreeSort>(() =>
    localStorage.getItem('opsidian.tree.sort') === 'name-desc' ? 'name-desc' : 'name',
  );
  const [graphOpen, setGraphOpen] = useState(false);
  const [graphMounted, setGraphMounted] = useState(false);
  const [noteStatus, setNoteStatus] = useState<NoteStatus>();
  const renaming = useRef(false);
  const [notice, setNotice] = useState('');
  const [version, setVersion] = useState(0);
  const editor = useRef<NoteEditorHandle>(null);
  const state = useRef({ open, trail, tree });
  state.current = { open, trail, tree };

  const refresh = useCallback(async () => {
    const next = await bridge.tree();
    setTree(next);
    setVersion((count) => count + 1);
    return next;
  }, []);
  const fail = (reason: unknown) => setNotice(message(reason));

  /** Shows a note once the current one is safely saved. `record` adds it to back/forward. */
  const show = useCallback(async (path: string, record = true, heading?: string) => {
    const current = state.current;
    if (current.open?.path === path) return;
    await editor.current?.flush();
    setOpen({ path, visit: (current.open?.visit ?? 0) + 1, ...(heading ? { heading } : {}) });
    if (record) {
      const paths = [...current.trail.paths.slice(0, current.trail.at + 1), path];
      setTrail({ paths, at: paths.length - 1 });
    }
    const folder = noteFolder(path);
    if (folder)
      setExpanded((before) => {
        const next = new Set(before);
        const parts = folder.split('/');
        parts.forEach((_part, depth) => next.add(parts.slice(0, depth + 1).join('/')));
        return next;
      });
  }, []);
  const step = (by: number) => {
    const at = trail.at + by;
    const path = trail.paths[at];
    if (!path) return;
    void show(path, false)
      .then(() => setTrail({ paths: trail.paths, at }))
      .catch(fail);
  };
  const create = useCallback(
    async (folder: string, name?: string) => {
      try {
        const path = await bridge.createNote(folder, name);
        await refresh();
        await show(path);
      } catch (reason) {
        fail(reason);
      }
    },
    [refresh, show],
  );
  const resolve = useMemo(() => linkResolver(tree?.notes ?? []), [tree]);
  const locateImage = useMemo(() => {
    const images = tree?.images ?? [];
    const exact = new Set(images);
    const named = new Map<string, string>();
    const depth = (path: string) => path.split('/').length;
    for (const path of [...images].sort((a, b) => depth(a) - depth(b))) {
      const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
      if (!named.has(name)) named.set(name, path);
    }
    return (path: string) =>
      exact.has(path)
        ? path
        : (named.get(path.slice(path.lastIndexOf('/') + 1).toLowerCase()) ?? path);
  }, [tree]);
  const follow = (target: string, heading?: string) => {
    const path = target ? resolve(target) : open?.path;
    // Like Obsidian, following a link to a note that does not exist creates it.
    if (!path) void create('', target.slice(target.lastIndexOf('/') + 1));
    else if (path !== open?.path) void show(path, true, heading).catch(fail);
    else if (heading) editor.current?.scrollToHeading(heading);
  };

  useEffect(() => {
    void refresh()
      .then((loaded) => {
        const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as {
          last?: string;
          expanded?: string[];
        };
        setExpanded(new Set(saved.expanded ?? []));
        const first =
          saved.last && loaded.notes.includes(saved.last) ? saved.last : loaded.notes[0];
        if (first) return show(first);
      })
      .catch(fail);
    return bridge.onChange((paths) => {
      void refresh()
        .then((next) => {
          const current = state.current.open?.path;
          if (!current) return;
          if (paths.includes(current)) return editor.current?.reloadIfClean();
          // Removed or renamed elsewhere. Unsaved edits keep the note open and put it back.
          if (!next.notes.includes(current) && editor.current?.settled()) setOpen(null);
        })
        .catch(fail);
    });
  }, [refresh, show, storageKey]);
  useEffect(() => {
    if (!tree) return;
    localStorage.setItem(storageKey, JSON.stringify({ last: open?.path, expanded: [...expanded] }));
  }, [open?.path, expanded, storageKey, tree]);
  useEffect(() => {
    void bridge.syncInfo().then(setSync).catch(fail);
    return bridge.onSync(setSync);
  }, []);
  useEffect(
    () =>
      window.opsidian?.onCloseRequest(() => {
        void (editor.current?.flush() ?? Promise.resolve())
          .then(() => window.opsidian?.closeReady())
          .catch((reason) => window.opsidian?.closeFailed(message(reason)));
      }),
    [],
  );
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      const key = event.key.toLowerCase();
      if (event.altKey && (key === 'arrowleft' || key === 'arrowright')) {
        event.preventDefault();
        step(key === 'arrowleft' ? -1 : 1);
      } else if (event.altKey || event.shiftKey) return;
      else if (key === 'n') {
        event.preventDefault();
        void create('');
      } else if (key === 'k' || key === 'o' || key === 'p') {
        event.preventDefault();
        setFinding(true);
      } else if (key === ',') {
        event.preventDefault();
        setSettings((open) => open ?? 'general');
      } else if (key === 'g') {
        event.preventDefault();
        toggleGraph();
      } else if (key === 'e' && open) {
        event.preventDefault();
        toggleReading();
      }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  });

  async function trash(path: string) {
    const gone = (other: string) => other === path || other.startsWith(`${path}/`);
    const affected = Boolean(open && gone(open.path));
    try {
      await editor.current?.flush();
      // An edit made while the note is on its way to the trash must not bring it back.
      const resume = affected ? editor.current?.suspend() : undefined;
      try {
        await bridge.trash(path);
        resume?.(null);
      } catch (reason) {
        resume?.(open!.path);
        throw reason;
      }
      setTrail((before) => {
        const paths = before.paths.filter((other) => !gone(other));
        const current = before.paths[before.at];
        const at = current && !gone(current) ? paths.indexOf(current) : paths.length - 1;
        return { paths, at };
      });
      if (affected) setOpen(null);
      const name = /\.md$/i.test(path) ? noteTitle(path) : path.slice(path.lastIndexOf('/') + 1);
      setNotice(`“${name}” was moved to the trash. Restore it from Trash in the sidebar.`);
      await refresh();
    } catch (reason) {
      fail(reason);
    }
  }
  /** Renames or moves a note or folder, then follows it wherever it is open or remembered. */
  async function relocate(path: string, action: () => Promise<MoveResult>): Promise<boolean> {
    const before = state.current.open?.path;
    try {
      await editor.current?.flush();
      // Typing goes on during the move; saving waits, then goes to wherever the note now is.
      const resume = editor.current?.suspend();
      let result: MoveResult;
      try {
        result = await action();
      } catch (reason) {
        resume?.(before!);
        throw reason;
      }
      const shift = (other: string) =>
        other === path
          ? result.path
          : other.startsWith(`${path}/`)
            ? result.path + other.slice(path.length)
            : other;
      const current = before && shift(before);
      // Links inside the open note may have been rewritten on disk. Take that text before
      // saving resumes, so the next save starts from it.
      if (current && result.rewritten.includes(current))
        await editor.current?.reloadIfClean(current).catch(fail);
      resume?.(current!);
      setOpen((open) => (open ? { ...open, path: shift(open.path) } : open));
      setTrail((trail) => ({ ...trail, paths: trail.paths.map(shift) }));
      setExpanded((folders) => new Set([...folders].map(shift)));
      await refresh();
      if (result.missed.length)
        setNotice(
          `Done, but links in ${result.missed.length === 1 ? 'one note' : `${result.missed.length} notes`} could not be updated: ${result.missed.map(noteTitle).join(', ')}.`,
        );
      return true;
    } catch (reason) {
      // The notebook may have changed even though the move reported a failure.
      void refresh().catch(() => {});
      fail(reason);
      return false;
    }
  }

  function toggleReading() {
    if (mode === 'reading') return setMode(editing.current);
    editing.current = mode;
    setMode('reading');
  }
  function toggleGraph() {
    if (graphOpen) return setGraphOpen(false);
    void (editor.current?.flush() ?? Promise.resolve()).finally(() => {
      setGraphMounted(true);
      setGraphOpen(true);
    });
  }
  const icon =
    'no-drag text-muted-foreground hover:bg-accent hover:text-accent-foreground flex size-7 items-center justify-center rounded-md disabled:opacity-40 disabled:hover:bg-transparent';

  if (!tree) return null;
  return (
    <div className="flex h-full">
      {sidebar && (
        <Sidebar
          vault={vault}
          tree={tree}
          active={open?.path ?? null}
          expanded={expanded}
          onToggle={(folder) =>
            setExpanded((before) => {
              const next = new Set(before);
              if (!next.delete(folder)) next.add(folder);
              return next;
            })
          }
          onOpen={(path) => void show(path).catch(fail)}
          onNewNote={(folder) => void create(folder)}
          onNewFolder={(parent, name) =>
            void bridge
              .createFolder(parent, name)
              .then(() => refresh())
              .catch(fail)
          }
          onRename={(path, name) => void relocate(path, () => bridge.rename(path, name))}
          onMove={(path, folder) => void relocate(path, () => bridge.move(path, folder))}
          onChooseFolder={setMoving}
          onTrash={(path) => void trash(path)}
          onReveal={(path) => void bridge.reveal(path).catch(fail)}
          onShowTrash={() => setTrashOpen(true)}
          onSwitch={() => onSwitch()}
          sort={sort}
          onSort={(next) => {
            setSort(next);
            localStorage.setItem('opsidian.tree.sort', next);
          }}
          onCollapseAll={() => setExpanded(new Set())}
          onHide={() => setSidebar(false)}
          onHelp={() => void bridge.openHelp().catch(fail)}
          onSettings={() => setSettings('general')}
        />
      )}
      <main className="relative flex min-w-0 flex-1 flex-col">
        <header
          className={cn(
            'drag flex h-11 shrink-0 items-center gap-0.5 pr-2.5',
            sidebar ? 'pl-2.5' : 'pl-[84px]',
          )}
        >
          {!sidebar && (
            <button
              aria-label="Show sidebar"
              title="Show sidebar"
              className={icon}
              onClick={() => setSidebar(true)}
            >
              <PanelLeft size={17} />
            </button>
          )}
          <button
            aria-label="Back"
            title="Back (⌥⌘←)"
            className={icon}
            disabled={trail.at <= 0}
            onClick={() => step(-1)}
          >
            <ArrowLeft size={17} />
          </button>
          <button
            aria-label="Forward"
            title="Forward (⌥⌘→)"
            className={icon}
            disabled={trail.at >= trail.paths.length - 1}
            onClick={() => step(1)}
          >
            <ArrowRight size={17} />
          </button>
          <div
            aria-label="Where this note is"
            className="text-muted-foreground flex min-w-0 flex-1 justify-center truncate px-3 text-[13.5px]"
          >
            {open && (
              <span className="truncate">
                {noteFolder(open.path) &&
                  noteFolder(open.path)
                    .split('/')
                    .map((part, position) => (
                      <span key={position}>
                        {part}
                        <span className="text-faint px-1.5">/</span>
                      </span>
                    ))}
                <span className="text-foreground">{noteTitle(open.path)}</span>
              </span>
            )}
          </div>
          <button
            aria-label={graphOpen ? 'Close graph' : 'Open graph'}
            title={graphOpen ? 'Close graph (⌘G)' : 'Open local graph (⌘G)'}
            className={cn(icon, graphOpen && 'text-foreground')}
            onClick={toggleGraph}
          >
            <Share2 size={17} />
          </button>
          {open && !graphOpen && (
            <>
              <button
                aria-label={mode === 'reading' ? 'Edit' : 'Reading view'}
                title={mode === 'reading' ? 'Edit (⌘E)' : 'Reading view (⌘E)'}
                className={icon}
                onClick={toggleReading}
              >
                {mode === 'reading' ? <Pencil size={17} /> : <BookOpen size={17} />}
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button aria-label="More options" title="More options" className={icon}>
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
                    editor.current?.focusTitle();
                  }}
                >
                  <DropdownMenuItem
                    onSelect={() => {
                      const next = mode === 'source' ? 'live' : 'source';
                      editing.current = next;
                      setMode(next);
                    }}
                  >
                    <Code /> <span className="flex-1">Source mode</span>
                    {mode === 'source' && <Check className="text-primary" />}
                  </DropdownMenuItem>
                  {sync.connected && (
                    <DropdownMenuItem onSelect={() => setHistoryOpen(true)}>
                      <History /> Version history
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => {
                      if (mode === 'reading') setMode(editing.current);
                      renaming.current = true;
                    }}
                  >
                    <Pencil /> Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setMoving(open.path)}>
                    <FolderInput /> Move to…
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void bridge.reveal(open.path).catch(fail)}>
                    <FolderSearch /> Show in Finder
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => void trash(open.path)}>
                    <Trash2 /> Move to trash
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </header>
        {notice && (
          <div role="alert" className="bg-secondary flex items-center gap-4 px-8 py-3 text-[13px]">
            <span className="flex-1 leading-5">{notice}</span>
            <button aria-label="Dismiss" className={icon} onClick={() => setNotice('')}>
              <X size={16} />
            </button>
          </div>
        )}
        {graphMounted && (
          <div className={graphOpen ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'hidden'}>
            <GraphView
              center={open?.path ?? null}
              version={version}
              dark={theme.dark}
              onOpen={(path) => void show(path).catch(fail)}
              onCreate={(name) => void create('', name)}
            />
          </div>
        )}
        {graphOpen ? null : open ? (
          <NoteEditor
            key={open.visit}
            ref={editor}
            path={open.path}
            notes={tree.notes}
            heading={open.heading}
            resolve={resolve}
            locateImage={locateImage}
            mode={mode}
            version={version}
            onOpenLink={follow}
            onOpen={(path) => void show(path).catch(fail)}
            onRename={(name) => relocate(open.path, () => bridge.rename(open.path, name))}
            onChanged={() => void refresh().catch(fail)}
            onNotice={setNotice}
            onStatus={setNoteStatus}
          />
        ) : (
          <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-5">
            <p className="text-foreground text-lg">No note is open</p>
            <div className="flex gap-6 text-sm">
              <button className="text-link" onClick={() => void create('')}>
                New note <kbd className="text-muted-foreground pl-1 font-sans text-xs">⌘ N</kbd>
              </button>
              <button className="text-link" onClick={() => setFinding(true)}>
                Find a note <kbd className="text-muted-foreground pl-1 font-sans text-xs">⌘ K</kbd>
              </button>
            </div>
          </div>
        )}
        <StatusBar
          note={open ? noteStatus : undefined}
          sync={sync}
          onRetrySave={() => void editor.current?.flush().catch(() => {})}
          onSyncSettings={() => setSettings('sync')}
        />
      </main>
      {finding && (
        <QuickSwitcher
          notes={tree.notes}
          recent={[...trail.paths].reverse()}
          onOpen={(path) => {
            setFinding(false);
            void show(path).catch(fail);
          }}
          onCreate={(name) => {
            setFinding(false);
            void create('', name);
          }}
          onClose={() => setFinding(false)}
        />
      )}
      {moving && (
        <FolderPicker
          path={moving}
          folders={tree.folders}
          onChoose={(folder) => {
            setMoving(null);
            void relocate(moving, () => bridge.move(moving, folder));
          }}
          onClose={() => setMoving(null)}
        />
      )}
      {settings && (
        <Settings
          section={settings}
          notebook={vault.name}
          sync={sync}
          theme={theme}
          onSection={setSettings}
          onConnect={() => {
            setSettings(undefined);
            setSyncOpen(true);
          }}
          onImport={() => {
            setSettings(undefined);
            onSwitch('github');
          }}
          onClose={() => setSettings(undefined)}
        />
      )}
      {syncOpen && <SyncDialog info={sync} onClose={() => setSyncOpen(false)} />}
      {historyOpen && open && (
        <HistoryDialog
          path={open.path}
          onRestore={(content) => {
            setHistoryOpen(false);
            editor.current?.restore(content);
          }}
          onClose={() => setHistoryOpen(false)}
        />
      )}
      {trashOpen && (
        <TrashDialog
          onRestored={(path) =>
            void refresh()
              .then(() => {
                if (/\.md$/i.test(path)) return show(path);
              })
              .catch(fail)
          }
          onClose={() => setTrashOpen(false)}
        />
      )}
    </div>
  );
}
