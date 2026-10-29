import { RangeSetBuilder, StateEffect, StateField, type EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { GFM, parser } from '@lezer/markdown';
import { cellOffset, parseTable, splitLink, type Table } from '@opsidian/core';
import { wikiLink, type PreviewOptions } from './live-preview';

/**
 * Whether the editor has focus, kept in the state so the table field can see it. Shared by
 * every preview, so redrawing previews does not lose it.
 */
const setFocus = StateEffect.define<boolean>();
const focused = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setFocus)) value = effect.value;
    return value;
  },
});
const trackFocus = [
  focused,
  EditorView.focusChangeEffect.of((_, focusing) => setFocus.of(focusing)),
];

/**
 * Tables drawn as tables: those at the top level of the note that the cursor is not in.
 * Tables inside quotes and lists stay as text.
 */
export function drawnTables(state: EditorState, hasFocus: boolean) {
  const tables: { from: number; to: number }[] = [];
  for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) {
    if (node.name !== 'Table') continue;
    const from = state.doc.lineAt(node.from).from,
      to = state.doc.lineAt(node.to).to;
    if (hasFocus && state.selection.ranges.some((range) => range.from <= to && range.to >= from))
      continue;
    tables.push({ from, to });
  }
  return tables;
}

const WIKI_LINK = /!?\[\[([^\]\n]+)\]\]/g;
/** Wiki links stand in the cell as one private-use character each while it is parsed. */
const PLACEHOLDER = /[-]/g;

/** A cell holds only inline Markdown, so every block construct is switched off. */
const inline = parser.configure([
  GFM,
  {
    remove: [
      'SetextHeading',
      'ATXHeading',
      'FencedCode',
      'IndentedCode',
      'Blockquote',
      'HorizontalRule',
      'BulletList',
      'OrderedList',
      'HTMLBlock',
      'LinkReference',
      'Table',
    ],
  },
]);
type Node = ReturnType<typeof inline.parse>['topNode'];

const STYLES: Record<string, string> = {
  StrongEmphasis: 'op-strong',
  Emphasis: 'op-emphasis',
  Strikethrough: 'op-strike',
};

/** Draws a cell's inline Markdown with DOM nodes and text, never as HTML. */
function renderCell(parent: HTMLElement, text: string, options: PreviewOptions) {
  const links: string[] = [];
  const masked = /[\ue000-\uf8ff]/.test(text)
    ? text
    : text.replace(WIKI_LINK, (link) => String.fromCharCode(0xe000 + links.push(link) - 1));
  const unmask = (part: string) =>
    part.replace(PLACEHOLDER, (char) => links[char.charCodeAt(0) - 0xe000] ?? char);
  const append = (into: HTMLElement, part: string) => {
    let at = 0;
    for (const match of part.matchAll(PLACEHOLDER)) {
      const link = links[match[0].charCodeAt(0) - 0xe000];
      if (link === undefined) continue;
      into.append(part.slice(at, match.index));
      const inner = link.replace(/^!?\[\[|\]\]$/g, '');
      const { target } = splitLink(inner);
      into.append(
        wikiLink(inner, !target || (options.linkExists?.(target) ?? true), options.onLink),
      );
      at = match.index + 1;
    }
    into.append(part.slice(at));
  };
  const walk = (node: Node, into: HTMLElement) => {
    let at = node.from;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      append(into, masked.slice(at, child.from));
      at = child.to;
      if (child.name.endsWith('Mark')) continue;
      if (child.name === 'Paragraph') walk(child, into);
      else if (child.name === 'Escape') append(into, masked.slice(child.from + 1, child.to));
      else if (child.name === 'InlineCode') {
        const code = document.createElement('code');
        code.className = 'op-code';
        let body = unmask(masked.slice(child.firstChild!.to, child.lastChild!.from));
        if (/^ .*\S.* $/.test(body)) body = body.slice(1, -1);
        code.textContent = body;
        into.append(code);
      } else if (STYLES[child.name]) {
        const span = document.createElement('span');
        span.className = STYLES[child.name]!;
        walk(child, span);
        into.append(span);
      } else append(into, masked.slice(child.from, child.to));
    }
    append(into, masked.slice(at, node.to));
  };
  walk(inline.parse(masked).topNode, parent);
}

class TableWidget extends WidgetType {
  constructor(
    readonly table: Table,
    /** The table's text and which of its links exist: what decides how it is drawn. */
    readonly key: string,
    readonly options: PreviewOptions,
  ) {
    super();
  }
  eq(other: TableWidget) {
    return this.key === other.key;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('div');
    wrap.className = 'op-table-wrap';
    const table = document.createElement('table');
    table.className = 'op-table';
    const head = document.createElement('thead'),
      body = document.createElement('tbody');
    const addRow = (section: HTMLElement, cells: string[], tag: 'th' | 'td', line: number) => {
      const row = document.createElement('tr');
      row.dataset.line = String(line);
      cells.forEach((text, index) => {
        const cell = document.createElement(tag);
        const align = this.table.align[index];
        if (align) cell.style.textAlign = align;
        renderCell(cell, text, this.options);
        row.append(cell);
      });
      section.append(row);
    };
    addRow(head, this.table.header, 'th', 0);
    // The delimiter row is the second line, so body rows start on the third.
    this.table.rows.forEach((cells, index) => addRow(body, cells, 'td', index + 2));
    table.append(head, body);
    wrap.append(table);
    // Clicking a cell shows the table's Markdown with the cursor in that cell.
    wrap.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (view.state.readOnly || target.closest('.op-wikilink')) return;
      if (window.getSelection()?.isCollapsed === false) return;
      const row = target.closest('tr'),
        cell = target.closest('th, td');
      const { doc } = view.state;
      const first = doc.lineAt(view.posAtDOM(wrap)).number;
      const line = doc.line(Math.min(first + Number(row?.dataset.line ?? 0), doc.lines));
      const index = cell && row ? Array.prototype.indexOf.call(row.children, cell) : 0;
      view.dispatch({ selection: { anchor: line.from + cellOffset(line.text, index) } });
      view.focus();
    });
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

function tableField(options: PreviewOptions) {
  const build = (state: EditorState) => {
    const builder = new RangeSetBuilder<Decoration>();
    for (const { from, to } of drawnTables(state, state.field(focused))) {
      const source = state.sliceDoc(from, to);
      const table = parseTable(source);
      if (!table) continue;
      const exists = [...table.header, ...table.rows.flat()]
        .flatMap((cell) => [...cell.matchAll(WIKI_LINK)])
        .map((match) => {
          const { target } = splitLink(match[1]!);
          return !target || (options.linkExists?.(target) ?? true) ? '1' : '0';
        })
        .join('');
      builder.add(
        from,
        to,
        Decoration.replace({
          widget: new TableWidget(table, `${source}\0${exists}`, options),
          block: true,
        }),
      );
    }
    return builder.finish();
  };
  return StateField.define<DecorationSet>({
    create: build,
    update(value, transaction) {
      if (
        transaction.docChanged ||
        transaction.selection ||
        transaction.effects.some((effect) => effect.is(setFocus)) ||
        syntaxTree(transaction.startState) !== syntaxTree(transaction.state)
      )
        return build(transaction.state);
      return value;
    },
    // A table covers whole lines, which only a state field may replace.
    provide: (field) => EditorView.decorations.from(field),
  });
}

export function tablePreview(options: PreviewOptions) {
  return [trackFocus, tableField(options)];
}
