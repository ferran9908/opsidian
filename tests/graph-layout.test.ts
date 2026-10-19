import { describe, expect, it } from 'vitest';
import {
  applyGraph,
  createSimulation,
  settle,
  settleGraph,
} from '../apps/desktop/src/graph/simulation';
import { GRAPH_DEFAULTS } from '../apps/desktop/src/graph/settings';

const forces = {
  center: GRAPH_DEFAULTS.center,
  repel: GRAPH_DEFAULTS.repel,
  link: GRAPH_DEFAULTS.link,
  distance: GRAPH_DEFAULTS.distance,
};

describe('graph layout', () => {
  it('settles a small graph without throwing the nodes away', () => {
    const { ticks, nodes } = settleGraph(
      [{ id: 'A.md' }, { id: 'B.md' }, { id: 'C.md' }],
      [
        { source: 'A.md', target: 'B.md' },
        { source: 'B.md', target: 'C.md' },
      ],
      forces,
    );
    expect(ticks).toBeGreaterThan(0);
    expect(nodes.map((node) => node.id).sort()).toEqual(['A.md', 'B.md', 'C.md']);
    expect(nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
  });

  it('keeps a node where it was when a neighbour is added', () => {
    const sim = createSimulation(
      [
        { id: 'A.md', x: 10, y: 20 },
        { id: 'B.md', x: 40, y: 50 },
      ],
      [{ source: 'A.md', target: 'B.md' }],
      forces,
    );
    applyGraph(
      sim,
      [{ id: 'A.md' }, { id: 'B.md' }, { id: 'C.md' }],
      [
        { source: 'A.md', target: 'B.md' },
        { source: 'B.md', target: 'C.md' },
      ],
    );
    expect(sim.node('A.md')).toMatchObject({ x: 10, y: 20 });
    expect(sim.node('B.md')).toMatchObject({ x: 40, y: 50 });
    expect(sim.node('C.md')).toBeDefined();
    const ticks = settle(sim, 80);
    expect(ticks).toBeGreaterThan(0);
    expect(sim.node('A.md')!.x).not.toBe(10);
  });

  it('hands a renamed node its old position when one path leaves and one arrives', () => {
    const sim = createSimulation(
      [
        { id: 'Old.md', x: 12, y: -8 },
        { id: 'Keep.md', x: 3, y: 4 },
      ],
      [{ source: 'Keep.md', target: 'Old.md' }],
      forces,
    );
    applyGraph(
      sim,
      [{ id: 'New.md' }, { id: 'Keep.md' }],
      [{ source: 'Keep.md', target: 'New.md' }],
    );
    expect(sim.node('New.md')).toMatchObject({ x: 12, y: -8 });
    expect(sim.node('Old.md')).toBeUndefined();
  });
});
