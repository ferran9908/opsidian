import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  BookOpen,
  FileText,
  PanelLeft,
  Sun,
  Moon,
  Monitor,
  Bold,
  Italic,
  Heading2,
  List,
  ListTodo,
  Link2,
  ImagePlus,
  Undo2,
  Redo2,
  Check,
  Circle,
  ArrowUpRight,
  X,
  RotateCcw,
} from 'lucide-react';
import {
  createEditor,
  type OpsidianEditor,
  type EditorMode,
  type EditorCommand,
} from '@opsidian/editor';
import { SaveQueue, imageMarkdown, noteSuggestions, type SaveStatus } from '@opsidian/core';
import { themes, type ThemePreference } from '@opsidian/theme';
import { browserStore } from './browser-store';
import styles from './App.module.css';

const bridge = window.opsidian ?? browserStore;
const commands = [
  ['undo', Undo2, 'Undo'],
  ['redo', Redo2, 'Redo'],
  ['heading', Heading2, 'Heading'],
  ['bold', Bold, 'Bold'],
  ['italic', Italic, 'Italic'],
  ['bullet', List, 'Bullet list'],
  ['task', ListTodo, 'Checklist'],
  ['link', Link2, 'Link a note'],
] as const;

export function App() {
  const editorRoot = useRef<HTMLDivElement>(null);
  const editor = useRef<OpsidianEditor | null>(null);
  const saves = useRef<SaveQueue | null>(null);
  const assets = useRef<Record<string, string>>({});
  const [status, setStatus] = useState<SaveStatus>({ state: 'saved' });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [location, setLocation] = useState('');
  const [mode, setMode] = useState<EditorMode>('live');
  const [title, setTitle] = useState('A slower kind of Sunday');
  const [words, setWords] = useState(0);
  const [sidebar, setSidebar] = useState(true);
  const [linked, setLinked] = useState('');
  const [theme, setTheme] = useState<ThemePreference>(
    () => (localStorage.getItem('opsidian-theme') as ThemePreference) || 'dark',
  );
  const [systemDark, setSystemDark] = useState(matchMedia('(prefers-color-scheme: dark)').matches);
  const dark = theme === 'dark' || (theme === 'system' && systemDark);
  const palette = themes[dark ? 'dark' : 'light'];
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const change = () => setSystemDark(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    localStorage.setItem('opsidian-theme', theme);
  }, [theme, dark]);
  useEffect(() => {
    let cancelled = false;
    const removeClose = window.opsidian?.onCloseRequest(() => {
      if (!saves.current) {
        void window.opsidian?.closeReady();
        return;
      }
      void saves.current
        .flush()
        .then(() => window.opsidian?.closeReady())
        .catch((reason) => window.opsidian?.closeFailed(String(reason)));
    });
    const summarize = (text: string) => {
      setTitle(text.match(/^#\s+(.+)$/m)?.[1] ?? 'Untitled note');
      setWords(text.trim().split(/\s+/).filter(Boolean).length);
    };
    void bridge
      .load()
      .then((note) => {
        if (cancelled || !editorRoot.current) return;
        assets.current = note.assets;
        setLocation(note.location);
        summarize(note.content);
        saves.current = new SaveQueue(note.content, (content) => bridge.save(content), setStatus);
        editor.current = createEditor({
          parent: editorRoot.current,
          content: note.content,
          suggestions: noteSuggestions,
          resolveImage: (path) => assets.current[path],
          onLink: setLinked,
          onChange: (content) => {
            saves.current?.update(content);
            summarize(content);
          },
          onSave: () => {
            void saves.current?.flush().catch(() => {});
          },
        });
        setLoaded(true);
      })
      .catch((reason) => setError(String(reason)));
    const flush = () => {
      void saves.current?.flush().catch(() => {});
    };
    window.addEventListener('pagehide', flush);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      removeClose?.();
      flush();
      editor.current?.destroy();
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  const command = (name: EditorCommand) => editor.current?.command(name);
  async function attach() {
    try {
      await saves.current?.flush();
      const image = await bridge.importImage();
      if (!image) return;
      assets.current[image.path] = image.url;
      editor.current?.insert(imageMarkdown(image.path));
      await saves.current?.flush();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  const themeIcon =
    theme === 'system' ? <Monitor size={17} /> : dark ? <Moon size={17} /> : <Sun size={17} />;
  const colorVars = Object.fromEntries(
    Object.entries(palette).map(([key, value]) => [`--${key}`, value]),
  ) as CSSProperties;
  return (
    <div className={styles.app} style={colorVars}>
      {sidebar && (
        <aside className={styles.sidebar}>
          <div className={styles.dragSpace}>
            <span>opsidian</span>
          </div>
          <div className={styles.notebook}>
            <div className={styles.bookSpine} />
            <div>
              <strong>Personal</strong>
              <span>Editor notebook</span>
            </div>
          </div>
          <div className={styles.sectionLabel}>YOUR NOTE</div>
          <button className={styles.activeNote} onClick={() => editor.current?.view.focus()}>
            <FileText size={17} />
            <span>{title}</span>
          </button>
          <div className={styles.sidebarGuide}>
            <span className={styles.sectionLabel}>MAKE YOURSELF AT HOME</span>
            <p>
              A thought, a list, a little plan.
              <br />
              It all starts on this page.
            </p>
            <button onClick={() => command('link')}>
              <Link2 size={15} /> Connect a thought <ArrowUpRight size={13} />
            </button>
            <button onClick={() => void attach()}>
              <ImagePlus size={15} /> Keep a picture <ArrowUpRight size={13} />
            </button>
          </div>
          <div className={styles.localInfo}>
            <span>
              <Circle size={7} fill="currentColor" /> Local notebook
            </span>
            <p>Your words stay on this device.</p>
            <details>
              <summary>Where is my note?</summary>
              <p>{location || 'Opening…'}</p>
            </details>
          </div>
        </aside>
      )}
      <main className={styles.main}>
        <header className={styles.header}>
          <button
            aria-label="Toggle sidebar"
            title="Toggle sidebar"
            onClick={() => setSidebar(!sidebar)}
          >
            <PanelLeft size={18} />
          </button>
          <div className={styles.breadcrumb}>
            Personal <span>/</span> <span>{title}</span>
          </div>
          <div className={styles.modeSwitch} aria-label="Editing mode">
            {(['live', 'source'] as const).map((value) => (
              <button
                key={value}
                aria-pressed={mode === value}
                onClick={() => {
                  setMode(value);
                  editor.current?.setMode(value);
                }}
              >
                {value === 'live' ? 'Live Preview' : 'Source'}
              </button>
            ))}
          </div>
          <button
            aria-label={`Theme: ${theme}`}
            title={`Theme: ${theme}. Click to cycle.`}
            onClick={() =>
              setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark')
            }
          >
            {themeIcon}
          </button>
        </header>
        <div className={styles.toolbar} role="toolbar" aria-label="Formatting">
          {commands.map(([name, Icon, label]) => (
            <button
              key={name}
              disabled={!loaded}
              aria-label={label}
              title={label}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => command(name)}
            >
              <Icon size={17} />
            </button>
          ))}
          <span />
          <button
            disabled={!loaded}
            aria-label="Attach image"
            title="Attach image"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void attach()}
          >
            <ImagePlus size={17} />
          </button>
          <div className={styles.toolbarHint}>A space to think.</div>
        </div>
        {error && (
          <div role="alert" className={styles.error}>
            {error}
            <button aria-label="Dismiss error" onClick={() => setError('')}>
              <X size={16} />
            </button>
          </div>
        )}
        {linked && (
          <div className={styles.linkNotice}>
            <BookOpen size={18} />
            <div>
              <strong>{linked}</strong>
              <p>
                This link is kept in your Markdown. Opening other notes arrives with the full
                notebook.
              </p>
            </div>
            <button aria-label="Dismiss link detail" onClick={() => setLinked('')}>
              <X size={16} />
            </button>
          </div>
        )}
        <div className={styles.writingArea}>
          <div className={styles.pageLabel}>
            PERSONAL NOTES <span>·</span> YOUR OWN LITTLE CORNER
          </div>
          {!loaded && !error && <p>Opening your notebook…</p>}
          <div ref={editorRoot} className={styles.editor} />
        </div>
        <footer className={styles.status}>
          <div role="status">
            {status.state === 'error' ? (
              <>
                <span className={styles.saveError}>{status.message}</span>
                <button onClick={() => void saves.current?.flush().catch(() => {})}>
                  <RotateCcw size={13} /> Retry save
                </button>
              </>
            ) : (
              <>
                <Check size={14} />
                {!loaded
                  ? 'Opening…'
                  : status.state === 'saving'
                    ? 'Saving…'
                    : window.opsidian
                      ? 'Saved on this Mac'
                      : 'Saved in browser preview'}
              </>
            )}
          </div>
          <span>
            {words} words <span>·</span> Markdown
          </span>
        </footer>
      </main>
    </div>
  );
}
