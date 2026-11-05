import type { EditorMode } from '@opsidian/editor';

/**
 * The window's notes, side by side or one above the other, as a tree. Pure data and pure
 * functions: no React and no DOM, so the rules can be tested on their own.
 */

/** A note shown in a pane. `visit` counts openings, so the editor remounts on a new note but not on a rename. */
export interface OpenNote {
  path: string;
  visit: number;
  heading?: string;
}
export interface Trail {
  paths: string[];
  at: number;
}
export interface PaneState {
  kind: 'pane';
  id: string;
  open: OpenNote | null;
  trail: Trail;
  mode: EditorMode;
  /** The mode to go back to when leaving reading view. */
  editing: EditorMode;
}
export interface SplitState {
  kind: 'split';
  id: string;
  /** `row`: side by side. `column`: one above the other. */
  direction: 'row' | 'column';
  children: Layout[];
  /** Fractions of the split, summing to 1. */
  sizes: number[];
}
export type Layout = PaneState | SplitState;
export type Direction = SplitState['direction'];

/** The narrowest a pane may be dragged, in pixels: `row` is width, `column` height. */
export const MIN_PANE: Record<Direction, number> = { row: 240, column: 160 };

export const newId = (): string => Math.random().toString(36).slice(2, 10);

export function emptyPane(mode: EditorMode, id = newId()): PaneState {
  return {
    kind: 'pane',
    id,
    open: null,
    trail: { paths: [], at: -1 },
    mode,
    editing: mode === 'reading' ? 'live' : mode,
  };
}

/** Every pane, in reading order: left to right, top to bottom. */
export function panes(layout: Layout): PaneState[] {
  return layout.kind === 'pane' ? [layout] : layout.children.flatMap(panes);
}

export function findPane(layout: Layout, id: string): PaneState | undefined {
  return panes(layout).find((pane) => pane.id === id);
}

export function updatePane(
  layout: Layout,
  id: string,
  change: (pane: PaneState) => PaneState,
): Layout {
  if (layout.kind === 'pane') return layout.id === id ? change(layout) : layout;
  let changed = false;
  const children = layout.children.map((child) => {
    const next = updatePane(child, id, change);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...layout, children } : layout;
}

/** Applies `change` to every pane. */
export function mapPanes(layout: Layout, change: (pane: PaneState) => PaneState): Layout {
  return layout.kind === 'pane'
    ? change(layout)
    : { ...layout, children: layout.children.map((child) => mapPanes(child, change)) };
}

/**
 * Puts `added` beside the pane `id`: after it in its split when that split already runs the
 * same way, sharing the pane's room, or else in a new split of two halves where the pane was.
 */
export function splitPane(
  layout: Layout,
  id: string,
  direction: Direction,
  added: PaneState,
): Layout {
  if (layout.kind === 'pane')
    return layout.id === id
      ? { kind: 'split', id: newId(), direction, children: [layout, added], sizes: [0.5, 0.5] }
      : layout;
  const at = layout.children.findIndex((child) => child.kind === 'pane' && child.id === id);
  if (at >= 0 && layout.direction === direction) {
    const half = layout.sizes[at]! / 2;
    return {
      ...layout,
      children: [...layout.children.slice(0, at + 1), added, ...layout.children.slice(at + 1)],
      sizes: [...layout.sizes.slice(0, at), half, half, ...layout.sizes.slice(at + 1)],
    };
  }
  return {
    ...layout,
    children: layout.children.map((child) => splitPane(child, id, direction, added)),
  };
}

/**
 * Removes the pane `id`; the panes beside it take its room. A split left with one child gives
 * way to that child. The last pane is never removed, only emptied.
 */
export function closePane(layout: Layout, id: string): Layout {
  if (layout.kind === 'pane') return layout.id === id ? { ...layout, open: null } : layout;
  return close(layout, id) ?? layout;
}
function close(layout: Layout, id: string): Layout | null {
  if (layout.kind === 'pane') return layout.id === id ? null : layout;
  const kept: { child: Layout; size: number }[] = [];
  layout.children.forEach((child, index) => {
    const next = close(child, id);
    if (next) kept.push({ child: next, size: layout.sizes[index]! });
  });
  if (!kept.length) return null;
  if (kept.length === 1) return kept[0]!.child;
  const total = kept.reduce((sum, entry) => sum + entry.size, 0);
  // A child that collapsed into a split running the same way joins this one.
  const children: Layout[] = [];
  const sizes: number[] = [];
  for (const { child, size } of kept) {
    if (child.kind === 'split' && child.direction === layout.direction) {
      children.push(...child.children);
      sizes.push(...child.sizes.map((part) => (part * size) / total));
    } else {
      children.push(child);
      sizes.push(size / total);
    }
  }
  return { ...layout, children, sizes };
}

/**
 * Moves the boundary after child `index` of split `splitId` to `fraction` of the split, keeping
 * both children at least `min` (a fraction of the split) wide or tall.
 */
export function resize(
  layout: Layout,
  splitId: string,
  index: number,
  fraction: number,
  min = 0.05,
): Layout {
  if (layout.kind === 'pane') return layout;
  if (layout.id !== splitId)
    return {
      ...layout,
      children: layout.children.map((child) => resize(child, splitId, index, fraction, min)),
    };
  const first = layout.sizes[index];
  const second = layout.sizes[index + 1];
  if (first === undefined || second === undefined) return layout;
  const start = layout.sizes.slice(0, index).reduce((sum, size) => sum + size, 0);
  const pair = first + second;
  const least = Math.min(min, pair / 2);
  const size = Math.min(pair - least, Math.max(least, fraction - start));
  const sizes = [...layout.sizes];
  sizes[index] = size;
  sizes[index + 1] = pair - size;
  return { ...layout, sizes };
}

/** The pane after (`1`) or before (`-1`) `id` in reading order, wrapping round. */
export function neighbour(layout: Layout, id: string, by: 1 | -1): string {
  const all = panes(layout);
  const at = all.findIndex((pane) => pane.id === id);
  if (at < 0) return all[0]!.id;
  return all[(at + by + all.length) % all.length]!.id;
}

/**
 * Drops notes that no longer exist from every pane, keeping the panes. A note open in two
 * panes stays open in the first only, since each pane's editor saves on its own.
 */
export function prune(layout: Layout, notes: readonly string[]): Layout {
  const exists = new Set(notes);
  const shown = new Set<string>();
  return mapPanes(layout, (pane) => {
    const current = pane.trail.paths[pane.trail.at];
    const paths = pane.trail.paths.filter((path) => exists.has(path));
    const trail = {
      paths,
      at: current && exists.has(current) ? paths.indexOf(current) : paths.length - 1,
    };
    const keep = pane.open && exists.has(pane.open.path) && !shown.has(pane.open.path);
    if (keep) shown.add(pane.open!.path);
    return { ...pane, open: keep ? pane.open : null, trail };
  });
}

/** Where each pane and each boundary sits, as fractions of the whole area. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Gutter {
  split: string;
  /** The boundary after this child. */
  index: number;
  direction: Direction;
  /** The split's own area. */
  area: Rect;
  /** Where the boundary is, as a fraction of the split. */
  at: number;
}
export function arrange(
  layout: Layout,
  area: Rect = { x: 0, y: 0, w: 1, h: 1 },
): { panes: { id: string; rect: Rect }[]; gutters: Gutter[] } {
  if (layout.kind === 'pane') return { panes: [{ id: layout.id, rect: area }], gutters: [] };
  const result: ReturnType<typeof arrange> = { panes: [], gutters: [] };
  let start = 0;
  layout.children.forEach((child, index) => {
    const size = layout.sizes[index]!;
    const rect =
      layout.direction === 'row'
        ? { x: area.x + start * area.w, y: area.y, w: size * area.w, h: area.h }
        : { x: area.x, y: area.y + start * area.h, w: area.w, h: size * area.h };
    const inner = arrange(child, rect);
    result.panes.push(...inner.panes);
    result.gutters.push(...inner.gutters);
    start += size;
    if (index < layout.children.length - 1)
      result.gutters.push({
        split: layout.id,
        index,
        direction: layout.direction,
        area,
        at: start,
      });
  });
  return result;
}

