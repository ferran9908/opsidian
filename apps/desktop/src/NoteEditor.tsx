import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type React from 'react';
import {
  ArrowUpRight,
  Bold,
  Check,
  Heading2,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListTodo,
  Redo2,
  RotateCcw,
  Undo2,
} from 'lucide-react';
import {
  createEditor,
  type EditorCommand,
  type EditorMode,
  type OpsidianEditor,
} from '@opsidian/editor';
import {
  SaveQueue,
  headingSection,
  isVaultImage,
  noteTitle,
  vaultImageMarkdown,
  type Backlink,
  type SaveStatus,
} from '@opsidian/core';
import { bridge, message } from './bridge';

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
const tool =
  'text-muted-foreground hover:bg-accent hover:text-accent-foreground flex size-[30px] items-center justify-center rounded-md disabled:opacity-40';
const countWords = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

export interface NoteEditorHandle {
  /** Resolves once every edit is on disk; rejects if the save failed. */
  flush(): Promise<void>;
  /** Loads the file again unless there are edits it would discard. */
  reloadIfClean(path?: string): Promise<void>;
  scrollToHeading(heading: string): void;
  /**
   * Holds back saves while the note is being renamed, moved or trashed. Call the result
   * with where the note now is, or null if it is gone and nothing more should be written.
   */
  suspend(): (path: string | null) => void;
  /** Whether there is nothing waiting to be saved. */
  settled(): boolean;
  focusTitle(): void;
}
interface Props {
  path: string;
  notes: string[];
  /** Heading to start at, from a `[[Note#Heading]]` link. */
  heading?: string | undefined;
  resolve(target: string): string | undefined;
  /** Finds an image by vault path or, failing that, by file name. */
  locateImage(path: string): string;
  mode: EditorMode;
  /** Changes whenever the notebook does, so links and backlinks can be refreshed. */
  version: number;
  onOpenLink(target: string, heading?: string): void;
  onOpen(path: string): void;
  /** Resolves false when the name was refused. */
  onRename(name: string): Promise<boolean>;
  /** Called after this editor added a file to the notebook. */
  onChanged(): void;
  onNotice(text: string): void;
}

