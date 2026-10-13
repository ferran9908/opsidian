import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  FolderSearch,
  Monitor,
  Moon,
  PanelLeft,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import type { EditorMode } from '@opsidian/editor';
import { noteFolder, noteTitle, resolveLink, type VaultInfo, type VaultTree } from '@opsidian/core';
import { bridge, message } from './bridge';
import type { useTheme } from './theme';
import { NoteEditor, type NoteEditorHandle } from './NoteEditor';
import { QuickSwitcher } from './QuickSwitcher';
import { Sidebar } from './Sidebar';
import { cn } from '@/lib/utils';

interface Props {
  vault: VaultInfo;
  theme: ReturnType<typeof useTheme>;
  onSwitch(): void;
}
const icon =
  'no-drag text-muted-foreground hover:bg-accent hover:text-accent-foreground flex size-8 items-center justify-center rounded-md disabled:opacity-40 disabled:hover:bg-transparent';

export function Workspace({ vault, theme, onSwitch }: Props) {
  const storageKey = `opsidian-session:${vault.location}`;
  const [tree, setTree] = useState<VaultTree>();
  // `visit` counts openings, so the editor remounts on a new note but not on a rename.
  const [open, setOpen] = useState<{ path: string; visit: number } | null>(null);
  const [trail, setTrail] = useState<{ paths: string[]; at: number }>({ paths: [], at: -1 });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [sidebar, setSidebar] = useState(true);
  const [finding, setFinding] = useState(false);
  const [mode, setMode] = useState<EditorMode>('live');
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
  const show = useCallback(async (path: string, record = true) => {
    const current = state.current;
    if (current.open?.path === path) return;
    await editor.current?.flush();
    setOpen({ path, visit: (current.open?.visit ?? 0) + 1 });
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
  const follow = (target: string) => {
    const path = resolveLink(target, tree?.notes ?? []);
    if (path) void show(path).catch(fail);
    // Like Obsidian, following a link to a note that does not exist creates it.
    else void create('', target.slice(target.lastIndexOf('/') + 1));
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
      }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  });

  async function trash() {
    if (!open) return;
    try {
      await editor.current?.flush();
      await bridge.trash(open.path);
      const paths = trail.paths.filter((path) => path !== open.path);
      setTrail({ paths, at: paths.length - 1 });
      setOpen(null);
      setNotice(`“${noteTitle(open.path)}” was moved to the notebook's .trash folder.`);
      await refresh();
    } catch (reason) {
      fail(reason);
    }
  }
  function renamed(from: string, to: string) {
    setOpen((current) => (current?.path === from ? { ...current, path: to } : current));
    setTrail((current) => ({
      ...current,
      paths: current.paths.map((path) => (path === from ? to : path)),
    }));
    void refresh().catch(fail);
  }

  if (!tree) return null;
  const ThemeIcon = theme.preference === 'system' ? Monitor : theme.dark ? Moon : Sun;
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
          onNewFolder={(name) =>
            void bridge
              .createFolder('', name)
              .then(() => refresh())
              .catch(fail)
          }
          onFind={() => setFinding(true)}
          onSwitch={onSwitch}
        />
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        <header
          className={cn(
            'drag border-border flex h-12 shrink-0 items-center gap-1 border-b pr-4',
            sidebar ? 'pl-3' : 'pl-[84px]',
          )}
        >
          <button
            aria-label="Toggle sidebar"
            title="Toggle sidebar"
            className={icon}
            onClick={() => setSidebar(!sidebar)}
          >
            <PanelLeft size={17} />
          </button>
          <button
            aria-label="Back"
            title="Back"
            className={icon}
            disabled={trail.at <= 0}
            onClick={() => step(-1)}
          >
            <ArrowLeft size={17} />
          </button>
          <button
            aria-label="Forward"
            title="Forward"
            className={icon}
            disabled={trail.at >= trail.paths.length - 1}
            onClick={() => step(1)}
          >
            <ArrowRight size={17} />
          </button>
          <div className="text-muted-foreground min-w-0 flex-1 truncate px-3 text-[13px]">
            {open &&
              [...(noteFolder(open.path) ? noteFolder(open.path).split('/') : [vault.name])].map(
                (part, position) => (
                  <span key={position}>
                    {part}
                    <span className="text-faint px-2">/</span>
                  </span>
                ),
              )}
            {open && <span className="text-foreground">{noteTitle(open.path)}</span>}
          </div>
          {open && (
            <>
              <div
                className="no-drag border-border flex shrink-0 rounded-md border p-0.5"
                aria-label="Editing mode"
              >
                {(['live', 'source'] as const).map((value) => (
                  <button
                    key={value}
                    aria-pressed={mode === value}
                    className={cn(
                      'text-muted-foreground rounded px-2.5 py-1 text-xs',
                      mode === value && 'bg-accent text-accent-foreground',
                    )}
                    onClick={() => setMode(value)}
                  >
                    {value === 'live' ? 'Live Preview' : 'Source'}
                  </button>
                ))}
              </div>
              <button
                aria-label="Show in Finder"
                title="Show in Finder"
                className={icon}
                onClick={() => void bridge.reveal(open.path).catch(fail)}
              >
                <FolderSearch size={17} />
              </button>
              <button
                aria-label="Move note to trash"
                title="Move note to trash"
                className={icon}
                onClick={() => void trash()}
              >
                <Trash2 size={17} />
              </button>
            </>
          )}
          <button
            aria-label={`Theme: ${theme.preference}`}
            title={`Theme: ${theme.preference}. Click to cycle.`}
            className={icon}
            onClick={theme.cycle}
          >
            <ThemeIcon size={17} />
          </button>
        </header>
        {notice && (
          <div role="alert" className="bg-secondary flex items-center gap-4 px-8 py-3 text-[13px]">
            <span className="flex-1 leading-5">{notice}</span>
            <button aria-label="Dismiss" className={icon} onClick={() => setNotice('')}>
              <X size={16} />
            </button>
          </div>
        )}
        {open ? (
          <NoteEditor
            key={open.visit}
            ref={editor}
            path={open.path}
            notes={tree.notes}
            mode={mode}
            version={version}
            onOpenLink={follow}
            onOpen={(path) => void show(path).catch(fail)}
            onRenamed={renamed}
            onNotice={setNotice}
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
    </div>
  );
}
