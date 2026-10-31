import { EditorState, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import {
  encodeDestination,
  inlineTags,
  linkLabel,
  parseFrontmatter,
  splitLink,
  type Frontmatter,
} from '@opsidian/core';
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
  /** Called when a `#tag` is clicked, in the text or in the properties above it. */
  onTag?(tag: string): void;
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

/** Whether properties are folded away, shared by every note like Obsidian's. */
let propertiesCollapsed = false;

type PropertyKind = 'text' | 'list' | 'number' | 'date' | 'tags';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function propertyKind(key: string, value: string | string[]): PropertyKind {
  if (key === 'tags' || key === 'tag') return 'tags';
  if (Array.isArray(value)) return 'list';
  if (DATE.test(value)) return 'date';
  if (/^-?\d+(\.\d+)?$/.test(value)) return 'number';
  return 'text';
}

/** A `2026-11-01` date written out, without touching the file. */
function formatDate(value: string) {
  const match = DATE.exec(value);
  if (!match) return value;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(date.getTime()) || date.getDate() !== Number(match[3])) return value;
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

const svg = (body: string) =>
  `<svg class="op-property-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICONS: Record<PropertyKind, string> = {
  text: svg('<path d="M2.5 3.5h9M2.5 7h9M2.5 10.5h5.5"/>'),
  list: svg(
    '<path d="M5 3.5h6.5M5 7h6.5M5 10.5h6.5"/><path d="M2.5 3.5h.01M2.5 7h.01M2.5 10.5h.01" stroke-width="1.6"/>',
  ),
  number: svg('<path d="M5.5 2.5 4.5 11.5M9.5 2.5l-1 9M2.5 5H12M2 9h9.5"/>'),
  date: svg(
    '<rect x="2" y="3" width="10" height="9" rx="1.5"/><path d="M2 6h10M5 1.75v2.5M9 1.75v2.5"/>',
  ),
  tags: svg(
    '<path d="M2 2.75v3.6c0 .3.12.58.33.8l5.5 5.5a1.1 1.1 0 0 0 1.56 0l3.04-3.04a1.1 1.1 0 0 0 0-1.56L6.93 2.55A1.1 1.1 0 0 0 6.15 2.2H2.55a.55.55 0 0 0-.55.55z"/><circle cx="4.75" cy="4.95" r=".9" fill="currentColor" stroke="none"/>',
  ),
};

const CHEVRON =
  '<svg class="op-properties-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5"/></svg>';

/** The note's frontmatter drawn as properties, the way Obsidian shows them above the text. */
class PropertiesWidget extends WidgetType {
  constructor(
    readonly raw: string,
    readonly frontmatter: Frontmatter,
    readonly onTag: PreviewOptions['onTag'],
  ) {
    super();
  }
  eq(other: PropertiesWidget) {
    return this.raw === other.raw;
  }
  toDOM(view: EditorView) {
    const box = document.createElement('div');
    box.className = 'op-properties';
    box.classList.toggle('op-properties-collapsed', propertiesCollapsed);
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Properties');
    const edit = (event: Event) => {
      if (view.state.readOnly) return;
      event.preventDefault();
      // Put the cursor on the first property, where the Markdown shows for editing.
      const line = view.state.doc.lineAt(Math.min(4, view.state.doc.length));
      view.dispatch({ selection: { anchor: line.to } });
      view.focus();
    };
    const heading = document.createElement('button');
    heading.type = 'button';
    heading.className = 'op-properties-heading';
    heading.setAttribute('aria-expanded', String(!propertiesCollapsed));
    heading.innerHTML = CHEVRON;
    heading.append('Properties');
    heading.addEventListener('mousedown', (event) => event.preventDefault());
    heading.addEventListener('click', () => {
      propertiesCollapsed = !propertiesCollapsed;
      box.classList.toggle('op-properties-collapsed', propertiesCollapsed);
      heading.setAttribute('aria-expanded', String(!propertiesCollapsed));
      view.requestMeasure();
    });
    box.append(heading);
    const rows = document.createElement('div');
    rows.className = 'op-properties-rows';
    for (const { key, value } of this.frontmatter.properties) {
      const row = document.createElement('div');
      row.className = 'op-property';
      const kind = propertyKind(key, value);
      const name = document.createElement('span');
      name.className = 'op-property-key';
      name.innerHTML = ICONS[kind];
      const label = document.createElement('span');
      label.textContent = key;
      label.title = key;
      name.append(label);
      const values = document.createElement('span');
      values.className = 'op-property-value';
      for (const item of Array.isArray(value) ? value : [value]) {
        if (kind === 'tags' && this.onTag) {
          values.append(tagPill(item.replace(/^#/, ''), this.onTag));
          continue;
        }
        const chip = document.createElement('span');
        chip.className = Array.isArray(value) ? 'op-property-item' : 'op-property-text';
        chip.textContent = kind === 'date' ? formatDate(item) : item;
        if (kind === 'date') chip.title = item;
        values.append(chip);
      }
      row.append(name, values);
      rows.append(row);
    }
    if (!this.frontmatter.properties.length) {
      const empty = document.createElement('span');
      empty.className = 'op-property-empty';
      empty.textContent = 'No properties';
      rows.append(empty);
    }
    rows.addEventListener('mousedown', (event) => {
      if (!(event.target as HTMLElement).closest('.op-tag')) edit(event);
    });
    box.append(rows);
    return box;
  }
  ignoreEvent(event: Event) {
    return event.type === 'mousedown' || event.type === 'click';
  }
}

function tagPill(tag: string, onTag: NonNullable<PreviewOptions['onTag']>) {
  const pill = document.createElement('span');
  pill.className = 'op-tag op-property-tag';
  pill.textContent = tag;
  pill.setAttribute('role', 'link');
  pill.setAttribute('aria-label', `#${tag}`);
  pill.addEventListener('mousedown', (event) => event.preventDefault());
  pill.addEventListener('click', () => onTag(tag));
  return pill;
}

