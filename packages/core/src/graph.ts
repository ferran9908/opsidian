import { noteTitle } from './links';
import { tagKey } from './frontmatter';

/** A note or an unresolved wiki-link target in the notebook graph. */
export interface GraphNode {
  /** Vault-relative path. Unresolved targets use the same shape (`Name.md`); tags are `#tag`. */
  path: string;
  title: string;
  exists: boolean;
  inDegree: number;
  outDegree: number;
  /** Set on a tag node, which every note carrying the tag links to. */
  tag?: true;
}

/** One directed link between two graph nodes. Duplicates and self-links are dropped. */
export interface GraphEdge {
  from: string;
  to: string;
}

/** A snapshot of the notebook's link graph. */
export interface NoteGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Identity of the current topology, ignoring degrees. Used to skip a layout restart. */
export function graphFingerprint(graph: NoteGraph): string {
  return `${graph.nodes.map((node) => node.path).join('\n')}\0${graph.edges
    .map((edge) => `${edge.from}>${edge.to}`)
    .join('\n')}`;
}

/** Path used as the identity of a wiki-link target that does not resolve to a note. */
export function unresolvedNotePath(target: string): string | undefined {
  const trimmed = target.trim().replace(/\\/g, '/');
  if (!trimmed) return undefined;
  return /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
}

const bare = (path: string) => path.replace(/\.md$/i, '').toLowerCase();

export function graphKey(path: string): string {
  return bare(path);
}

/** Breadth-first neighbourhood of `center`, both directions, to `depth` hops. */
export function localGraph(graph: NoteGraph, center: string, depth: number): NoteGraph {
  const byPath = new Map(graph.nodes.map((node) => [node.path, node]));
  const focus = byPath.get(center);
  if (!focus) return { nodes: [], edges: [] };
  if (depth <= 0) return { nodes: [focus], edges: [] };

  const next = new Map<string, string[]>();
  const add = (from: string, to: string) => {
    const list = next.get(from);
    if (list) list.push(to);
    else next.set(from, [to]);
  };
  for (const edge of graph.edges) {
    add(edge.from, edge.to);
    add(edge.to, edge.from);
  }

  const ring = new Map<string, number>([[center, 0]]);
  const queue = [center];
  for (let index = 0; index < queue.length; index++) {
    const path = queue[index]!;
    const hops = ring.get(path)!;
    if (hops >= depth) continue;
    for (const neighbour of next.get(path) ?? []) {
      if (ring.has(neighbour)) continue;
      ring.set(neighbour, hops + 1);
      queue.push(neighbour);
    }
  }

  return {
    nodes: [...ring.keys()]
      .map((path) => byPath.get(path)!)
      .sort((a, b) => a.path.localeCompare(b.path)),
    edges: graph.edges.filter((edge) => ring.has(edge.from) && ring.has(edge.to)),
  };
}

export function filterGraph(
  graph: NoteGraph,
  options: { orphans: boolean; existingOnly: boolean; keep?: string },
): NoteGraph {
  let nodes = options.existingOnly ? graph.nodes.filter((node) => node.exists) : graph.nodes;
  const allowed = new Set(nodes.map((node) => node.path));
  if (options.keep && !allowed.has(options.keep)) {
    const kept = graph.nodes.find((node) => node.path === options.keep);
    if (kept) {
      nodes = [...nodes, kept].sort((a, b) => a.path.localeCompare(b.path));
      allowed.add(kept.path);
    }
  }
  const edges = graph.edges.filter((edge) => allowed.has(edge.from) && allowed.has(edge.to));
  if (options.orphans) return { nodes, edges };

  const connected = new Set<string>();
  for (const edge of edges) {
    connected.add(edge.from);
    connected.add(edge.to);
  }
  return {
    nodes: nodes.filter((node) => connected.has(node.path) || node.path === options.keep),
    edges,
  };
}

/** Identity of a tag's node in the graph. */
export function tagNodePath(tag: string): string {
  return `#${tag}`;
}

/**
 * Build a graph from outgoing wiki-link targets. `resolve` is the notebook's link resolver.
 * With `tags`, each tag is a node too, linked from every note that carries it.
 */
export function buildNoteGraph(
  notes: Iterable<[string, { links: { target: string }[]; tags?: string[] }]>,
  resolve: (target: string) => string | undefined,
  options: { tags?: boolean } = {},
): NoteGraph {
  const nodes = new Map<
    string,
    { title: string; exists: boolean; inDegree: number; outDegree: number; tag?: true }
  >();
  const tagNodes = new Map<string, string>();
  const unresolved = new Map<string, string>();
  for (const [path] of notes) {
    nodes.set(path, { title: noteTitle(path), exists: true, inDegree: 0, outDegree: 0 });
  }

  const targetOf = (target: string): string | undefined => {
    const resolved = resolve(target);
    if (resolved) return resolved;
    const path = unresolvedNotePath(target);
    if (!path) return undefined;
    const key = graphKey(path);
    const known = unresolved.get(key);
    if (known) return known;
    unresolved.set(key, path);
    if (!nodes.has(path))
      nodes.set(path, { title: noteTitle(path), exists: false, inDegree: 0, outDegree: 0 });
    return path;
  };

  const edges = new Map<string, GraphEdge>();
  for (const [source, note] of notes) {
    const seen = new Set<string>();
    const connect = (to: string) => {
      if (to === source || seen.has(to)) return;
      seen.add(to);
      const fromNode = nodes.get(source);
      const toNode = nodes.get(to);
      if (!fromNode || !toNode) return;
      edges.set(`${source}\0${to}`, { from: source, to });
      fromNode.outDegree += 1;
      toNode.inDegree += 1;
    };
    for (const link of note.links) {
      if (!link.target) continue;
      const to = targetOf(link.target);
      if (to) connect(to);
    }
    if (!options.tags) continue;
    for (const tag of note.tags ?? []) {
      let path = tagNodes.get(tagKey(tag));
      if (!path) {
        path = tagNodePath(tag);
        tagNodes.set(tagKey(tag), path);
        nodes.set(path, { title: path, exists: true, inDegree: 0, outDegree: 0, tag: true });
      }
      connect(path);
    }
  }

  return {
    nodes: [...nodes]
      .map(([path, node]) => ({ path, ...node }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    edges: [...edges.values()].sort(
      (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
    ),
  };
}
