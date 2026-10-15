import { Annotation, Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  undo,
  redo,
} from '@codemirror/commands';
import { markdown, markdownKeymap } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  startCompletion,
  type CompletionContext,
} from '@codemirror/autocomplete';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { headingOffset } from '@opsidian/core';
import { createSearchPanel } from './search-panel';
import { livePreview, isCodeAt, type PreviewOptions } from './live-preview';

/** Live Preview and Source edit the note; Reading shows it as it reads, with no editing. */
export type EditorMode = 'live' | 'source' | 'reading';
export type EditorCommand =
  'bold' | 'italic' | 'heading' | 'bullet' | 'task' | 'link' | 'undo' | 'redo';
export interface EditorOptions extends PreviewOptions {
  parent: HTMLElement;
  content: string;
  /** Note names offered after `[[`. A function is read each time, so the list can change. */
  suggestions: readonly string[] | (() => readonly string[]);
  /** Called for edits made in the editor, not for `setContent`. */
  onChange(content: string): void;
  onSave(): void;
  mode?: EditorMode;
}
const external = Annotation.define<boolean>();
const highlighting = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.strong, fontWeight: 'calc(var(--op-weight) + 200)' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strikethrough, textDecoration: 'line-through' },
    { tag: tags.monospace, fontFamily: 'ui-monospace, monospace' },
    { tag: tags.processingInstruction, color: 'var(--muted-foreground)' },
  ]),
);

/** Draws Markdown the way the editor does, but fixed. Embeds inside it read as links. */
function renderMarkdown(parent: HTMLElement, content: string, options: PreviewOptions) {
  const { loadEmbed: _load, renderEmbed: _render, ...plain } = options;
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: content,
      extensions: [
        markdown({ extensions: [GFM] }),
        highlighting,
        EditorView.lineWrapping,
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
        livePreview(plain),
      ],
    }),
  });
  return () => view.destroy();
}

export function createEditor(options: EditorOptions) {
  const mode = new Compartment();
  const preview: PreviewOptions = {
    ...options,
    renderEmbed: (parent, content) => renderMarkdown(parent, content, options),
  };
  const suggestions = () =>
    typeof options.suggestions === 'function' ? options.suggestions() : options.suggestions;
  let currentMode = options.mode ?? 'live';
  const modeExtensions = (value: EditorMode) =>
    value === 'source'
      ? []
      : value === 'reading'
        ? [livePreview(preview), EditorView.editable.of(false), EditorState.readOnly.of(true)]
        : livePreview(preview);
  const source = (context: CompletionContext) => {
    const match = context.matchBefore(/\[\[[^\]\n]*/);
    if (!match || isCodeAt(view, match.from)) return null;
    return {
      from: match.from + 2,
      options: suggestions().map((label) => ({
        label,
        type: 'text',
        detail: 'note link',
        apply: (editor: EditorView, _: unknown, from: number, to: number) => {
          const hasClose = editor.state.sliceDoc(to, to + 2) === ']]';
          editor.dispatch({
            changes: { from, to: to + (hasClose ? 2 : 0), insert: `${label}]]` },
            selection: { anchor: from + label.length + 2 },
          });
        },
      })),
      validFor: /^[^\]\n]*$/,
    };
  };
  const view = new EditorView({
    parent: options.parent,
    state: EditorState.create({
      doc: options.content,
      extensions: [
        history(),
        markdown({ extensions: [GFM] }),
        closeBrackets(),
        highlighting,
        search({ top: true, createPanel: createSearchPanel }),
        highlightSelectionMatches(),
        autocompletion({ override: [source], activateOnTyping: true }),
        keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              options.onSave();
              return true;
            },
          },
          {
            key: 'Mod-b',
            run: () => {
              command('bold');
              return true;
            },
          },
          {
            key: 'Mod-i',
            run: () => {
              command('italic');
              return true;
            },
          },
          ...markdownKeymap,
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          indentWithTab,
        ]),
        EditorView.lineWrapping,
        placeholder('A thought worth keeping…'),
        EditorView.contentAttributes.of({
          'aria-label': 'Note editor',
          spellcheck: 'true',
          autocapitalize: 'sentences',
          autocorrect: 'on',
        }),
        EditorView.updateListener.of((update) => {
          if (
            update.docChanged &&
            !update.transactions.some((transaction) => transaction.annotation(external))
          )
            options.onChange(update.state.doc.toString());
        }),
        mode.of(modeExtensions(currentMode)),
      ],
    }),
  });
  function insert(text: string) {
    view.dispatch(view.state.replaceSelection(text));
    view.focus();
  }
  function wrap(marker: string) {
    const { from, to } = view.state.selection.main;
    const selected = view.state.sliceDoc(from, to);
    view.dispatch({
      changes: { from, to, insert: marker + selected + marker },
      selection: { anchor: from + marker.length, head: to + marker.length },
    });
    view.focus();
  }
  function command(name: EditorCommand) {
    if (name === 'undo') {
      undo(view);
      view.focus();
      return;
    }
    if (name === 'redo') {
      redo(view);
      view.focus();
      return;
    }
    if (name === 'bold' || name === 'italic') {
      wrap(name === 'bold' ? '**' : '*');
      return;
    }
    if (name === 'link') {
      insert('[[');
      startCompletion(view);
      return;
    }
    const { from, to } = view.state.selection.main;
    const start = view.state.doc.lineAt(from).number,
      end = view.state.doc.lineAt(to).number;
    const prefix = { heading: '## ', bullet: '- ', task: '- [ ] ' }[name];
    const changes = [];
    for (let n = start; n <= end; n++)
      changes.push({ from: view.state.doc.line(n).from, insert: prefix });
    view.dispatch({ changes });
    view.focus();
  }
  return {
    view,
    insert,
    command,
    setMode(value: EditorMode) {
      currentMode = value;
      view.dispatch({ effects: mode.reconfigure(modeExtensions(value)) });
    },
    /** Redraws previews after images or the set of existing notes changed. */
    refresh() {
      if (currentMode !== 'source')
        view.dispatch({ effects: mode.reconfigure(modeExtensions(currentMode)) });
    },
    /**
     * Replaces the text with a version loaded from elsewhere. Only the part that differs is
     * touched, so the cursor and the scroll position stay with the text around them.
     */
    setContent(text: string) {
      // The editor holds lines joined by "\n", whatever the file uses.
      const content = text.replace(/\r\n?/g, '\n');
      const before = view.state.doc.toString();
      if (before === content) return;
      let start = 0;
      const limit = Math.min(before.length, content.length);
      while (start < limit && before[start] === content[start]) start++;
      let end = 0;
      while (
        end < limit - start &&
        before[before.length - 1 - end] === content[content.length - 1 - end]
      )
        end++;
      view.dispatch({
        changes: {
          from: start,
          to: before.length - end,
          insert: content.slice(start, content.length - end),
        },
        annotations: external.of(true),
      });
    },
    /** Replaces the whole text as an edit the user made: it is saved and can be undone. */
    replaceAll(content: string) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
      view.focus();
    },
    /** Puts a heading at the top of the view. False when the note has no such heading. */
    scrollToHeading(heading: string): boolean {
      const at = headingOffset(view.state.doc.toString(), heading);
      if (at === undefined) return false;
      view.dispatch({
        selection: { anchor: view.state.doc.lineAt(at).to },
        effects: EditorView.scrollIntoView(at, { y: 'start', yMargin: 24 }),
      });
      return true;
    },
    destroy() {
      view.destroy();
    },
  };
}
export type OpsidianEditor = ReturnType<typeof createEditor>;