/** Tags in the text are marks, so a click is caught here rather than moving the cursor. */
function tagClicks(options: PreviewOptions) {
  return EditorView.domEventHandlers({
    mousedown(event) {
      const target = (event.target as HTMLElement).closest?.('.op-tag[data-tag]');
      if (!target || !options.onTag || event.button !== 0) return false;
      event.preventDefault();
      options.onTag(target.getAttribute('data-tag')!);
      return true;
    },
  });
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
  return [
    tablePreview(options),
    propertiesPreview(options),
    inlinePreview(options),
    tagClicks(options),
  ];
}

/** Where the note's frontmatter is: from the start to the end of the closing line. */
function frontmatterRange(state: EditorState): { to: number; frontmatter: Frontmatter } | null {
  const head = state.sliceDoc(0, Math.min(state.doc.length, 20000));
  const frontmatter = parseFrontmatter(head);
  if (!frontmatter) return null;
  return { to: state.doc.lineAt(Math.max(0, frontmatter.end - 1)).to, frontmatter };
}

/** Whether the editor has focus, kept in the state so decorations computed from it can know. */
const setFocus = StateEffect.define<boolean>();
const focused = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setFocus)) return effect.value;
    return value;
  },
});

/**
 * Frontmatter is drawn as properties, or as muted Markdown while the cursor is in it. It is a
 * block widget, which the editor only accepts from the state, not from a view plugin.
 */
function propertiesPreview(options: PreviewOptions) {
  return [
    focused,
    EditorView.domEventHandlers({
      focus: (_event, view) => void view.dispatch({ effects: setFocus.of(true) }),
      blur: (_event, view) => void view.dispatch({ effects: setFocus.of(false) }),
    }),
    EditorView.decorations.compute(['doc', 'selection', focused], (state) => {
      const found = frontmatterRange(state);
      if (!found) return Decoration.none;
      const { to, frontmatter } = found;
      const builder = new RangeSetBuilder<Decoration>();
      const active =
        state.field(focused) && state.selection.ranges.some((r) => r.from <= to && r.to >= 0);
      if (active) {
        for (let at = 0; at <= to;) {
          const line = state.doc.lineAt(at);
          builder.add(line.from, line.from, Decoration.line({ class: 'op-frontmatter' }));
          at = line.to + 1;
        }
      } else
        builder.add(
          0,
          to,
          Decoration.replace({
            widget: new PropertiesWidget(state.sliceDoc(0, to), frontmatter, options.onTag),
            block: true,
          }),
        );
      return builder.finish();
    }),
  ];
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
        // Frontmatter is left to the properties extension, which draws it or shows it as is.
        const frontmatterEnd = frontmatterRange(state)?.to ?? 0;
        const inFrontmatter = (at: number) => at < frontmatterEnd;
        for (const visible of view.visibleRanges) {
          syntaxTree(state).iterate({
            from: visible.from,
            to: visible.to,
            enter: (node) => {
              const { name, from, to } = node;
              if (name !== 'Document' && inFrontmatter(from)) return false;
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
          for (const found of inlineTags(text)) {
            const from = visible.from + found.from,
              to = visible.from + found.to;
            if (inFrontmatter(from) || isCodeAt(view, from) || inTable(from)) continue;
            if (active(from, to)) add(from, to, Decoration.mark({ class: 'op-tag-source' }));
            else
              add(
                from,
                to,
                Decoration.mark({
                  class: 'op-tag',
                  attributes: { 'data-tag': found.tag, role: 'link' },
                }),
              );
          }
          for (const match of text.matchAll(/!?\[\[([^\]\n]+)\]\]/g)) {
            const from = visible.from + match.index,
              to = from + match[0].length;
            const inner = match[1]!;
            const { target } = splitLink(inner);
            if (inFrontmatter(from) || isCodeAt(view, from) || inTable(from)) continue;
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
