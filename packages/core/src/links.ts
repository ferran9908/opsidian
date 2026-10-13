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
  const reference = bar === -1 ? inner : inner.slice(0, bar);
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

/** Wiki links in a note, ignoring anything inside fenced or inline code. */
export function parseLinks(markdown: string): WikiLink[] {
  let fence: string | undefined;
  const prose = markdown
    .split('\n')
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        return blank(line);
      }
      if (marker) {
        fence = marker;
        return blank(line);
      }
      return line.replace(/`[^`\n]*`/g, blank);
    })
    .join('\n');
  const links: WikiLink[] = [];
  for (const match of prose.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    links.push({
      ...splitLink(match[1]!),
      from: match.index,
      to: match.index + match[0].length,
    });
  }
  return links;
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

/**
 * Resolves a link target to a note path the way Obsidian does: an exact vault path wins,
 * otherwise the note with that name closest to the vault root.
 */
export function resolveLink(target: string, paths: Iterable<string>): string | undefined {
  const wanted = target.trim().replace(/\.md$/i, '').toLowerCase();
  if (!wanted) return undefined;
  let best: string | undefined;
  let bestDepth = Infinity;
  for (const path of paths) {
    const candidate = path.replace(/\.md$/i, '').toLowerCase();
    if (candidate === wanted) return path;
    if (!candidate.endsWith(`/${wanted}`)) continue;
    const depth = path.split('/').length;
    if (depth < bestDepth || (depth === bestDepth && path < best!)) {
      best = path;
      bestDepth = depth;
    }
  }
  return best;
}
