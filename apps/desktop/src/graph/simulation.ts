import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation as D3Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import type { ForceSettings } from './types';

export interface SimNode extends SimulationNodeDatum {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  source: SimNode | string;
  target: SimNode | string;
}

export interface Simulation {
  nodes: SimNode[];
  node(id: string): SimNode | undefined;
  alpha(value?: number): number;
  replace(nodes: SimNode[], edges: { source: string; target: string }[]): void;
  engine: D3Simulation<SimNode, SimLink>;
}

export function mapForces(settings: ForceSettings) {
  return {
    center: settings.center / 100,
    charge: -(8 + settings.repel * 10),
    link: settings.link / 100,
    distance: settings.distance,
  };
}

function place(nodes: { id: string; x?: number; y?: number }[]): SimNode[] {
  const radius = Math.max(40, Math.sqrt(nodes.length) * 18);
  return nodes.map((node, index) => {
    const angle = (index / Math.max(nodes.length, 1)) * Math.PI * 2;
    return {
      id: node.id,
      x: node.x ?? Math.cos(angle) * radius,
      y: node.y ?? Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
    };
  });
}

function linksOf(nodes: SimNode[], edges: { source: string; target: string }[]): SimLink[] {
  const known = new Set(nodes.map((node) => node.id));
  return edges
    .filter(
      (edge) => known.has(edge.source) && known.has(edge.target) && edge.source !== edge.target,
    )
    .map((edge) => ({ source: edge.source, target: edge.target }));
}

export function createSimulation(
  nodes: { id: string; x?: number; y?: number }[],
  edges: { source: string; target: string }[],
  forces: ForceSettings,
): Simulation {
  const simNodes = place(nodes);
  let index = new Map(simNodes.map((node) => [node.id, node]));
  const mapped = mapForces(forces);
  const engine = forceSimulation(simNodes)
    .force('center', forceCenter(0, 0).strength(mapped.center))
    .force('charge', forceManyBody().strength(mapped.charge).distanceMax(800))
    .force(
      'link',
      forceLink<SimNode, SimLink>(linksOf(simNodes, edges))
        .id((node) => node.id)
        .distance(mapped.distance)
        .strength(mapped.link),
    )
    .stop();

  return {
    get nodes() {
      return engine.nodes();
    },
    node: (id) => index.get(id),
    alpha: (value) => {
      if (value === undefined) return engine.alpha();
      engine.alpha(value);
      return value;
    },
    replace(next, nextEdges) {
      engine.nodes(next);
      index = new Map(next.map((node) => [node.id, node]));
      const force = engine.force('link') as ReturnType<typeof forceLink<SimNode, SimLink>>;
      force.links(linksOf(next, nextEdges));
    },
    engine,
  };
}

export function applyForces(sim: Simulation, forces: ForceSettings): void {
  const mapped = mapForces(forces);
  const center = sim.engine.force('center') as ReturnType<typeof forceCenter>;
  const charge = sim.engine.force('charge') as ReturnType<typeof forceManyBody>;
  const link = sim.engine.force('link') as ReturnType<typeof forceLink<SimNode, SimLink>>;
  center.strength(mapped.center);
  charge.strength(mapped.charge);
  link.distance(mapped.distance).strength(mapped.link);
}

export function applyGraph(
  sim: Simulation,
  nodes: { id: string; x?: number; y?: number }[],
  edges: { source: string; target: string }[],
): void {
  const previous = new Map(sim.nodes.map((node) => [node.id, node]));
  const next = place(nodes).map((node) => {
    const kept = previous.get(node.id);
    return kept ?? node;
  });
  const added = next.filter((node) => !previous.has(node.id));
  const removed = [...previous.keys()].filter((id) => !nodes.some((node) => node.id === id));
  if (removed.length === 1 && added.length === 1) {
    const old = previous.get(removed[0]!)!;
    added[0]!.x = old.x;
    added[0]!.y = old.y;
    added[0]!.vx = old.vx;
    added[0]!.vy = old.vy;
  } else {
    for (const node of added) {
      const edge = edges.find((item) => item.source === node.id || item.target === node.id);
      const other = edge && (edge.source === node.id ? edge.target : edge.source);
      const near = other ? previous.get(other) : undefined;
      if (!near) continue;
      node.x = near.x + (Math.random() - 0.5) * 24;
      node.y = near.y + (Math.random() - 0.5) * 24;
    }
  }
  sim.replace(next, edges);
}

export function tick(sim: Simulation): boolean {
  sim.engine.tick();
  return sim.engine.alpha() >= sim.engine.alphaMin();
}

export function settle(sim: Simulation, maxTicks = 400): number {
  let ticks = 0;
  while (ticks < maxTicks && tick(sim)) ticks += 1;
  return ticks;
}

export function settleGraph(
  nodes: { id: string }[],
  edges: { source: string; target: string }[],
  forces: ForceSettings,
  maxTicks = 400,
): { ticks: number; nodes: SimNode[] } {
  const sim = createSimulation(nodes, edges, forces);
  sim.alpha(1);
  const ticks = settle(sim, maxTicks);
  return { ticks, nodes: sim.nodes };
}
