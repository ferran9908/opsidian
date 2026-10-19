import { quadtree, type Quadtree, type QuadtreeLeaf } from 'd3-quadtree';
import type { DisplaySettings, GraphColors, GraphRenderer, RenderEdge, RenderNode } from './types';

export function nodeRadius(degree: number, size: number): number {
  return (3.4 + Math.sqrt(Math.max(0, degree)) * 2.2) * size;
}

const emptyDisplay: DisplaySettings = {
  arrows: false,
  textFade: 60,
  nodeSize: 1,
  linkThickness: 1,
};

const emptyColors: GraphColors = {
  node: '#222',
  unresolved: '#aaa',
  active: '#8a5cf5',
  highlight: '#8a5cf5',
  link: '#ccc',
  linkHighlight: '#8a5cf5',
  label: '#555',
  background: '#fff',
};

/** Canvas graph renderer. Swap this for a WebGL one later; GraphView talks only to GraphRenderer. */
export function createCanvasRenderer(canvas: HTMLCanvasElement): GraphRenderer {
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('This browser cannot draw the graph.');

  let width = 0;
  let height = 0;
  let dpr = 1;
  let vx = 0;
  let vy = 0;
  let scale = 1;
  let colors = emptyColors;
  let display = emptyDisplay;
  let nodes: RenderNode[] = [];
  let edges: RenderEdge[] = [];
  let hover: string | null = null;
  let active: string | null = null;
  let neighbours = new Set<string>();
  let tree: Quadtree<RenderNode> | undefined;

  const rebuild = () => {
    tree = quadtree<RenderNode>()
      .x((node) => node.x)
      .y((node) => node.y)
      .addAll(nodes);
    neighbours = new Set<string>();
    if (!hover) return;
    neighbours.add(hover);
    for (const edge of edges) {
      if (edge.from === hover) neighbours.add(edge.to);
      if (edge.to === hover) neighbours.add(edge.from);
    }
  };

  const visible = (x: number, y: number, pad: number) => {
    const sx = x * scale + vx;
    const sy = y * scale + vy;
    return sx >= -pad && sy >= -pad && sx <= width + pad && sy <= height + pad;
  };

  const labelAlpha = () => {
    const fade = display.textFade / 100;
    const start = 0.45 + (1 - fade) * 1.15;
    return Math.min(1, Math.max(0, (scale - start) / 0.55));
  };

  const drawEdges = (list: RenderEdge[], color: string, alpha: number) => {
    if (!list.length || alpha < 0.02) return;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = display.linkThickness / scale;
    ctx.beginPath();
    const byId = new Map(nodes.map((node) => [node.id, node]));
    for (const edge of list) {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) continue;
      if (!visible(from.x, from.y, 80) && !visible(to.x, to.y, 80)) continue;
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
    }
    ctx.stroke();
    if (!display.arrows) return;
    ctx.fillStyle = color;
    for (const edge of list) {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) continue;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const length = Math.hypot(dx, dy);
      if (length < 1) continue;
      const radius = nodeRadius(to.degree, display.nodeSize);
      const ux = dx / length;
      const uy = dy / length;
      const tipX = to.x - ux * (radius + 0.6);
      const tipY = to.y - uy * (radius + 0.6);
      const head = 6 / scale;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - ux * head + uy * head * 0.45, tipY - uy * head - ux * head * 0.45);
      ctx.lineTo(tipX - ux * head - uy * head * 0.45, tipY - uy * head + ux * head * 0.45);
      ctx.closePath();
      ctx.fill();
    }
  };

  const drawNodes = (list: RenderNode[], alpha: number, highlighted: boolean) => {
    if (!list.length || alpha < 0.02) return;
    ctx.globalAlpha = alpha;
    for (const node of list) {
      if (!visible(node.x, node.y, 24)) continue;
      const radius = nodeRadius(node.degree, display.nodeSize);
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      if (node.exists) {
        ctx.fillStyle =
          node.id === active ? colors.active : highlighted ? colors.highlight : colors.node;
        ctx.fill();
      } else {
        ctx.fillStyle = colors.background;
        ctx.fill();
        ctx.lineWidth = 1.4 / scale;
        ctx.strokeStyle = highlighted || node.id === active ? colors.highlight : colors.unresolved;
        ctx.stroke();
      }
      if (node.id === active && node.exists) {
        ctx.lineWidth = 1.6 / scale;
        ctx.strokeStyle = colors.active;
        ctx.stroke();
      }
    }
  };

  const drawLabels = (list: RenderNode[], alpha: number) => {
    const text = labelAlpha() * alpha;
    if (text < 0.03) return;
    ctx.globalAlpha = text;
    ctx.fillStyle = colors.label;
    ctx.font = `${11 / scale}px ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const node of list) {
      if (!visible(node.x, node.y, 40)) continue;
      const radius = nodeRadius(node.degree, display.nodeSize);
      ctx.fillText(node.title, node.x, node.y + radius + 3 / scale);
    }
  };

  return {
    resize(nextWidth, nextHeight, nextDpr) {
      width = nextWidth;
      height = nextHeight;
      dpr = nextDpr;
      canvas.width = Math.max(1, Math.floor(nextWidth * nextDpr));
      canvas.height = Math.max(1, Math.floor(nextHeight * nextDpr));
      canvas.style.width = `${nextWidth}px`;
      canvas.style.height = `${nextHeight}px`;
    },
    setViewport(x, y, nextScale) {
      vx = x;
      vy = y;
      scale = nextScale;
    },
    setTheme(next) {
      colors = next;
    },
    setDisplay(next) {
      display = next;
    },
    setGraph(nextNodes, nextEdges) {
      nodes = nextNodes;
      edges = nextEdges;
      rebuild();
    },
    setPositions(positions) {
      for (const node of nodes) {
        const at = positions.get(node.id);
        if (!at) continue;
        node.x = at.x;
        node.y = at.y;
      }
      rebuild();
    },
    setHover(id) {
      hover = id;
      rebuild();
    },
    setActive(id) {
      active = id;
    },
    draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = colors.background;
      ctx.fillRect(0, 0, width, height);
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * vx, dpr * vy);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const faded = hover ? 0.14 : 1;
      const restNodes = hover ? nodes.filter((node) => !neighbours.has(node.id)) : nodes;
      const hotNodes = hover ? nodes.filter((node) => neighbours.has(node.id)) : [];
      const restEdges = hover
        ? edges.filter((edge) => !neighbours.has(edge.from) || !neighbours.has(edge.to))
        : edges;
      const hotEdges = hover
        ? edges.filter((edge) => neighbours.has(edge.from) && neighbours.has(edge.to))
        : [];
      drawEdges(restEdges, colors.link, faded);
      drawNodes(restNodes, faded, false);
      drawLabels(restNodes, faded);
      drawEdges(hotEdges, colors.linkHighlight, 1);
      drawNodes(hotNodes, 1, true);
      drawLabels(hotNodes, 1);
      ctx.globalAlpha = 1;
    },
    hitTest(sx, sy) {
      if (!tree) return null;
      const wx = (sx - vx) / scale;
      const wy = (sy - vy) / scale;
      const reach = (nodeRadius(40, display.nodeSize) + 6) / scale;
      let best: RenderNode | undefined;
      let bestDistance = reach * reach;
      tree.visit((quad, x1, y1, x2, y2) => {
        const data = 'data' in quad ? (quad as QuadtreeLeaf<RenderNode>).data : undefined;
        if (data) {
          const radius = nodeRadius(data.degree, display.nodeSize) + 4 / scale;
          const dx = data.x - wx;
          const dy = data.y - wy;
          const distance = dx * dx + dy * dy;
          if (distance <= radius * radius && distance <= bestDistance) {
            best = data;
            bestDistance = distance;
          }
        }
        return x1 > wx + reach || x2 < wx - reach || y1 > wy + reach || y2 < wy - reach;
      });
      return best?.id ?? null;
    },
    destroy() {
      nodes = [];
      edges = [];
      tree = undefined;
    },
  };
}
