/**
 * A note as plain HTML, for a page shown to someone without Opsidian: a shared link, or an
 * exported file. The editor draws notes with CodeMirror; this is the same Markdown, read once
 * by the same parser, and written out as HTML with nothing live in it.
 *
 * Nothing in the note becomes markup except what Markdown says is markup: HTML written in a
 * note is shown as text, as tables already show it, so a note can never carry a script or a
 * form onto the page. Comments, `<!-- -->` and `%% %%`, which Reading view hides, are left out
 * rather than shown.
 */
import { GFM, parser as markdownParser } from '@lezer/markdown';
import type { SyntaxNode } from '@lezer/common';
import { parseFrontmatter, inlineTags } from './frontmatter';
import { linkLabel, linkResolver, noteTitle, parseLinks, prose, splitLink } from './links';

export interface RenderOptions {
  /**
   * Where a file the note embeds or links to can be fetched: `attachments/a.png` → an address,
   * or undefined when it is not being shared, in which case the note shows its name instead.
   */
  file?: (path: string) => string | undefined;
  /** Where another note is, for a `[[link]]` to one that is also reachable; undefined unlinks it. */
  note?: (path: string) => string | undefined;
  /** Every path in the notebook, so `[[Name]]` finds the note or image it means. */
  paths?: Iterable<string>;
}

const parser = markdownParser.configure(GFM);
const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;
const SAFE_URL = /^(https?:|mailto:|tel:)/i;
const MARKS = new Set([
  'HeaderMark',
  'QuoteMark',
  'ListMark',
  'LinkMark',
  'EmphasisMark',
  'CodeMark',
  'CodeInfo',
  'LinkTitle',
  'LinkLabel',
  'StrikethroughMark',
  'TableDelimiter',
  'TaskMarker',
]);

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** `%%comments%%` removed, since Reading view hides them and a reader was not meant to see them. */
function withoutComments(markdown: string): string {
  const text = prose(markdown);
  let result = '';
  let copied = 0;
  for (const match of text.matchAll(/%%[\s\S]*?%%/g)) {
    result += markdown.slice(copied, match.index);
    copied = match.index + match[0].length;
  }
  return copied ? result + markdown.slice(copied) : markdown;
}

interface Wiki {
  from: number;
  to: number;
  embed: boolean;
  inner: string;
}

class Renderer {
  private readonly text: string;
  private readonly wikis: Wiki[];
  private readonly resolve: (target: string) => string | undefined;
  /** Files the note asked for, whether or not they were available. */
  readonly files = new Set<string>();

  constructor(
    markdown: string,
    private readonly options: RenderOptions,
  ) {
    this.text = markdown;
    this.resolve = linkResolver(options.paths ?? []);
    this.wikis = parseLinks(markdown).map((link) => ({
      from: markdown[link.from - 1] === '!' ? link.from - 1 : link.from,
      to: link.to,
      embed: markdown[link.from - 1] === '!',
      inner: markdown.slice(link.from + 2, link.to - 2),
    }));
  }

  render(): string {
    const tree = parser.parse(this.text);
    return this.blocks(tree.topNode, false);
  }

  private children(node: SyntaxNode): SyntaxNode[] {
    const found: SyntaxNode[] = [];
    for (let child = node.firstChild; child; child = child.nextSibling) found.push(child);
    return found;
  }
  private slice(node: SyntaxNode): string {
    return this.text.slice(node.from, node.to);
  }

  private blocks(node: SyntaxNode, tight: boolean): string {
    return this.children(node)
      .map((child) => this.block(child, tight))
      .join('');
  }

