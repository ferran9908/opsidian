import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CircleHelp,
  Code,
  Columns2,
  Copy,
  FilePlus2,
  FolderInput,
  FolderOpen,
  FolderSearch,
  History,
  Link,
  PanelLeft,
  Pencil,
  RefreshCw,
  Replace,
  Rows2,
  Search,
  Settings as SettingsIcon,
  TextSearch,
  Trash2,
  Waypoints,
  X,
} from 'lucide-react';
import {
  linkResolver,
  noteFolder,
  noteTitle,
  type MissingNotebook,
  type MoveResult,
  type SyncInfo,
  type TagCount,
  type VaultInfo,
  type VaultTree,
} from '@opsidian/core';
import { bridge, message } from './bridge';
import type { useTheme } from './theme';
import { NoteEditor, type NoteEditorHandle } from './NoteEditor';
import { FolderPicker } from './FolderPicker';
import { QuickSwitcher } from './QuickSwitcher';
import { CommandPalette, type PaletteCommand } from './CommandPalette';
import { copyOutcome } from './GitHub';
import { TrashDialog } from './TrashDialog';
import { SyncDialog } from './SyncDialog';
import { Settings, SETTINGS_SECTIONS, type SettingsSection } from './Settings';
import { HistoryDialog } from './HistoryDialog';
import { ShareDialog } from './ShareDialog';
import { copyText } from './clipboard';
import { Sidebar, type TreeSort } from './Sidebar';
import { StatusBar, type NoteStatus } from './StatusBar';
import { MissingNotice } from './MissingNotice';
import { GraphView } from './graph/GraphView';
import { defaultMode } from './preferences';
import { Crumbs, HeaderBar, iconButton, Pane, ShowSidebar } from './Pane';
import { SplitView } from './SplitView';
import {
  closePane,
  emptyPane,
  findPane,
  mapPanes,
  neighbour,
  panes,
  resize,
  restoreLayout,
  saveLayout,
  splitPane,
  updatePane,
  type Direction,
  type Layout,
  type PaneState,
} from './panes';
import { cn } from '@/lib/utils';

/** Every folder a note sits in, outermost first. */
const folders = (path: string) => {
  const parts = noteFolder(path).split('/').filter(Boolean);
  return parts.map((_part, depth) => parts.slice(0, depth + 1).join('/'));
};
const SHARE_NEEDS_HOST =
  'Sharing a note as a link needs a sync host. Set one up in Settings → Sync.';

interface Props {
  vault: VaultInfo;
  theme: ReturnType<typeof useTheme>;
  /** Shows the welcome screen, to open another notebook or, with `github`, import one. */
  onSwitch(mode?: 'github'): void;
  /** Another notebook, or this one downloaded again, was opened from the missing notice. */
  onOpened(vault: VaultInfo): void;
  /**
   * This notebook, whose folder is gone, was closed: still `missing`, so the welcome screen
   * offers it, or given up (null), with a `warning` worth showing.
   */
  onClose(missing: MissingNotebook | null, warning?: string): void;
}