export const NoteEditor = forwardRef<NoteEditorHandle, Props>(function NoteEditor(props, ref) {
  const { path, mode, version } = props;
  const root = useRef<HTMLDivElement>(null);
  const titleField = useRef<HTMLInputElement>(null);
  const editor = useRef<OpsidianEditor | null>(null);
  const saves = useRef<SaveQueue | null>(null);
  const revision = useRef('');
  // Where saves go. Updated the moment a rename lands, ahead of the next render.
  const target = useRef<string | null>(props.path);
  const held = useRef<Promise<void> | undefined>(undefined);
  // The editor outlives renders, so its callbacks read the latest props through this.
  const latest = useRef(props);
  latest.current = props;
  const [status, setStatus] = useState<SaveStatus>({ state: 'saved' });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [words, setWords] = useState(0);
  const [title, setTitle] = useState(noteTitle(path));
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);

  const reloadIfClean = async (from = latest.current.path) => {
    if (!editor.current || !saves.current?.settled) return;
    const document = await bridge.read(from);
    if (!saves.current.settled || document.revision === revision.current) return;
    revision.current = document.revision;
    saves.current.adopt(document.content);
    editor.current.setContent(document.content);
    setWords(countWords(document.content));
  };
  useImperativeHandle(ref, () => ({
    flush: async () => saves.current?.flush(),
    reloadIfClean,
    scrollToHeading: (heading) => void editor.current?.scrollToHeading(heading),
    suspend: () => {
      let release!: () => void;
      held.current = new Promise<void>((resolve) => {
        release = resolve;
      });
      return (path) => {
        target.current = path;
        held.current = undefined;
        release();
      };
    },
    settled: () => saves.current?.settled ?? true,
    focusTitle: () => titleField.current?.select(),
  }));

  useEffect(() => {
    let cancelled = false;
    let counting: ReturnType<typeof setTimeout>;
    /** Saves one snapshot. A string result is what the file holds instead, after a conflict. */
    const write = async (content: string): Promise<void | string> => {
      await held.current;
      const path = target.current;
      // Trashed while this edit was waiting: there is no note left to write it to.
      if (path === null) return;
      const result = await bridge.save(path, content, revision.current);
      if ('revision' in result) {
        revision.current = result.revision;
        return;
      }
      // The file changed underneath this edit. The edit is in a copy; show what is on disk.
      const typed = editor.current?.view.state.doc.toString();
      if (typed !== undefined && typed !== content) {
        const copy = await bridge.read(result.conflict);
        await bridge.save(result.conflict, typed, copy.revision);
      }
      const disk = await bridge.read(path);
      revision.current = disk.revision;
      editor.current?.setContent(disk.content);
      latest.current.onNotice(
        `“${noteTitle(path)}” changed outside Opsidian, so the newer file was kept. Your version is saved as “${noteTitle(result.conflict)}”.`,
      );
      return disk.content;
    };
    void bridge
      .read(path)
      .then((document) => {
        if (cancelled || !root.current) return;
        revision.current = document.revision;
        setWords(countWords(document.content));
        saves.current = new SaveQueue(document.content, write, setStatus);
        editor.current = createEditor({
          parent: root.current,
          content: document.content,
          mode: latest.current.mode,
          suggestions: () => latest.current.notes.map(noteTitle),
          linkExists: (target) => Boolean(latest.current.resolve(target)),
          resolveImage: (source) => {
            let image: string;
            try {
              image = decodeURI(source);
            } catch {
              return undefined;
            }
            return isVaultImage(image)
              ? bridge.imageUrl(latest.current.locateImage(image))
              : undefined;
          },
          onLink: (target, heading) => latest.current.onOpenLink(target, heading),
          loadEmbed: async (target, heading) => {
            const from = target ? latest.current.resolve(target) : latest.current.path;
            if (!from) return undefined;
            const { content } = await bridge.read(from);
            return heading ? headingSection(content, heading) : content;
          },
          embedStamp: () => latest.current.version,
          onChange: (content) => {
            saves.current?.update(content);
            clearTimeout(counting);
            counting = setTimeout(() => setWords(countWords(content)), 250);
          },
          onSave: () => {
            void saves.current?.flush().catch(() => {});
          },
        });
        setLoaded(true);
        // A brand-new note starts at its name; anything else starts in the text.
        if (!document.content && /^Untitled( \d+)?$/.test(noteTitle(path)))
          titleField.current?.select();
        else editor.current.view.focus();
        if (latest.current.heading) editor.current.scrollToHeading(latest.current.heading);
      })
      .catch((reason) => setError(message(reason)));
    const flush = () => {
      void saves.current?.flush().catch(() => {});
    };
    const hidden = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      cancelled = true;
      clearTimeout(counting);
      flush();
      editor.current?.destroy();
      editor.current = null;
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', hidden);
    };
    // One editor per mounted note: the parent remounts this component to open another.
  }, []);

  useEffect(() => setTitle(noteTitle(path)), [path]);
  useEffect(() => editor.current?.setMode(mode), [mode]);
  useEffect(() => {
    editor.current?.refresh();
    let stale = false;
    void bridge.backlinks(path).then((links) => {
      if (!stale) setBacklinks(links);
    });
    return () => {
      stale = true;
    };
  }, [path, version, loaded]);

  async function rename() {
    const name = title.trim();
    if (name === noteTitle(path)) return setTitle(name);
    if (!(await props.onRename(name))) setTitle(noteTitle(path));
  }
  async function attach() {
    try {
      const image = await bridge.importImage();
      if (!image) return;
      editor.current?.insert(vaultImageMarkdown(image));
      props.onChanged();
    } catch (reason) {
      props.onNotice(message(reason));
    }
  }
  /** Stores pasted or dropped images in the notebook and links them where the cursor is. */
  function receive(event: React.ClipboardEvent | React.DragEvent) {
    const data = 'clipboardData' in event ? event.clipboardData : event.dataTransfer;
    const images = [...data.files].filter((file) => /^image\/(png|jpeg|gif|webp)$/.test(file.type));
    // Spreadsheets and word processors copy a picture of the text beside the text; paste the text.
    const hasText = 'clipboardData' in event && Boolean(data.getData('text/plain'));
    if (!images.length || hasText || !editor.current) return;
    event.preventDefault();
    event.stopPropagation();
    if ('clientX' in event) {
      const at = editor.current.view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (at !== null) editor.current.view.dispatch({ selection: { anchor: at } });
    }
    void (async () => {
      for (const image of images) {
        const stored = await bridge.saveImage(new Uint8Array(await image.arrayBuffer()));
        editor.current?.insert(vaultImageMarkdown(stored));
      }
      props.onChanged();
    })().catch((reason) => props.onNotice(message(reason)));
  }
  const command = (name: EditorCommand) => editor.current?.command(name);

  return (
    <>
      <div
        className="flex min-h-[44px] shrink-0 items-center gap-1 px-7"
        role="toolbar"
        aria-label="Formatting"
      >
        {commands.map(([name, Icon, label]) => (
          <button
            key={name}
            disabled={!loaded}
            aria-label={label}
            title={label}
            className={tool}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => command(name)}
          >
            <Icon size={17} />
          </button>
        ))}
        <span className="bg-border mx-1.5 h-[18px] w-px" />
        <button
          disabled={!loaded}
          aria-label="Attach image"
          title="Attach image"
          className={tool}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void attach()}
        >
          <ImagePlus size={17} />
        </button>
      </div>
      <div className="flex-1 overflow-auto px-[max(32px,calc((100%-700px)/2))] pt-6 max-[650px]:px-6">
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : (
          <input
            ref={titleField}
            value={title}
            aria-label="Note title"
            spellCheck={false}
            className="mb-[0.5em] w-full bg-transparent text-[25.888px] leading-[1.2] font-bold tracking-[-0.015em] outline-none"
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => void rename()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setTitle(noteTitle(path));
                editor.current?.view.focus();
              }
              if (event.key === 'Enter' || event.key === 'ArrowDown') {
                event.preventDefault();
                editor.current?.view.focus();
              }
            }}
          />
        )}
        <div ref={root} onPasteCapture={receive} onDropCapture={receive} />
        {loaded && backlinks.length > 0 && (
          <section className="border-border mb-16 border-t pt-6" aria-label="Linked from">
            <h2 className="text-muted-foreground text-xs tracking-[0.04em]">
              LINKED FROM{' '}
              <span className="pl-2">
                {backlinks.length} {backlinks.length === 1 ? 'NOTE' : 'NOTES'}
              </span>
            </h2>
            <ul className="mt-3 space-y-3">
              {backlinks.map((link) => (
                <li key={link.path}>
                  <button
                    className="text-link flex items-center gap-1 text-sm"
                    onClick={() => props.onOpen(link.path)}
                  >
                    <ArrowUpRight size={14} /> {noteTitle(link.path)}
                  </button>
                  <p className="text-muted-foreground truncate pl-5 text-[13px] leading-6">
                    {link.excerpt}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <footer className="border-border text-muted-foreground flex min-h-[38px] shrink-0 items-center justify-between gap-6 border-t px-8 text-xs">
        <div role="status" className="flex min-w-0 items-center gap-2">
          {status.state === 'error' ? (
            <>
              <span className="text-destructive truncate">{status.message}</span>
              <button
                className="hover:text-foreground flex shrink-0 items-center gap-1"
                onClick={() => void saves.current?.flush().catch(() => {})}
              >
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
        <span className="whitespace-nowrap">
          {words} {words === 1 ? 'word' : 'words'} · Markdown
        </span>
      </footer>
    </>
  );
});
