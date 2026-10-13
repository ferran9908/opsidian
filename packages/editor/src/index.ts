import { Compartment, EditorState } from '@codemirror/state';
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
import { createSearchPanel } from './search-panel';
import { livePreview, isCodeAt, type PreviewOptions } from './live-preview';

export type EditorMode = 'live' | 'source';
export type EditorCommand =
  'bold' | 'italic' | 'heading' | 'bullet' | 'task' | 'link' | 'undo' | 'redo';
export interface EditorOptions extends PreviewOptions {
  parent: HTMLElement;
  content: string;
  suggestions: readonly string[];
  onChange(content: string): void;
  onSave(): void;
  mode?: EditorMode;
}
export function createEditor(options: EditorOptions) {
  const mode = new Compartment();
  let currentMode = options.mode ?? 'live';
  const source = (context: CompletionContext) => {
    const match = context.matchBefore(/\[\[[^\]\n]*/);
    if (!match || isCodeAt(view, match.from)) return null;
    return {
      from: match.from + 2,
      options: options.suggestions.map((label) => ({
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
        syntaxHighlighting(
          HighlightStyle.define([
            { tag: tags.strong, fontWeight: '650' },
            { tag: tags.emphasis, fontStyle: 'italic' },
            { tag: tags.strikethrough, textDecoration: 'line-through' },
            { tag: tags.monospace, fontFamily: 'ui-monospace, monospace' },
            { tag: tags.processingInstruction, color: 'var(--muted-foreground)' },
          ]),
        ),
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
          if (update.docChanged) options.onChange(update.state.doc.toString());
        }),
        mode.of(options.mode === 'source' ? [] : livePreview(options)),
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
      view.dispatch({ effects: mode.reconfigure(value === 'live' ? livePreview(options) : []) });
    },
    refreshAssets() {
      if (currentMode === 'live')
        view.dispatch({ effects: mode.reconfigure(livePreview(options)) });
    },
    destroy() {
      view.destroy();
    },
  };
}
export type OpsidianEditor = ReturnType<typeof createEditor>;
