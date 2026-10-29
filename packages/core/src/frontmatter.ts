/**
 * YAML frontmatter and `#tags`, the two ways Obsidian attaches properties to a note.
 *
 * Only the YAML that notes actually carry is read: `key: value`, `key: [a, b]`, and a key
 * followed by `- item` lines. Anything else is kept as written and shown as text. The block
 * is never rewritten, so a note with richer YAML loses nothing.
 */
import { prose } from './links';

export interface Frontmatter {
  /** Offset just past the closing `---` line, where the note's text begins. */
  end: number;
  /** Each property in order, with its value as one string or a list of strings. */
  properties: { key: string; value: string | string[] }[];
}

const OPEN = /^---[ \t]*\r?\n/;

/** The frontmatter block at the start of a note, or undefined when there is none. */
export function parseFrontmatter(markdown: string): Frontmatter | undefined {
  if (!OPEN.test(markdown)) return undefined;
  const lines = markdown.split('\n');
  let close = -1;
  for (let n = 1; n < lines.length; n++) {
    if (/^(---|\.\.\.)[ \t]*\r?$/.test(lines[n]!)) {
      close = n;
      break;
    }
  }
  if (close === -1) return undefined;
  let end = 0;
  for (let n = 0; n <= close; n++) end += lines[n]!.length + 1;
  end = Math.min(end, markdown.length);
  const properties: Frontmatter['properties'] = [];
  for (let n = 1; n < close; n++) {
    const line = lines[n]!.replace(/\r$/, '');
    const match = /^([^\s:#][^:]*?):(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
    if (!match) {
      // A `- item` line continues the key above.
      const item = /^[ \t]+-[ \t]*(.*?)[ \t]*$/.exec(line);
      const last = properties[properties.length - 1];
      if (item && last && Array.isArray(last.value)) last.value.push(unquote(item[1]!));
      continue;
    }
    const key = match[1]!;
    const raw = match[2] ?? '';
    if (!raw) {
      properties.push({ key, value: [] });
    } else if (/^\[.*\]$/.test(raw)) {
      properties.push({
        key,
        value: raw
          .slice(1, -1)
          .split(',')
          .map((part) => unquote(part.trim()))
          .filter(Boolean),
      });
    } else properties.push({ key, value: unquote(raw) });
  }
  return { end, properties };
}

function unquote(value: string): string {
  const match = /^(['"])(.*)\1$/.exec(value);
  return match ? match[2]! : value;
}

/** A tag as Obsidian accepts it: letters, digits, `_`, `-`, `/`, and at least one non-digit. */
const TAG_CHARS = /^[\p{L}\p{N}_\-/]+$/u;
const isTag = (text: string) => TAG_CHARS.test(text) && /[^\p{N}]/u.test(text);

/** Tags named in frontmatter, under `tags` or `tag`, with or without a leading `#`. */
export function frontmatterTags(frontmatter: Frontmatter | undefined): string[] {
  if (!frontmatter) return [];
  const tags: string[] = [];
  for (const { key, value } of frontmatter.properties) {
    if (key !== 'tags' && key !== 'tag') continue;
    const items = Array.isArray(value) ? value : value.split(/[,\s]+/);
    for (const item of items) {
      const tag = item.replace(/^#/, '').trim();
      if (tag && isTag(tag)) tags.push(tag);
    }
  }
  return tags;
}

export interface InlineTag {
  tag: string;
  /** Offsets of the `#tag` text in the note. */
  from: number;
  to: number;
}

/** `#tags` in the note's own text, given the text with code already blanked. */
export function inlineTags(prose: string, start = 0): InlineTag[] {
  const tags: InlineTag[] = [];
  const pattern = /(^|[\s(\[{,;])#([\p{L}\p{N}_\-/]+)/gmu;
  for (const match of prose.slice(start).matchAll(pattern)) {
    const tag = match[2]!;
    if (!isTag(tag)) continue;
    const from = start + match.index + match[1]!.length;
    tags.push({ tag, from, to: from + 1 + tag.length });
  }
  return tags;
}

/** Tags compare without regard to letter case, and the first spelling seen is kept. */
export function tagKey(tag: string): string {
  return tag.toLowerCase();
}

/**
 * Every tag a note carries, from its frontmatter and its text, each once in the spelling
 * first seen. Code is ignored, as it is for links.
 */
export function parseTags(markdown: string): string[] {
  const frontmatter = parseFrontmatter(markdown);
  const seen = new Map<string, string>();
  for (const tag of frontmatterTags(frontmatter)) seen.set(tagKey(tag), tag);
  for (const { tag } of inlineTags(prose(markdown), frontmatter?.end ?? 0))
    if (!seen.has(tagKey(tag))) seen.set(tagKey(tag), tag);
  return [...seen.values()];
}
