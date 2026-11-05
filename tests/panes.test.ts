import { describe, expect, it } from 'vitest';
import {
  arrange,
  closePane,
  emptyPane,
  findPane,
  neighbour,
  panes,
  prune,
  resize,
  restoreLayout,
  saveLayout,
  splitPane,
  updatePane,
  type Layout,
  type PaneState,
  type SplitState,
} from '../apps/desktop/src/panes';

const pane = (id: string, path?: string): PaneState => ({
  ...emptyPane('live', id),
  ...(path ? { open: { path, visit: 1 }, trail: { paths: [path], at: 0 } } : {}),
});
const ids = (layout: Layout) => panes(layout).map((leaf) => leaf.id);
const asSplit = (layout: Layout) => {
  expect(layout.kind).toBe('split');
  return layout as SplitState;
};

describe('panes', () => {
  it('splits a single pane to the right into two halves', () => {
    const layout = asSplit(splitPane(pane('a'), 'a', 'row', pane('b')));
    expect(layout.direction).toBe('row');
    expect(ids(layout)).toEqual(['a', 'b']);
    expect(layout.sizes).toEqual([0.5, 0.5]);
  });

  it('nests a split down inside a row', () => {
    const row = splitPane(pane('a'), 'a', 'row', pane('b'));
    const layout = asSplit(splitPane(row, 'b', 'column', pane('c')));
    expect(layout.direction).toBe('row');
    expect(layout.sizes).toEqual([0.5, 0.5]);
    const column = asSplit(layout.children[1]!);
    expect(column.direction).toBe('column');
    expect(ids(column)).toEqual(['b', 'c']);
    expect(ids(layout)).toEqual(['a', 'b', 'c']);
  });

  it('adds a sibling when splitting the same way, sharing the pane’s room', () => {
    const row = splitPane(pane('a'), 'a', 'row', pane('b'));
    const layout = asSplit(splitPane(row, 'a', 'row', pane('c')));
    expect(layout.children).toHaveLength(3);
    expect(ids(layout)).toEqual(['a', 'c', 'b']);
    expect(layout.sizes).toEqual([0.25, 0.25, 0.5]);
  });

  it('collapses a split left with one pane', () => {
    const row = splitPane(pane('a'), 'a', 'row', pane('b'));
    const nested = splitPane(row, 'b', 'column', pane('c'));
    const closed = asSplit(closePane(nested, 'c'));
    expect(closed.direction).toBe('row');
    expect(closed.children.map((child) => child.kind)).toEqual(['pane', 'pane']);
    expect(ids(closed)).toEqual(['a', 'b']);
    expect(closePane(closed, 'a')).toEqual(findPane(closed, 'b'));
  });

  it('gives a closed pane’s room to the rest, keeping their proportions', () => {
    const three = splitPane(splitPane(pane('a'), 'a', 'row', pane('b')), 'a', 'row', pane('c'));
    const closed = asSplit(closePane(three, 'b'));
    expect(ids(closed)).toEqual(['a', 'c']);
    expect(closed.sizes).toEqual([0.5, 0.5]);
  });

  it('flattens a collapsed split into a parent running the same way', () => {
    // row[a, column[row[b, d], c]]: closing c leaves row[a, b, d].
    let layout: Layout = splitPane(pane('a'), 'a', 'row', pane('b'));
    layout = splitPane(layout, 'b', 'column', pane('c'));
    layout = splitPane(layout, 'b', 'row', pane('d'));
    const closed = asSplit(closePane(layout, 'c'));
    expect(closed.children.every((child) => child.kind === 'pane')).toBe(true);
    expect(ids(closed)).toEqual(['a', 'b', 'd']);
    expect(closed.sizes).toEqual([0.5, 0.25, 0.25]);
  });

  it('empties the last pane instead of closing it', () => {
    const only = pane('a', 'Note.md');
    const closed = closePane(only, 'a');
    expect(closed.kind).toBe('pane');
    expect((closed as PaneState).open).toBeNull();
    expect((closed as PaneState).id).toBe('a');
  });

  it('resizes within the minimum', () => {
    const row = asSplit(splitPane(pane('a'), 'a', 'row', pane('b')));
    expect(asSplit(resize(row, row.id, 0, 0.3, 0.2)).sizes).toEqual([0.3, 0.7]);
    expect(asSplit(resize(row, row.id, 0, 0.05, 0.2)).sizes).toEqual([0.2, 0.8]);
    expect(asSplit(resize(row, row.id, 0, 0.99, 0.2)).sizes[0]).toBeCloseTo(0.8);
    // The boundary is measured from the start of the split, past the children before it.
    const three = asSplit(splitPane(row, 'b', 'row', pane('c')));
    const moved = asSplit(resize(three, three.id, 1, 0.6, 0.1)).sizes;
    expect(moved[0]).toBe(0.5);
    expect(moved[1]).toBeCloseTo(0.1);
    expect(moved[2]).toBeCloseTo(0.4);
  });

  it('cycles focus in reading order', () => {
    const layout = splitPane(splitPane(pane('a'), 'a', 'row', pane('b')), 'b', 'column', pane('c'));
    expect(neighbour(layout, 'a', 1)).toBe('b');
    expect(neighbour(layout, 'c', 1)).toBe('a');
    expect(neighbour(layout, 'a', -1)).toBe('c');
  });

  it('lays panes out as fractions of the area', () => {
    const layout = splitPane(splitPane(pane('a'), 'a', 'row', pane('b')), 'b', 'column', pane('c'));
    const { panes: rects, gutters } = arrange(layout);
    expect(rects).toEqual([
      { id: 'a', rect: { x: 0, y: 0, w: 0.5, h: 1 } },
      { id: 'b', rect: { x: 0.5, y: 0, w: 0.5, h: 0.5 } },
      { id: 'c', rect: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } },
    ]);
    expect(gutters.map((gutter) => [gutter.direction, gutter.at])).toEqual([
      ['row', 0.5],
      ['column', 0.5],
    ]);
  });

  it('prunes notes that are gone, keeping the panes', () => {
    let layout: Layout = splitPane(pane('a', 'Kept.md'), 'a', 'row', pane('b', 'Gone.md'));
    layout = updatePane(layout, 'a', (leaf) => ({
      ...leaf,
      trail: { paths: ['Gone.md', 'Kept.md'], at: 1 },
    }));
    const pruned = prune(layout, ['Kept.md']);
    expect(ids(pruned)).toEqual(['a', 'b']);
    expect(findPane(pruned, 'a')!.open?.path).toBe('Kept.md');
    expect(findPane(pruned, 'a')!.trail).toEqual({ paths: ['Kept.md'], at: 0 });
    expect(findPane(pruned, 'b')!.open).toBeNull();
  });

  it('never restores one note into two panes', () => {
    const layout = splitPane(pane('a', 'Same.md'), 'a', 'row', pane('b', 'Same.md'));
    const pruned = prune(layout, ['Same.md']);
    expect(findPane(pruned, 'a')!.open?.path).toBe('Same.md');
    expect(findPane(pruned, 'b')!.open).toBeNull();
  });

  it('restores a saved session against the notes there are now', () => {
    const layout = splitPane(pane('a', 'One.md'), 'a', 'column', pane('b', 'Two.md'));
    const saved = JSON.parse(JSON.stringify({ layout: saveLayout(layout), focused: 'b' }));
    const back = restoreLayout(saved, ['One.md'], 'source');
    expect(back.focused).toBe('b');
    expect(asSplit(back.layout).direction).toBe('column');
    expect(findPane(back.layout, 'a')!.open?.path).toBe('One.md');
    expect(findPane(back.layout, 'a')!.mode).toBe('source');
    expect(findPane(back.layout, 'b')!.open).toBeNull();
  });

  it('reads the older single-note session as one pane', () => {
    const back = restoreLayout({ last: 'Old.md', expanded: [] }, ['First.md', 'Old.md'], 'live');
    expect(back.layout.kind).toBe('pane');
    expect((back.layout as PaneState).open?.path).toBe('Old.md');
    const missing = restoreLayout({ last: 'Gone.md' }, ['First.md'], 'live');
    expect((missing.layout as PaneState).open?.path).toBe('First.md');
    expect(restoreLayout('nonsense', [], 'live').layout.kind).toBe('pane');
  });
});