export function Workspace({ vault, theme, onSwitch, onOpened, onClose }: Props) {
  const storageKey = `opsidian-session:${vault.location}`;
  const [tree, setTree] = useState<VaultTree>();
  const [tags, setTags] = useState<TagCount[]>([]);
  const [first] = useState(() => emptyPane(defaultMode()));
  // The notes on screen, side by side or one above the other, and the pane in use.
  const [layout, setLayout] = useState<Layout>(first);
  const [focused, setFocused] = useState(first.id);
  const [statuses, setStatuses] = useState<Record<string, NoteStatus>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [sidebar, setSidebar] = useState(true);
  // The find dialog's starting text, or null while it is closed.
  const [finding, setFinding] = useState<string | null>(null);
  const [commanding, setCommanding] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [sync, setSync] = useState<SyncInfo>({ connected: false });
  const [syncOpen, setSyncOpen] = useState(false);
  const [settings, setSettings] = useState<SettingsSection>();
  /** The pane and note whose history is open. */
  const [history, setHistory] = useState<{ pane: string; path: string } | null>(null);
  /** The note being shared as a link, while the dialog is open. */
  const [sharing, setSharing] = useState<string | null>(null);
  const [sort, setSort] = useState<TreeSort>(() =>
    localStorage.getItem('opsidian.tree.sort') === 'name-desc' ? 'name-desc' : 'name',
  );
  const [graphOpen, setGraphOpen] = useState(false);
  const [graphMounted, setGraphMounted] = useState(false);
  const [notice, setNotice] = useState('');
  const [version, setVersion] = useState(0);
  // Set while the notebook's folder is not where it was.
  const [gone, setGone] = useState<MissingNotebook | null>(null);
  // Each pane's editor, by pane id, while it has a note open.
  const editors = useRef(new Map<string, NoteEditorHandle>());
  const editorRefs = useRef(new Map<string, (handle: NoteEditorHandle | null) => void>());
  // The session is only written once it has been read, so a blank start cannot replace it.
  const restored = useRef(false);
  const state = useRef({ layout, focused, tree });
  state.current = { layout, focused, tree };

  const all = panes(layout);
  const focusedPane = findPane(layout, focused) ?? all[0]!;
  const open = focusedPane.open;
  const mode = focusedPane.mode;

  /** A stable ref callback per pane, so React does not detach and attach it every render. */
  const editorRef = (id: string) => {
    let callback = editorRefs.current.get(id);
    if (!callback) {
      callback = (handle) => {
        if (handle) editors.current.set(id, handle);
        else editors.current.delete(id);
      };
      editorRefs.current.set(id, callback);
    }
    return callback;
  };
  const focusedEditor = () => editors.current.get(state.current.focused);
  const allEditors = () => [...editors.current.values()];
  /** Saves every pane. Waits for all of them, then fails with the first failure, if any. */
  const flushAll = useCallback(async () => {
    const results = await Promise.allSettled(allEditors().map((editor) => editor.flush()));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
  }, []);

  const refresh = useCallback(async () => {
    const [next, tagged] = await Promise.all([bridge.tree(), bridge.tags()]);
    setTree(next);
    setTags(tagged);
    setVersion((count) => count + 1);
    return next;
  }, []);
  const fail = (reason: unknown) => setNotice(message(reason));
  const expandTo = useCallback((path: string) => {
    if (!noteFolder(path)) return;
    setExpanded((before) => new Set([...before, ...folders(path)]));
  }, []);

  /**
   * Shows a note in pane `id` once that pane's note is safely saved. `at` moves along the
   * pane's back/forward trail instead of adding to it. A note already open in another pane is
   * not opened twice, since each editor saves on its own: that pane is focused instead.
   */
  const showIn = useCallback(
    async (id: string, path: string, options: { heading?: string; at?: number } = {}) => {
      const { layout } = state.current;
      const elsewhere = panes(layout).find((pane) => pane.open?.path === path);
      if (elsewhere) {
        setFocused(elsewhere.id);
        if (options.heading) editors.current.get(elsewhere.id)?.scrollToHeading(options.heading);
        return;
      }
      if (!findPane(layout, id)) return;
      await editors.current.get(id)?.flush();
      const { heading, at } = options;
      setLayout((before) =>
        updatePane(before, id, (pane) => {
          const paths = [...pane.trail.paths.slice(0, pane.trail.at + 1), path];
          return {
            ...pane,
            open: { path, visit: (pane.open?.visit ?? 0) + 1, ...(heading ? { heading } : {}) },
            trail: at === undefined ? { paths, at: paths.length - 1 } : { ...pane.trail, at },
          };
        }),
      );
      setFocused(id);
      expandTo(path);
    },
    [expandTo],
  );
  /** Shows a note in the pane in use. */
  const show = useCallback(
    (path: string, heading?: string) =>
      showIn(state.current.focused, path, heading ? { heading } : {}),
    [showIn],
  );
  const step = (id: string, by: number) => {
    const pane = findPane(layout, id);
    if (!pane) return;
    const at = pane.trail.at + by;
    const path = pane.trail.paths[at];
    if (!path) return;
    void showIn(id, path, { at }).catch(fail);
  };
  const create = useCallback(
    async (folder: string, name?: string, into?: string) => {
      try {
        const path = await bridge.createNote(folder, name);
        await refresh();
        await showIn(into ?? state.current.focused, path);
      } catch (reason) {
        fail(reason);
      }
    },
    [refresh, showIn],
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
  /** A link was followed in pane `id`: the note opens in that pane. */
  const follow = (id: string, target: string, heading?: string) => {
    const here = findPane(layout, id)?.open?.path;
    const path = target ? resolve(target) : here;
    // Like Obsidian, following a link to a note that does not exist creates it.
    if (!path) void create('', target.slice(target.lastIndexOf('/') + 1), id);
    else if (path !== here) void showIn(id, path, heading ? { heading } : {}).catch(fail);
    else if (heading) editors.current.get(id)?.scrollToHeading(heading);
  };

  /** Opens a new pane beside `from`, empty or showing `path`, and moves to it. */
  function split(direction: Direction, path?: string, from = state.current.focused) {
    const current = state.current;
    if (path) {
      const elsewhere = panes(current.layout).find((pane) => pane.open?.path === path);
      if (elsewhere) return setFocused(elsewhere.id);
    }
    const blank = emptyPane(defaultMode());
    const added: PaneState = path
      ? { ...blank, open: { path, visit: 1 }, trail: { paths: [path], at: 0 } }
      : blank;
    setLayout(splitPane(current.layout, from, direction, added));
    setFocused(added.id);
    if (path) expandTo(path);
  }
  /** Closes a pane once its note is saved; the pane before it, or after, is used next. */
  async function closeOne(id: string) {
    try {
      await editors.current.get(id)?.flush();
    } catch (reason) {
      return fail(reason);
    }
    const before = panes(state.current.layout);
    if (before.length < 2) return;
    const at = before.findIndex((pane) => pane.id === id);
    setLayout((layout) => closePane(layout, id));
    if (state.current.focused === id) setFocused((before[at - 1] ?? before[at + 1])!.id);
    setStatuses(({ [id]: _closed, ...rest }) => rest);
    editorRefs.current.delete(id);
  }
  const focusNext = (by: 1 | -1) => setFocused(neighbour(layout, focusedPane.id, by));

  useEffect(() => {
    void refresh()
      .then((loaded) => {
        let saved: { expanded?: unknown } = {};
        try {
          saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as typeof saved;
        } catch {
          // A session that cannot be read starts over.
        }
        const session = restoreLayout(saved, loaded.notes, defaultMode());
        const kept = Array.isArray(saved.expanded)
          ? saved.expanded.filter((folder): folder is string => typeof folder === 'string')
          : [];
        const shown = panes(session.layout).flatMap((pane) =>
          pane.open ? folders(pane.open.path) : [],
        );
        restored.current = true;
        setExpanded(new Set([...kept, ...shown]));
        setLayout(session.layout);
        setFocused(session.focused);
      })
      .catch(fail);
    return bridge.onChange((paths) => {
      void refresh()
        .then((next) => {
          const notes = new Set(next.notes);
          const cleared = new Set<string>();
          const reloads: Promise<void>[] = [];
          for (const pane of panes(state.current.layout)) {
            if (!pane.open) continue;
            const editor = editors.current.get(pane.id);
            if (paths.includes(pane.open.path)) {
              if (editor) reloads.push(editor.reloadIfClean());
            }
            // Removed or renamed elsewhere. Unsaved edits keep the note open and put it back.
            else if (!notes.has(pane.open.path) && (editor?.settled() ?? true))
              cleared.add(pane.id);
          }
          if (cleared.size)
            setLayout((layout) =>
              mapPanes(layout, (pane) => (cleared.has(pane.id) ? { ...pane, open: null } : pane)),
            );
          return Promise.all(reloads);
        })
        .catch(fail);
    });
  }, [refresh, storageKey]);
  useEffect(() => {
    if (!tree || !restored.current) return;
    localStorage.setItem(
      storageKey,
      JSON.stringify({ layout: saveLayout(layout), focused, expanded: [...expanded] }),
    );
  }, [layout, focused, expanded, storageKey, tree]);
  useEffect(() => {
    void bridge.syncInfo().then(setSync).catch(fail);
    return bridge.onSync(setSync);
  }, []);
  useEffect(() => {
    void bridge.missing().then(setGone).catch(fail);
    return bridge.onPresence((next) => {
      setGone(next);
      // Back where it was: what could not be saved meanwhile is saved now.
      if (!next) void flushAll().catch(() => {});
    });
  }, [flushAll]);
  useEffect(
    () =>
      window.opsidian?.onCloseRequest(() => {
        void flushAll()
          .then(() => window.opsidian?.closeReady())
          .catch((reason) => window.opsidian?.closeFailed(message(reason)));
      }),
    [flushAll],
  );
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      const key = event.key.toLowerCase();
      if (event.metaKey && event.ctrlKey && /^Bracket(Left|Right)$/.test(event.code)) {
        event.preventDefault();
        focusNext(event.code === 'BracketRight' ? 1 : -1);
      } else if (!event.altKey && (event.code === 'Backslash' || key === '\\' || key === '|')) {
        event.preventDefault();
        split(event.shiftKey ? 'column' : 'row');
      } else if (event.altKey && (key === 'arrowleft' || key === 'arrowright')) {
        event.preventDefault();
        step(focusedPane.id, key === 'arrowleft' ? -1 : 1);
      } else if (event.altKey || event.shiftKey) return;
      else if (key === 'n') {
        event.preventDefault();
        void create('');
      } else if (key === 'k' || key === 'o') {
        event.preventDefault();
        setCommanding(false);
        setFinding('');
      } else if (key === 'p') {
        event.preventDefault();
        setFinding(null);
        setCommanding(true);
      } else if (key === ',') {
        event.preventDefault();
        setSettings((open) => open ?? 'general');
      } else if (key === 'g') {
        event.preventDefault();
        toggleGraph();
      } else if (key === 'e' && open) {
        event.preventDefault();
        toggleReading(focusedPane.id);
      }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  });

  /**
   * Has the host copy this notebook to GitHub now, whatever its schedule. The notes being
   * written are saved first, so the copy has them.
   */
  async function syncWithGitHub() {
    if (!sync.connected)
      return setNotice(
        'This notebook does not sync with a host, so it is not kept on GitHub. Set that up in Settings → GitHub.',
      );
    setNotice('Syncing with GitHub…');
    try {
      await flushAll();
      setNotice(copyOutcome(await bridge.syncWithGitHub()));
    } catch (reason) {
      fail(reason);
    }
  }
  /** Searches the notebook for a tag, as clicking one does. A tag just typed is saved first. */
  const findTag = (tag: string) => {
    setCommanding(false);
    void (focusedEditor()?.flush() ?? Promise.resolve())
      .catch(() => {})
      .then(() => setFinding(`#${tag}`));
  };
  const toggleReading = (id: string) =>
    setLayout((layout) =>
      updatePane(layout, id, (pane) =>
        pane.mode === 'reading'
          ? { ...pane, mode: pane.editing }
          : { ...pane, editing: pane.mode, mode: 'reading' },
      ),
    );
  const sourceMode = (id: string) =>
    setLayout((layout) =>
      updatePane(layout, id, (pane) => {
        const next = pane.mode === 'source' ? 'live' : 'source';
        return { ...pane, mode: next, editing: next };
      }),
    );
  const leaveReading = (id: string) =>
    setLayout((layout) =>
      updatePane(layout, id, (pane) =>
        pane.mode === 'reading' ? { ...pane, mode: pane.editing } : pane,
      ),
    );
  const share = (path: string) => (sync.connected ? setSharing(path) : setNotice(SHARE_NEEDS_HOST));
  /** Copies a note beside itself as “Name 1”, Obsidian's naming, and opens the copy. */
  async function duplicate(path: string) {
    try {
      // The copy takes what was just typed.
      await Promise.all(
        panes(state.current.layout)
          .filter((pane) => pane.open?.path === path)
          .map((pane) => editors.current.get(pane.id)?.flush()),
      );
      const { content } = await bridge.read(path);
      const copy = await bridge.createNote(noteFolder(path), noteTitle(path));
      const fresh = await bridge.read(copy);
      await bridge.save(copy, content, fresh.revision);
      await refresh();
      await show(copy);
    } catch (reason) {
      fail(reason);
    }
  }
  const commands: PaletteCommand[] = [
    { id: 'new-note', title: 'New note', icon: FilePlus2, keys: '⌘N', run: () => void create('') },
    { id: 'find-note', title: 'Find a note', icon: Search, keys: '⌘K', run: () => setFinding('') },
    ...(open && !graphOpen
      ? [
          {
            id: 'find-in-note',
            title: 'Find in note',
            icon: TextSearch,
            keys: '⌘F',
            run: () => focusedEditor()?.find(false),
          },
          ...(mode !== 'reading'
            ? [
                {
                  id: 'replace-in-note',
                  title: 'Find and replace in note',
                  icon: Replace,
                  keys: '⌥⌘F',
                  run: () => focusedEditor()?.find(true),
                },
              ]
            : []),
          {
            id: 'reading',
            title: mode === 'reading' ? 'Edit note' : 'Reading view',
            icon: mode === 'reading' ? Pencil : BookOpen,
            keys: '⌘E',
            run: () => toggleReading(focusedPane.id),
          },
          {
            id: 'source',
            title: mode === 'source' ? 'Live Preview' : 'Source mode',
            icon: Code,
            run: () => sourceMode(focusedPane.id),
          },
          {
            id: 'rename',
            title: 'Rename note',
            icon: Pencil,
            run: () => {
              leaveReading(focusedPane.id);
              setTimeout(() => focusedEditor()?.focusTitle(), 0);
            },
          },
          {
            id: 'duplicate',
            title: 'Duplicate note',
            icon: Copy,
            run: () => void duplicate(open.path),
          },
          {
            id: 'move',
            title: 'Move note to…',
            icon: FolderInput,
            run: () => setMoving(open.path),
          },
          {
            id: 'reveal',
            title: 'Show note in Finder',
            icon: FolderSearch,
            run: () => void bridge.reveal(open.path).catch(fail),
          },
          {
            id: 'share',
            title: 'Share note as a link…',
            icon: Link,
            run: () => share(open.path),
          },
          ...(sync.connected
            ? [
                {
                  id: 'history',
                  title: 'Version history',
                  icon: History,
                  run: () => setHistory({ pane: focusedPane.id, path: open.path }),
                },
              ]
            : []),
          {
            id: 'trash-note',
            title: 'Move note to trash',
            icon: Trash2,
            run: () => void trash(open.path),
          },
        ]
      : []),
    {
      id: 'split-right',
      title: 'Split right',
      icon: Columns2,
      keys: '⌘\\',
      run: () => split('row'),
    },
    {
      id: 'split-down',
      title: 'Split down',
      icon: Rows2,
      keys: '⇧⌘\\',
      run: () => split('column'),
    },
    ...(all.length > 1
      ? [
          {
            id: 'close-pane',
            title: 'Close pane',
            icon: X,
            run: () => void closeOne(focusedPane.id),
          },
          {
            id: 'focus-next-pane',
            title: 'Focus next pane',
            icon: ArrowRight,
            keys: '⌃⌘]',
            run: () => focusNext(1),
          },
          {
            id: 'focus-previous-pane',
            title: 'Focus previous pane',
            icon: ArrowLeft,
            keys: '⌃⌘[',
            run: () => focusNext(-1),
          },
        ]
      : []),
    {
      id: 'graph',
      title: graphOpen ? 'Close graph' : 'Open local graph',
      icon: Waypoints,
      keys: '⌘G',
      run: toggleGraph,
    },
    {
      id: 'back',
      title: 'Back',
      icon: ArrowLeft,
      keys: '⌥⌘←',
      run: () => step(focusedPane.id, -1),
    },
    {
      id: 'forward',
      title: 'Forward',
      icon: ArrowRight,
      keys: '⌥⌘→',
      run: () => step(focusedPane.id, 1),
    },
    {
      id: 'sidebar',
      title: sidebar ? 'Hide sidebar' : 'Show sidebar',
      icon: PanelLeft,
      run: () => setSidebar(!sidebar),
    },
    { id: 'trash', title: 'Open trash', icon: Trash2, run: () => setTrashOpen(true) },
    {
      id: 'sync-status',
      title: 'Sync status',
      icon: RefreshCw,
      run: () => (sync.connected ? setSyncOpen(true) : setSettings('sync')),
    },
    {
      id: 'sync-github',
      title: 'Sync with GitHub',
      icon: RefreshCw,
      run: () => void syncWithGitHub(),
    },
    ...SETTINGS_SECTIONS.map(([id, label]) => ({
      id: `settings-${id}`,
      title: `Settings: ${label}`,
      icon: SettingsIcon,
      ...(id === 'general' ? { keys: '⌘,' } : {}),
      run: () => setSettings(id),
    })),
    {
      id: 'switch',
      title: 'Switch notebook',
      icon: FolderOpen,
      run: () => void flushAll().then(() => onSwitch(), fail),
    },
    { id: 'help', title: 'Help', icon: CircleHelp, run: () => void bridge.openHelp().catch(fail) },
  ];

  async function trash(path: string) {
    const gone = (other: string) => other === path || other.startsWith(`${path}/`);
    const affected = panes(state.current.layout).filter(
      (pane) => pane.open && gone(pane.open.path),
    );
    try {
      await flushAll();
      // An edit made while the note is on its way to the trash must not bring it back.
      const held = affected.map((pane) => ({
        path: pane.open!.path,
        resume: editors.current.get(pane.id)?.suspend(),
      }));
      try {
        await bridge.trash(path);
        held.forEach(({ resume }) => resume?.(null));
      } catch (reason) {
        held.forEach(({ path, resume }) => resume?.(path));
        throw reason;
      }
      setLayout((layout) =>
        mapPanes(layout, (pane) => {
          const paths = pane.trail.paths.filter((other) => !gone(other));
          const current = pane.trail.paths[pane.trail.at];
          const at = current && !gone(current) ? paths.indexOf(current) : paths.length - 1;
          const open = pane.open && gone(pane.open.path) ? null : pane.open;
          return { ...pane, open, trail: { paths, at } };
        }),
      );
      const name = /\.md$/i.test(path) ? noteTitle(path) : path.slice(path.lastIndexOf('/') + 1);
      setNotice(`“${name}” was moved to the trash. Restore it from Trash in the sidebar.`);
      await refresh();
    } catch (reason) {
      fail(reason);
    }
  }
  /** Renames or moves a note or folder, then follows it wherever it is open or remembered. */
  async function relocate(path: string, action: () => Promise<MoveResult>): Promise<boolean> {
    try {
      await flushAll();
      // Typing goes on during the move; saving waits, then goes to wherever the note now is.
      // Every pane waits: any of them may show the note, or a note in the folder.
      const held = panes(state.current.layout).flatMap((pane) => {
        const editor = editors.current.get(pane.id);
        return pane.open && editor
          ? [{ path: pane.open.path, editor, resume: editor.suspend() }]
          : [];
      });
      let result: MoveResult;
      try {
        result = await action();
      } catch (reason) {
        held.forEach(({ path, resume }) => resume(path));
        throw reason;
      }
      const shift = (other: string) =>
        other === path
          ? result.path
          : other.startsWith(`${path}/`)
            ? result.path + other.slice(path.length)
            : other;
      for (const { path: before, editor, resume } of held) {
        const current = shift(before);
        // Links inside an open note may have been rewritten on disk. Take that text before
        // saving resumes, so the next save starts from it.
        if (result.rewritten.includes(current)) await editor.reloadIfClean(current).catch(fail);
        resume(current);
      }
      setLayout((layout) =>
        mapPanes(layout, (pane) => ({
          ...pane,
          open: pane.open ? { ...pane.open, path: shift(pane.open.path) } : null,
          trail: { ...pane.trail, paths: pane.trail.paths.map(shift) },
        })),
      );
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

  function toggleGraph() {
    if (graphOpen) return setGraphOpen(false);
    void flushAll().finally(() => {
      setGraphMounted(true);
      setGraphOpen(true);
    });
  }

  // Nothing until the session is back, so a restored pane does not first flash empty.
  if (!tree || !restored.current) return null;
  const noticeBar = notice ? (
    <div role="alert" className="bg-secondary flex items-center gap-4 px-8 py-3 text-[13px]">
      <span className="flex-1 leading-5">{notice}</span>
      <button aria-label="Dismiss" className={iconButton} onClick={() => setNotice('')}>
        <X size={16} />
      </button>
    </div>
  ) : null;
  const unsaved = [focusedPane, ...all].find((pane) => {
    const editor = editors.current.get(pane.id);
    return pane.open && editor && !editor.settled();
  });
  // A save that failed in any pane is shown, over the pane in use: nothing else would say so.
  const reported =
    all.find((pane) => pane.open && statuses[pane.id]?.save.state === 'error') ?? focusedPane;
  const renderPane = (pane: PaneState, index: number) => {
    const id = pane.id;
    const note = pane.open;
    return (
      <Pane
        pane={pane}
        focused={id === focusedPane.id}
        first={index === 0}
        sidebar={sidebar}
        closable={all.length > 1}
        history={sync.connected}
        notice={id === focusedPane.id ? noticeBar : null}
        onFocus={() => setFocused(id)}
        onFocusEditor={() => {
          const editor = editors.current.get(id);
          editor?.focus();
          return Boolean(editor);
        }}
        onFocusTitle={() => editors.current.get(id)?.focusTitle()}
        onShowSidebar={() => setSidebar(true)}
        onStep={(by) => step(id, by)}
        onToggleGraph={toggleGraph}
        onToggleReading={() => toggleReading(id)}
        onSourceMode={() => sourceMode(id)}
        onShare={() => note && share(note.path)}
        onHistory={() => note && setHistory({ pane: id, path: note.path })}
        onRename={() => leaveReading(id)}
        onDuplicate={() => note && void duplicate(note.path)}
        onMove={() => note && setMoving(note.path)}
        onReveal={() => note && void bridge.reveal(note.path).catch(fail)}
        onTrash={() => note && void trash(note.path)}
        onSplit={(direction) => split(direction, undefined, id)}
        onClose={() => void closeOne(id)}
        onNewNote={() => void create('', undefined, id)}
        onFind={() => setFinding('')}
      >
        {note && (
          <NoteEditor
            key={note.visit}
            ref={editorRef(id)}
            path={note.path}
            notes={tree.notes}
            tags={tags.map((entry) => entry.tag)}
            heading={note.heading}
            resolve={resolve}
            locateImage={locateImage}
            mode={pane.mode}
            autoFocus={id === focusedPane.id}
            version={version}
            onOpenLink={(target, heading) => follow(id, target, heading)}
            onOpen={(path) => void showIn(id, path).catch(fail)}
            onTag={findTag}
            onRename={(name) => relocate(note.path, () => bridge.rename(note.path, name))}
            onChanged={() => void refresh().catch(fail)}
            onNotice={setNotice}
            onStatus={(status) => setStatuses((before) => ({ ...before, [id]: status }))}
          />
        )}
      </Pane>
    );
  };
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
          onOpenSplit={(path, direction) => split(direction, path)}
          onDuplicate={(path) => void duplicate(path)}
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
        {graphOpen && (
          <>
            <HeaderBar label="Graph header" traffic={!sidebar}>
              {!sidebar && <ShowSidebar onShow={() => setSidebar(true)} />}
              <Crumbs path={open?.path ?? null} active />
              <button
                aria-label="Close graph"
                title="Close graph (⌘G)"
                className={cn(iconButton, 'text-foreground')}
                onClick={toggleGraph}
              >
                <Waypoints size={17} />
              </button>
            </HeaderBar>
            {noticeBar}
          </>
        )}
        {graphMounted && (
          <div className={graphOpen ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'hidden'}>
            <GraphView
              center={open?.path ?? null}
              version={version}
              dark={theme.dark}
              onOpen={(path) => void show(path).catch(fail)}
              onCreate={(name) => void create('', name)}
              onTag={findTag}
            />
          </div>
        )}
        {/* Hidden, not unmounted, under the graph: each editor keeps its place and history. */}
        <div className={graphOpen ? 'hidden' : 'flex min-h-0 min-w-0 flex-1 flex-col'}>
          <SplitView
            layout={layout}
            renderPane={renderPane}
            onResize={(split, index, fraction, min) =>
              setLayout((layout) => resize(layout, split, index, fraction, min))
            }
          />
        </div>
        <StatusBar
          note={reported.open ? statuses[reported.id] : undefined}
          sync={sync}
          onRetrySave={() =>
            void editors.current
              .get(reported.id)
              ?.flush()
              .catch(() => {})
          }
          onSyncSettings={() => setSettings('sync')}
        />
      </main>
      {gone && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[12vh]">
          <div className="border-border bg-popover text-popover-foreground w-[min(560px,92vw)] rounded-xl border p-6 shadow-2xl">
            <MissingNotice
              missing={gone}
              unsaved={
                unsaved?.open
                  ? {
                      note: noteTitle(unsaved.open.path),
                      copy: () => copyText(editors.current.get(unsaved.id)?.text() ?? ''),
                    }
                  : undefined
              }
              onOpened={(next) => {
                if (next.location !== vault.location) return onOpened(next);
                // Downloaded again into the same place: carry on, and save what waited.
                setGone(null);
                void refresh().catch(fail);
                void flushAll().catch(() => {});
              }}
              onDone={(warning) => onClose(null, warning)}
              onClose={() => void bridge.closeVault().then(() => onClose(gone), fail)}
            />
          </div>
        </div>
      )}
      {commanding && <CommandPalette commands={commands} onClose={() => setCommanding(false)} />}
      {finding !== null && (
        <QuickSwitcher
          notes={tree.notes}
          recent={[...focusedPane.trail.paths].reverse()}
          initial={finding}
          onOpen={(path) => {
            setFinding(null);
            void show(path).catch(fail);
          }}
          onCreate={(name) => {
            setFinding(null);
            void create('', name);
          }}
          onClose={() => setFinding(null)}
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
          onStopSyncing={async (trash) => {
            // The notes being written go up with the rest before anything is let go of.
            await flushAll();
            const host = sync.host?.replace(/^https?:\/\//, '') ?? 'The host';
            const { hostTold, trashed } = await bridge.disconnect({ trash });
            const unheard = hostTold
              ? ''
              : `${host} could not be reached, so it still lists this Mac; remove it there, in Settings → Devices or with “host remove”.`;
            if (trashed) {
              onClose(null, unheard && `Moved “${vault.name}” to the Trash. ${unheard}`);
              return undefined;
            }
            const kept = !trash
              ? ''
              : sync.removed
                ? 'The folder was kept: the host no longer accepts this Mac, so what is in it could not be checked against the host. Move it to the Trash yourself once you have checked it.'
                : 'The folder was kept: not every change in it had reached the host, so deleting it could have lost notes. Move it to the Trash yourself once you have checked it.';
            return [unheard && `Stopped. ${unheard}`, kept].filter(Boolean).join(' ') || undefined;
          }}
          onReset={async () => {
            await flushAll();
            await bridge.resetApp();
          }}
          onClose={() => setSettings(undefined)}
        />
      )}
      {syncOpen && <SyncDialog info={sync} onClose={() => setSyncOpen(false)} />}
      {sharing && <ShareDialog path={sharing} flush={flushAll} onClose={() => setSharing(null)} />}
      {history && (
        <HistoryDialog
          path={history.path}
          onRestore={(content) => {
            setHistory(null);
            editors.current.get(history.pane)?.restore(content);
          }}
          onClose={() => setHistory(null)}
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
