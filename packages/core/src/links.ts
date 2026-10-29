export interface WikiLink {
  /** Note name or vault path the link points at. Empty for a same-note `[[#Heading]]`. */
  target: string;
  heading?: string;
  alias?: string;
  from: number;
  to: number;
}

/** Splits the text between `[[` and `]]` into its target, heading and alias. */
export function splitLink(inner: string): Pick<WikiLink, 'target' | 'heading' | 'alias'> {
  const bar = inner.indexOf('|');
  // Inside a table Obsidian writes the bar as `\|`.
  const reference = bar === -1 ? inner : inner.slice(0, bar).replace(/\\$/, '');
  const alias = bar === -1 ? undefined : inner.slice(bar + 1).trim() || undefined;
  const hash = reference.indexOf('#');
  const target = (hash === -1 ? reference : reference.slice(0, hash)).trim();
  const heading = hash === -1 ? undefined : reference.slice(hash + 1).trim() || undefined;
  return { target, ...(heading ? { heading } : {}), ...(alias ? { alias } : {}) };
}

/** Text a link shows when its Markdown is not being edited. */
export function linkLabel(inner: string): string {
  const { target, heading, alias } = splitLink(inner);
  return alias ?? (heading ? (target ? `${target} > ${heading}` : heading) : target);
}

const blank = (text: string) => text.replace(/[^\n]/g, ' ');

/** What may come before a code fence: indentation, quote marks and list markers. */
const FENCE = /^(?:[ \t]|>|[-*+][ \t]|\d+[.)][ \t])*(`{3,}(?!.*`)|~{3,})/;

/**
 * The note with fenced and inline code blanked out, so offsets still match the original.
 * Code blocks made only by indentation are not recognised.
 */
