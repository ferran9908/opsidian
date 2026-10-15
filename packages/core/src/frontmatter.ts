/**
 * A note's properties: the YAML block between `---` lines at the very top of a note, as
 * Obsidian writes it. Only the simple shapes Obsidian itself writes are understood — a value on
 * the same line, a list of `- items`, or a `[flow, list]` — and anything else is kept as it is
 * and shown as written. Changing a property rewrites only that property's lines, so comments,
 * order and anything not understood are left exactly as they were.
 */

export type PropertyType =
  'text' | 'list' | 'tags' | 'number' | 'checkbox' | 'date' | 'datetime' | 'raw';
export type PropertyValue = string | number | boolean | string[] | null;

export interface Property {
  key: string;
  type: PropertyType;
  value: PropertyValue;
  /** The property's own lines, from its key to before the next key. */
  source: string;
  /** Where those lines are in the note: from the start of the key line to after its last line. */
  from: number;
  to: number;
}

export interface Frontmatter {
  /** From the start of the note to after the closing `---` line, including its line break. */
  to: number;
  /** Where the YAML between the two `---` lines starts and ends. */
  bodyFrom: number;
  bodyTo: number;
  properties: Property[];
}

const OPEN = /^---[ \t]*\r?\n/;
const CLOSE = /^(---|\.\.\.)[ \t]*$/;
/** A top-level key: not indented, not a list item, not a comment. */
const KEY = /^([^\s#\-:][^:]*?|-[^\s:][^:]*?)[ \t]*:(?:[ \t]+(.*?))?[ \t]*$/;
const LIST_ITEM = /^[ \t]*-(?:[ \t]+(.*?))?[ \t]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/** Keys that are always lists, whatever they hold. */
const LIST_KEYS = new Set(['aliases', 'alias', 'cssclasses', 'cssclass']);
const TAG_KEYS = new Set(['tags', 'tag']);

/** Where the properties are in a note, if it has any. */
export function readFrontmatter(doc: string): Frontmatter | undefined {
  const open = OPEN.exec(doc);
  if (!open) return undefined;
  const bodyFrom = open[0].length;
  let at = bodyFrom;
  while (at <= doc.length) {
    const end = doc.indexOf('\n', at);
    const line = doc.slice(at, end === -1 ? doc.length : end).replace(/\r$/, '');
    if (CLOSE.test(line)) {
      const to = end === -1 ? doc.length : end + 1;
      return { to, bodyFrom, bodyTo: at, properties: parseProperties(doc, bodyFrom, at) };
    }
    if (end === -1) return undefined;
    at = end + 1;
  }
  return undefined;
}

/** The note without its properties, for showing a note's text on its own. */
export function stripFrontmatter(doc: string): string {
  const found = readFrontmatter(doc);
  return found ? doc.slice(found.to) : doc;
}

function parseProperties(doc: string, from: number, to: number): Property[] {
  const properties: Property[] = [];
  let current: { key: string; rest: string | undefined; from: number; lines: string[] } | undefined;
  const finish = (end: number) => {
    if (!current) return;
    const source = doc.slice(current.from, end);
    properties.push({
      key: current.key,
      ...interpret(current.key, current.rest, current.lines),
      source,
      from: current.from,
      to: end,
    });
    current = undefined;
  };
  let at = from;
  while (at < to) {
    const end = doc.indexOf('\n', at);
    const next = end === -1 || end >= to ? to : end + 1;
    const line = doc.slice(at, next).replace(/\r?\n$/, '');
    const key = KEY.exec(line);
    if (key) {
      finish(at);
      current = { key: unquoteKey(key[1]!), rest: key[2], from: at, lines: [] };
    } else if (current) current.lines.push(line);
    at = next;
  }
  finish(to);
  return properties;
}

function unquoteKey(key: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(key);
  return quoted ? quoted[2]! : key;
}

function interpret(
  key: string,
  rest: string | undefined,
  lines: string[],
): Pick<Property, 'type' | 'value'> {
  const name = key.toLowerCase();
  const content = lines.filter((line) => line.trim() && !/^\s*#/.test(line));
  let value: PropertyValue;
  if (rest === undefined || rest === '' || /^#/.test(rest)) {
    if (!content.length) value = null;
    else if (content.every((line) => LIST_ITEM.test(line)))
      value = content.map((line) => scalarText(LIST_ITEM.exec(line)![1] ?? ''));
    else return { type: 'raw', value: lines.join('\n') };
  } else if (content.length) return { type: 'raw', value: [rest, ...lines].join('\n') };
  else if (/^\[.*\]$/.test(rest)) value = flowList(rest.slice(1, -1));
  else if (/^[|>{&*!]/.test(rest)) return { type: 'raw', value: rest };
  else value = scalar(rest);

  if (TAG_KEYS.has(name)) {
    const items = value === null ? [] : Array.isArray(value) ? value : [String(value)];
    // A tags property may hold "a b" or "a, b" on one line; Obsidian reads those as several.
    const tags = items
      .flatMap((item) => (Array.isArray(value) ? [item] : item.split(/[\s,]+/)))
      .map((tag) => tag.replace(/^#/, ''))
      .filter(Boolean);
    return { type: 'tags', value: tags };
  }
  if (LIST_KEYS.has(name)) {
    const items = value === null ? [] : Array.isArray(value) ? value : [String(value)];
    return { type: 'list', value: items };
  }
  if (Array.isArray(value)) return { type: 'list', value };
  if (typeof value === 'boolean') return { type: 'checkbox', value };
  if (typeof value === 'number') return { type: 'number', value };
  if (typeof value === 'string' && DATE.test(value)) return { type: 'date', value };
  if (typeof value === 'string' && DATETIME.test(value))
    return { type: 'datetime', value: value.replace(' ', 'T').slice(0, 16) };
  return { type: 'text', value };
}

/** A plain or quoted scalar, typed the way YAML would: booleans, numbers, null, or text. */
function scalar(text: string): PropertyValue {
  const trimmed = stripComment(text).trim();
  if (/^["']/.test(trimmed)) return unquote(trimmed);
  if (trimmed === '' || trimmed === '~' || trimmed === 'null') return null;
  if (trimmed === 'true' || trimmed === 'false') return trimmed === 'true';
  if (NUMBER.test(trimmed)) return Number(trimmed);
  return trimmed;
}
/** A list item or flow-list entry: always text, the way Obsidian shows it. */
function scalarText(text: string): string {
  const trimmed = stripComment(text).trim();
  return /^["']/.test(trimmed) ? unquote(trimmed) : trimmed;
}
function stripComment(text: string): string {
  if (/^["']/.test(text.trim())) return text;
  const at = text.search(/\s#/);
  return at === -1 ? text : text.slice(0, at);
}
function unquote(text: string): string {
  if (text.startsWith('"')) {
    const end = text.lastIndexOf('"');
    return text
      .slice(1, end > 0 ? end : undefined)
      .replace(/\\(["\\nt])/g, (_, char: string) => ({ n: '\n', t: '\t' })[char] ?? char);
  }
  const end = text.lastIndexOf("'");
  return text.slice(1, end > 0 ? end : undefined).replace(/''/g, "'");
}
function flowList(inner: string): string[] {
  const items: string[] = [];
  let item = '';
  let quote = '';
  for (const char of inner) {
    if (quote) {
      item += char;
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
      item += char;
    } else if (char === ',') {
      items.push(item);
      item = '';
    } else item += char;
  }
  items.push(item);
  return items.map(scalarText).filter((entry) => entry !== '');
}

/** Text as YAML would read it back unchanged: quoted when a plain scalar would mean something else. */
export function yamlText(text: string): string {
  const plain =
    text !== '' &&
    !/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(text) &&
    !/\s$/.test(text) &&
    !/: |:$| #|\n|\t/.test(text) &&
    !/^(true|false|null|yes|no|on|off|~)$/i.test(text) &&
    !NUMBER.test(text) &&
    !DATE.test(text) &&
    !DATETIME.test(text);
  return plain ? text : JSON.stringify(text);
}

function keyText(key: string): string {
  return /^[^\s#\-:"'][^:]*$/.test(key) && !/\s$/.test(key) ? key : JSON.stringify(key);
}

/** One property's lines, as Obsidian writes them. Lists are always written as `- items`. */
export function propertyLines(key: string, type: PropertyType, value: PropertyValue): string {
  const name = keyText(key);
  if (value === null || value === '' || (Array.isArray(value) && !value.length))
    return `${name}:\n`;
  if (Array.isArray(value))
    return `${name}:\n${value.map((item) => `  - ${yamlText(type === 'tags' ? item.replace(/^#/, '') : item)}`).join('\n')}\n`;
  if (typeof value === 'boolean' || typeof value === 'number') return `${name}: ${value}\n`;
  if (type === 'date' || type === 'datetime') return `${name}: ${value}\n`;
  return `${name}: ${yamlText(value)}\n`;
}

export interface Edit {
  from: number;
  to: number;
  insert: string;
}

/**
 * The change that sets one property, adding it at the end if the note does not have it, and
 * the properties block too if the note has none.
 */
export function setProperty(
  doc: string,
  key: string,
  type: PropertyType,
  value: PropertyValue,
): Edit {
  const lines = propertyLines(key, type, value);
  const found = readFrontmatter(doc);
  if (!found) return { from: 0, to: 0, insert: `---\n${lines}---\n` };
  const existing = found.properties.find((property) => property.key === key);
  if (existing) {
    // Blank lines and comments after the property belong to what follows; keep them.
    const kept = /(\n(?:[ \t]*(?:#.*)?\n)*)$/.exec(doc.slice(existing.from, existing.to));
    const trailing = kept ? kept[1]!.slice(1) : '';
    return { from: existing.from, to: existing.to, insert: lines + trailing };
  }
  // The last property may end without a line break when it runs into the closing line.
  const before = doc.slice(0, found.bodyTo);
  const insert = before.endsWith('\n') ? lines : `\n${lines}`;
  return { from: found.bodyTo, to: found.bodyTo, insert };
}

/** The change that removes one property; the whole block goes when it was the last. */
export function removeProperty(doc: string, key: string): Edit | undefined {
  const found = readFrontmatter(doc);
  const existing = found?.properties.find((property) => property.key === key);
  if (!found || !existing) return undefined;
  const others = found.properties.filter((property) => property !== existing);
  const remainder = doc.slice(found.bodyFrom, found.bodyTo).replace(existing.source, '');
  if (!others.length && !remainder.trim()) return { from: 0, to: found.to, insert: '' };
  return { from: existing.from, to: existing.to, insert: '' };
}

export function applyEdit(doc: string, edit: Edit): string {
  return doc.slice(0, edit.from) + edit.insert + doc.slice(edit.to);
}

/** The tags a note carries: its `tags` property and any `#tags` in its text, without `#`. */
export function noteTags(doc: string): string[] {
  const found = readFrontmatter(doc);
  const tags = new Set<string>();
  for (const property of found?.properties ?? [])
    if (property.type === 'tags' && Array.isArray(property.value))
      for (const tag of property.value) tags.add(tag);
  const body = found ? doc.slice(found.to) : doc;
  // Code is not tags, and a heading's `# ` has a space after it.
  const prose = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  for (const match of prose.matchAll(
    /(?:^|[\s(])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu,
  ))
    tags.add(match[1]!);
  return [...tags];
}
