import { noteTitle, parseLinks, resolveLink, type WikiLink } from './links';

export interface Backlink {
  path: string;
  excerpt: string;
}
export interface SearchResult {
  path: string;
  /** Present when the match is in the note body rather than only its title. */
  excerpt?: string;
}

const EXCERPT = 160;
function excerptAround(content: string, from: number, to: number): string {
  const lineStart = content.lastIndexOf('\n', from - 1) + 1;
  const lineEnd = content.indexOf('\n', to);
  const line = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  if (line.length <= EXCERPT) return line.trim();
  const start = Math.max(0, from - lineStart - EXCERPT / 2);
  const slice = line.slice(start, start + EXCERPT).trim();
  return `${start > 0 ? '…' : ''}${slice}${start + EXCERPT < line.length ? '…' : ''}`;
}

/** Rebuildable in-memory index of a vault's notes: link graph and text search. */
export class NoteIndex {
  private readonly notes = new Map<string, { content: string; lower: string; links: WikiLink[] }>();

  set(path: string, content: string): void {
    this.notes.set(path, { content, lower: content.toLowerCase(), links: parseLinks(content) });
  }
  delete(path: string): void {
    this.notes.delete(path);
  }
  move(from: string, to: string): void {
    const note = this.notes.get(from);
    if (!note) return;
    this.notes.delete(from);
    this.notes.set(to, note);
  }
  has(path: string): boolean {
    return this.notes.has(path);
  }
  content(path: string): string | undefined {
    return this.notes.get(path)?.content;
  }
  paths(): string[] {
    return [...this.notes.keys()].sort((a, b) => a.localeCompare(b));
  }
  resolve(target: string): string | undefined {
    return resolveLink(target, this.notes.keys());
  }

  /** Notes that link to `path`, one entry per linking note. */
  backlinks(path: string): Backlink[] {
    const result: Backlink[] = [];
    for (const [source, note] of this.notes) {
      if (source === path) continue;
      const link = note.links.find((candidate) => this.resolve(candidate.target) === path);
      if (link)
        result.push({ path: source, excerpt: excerptAround(note.content, link.from, link.to) });
    }
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Notes containing every word of `query`, title matches first. */
  search(query: string, limit = 30): SearchResult[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const scored: { score: number; result: SearchResult }[] = [];
    for (const [path, note] of this.notes) {
      const title = noteTitle(path).toLowerCase();
      if (!terms.every((term) => title.includes(term) || note.lower.includes(term))) continue;
      const inTitle = terms.every((term) => title.includes(term));
      const whole = terms.join(' ');
      const score = title === whole ? 4 : title.startsWith(whole) ? 3 : inTitle ? 2 : 1;
      const term = terms.find((candidate) => note.lower.includes(candidate));
      const at = term ? note.lower.indexOf(term) : -1;
      scored.push({
        score,
        result: {
          path,
          ...(term ? { excerpt: excerptAround(note.content, at, at + term.length) } : {}),
        },
      });
    }
    return scored
      .sort((a, b) => b.score - a.score || a.result.path.localeCompare(b.result.path))
      .slice(0, limit)
      .map((entry) => entry.result);
  }
}