function prose(markdown: string): string {
  let fence: string | undefined;
  return markdown
    .split('\n')
    .map((line) => {
      const marker = FENCE.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        return blank(line);
      }
      if (marker) {
        fence = marker;
        return blank(line);
      }
      // A code span opens and closes with the same number of backticks.
      return line.replace(/(?<!`)(`+)(?!`).*?(?<!`)\1(?!`)/g, blank);
    })
    .join('\n');
}

/** Wiki links and `![[embeds]]` in a note, ignoring anything inside fenced or inline code. */
export function parseLinks(markdown: string): WikiLink[] {
  const links: WikiLink[] = [];
  for (const match of prose(markdown).matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    links.push({
      ...splitLink(match[1]!),
      from: match.index,
      to: match.index + match[0].length,
    });
  }
  return links;
}

/**
 * Points links somewhere else. `retarget` gets each link's target and returns the new one,
 * or undefined to leave the link alone. Headings and aliases are kept as written.
 */
export function retargetLinks(
  markdown: string,
  retarget: (target: string) => string | undefined,
): string {
  let result = '';
  let copied = 0;
  for (const link of parseLinks(markdown)) {
    if (!link.target) continue;
    const next = retarget(link.target);
    if (next === undefined || next === link.target) continue;
    const inner = markdown.slice(link.from + 2, link.to - 2);
    const rest = /\\?\||#/.exec(inner);
    result += `${markdown.slice(copied, link.from)}[[${next}${rest ? inner.slice(rest.index) : ''}]]`;
    copied = link.to;
  }
  return copied ? result + markdown.slice(copied) : markdown;
}

/**
 * Rewrites the destinations of Markdown images and links (`![](a/b.png)`, `[text](a/b.pdf)`,
 * `[text](<a/b c.pdf>)`). `retarget` gets the decoded destination and returns the new one,
 * or undefined to keep it.
 */
export function retargetFiles(
  markdown: string,
  retarget: (path: string) => string | undefined,
): string {
  let result = '';
  let copied = 0;
  const destination = /\]\((<[^<>\n]+>|(?:[^()\s<>]|\([^()\s]*\))+)(?=(?:[ \t]+"[^"\n]*")?\))/g;
  for (const match of prose(markdown).matchAll(destination)) {
    const from = match.index + 2;
    const written = markdown.slice(from, from + match[1]!.length);
    const angled = written.startsWith('<');
    let path: string;
    try {
      path = angled ? written.slice(1, -1) : decodeURI(written);
    } catch {
      continue;
    }
    const next = retarget(path);
    if (next === undefined || next === path) continue;
    result += markdown.slice(copied, from) + (angled ? `<${next}>` : encodeDestination(next));
    copied = from + written.length;
  }
  return copied ? result + markdown.slice(copied) : markdown;
}

/** A vault path as a Markdown link destination: no spaces, and no parentheses to unbalance it. */
export function encodeDestination(path: string): string {
  return encodeURI(path).replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/** Where each heading line starts, with its level and text, ignoring code. */
function headings(markdown: string): { from: number; level: number; text: string }[] {
  const found = [];
  let from = 0;
  for (const line of prose(markdown).split('\n')) {
    const match = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (match) found.push({ from, level: match[1]!.length, text: match[2]! });
    from += line.length + 1;
  }
  return found;
}

/** Offset of the line holding a heading, matched without regard to letter case. */
export function headingOffset(markdown: string, heading: string): number | undefined {
  const wanted = heading.trim().toLowerCase();
  return headings(markdown).find((item) => item.text.toLowerCase() === wanted)?.from;
}

/** Text of a note from a heading to the next heading of the same or a higher level. */
export function headingSection(markdown: string, heading: string): string | undefined {
  const wanted = heading.trim().toLowerCase();
  const all = headings(markdown);
  const start = all.findIndex((item) => item.text.toLowerCase() === wanted);
  if (start === -1) return undefined;
  const end = all.slice(start + 1).find((item) => item.level <= all[start]!.level);
  return markdown.slice(all[start]!.from, end?.from).trimEnd();
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const FORBIDDEN = /[\\/:*?"<>|#^[\]]/;

/** Rejects names that are unsafe as filenames or ambiguous inside a `[[link]]`. */
export function validateName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Give it a name first.');
  if (value !== value.trim()) throw new Error('A name cannot start or end with a space.');
  if (value.length > 200) throw new Error('That name is too long.');
  if (value.startsWith('.') || value.endsWith('.'))
    throw new Error('A name cannot start or end with a dot.');
  if (CONTROL.test(value) || FORBIDDEN.test(value))
    throw new Error('A name cannot contain \\ / : * ? " < > | # ^ [ ]');
}

/** `Travel/Japan.md` → `Japan`. */
export function noteTitle(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
}

/** `Travel/Japan.md` → `Travel`; a note at the vault root → ``. */
export function noteFolder(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

const bare = (path: string) => path.replace(/\.md$/i, '').toLowerCase();

/**
 * Resolves link targets to note paths the way Obsidian does: an exact vault path wins,
 * otherwise the note with that name closest to the vault root. Built once for many lookups.
 */
export function linkResolver(paths: Iterable<string>): (target: string) => string | undefined {
  const exact = new Map<string, string>();
  const named = new Map<string, { path: string; key: string; depth: number }[]>();
  for (const path of paths) {
    const key = bare(path);
    if (!exact.has(key)) exact.set(key, path);
    const name = key.slice(key.lastIndexOf('/') + 1);
    const entry = { path, key, depth: path.split('/').length };
    const list = named.get(name);
    if (list) list.push(entry);
    else named.set(name, [entry]);
  }
  for (const list of named.values())
    list.sort((a, b) => a.depth - b.depth || (a.path < b.path ? -1 : 1));
  return (target) => {
    const wanted = bare(target.trim());
    if (!wanted) return undefined;
    const found = exact.get(wanted);
    if (found) return found;
    return named
      .get(wanted.slice(wanted.lastIndexOf('/') + 1))
      ?.find((entry) => entry.key.endsWith(`/${wanted}`))?.path;
  };
}

/** One-off form of `linkResolver`. */
export function resolveLink(target: string, paths: Iterable<string>): string | undefined {
  return linkResolver(paths)(target);
}

/** The shortest link text that reaches `path`: its name, or its full path if the name is taken. */
export function linkTarget(path: string, resolve: (target: string) => string | undefined): string {
  const title = noteTitle(path);
  return resolve(title) === path ? title : path.replace(/\.md$/i, '');
}

/**
 * A web address as a table shows it: without `https://`, `www.` or a closing slash, and cut
 * with an ellipsis past `max` characters. Only what is drawn changes; the note keeps the address.
 */
export function shortUrl(url: string, max = 30): string {
  const text = url
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/$/, '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
