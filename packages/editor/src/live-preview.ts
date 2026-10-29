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
import { encodeDestination, linkLabel, splitLink } from '@opsidian/core';
import { drawnTables, tablePreview } from './table';

export interface PreviewOptions {
  resolveImage(path: string): string | undefined;
  /** Called when a link is clicked. `target` is empty for a `[[#Heading]]` in the same note. */
  onLink(target: string, heading?: string): void;
  /** Lets links to notes that do not exist yet be drawn differently. */
  linkExists?(target: string): boolean;
  /** Text an `![[embed]]` shows, or undefined when there is no such note or heading. */
  loadEmbed?(target: string, heading?: string): Promise<string | undefined>;
  /** Changes whenever embedded notes may have changed, so embeds are drawn again. */
  embedStamp?(): number;
  /** Supplied by the editor: draws Markdown read-only and returns how to remove it. */
  renderEmbed?(parent: HTMLElement, content: string): () => void;
}

const IMAGE_NAME = /\.(png|jpe?g|gif|webp)$/i;

/** Image sources the preview will load: inline raster data, or a file served from the vault. */
const SAFE_IMAGE = /^(data:image\/(png|jpeg|gif|webp);base64,|opsidian:\/\/vault\/)/;

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

export function wikiLink(inner: string, exists: boolean, onLink: PreviewOptions['onLink']) {
  // A span, not a button, so a long link wraps with the sentence around it.
  const link = document.createElement('span');
  link.className = exists ? 'op-wikilink' : 'op-wikilink op-wikilink-unresolved';
  link.textContent = linkLabel(inner);
  link.setAttribute('role', 'link');
  const { target, heading } = splitLink(inner);
  link.addEventListener('mousedown', (event) => event.preventDefault());
  link.addEventListener('click', () => {
    if (target || heading) onLink(target, heading);
  });
  return link;
}

class LinkWidget extends WidgetType {
  constructor(
    readonly inner: string,
    readonly exists: boolean,
    readonly onLink: PreviewOptions['onLink'],
  ) {
    super();
  }
  eq(other: LinkWidget) {
    return this.inner === other.inner && this.exists === other.exists;
  }
  toDOM() {
    return wikiLink(this.inner, this.exists, this.onLink);
  }
  ignoreEvent() {
    return true;
  }
}

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const bullet = document.createElement('span');
    bullet.className = 'op-bullet';
    bullet.setAttribute('aria-hidden', 'true');
    return bullet;
  }
}

/**
 * How to take down the note drawn inside each embed, or null once the embed is gone.
 * Kept by element, not on the widget: the editor reuses the element under an equal widget.
 */
const embedded = new WeakMap<HTMLElement, (() => void) | null>();

class EmbedWidget extends WidgetType {
  constructor(
    readonly inner: string,
    readonly stamp: number,
    readonly options: PreviewOptions,
  ) {
    super();
  }
  eq(other: EmbedWidget) {
    return this.inner === other.inner && this.stamp === other.stamp;
  }
  toDOM(view: EditorView) {
    const { target, heading } = splitLink(this.inner);
    const box = document.createElement('span');
    box.className = 'op-embed';
    const title = document.createElement('span');
    title.className = 'op-embed-title';
    title.textContent = linkLabel(this.inner.split('|')[0]!);
    title.setAttribute('role', 'link');
    title.addEventListener('mousedown', (event) => event.preventDefault());
    title.addEventListener('click', () => this.options.onLink(target, heading));
    const body = document.createElement('span');
    body.className = 'op-embed-body';
    box.append(title, body);
    void this.options.loadEmbed?.(target, heading).then(
      (content) => {
        if (embedded.get(box) === null) return;
        if (content === undefined) {
          box.classList.add('op-embed-missing');
          body.textContent = 'Nothing to show yet. Click the name to create or open it.';
        } else embedded.set(box, this.options.renderEmbed?.(body, content.trimEnd()) ?? null);
        view.requestMeasure();
      },
      () => {
        body.textContent = 'This note could not be read.';
      },
    );
    return box;
  }
  destroy(box: HTMLElement) {
    embedded.get(box)?.();
    embedded.set(box, null);
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
  return [tablePreview(options), inlinePreview(options)];
}

function inlinePreview(options: PreviewOptions) {
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
        const quoteLines = new Set<number>();
        // Drawn tables are left to the table preview.
        const tables = drawnTables(state, view.hasFocus);
        const inTable = (at: number) => tables.some((t) => t.from <= at && at <= t.to);
        for (const visible of view.visibleRanges) {
          syntaxTree(state).iterate({
            from: visible.from,
            to: visible.to,
            enter: (node) => {
              const { name, from, to } = node;
              if (name === 'Table' && inTable(from)) return false;
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
              if (name === 'Blockquote') {
                for (let at = from; at <= to;) {
                  const line = state.doc.lineAt(at);
                  if (!quoteLines.has(line.from)) {
                    add(line.from, line.from, Decoration.line({ class: 'op-quote' }));
                    quoteLines.add(line.from);
                  }
                  at = line.to + 1;
                }
              }
              if (name === 'ListMark' && !active(from, to)) {
                // A checklist shows only its box; an ordered list keeps its number.
                if (/^[ \t]\[[ xX]\][ \t]/.test(state.sliceDoc(to, to + 5)))
                  add(from, to + 1, Decoration.replace({}));
                else if (node.node.parent?.parent?.name === 'BulletList')
                  add(from, to, Decoration.replace({ widget: new BulletWidget() }));
                else add(from, to, Decoration.mark({ class: 'op-list-number' }));
                return false;
              }
              if (name === 'Image' && !active(from, to)) {
                const text = state.sliceDoc(from, to);
                const match = /^!\[([^\]]*)\]\(([^\s)]+)\)$/.exec(text);
                const url = match?.[2] ? options.resolveImage(match[2]) : undefined;
                if (url && SAFE_IMAGE.test(url)) {
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
          for (const match of text.matchAll(/!?\[\[([^\]\n]+)\]\]/g)) {
            const from = visible.from + match.index,
              to = from + match[0].length;
            const inner = match[1]!;
            const { target } = splitLink(inner);
            if (isCodeAt(view, from) || inTable(from)) continue;
            if (active(from, to)) add(from, to, Decoration.mark({ class: 'op-link-source' }));
            else if (match[0].startsWith('!') && IMAGE_NAME.test(target)) {
              // Image sources are link destinations, so a name is passed in that form.
              const url = options.resolveImage(encodeDestination(target));
              if (url && SAFE_IMAGE.test(url))
                add(from, to, Decoration.replace({ widget: new ImageWidget(url, target) }));
              else add(from, to, Decoration.mark({ class: 'op-link-source' }));
            } else if (match[0].startsWith('!') && options.loadEmbed && options.renderEmbed)
              add(
                from,
                to,
                Decoration.replace({
                  widget: new EmbedWidget(inner, options.embedStamp?.() ?? 0, options),
                }),
              );
            else {
              // Without embed support (or inside an embed) an embed reads as a plain link.
              const start = match[0].startsWith('!') ? from + 1 : from;
              add(
                start,
                to,
                Decoration.replace({
                  widget: new LinkWidget(
                    inner,
                    !target || (options.linkExists?.(target) ?? true),
                    options.onLink,
                  ),
                }),
              );
            }
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