/** The layout as kept between launches: notes by path only. */
export type SavedLayout =
  | { kind: 'pane'; id: string; open: string | null }
  | { kind: 'split'; id: string; direction: Direction; children: SavedLayout[]; sizes: number[] };

export function saveLayout(layout: Layout): SavedLayout {
  return layout.kind === 'pane'
    ? { kind: 'pane', id: layout.id, open: layout.open?.path ?? null }
    : {
        kind: 'split',
        id: layout.id,
        direction: layout.direction,
        children: layout.children.map(saveLayout),
        sizes: layout.sizes,
      };
}

/**
 * Reads back what `saveLayout` kept, or the older `{ last }` of a single note, against the notes
 * there are now. Anything malformed starts over with one pane.
 */
export function restoreLayout(
  saved: unknown,
  notes: readonly string[],
  mode: EditorMode,
): { layout: Layout; focused: string } {
  const read = (value: unknown): Layout | null => {
    if (!value || typeof value !== 'object') return null;
    const node = value as Record<string, unknown>;
    const id = typeof node.id === 'string' && node.id ? node.id : newId();
    if (node.kind === 'pane') {
      const pane = emptyPane(mode, id);
      return typeof node.open === 'string'
        ? { ...pane, open: { path: node.open, visit: 1 }, trail: { paths: [node.open], at: 0 } }
        : pane;
    }
    if (node.kind !== 'split' || (node.direction !== 'row' && node.direction !== 'column'))
      return null;
    if (!Array.isArray(node.children) || !Array.isArray(node.sizes)) return null;
    const children = node.children.map(read);
    const sizes = node.sizes.filter((size): size is number => typeof size === 'number' && size > 0);
    if (children.length < 2 || children.some((child) => !child) || sizes.length !== children.length)
      return null;
    const total = sizes.reduce((sum, size) => sum + size, 0);
    return {
      kind: 'split',
      id,
      direction: node.direction,
      children: children as Layout[],
      sizes: sizes.map((size) => size / total),
    };
  };
  const session = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>;
  let layout =
    read(session.layout) ??
    read({ kind: 'pane', open: typeof session.last === 'string' ? session.last : null })!;
  // Ids must be unique for focus and editors to find their pane.
  const ids = panes(layout).map((pane) => pane.id);
  if (new Set(ids).size !== ids.length)
    layout = mapPanes(layout, (pane) => ({ ...pane, id: newId() }));
  layout = prune(layout, notes);
  const all = panes(layout);
  const focused = all.find((pane) => pane.id === session.focused)?.id ?? all[0]!.id;
  // Nothing left to show: open the first note, as a fresh notebook does.
  const first = notes[0];
  if (first && all.every((pane) => !pane.open))
    layout = updatePane(layout, focused, (pane) => ({
      ...pane,
      open: { path: first, visit: 1 },
      trail: { paths: [first], at: 0 },
    }));
  return { layout, focused };
}
