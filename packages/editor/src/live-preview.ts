import { RangeSetBuilder } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';

export interface PreviewOptions {
  resolveImage(path: string): string | undefined;
  onLink(name: string): void;
}

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly from: number,
  ) {
    super();
  }
  eq(other: CheckboxWidget) {
    return this.checked === other.checked && this.from === other.from;
  }
  toDOM(view: EditorView) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.checked;
    box.className = 'op-task';
    box.setAttribute('aria-label', this.checked ? 'Mark task incomplete' : 'Mark task complete');
    box.addEventListener('change', () => {
      view.dispatch({
        changes: { from: this.from, to: this.from + 3, insert: box.checked ? '[x]' : '[ ]' },
      });
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly alt: string,
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return this.url === other.url && this.alt === other.alt;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('span');
    wrap.className = 'op-image';
    const image = document.createElement('img');
    image.src = this.url;
    image.alt = this.alt;
    image.loading = 'lazy';
    image.addEventListener('load', () => view.requestMeasure());
    wrap.append(image);
    return wrap;
  }
}

class LinkWidget extends WidgetType {
  constructor(
    readonly name: string,
    readonly onLink: (name: string) => void,
  ) {
    super();
  }
  eq(other: LinkWidget) {
    return this.name === other.name;
  }
  toDOM() {
    const button = document.createElement('button');
    button.className = 'op-wikilink';
    button.textContent = this.name;
    button.type = 'button';
    button.addEventListener('click', () => this.onLink(this.name));
    return button;
  }
  ignoreEvent() {
    return true;
  }
}

export function isCodeAt(view: EditorView, pos: number) {
  let node = syntaxTree(view.state).resolveInner(pos, 1);
  for (;;) {
    if (['InlineCode', 'FencedCode', 'CodeBlock'].includes(node.name)) return true;
    if (!node.parent) return false;
    node = node.parent;
  }
}

export function livePreview(options: PreviewOptions) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          update.focusChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        )
          this.decorations = this.build(update.view);
      }
      build(view: EditorView): DecorationSet {
        const { state } = view;
        const ranges: { from: number; to: number; decoration: Decoration }[] = [];
        const active = (from: number, to: number) =>
          view.hasFocus && state.selection.ranges.some((r) => r.from <= to && r.to >= from);
        const add = (from: number, to: number, decoration: Decoration) =>
          ranges.push({ from, to, decoration });
        const markedLines = new Set<number>();
        for (const visible of view.visibleRanges) {
          syntaxTree(state).iterate({
            from: visible.from,
            to: visible.to,
            enter: (node) => {
              const { name, from, to } = node;
              if (['FencedCode', 'CodeBlock', 'InlineCode'].includes(name)) {
                add(from, to, Decoration.mark({ class: 'op-code' }));
                return false;
              }
              if (/^ATXHeading[1-6]$/.test(name)) {
                const line = state.doc.lineAt(from);
                if (!markedLines.has(line.from)) {
                  add(
                    line.from,
                    line.from,
                    Decoration.line({ class: `op-heading op-h${name.slice(-1)}` }),
                  );
                  markedLines.add(line.from);
                }
              }
              if (name === 'StrongEmphasis') add(from, to, Decoration.mark({ class: 'op-strong' }));
              if (name === 'Emphasis') add(from, to, Decoration.mark({ class: 'op-emphasis' }));
              if (name === 'Strikethrough') add(from, to, Decoration.mark({ class: 'op-strike' }));
              if (name === 'Blockquote') add(from, to, Decoration.mark({ class: 'op-quote' }));
              if (name === 'Image' && !active(from, to)) {
                const text = state.sliceDoc(from, to);
                const match = /^!\[([^\]]*)\]\(([^\s)]+)\)$/.exec(text);
                const url = match?.[2] ? options.resolveImage(match[2]) : undefined;
                if (url && /^data:image\/(png|jpeg|gif|webp);base64,/.test(url)) {
                  add(
                    from,
                    to,
                    Decoration.replace({ widget: new ImageWidget(url, match?.[1] ?? '') }),
                  );
                  return false;
                }
              }
              if (name === 'TaskMarker' && !active(from, to)) {
                add(
                  from,
                  to,
                  Decoration.replace({
                    widget: new CheckboxWidget(
                      state.sliceDoc(from, to).toLowerCase() === '[x]',
                      from,
                    ),
                  }),
                );
                return false;
              }
              if (['HeaderMark', 'EmphasisMark', 'StrikethroughMark', 'QuoteMark'].includes(name)) {
                const parent = node.node.parent;
                if (parent && !active(parent.from, parent.to)) {
                  let end = to;
                  if (name === 'HeaderMark' && state.sliceDoc(to, to + 1) === ' ') end++;
                  add(from, end, Decoration.replace({}));
                } else add(from, to, Decoration.mark({ class: 'op-syntax' }));
              }
            },
          });
          const text = state.sliceDoc(visible.from, visible.to);
          for (const match of text.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
            const from = visible.from + match.index,
              to = from + match[0].length;
            if (isCodeAt(view, from)) continue;
            if (active(from, to)) add(from, to, Decoration.mark({ class: 'op-link-source' }));
            else
              add(
                from,
                to,
                Decoration.replace({ widget: new LinkWidget(match[1]!, options.onLink) }),
              );
          }
        }
        const builder = new RangeSetBuilder<Decoration>();
        ranges.sort(
          (a, b) =>
            a.from - b.from || a.decoration.startSide - b.decoration.startSide || a.to - b.to,
        );
        for (const r of ranges) builder.add(r.from, r.to, r.decoration);
        return builder.finish();
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}