  private block(node: SyntaxNode, tight: boolean): string {
    const { name } = node;
    if (MARKS.has(name)) return '';
    switch (name) {
      case 'Paragraph':
        return tight ? this.inline(node).trim() : `<p>${this.inline(node).trim()}</p>\n`;
      case 'ATXHeading1':
      case 'ATXHeading2':
      case 'ATXHeading3':
      case 'ATXHeading4':
      case 'ATXHeading5':
      case 'ATXHeading6':
      case 'SetextHeading1':
      case 'SetextHeading2': {
        const level = name.endsWith('1') ? 1 : Number(name.slice(-1));
        return `<h${level}>${this.inline(node).trim()}</h${level}>\n`;
      }
      case 'Blockquote':
        return `<blockquote>\n${this.blocks(node, false)}</blockquote>\n`;
      case 'HorizontalRule':
        return '<hr>\n';
      case 'BulletList':
      case 'OrderedList': {
        const items = this.children(node).filter((child) => child.name === 'ListItem');
        const loose = items.some(
          (item, index) =>
            (index > 0 && /\n[ \t]*\n/.test(this.text.slice(items[index - 1]!.to, item.from))) ||
            this.children(item).filter(
              (child) =>
                !MARKS.has(child.name) &&
                child.name !== 'BulletList' &&
                child.name !== 'OrderedList',
            ).length > 1,
        );
        const start = /^\s*(\d+)/.exec(this.slice(node))?.[1];
        const open =
          name === 'OrderedList' && start && start !== '1'
            ? `<ol start="${start}">`
            : `<${name === 'OrderedList' ? 'ol' : 'ul'}>`;
        return `${open}\n${items.map((item) => this.item(item, !loose)).join('')}</${name === 'OrderedList' ? 'ol' : 'ul'}>\n`;
      }
      case 'Task': {
        const marker = node.getChild('TaskMarker');
        const checked = marker ? /x/i.test(this.slice(marker)) : false;
        return `<span class="task"><input type="checkbox" disabled${checked ? ' checked' : ''}> ${this.inline(node).trim()}</span>`;
      }
      case 'FencedCode': {
        const info = node.getChild('CodeInfo');
        const language = info ? /^[\w+#-]+/.exec(this.slice(info))?.[0] : undefined;
        const code = this.children(node)
          .filter((child) => child.name === 'CodeText')
          .map((child) => this.slice(child))
          .join('\n');
        return `<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${escapeHtml(code)}\n</code></pre>\n`;
      }
      case 'CodeBlock': {
        const code = this.children(node)
          .filter((child) => child.name === 'CodeText')
          .map((child) => this.slice(child))
          .join('\n');
        return `<pre><code>${escapeHtml(code)}\n</code></pre>\n`;
      }
      case 'Table':
        return this.table(node);
      case 'HTMLBlock':
      case 'ProcessingInstructionBlock':
        // Shown as written, never run.
        return `<p>${escapeHtml(this.slice(node))}</p>\n`;
      case 'CommentBlock':
      case 'LinkReference':
        return '';
      default:
        return node.firstChild ? this.blocks(node, tight) : escapeHtml(this.slice(node));
    }
  }

  private item(node: SyntaxNode, tight: boolean): string {
    const parts = this.children(node).filter((child) => !MARKS.has(child.name));
    const task = parts[0]?.name === 'Task';
    const inner = parts
      .map((child, index) => {
        const html = this.block(child, tight);
        // A nested list follows its item's text on a new line either way.
        return index > 0 && (child.name === 'BulletList' || child.name === 'OrderedList')
          ? `\n${html}`
          : html;
      })
      .join('');
    return `<li${task ? ' class="task-item"' : ''}>${inner}</li>\n`;
  }

  private table(node: SyntaxNode): string {
    const delimiter = node.getChild('TableDelimiter');
    const aligns = delimiter
      ? this.slice(delimiter)
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((mark) => {
            const cell = mark.trim();
            const left = cell.startsWith(':');
            const right = cell.endsWith(':');
            return left && right ? 'center' : right ? 'right' : left ? 'left' : undefined;
          })
      : [];
    const row = (line: SyntaxNode, tag: 'th' | 'td') =>
      `<tr>${this.children(line)
        .filter((cell) => cell.name === 'TableCell')
        .map(
          (cell, index) =>
            `<${tag}${aligns[index] ? ` align="${aligns[index]}"` : ''}>${this.inline(cell).trim()}</${tag}>`,
        )
        .join('')}</tr>\n`;
    const header = node.getChild('TableHeader');
    const body = this.children(node).filter((child) => child.name === 'TableRow');
    return (
      `<table>\n` +
      (header ? `<thead>\n${row(header, 'th')}</thead>\n` : '') +
      (body.length ? `<tbody>\n${body.map((line) => row(line, 'td')).join('')}</tbody>\n` : '') +
      `</table>\n`
    );
  }

  /** The content of an inline container, from after its opening marks to its end. */
  private inline(node: SyntaxNode, until = node.to): string {
    const children = this.children(node);
    let html = '';
    let position = node.from;
    for (const child of children) {
      if (child.from < position || child.from >= until) continue;
      // Anything the parser found inside a [[link]] belongs to the link.
      if (this.wikis.some((wiki) => child.from >= wiki.from && child.from < wiki.to)) continue;
      html += this.plain(position, child.from);
      html += this.span(child);
      position = child.to;
    }
    return html + this.plain(position, Math.min(until, node.to));
  }

  /** The `]` that closes a link's text, after which its destination follows. */
  private closing(node: SyntaxNode): SyntaxNode | undefined {
    const marks = this.children(node).filter((child) => child.name === 'LinkMark');
    return marks.find((mark, index) => index > 0 && this.slice(mark) === ']');
  }
  /** The text between a link's brackets, drawn. */
  private label(node: SyntaxNode): string {
    return this.inline(node, this.closing(node)?.from ?? node.to);
  }
  /**
   * The text between a link's brackets as written, escaped, for an attribute: drawn text
   * carries markup of its own, whose quotes would end the attribute.
   */
  private labelText(node: SyntaxNode): string {
    const open = this.children(node).find((child) => child.name === 'LinkMark');
    const from = open?.to ?? node.from;
    const to = this.closing(node)?.from ?? node.to;
    return escapeHtml(this.text.slice(from, to));
  }

  /** Text with no markup of its own: wiki links and #tags are found here. */
  private plain(from: number, to: number): string {
    if (from >= to) return '';
    let html = '';
    let position = from;
    for (const wiki of this.wikis) {
      if (wiki.from < from || wiki.from >= to) continue;
      html += this.words(position, wiki.from);
      html += this.wiki(wiki);
      position = Math.min(wiki.to, to);
    }
    return html + this.words(position, to);
  }

  private words(from: number, to: number): string {
    if (from >= to) return '';
    const text = this.text.slice(from, to);
    let html = '';
    let copied = 0;
    for (const { tag, from: start, to: end } of inlineTags(text)) {
      html += escapeHtml(text.slice(copied, start));
      html += `<span class="tag">#${escapeHtml(tag)}</span>`;
      copied = end;
    }
    return html + escapeHtml(text.slice(copied));
  }

  private wiki(link: Wiki): string {
    const { target } = splitLink(link.inner);
    const label = escapeHtml(linkLabel(link.inner));
    const path = target ? this.resolve(target) : undefined;
    if (link.embed) {
      if (path && !/\.md$/i.test(path)) return this.media(path, label, label, '');
      // A file that is not in the notebook, by the look of its name.
      if (!path && /\.[a-z0-9]{1,5}$/i.test(target) && !/\.md$/i.test(target))
        return `<span class="missing">${label}</span>`;
      const where = path && this.options.note?.(path);
      const title = escapeHtml(path ? noteTitle(path) : target);
      return where
        ? `<a class="embed" href="${escapeHtml(where)}">${title}</a>`
        : `<span class="embed">${title}</span>`;
    }
    const where = path && this.options.note?.(path);
    return where
      ? `<a class="wiki" href="${escapeHtml(where)}">${label}</a>`
      : `<span class="wiki">${label}</span>`;
  }

  /**
   * An image, or a link to any other file, by its path in the notebook. `alt` is plain
   * escaped text, safe inside an attribute; `label` is drawn text, for between tags.
   */
  private media(path: string, label: string, alt: string, title: string): string {
    // Another note is never published with this one, whichever way it is written.
    if (/\.md$/i.test(path)) {
      const where = this.options.note?.(path);
      const shown = label || escapeHtml(noteTitle(path));
      return where
        ? `<a class="wiki" href="${escapeHtml(where)}">${shown}</a>`
        : `<span class="wiki">${shown}</span>`;
    }
    this.files.add(path);
    const where = this.options.file?.(path);
    if (!where) return `<span class="missing">${label || escapeHtml(noteTitle(path))}</span>`;
    const href = escapeHtml(where);
    if (IMAGE.test(path)) return `<img src="${href}" alt="${alt}"${title}>`;
    return `<a href="${href}"${title}>${label || escapeHtml(path.slice(path.lastIndexOf('/') + 1))}</a>`;
  }

  private span(node: SyntaxNode): string {
    const { name } = node;
    if (MARKS.has(name)) return '';
    switch (name) {
      case 'Escape':
        return escapeHtml(this.slice(node).slice(1));
      case 'Entity':
        return this.slice(node);
      case 'HardBreak':
        return '<br>\n';
      case 'Emphasis':
        return `<em>${this.inline(node)}</em>`;
      case 'StrongEmphasis':
        return `<strong>${this.inline(node)}</strong>`;
      case 'Strikethrough':
        return `<del>${this.inline(node)}</del>`;
      case 'InlineCode': {
        const marks = this.children(node).filter((child) => child.name === 'CodeMark');
        const from = marks[0]?.to ?? node.from;
        const to = marks[marks.length - 1]?.from ?? node.to;
        return `<code>${escapeHtml(this.text.slice(from, to).replace(/\n/g, ' '))}</code>`;
      }
      case 'Link':
      case 'Image':
        return this.link(node, name === 'Image');
      case 'Autolink': {
        const url = node.getChild('URL');
        const address = url ? this.slice(url) : this.slice(node).slice(1, -1);
        return this.anchor(address, escapeHtml(address));
      }
      case 'URL': {
        const address = this.slice(node);
        return this.anchor(address, escapeHtml(address));
      }
      case 'Comment':
        return '';
      case 'HTMLTag':
      case 'ProcessingInstruction':
        return escapeHtml(this.slice(node));
      case 'Task':
        return this.block(node, true);
      default:
        return node.firstChild ? this.inline(node) : escapeHtml(this.slice(node));
    }
  }

  private anchor(address: string, label: string, title = ''): string {
    const href = /^[\w.+-]+@/.test(address)
      ? `mailto:${address}`
      : /^www\./i.test(address)
        ? `https://${address}`
        : address;
    if (!SAFE_URL.test(href)) return label;
    return `<a href="${escapeHtml(href)}" rel="noopener noreferrer"${title}>${label}</a>`;
  }

  /** `[text](destination "title")` and `![alt](destination)`. A shortcut `[text]` stays as written. */
  private link(node: SyntaxNode, image: boolean): string {
    // The destination follows the closing bracket; an address inside the text is not it.
    const closing = this.closing(node);
    const after = this.children(node).filter((child) => child.from >= (closing?.to ?? node.to));
    const url = after.find((child) => child.name === 'URL');
    const label = this.label(node);
    if (!url) return `[${label}]`;
    const alt = this.labelText(node);
    const titleNode = after.find((child) => child.name === 'LinkTitle');
    const title = titleNode ? ` title="${escapeHtml(this.slice(titleNode).slice(1, -1))}"` : '';
    const written = this.slice(url).replace(/^<|>$/g, '');
    if (/^[a-z][a-z0-9+.-]*:/i.test(written) || written.startsWith('//')) {
      if (image)
        return SAFE_URL.test(written)
          ? `<img src="${escapeHtml(written)}" alt="${alt}"${title}>`
          : label;
      return this.anchor(written, label, title);
    }
    if (written.startsWith('#')) return label;
    let path: string;
    try {
      path = decodeURI(written);
    } catch {
      return label;
    }
    const found = this.resolve(path) ?? path;
    if (/\.md$/i.test(found) && !image) {
      const where = this.options.note?.(found);
      return where ? `<a class="wiki" href="${escapeHtml(where)}">${label}</a>` : label;
    }
    return this.media(found, label, alt, title);
  }
}

/** The note's frontmatter as a list of properties, the way the editor draws it. */
function properties(markdown: string): { html: string; rest: string } {
  const block = parseFrontmatter(markdown);
  if (!block) return { html: '', rest: markdown };
  const rest = markdown.slice(block.end);
  if (!block.properties.length) return { html: '', rest };
  const rows = block.properties
    .map(({ key, value }) => {
      const tags = key === 'tags' || key === 'tag';
      const values = Array.isArray(value) ? value : [value];
      const shown = values
        .map((each) =>
          tags
            ? `<span class="tag">#${escapeHtml(each.replace(/^#/, ''))}</span>`
            : `<span>${escapeHtml(each)}</span>`,
        )
        .join(Array.isArray(value) && !tags ? ', ' : ' ');
      return `<div class="property"><dt>${escapeHtml(key)}</dt><dd>${shown}</dd></div>\n`;
    })
    .join('');
  return { html: `<dl class="properties">\n${rows}</dl>\n`, rest };
}

/** The body of a note as HTML: its properties, then its text. */
export function renderMarkdown(markdown: string, options: RenderOptions = {}): string {
  const { html, rest } = properties(markdown);
  return html + new Renderer(withoutComments(rest), options).render();
}

/**
 * The paths of every file the note shows or links to, as it would be rendered: what has to
 * travel with the note for the page to be whole. Notes it links to are not included.
 */
export function renderedFiles(markdown: string, paths: Iterable<string>): string[] {
  const renderer = new Renderer(withoutComments(properties(markdown).rest), { paths });
  renderer.render();
  return [...renderer.files];
}

export interface PageOptions {
  title: string;
  /** The rendered body, from `renderMarkdown`. */
  body: string;
  /** A line under the note, such as when the link stops working. */
  footer?: string;
  /** Prevents the page being indexed if it is ever found. */
  robots?: boolean;
}

const STYLE = `
:root { color-scheme: light dark; --bg: #ffffff; --fg: #222222; --muted: #6b6b6b; --faint: #e3e3e3; --accent: #7a5af5; --code: #f3f3f3; --pill: #ece8fd; }
@media (prefers-color-scheme: dark) { :root { --bg: #1e1e1e; --fg: #dcddde; --muted: #9a9a9a; --faint: #363636; --accent: #a78bfa; --code: #2a2a2a; --pill: #33304a; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; -webkit-text-size-adjust: 100%; }
main { max-width: 44rem; margin: 0 auto; padding: 3rem 1.25rem 4rem; }
h1.title { font-size: 2rem; line-height: 1.2; margin: 0 0 1.5rem; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.6em 0 0.5em; font-weight: 600; }
h1 { font-size: 1.7rem; } h2 { font-size: 1.4rem; } h3 { font-size: 1.2rem; } h4, h5, h6 { font-size: 1rem; }
p, ul, ol, blockquote, pre, table, dl { margin: 0 0 1em; }
a { color: var(--accent); }
img { max-width: 100%; height: auto; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; background: var(--code); padding: 0.1em 0.3em; border-radius: 4px; }
pre { background: var(--code); padding: 0.9em 1em; border-radius: 6px; overflow-x: auto; }
pre code { background: none; padding: 0; font-size: 0.85em; }
blockquote { border-left: 3px solid var(--faint); margin-left: 0; padding-left: 1em; color: var(--muted); }
hr { border: 0; border-top: 1px solid var(--faint); margin: 2em 0; }
ul, ol { padding-left: 1.6em; }
li { margin: 0.15em 0; }
li.task-item { list-style: none; margin-left: -1.4em; }
.task input { vertical-align: middle; margin-right: 0.4em; }
table { border-collapse: collapse; display: block; overflow-x: auto; max-width: 100%; }
th, td { border: 1px solid var(--faint); padding: 0.4em 0.7em; text-align: left; vertical-align: top; }
th { font-weight: 600; }
.tag { display: inline-block; background: var(--pill); color: var(--accent); border-radius: 999px; padding: 0 0.6em; font-size: 0.85em; }
.wiki, .embed { color: var(--accent); }
.missing, .embed:not(a) { color: var(--muted); font-style: italic; }
.properties { border: 1px solid var(--faint); border-radius: 8px; padding: 0.5em 1em; font-size: 0.9em; }
.property { display: flex; gap: 1em; padding: 0.2em 0; }
.property dt { color: var(--muted); min-width: 7em; flex-shrink: 0; }
.property dd { margin: 0; }
footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--faint); color: var(--muted); font-size: 0.85rem; }
`;

/** A whole page around a rendered note, with no script and no outside resources. */
export function renderPage(options: PageOptions): string {
  return (
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    (options.robots === false ? '' : `<meta name="robots" content="noindex, nofollow">\n`) +
    `<title>${escapeHtml(options.title)}</title>\n<style>${STYLE}</style>\n</head>\n<body>\n<main>\n` +
    `<h1 class="title">${escapeHtml(options.title)}</h1>\n${options.body}` +
    (options.footer ? `<footer>${options.footer}</footer>\n` : '') +
    `</main>\n</body>\n</html>\n`
  );
}
