export interface ForceSettings {
  center: number;
  repel: number;
  link: number;
  distance: number;
}

export interface DisplaySettings {
  arrows: boolean;
  textFade: number;
  nodeSize: number;
  linkThickness: number;
}

export interface GraphColors {
  node: string;
  unresolved: string;
  active: string;
  highlight: string;
  link: string;
  linkHighlight: string;
  label: string;
  background: string;
}

export interface RenderNode {
  id: string;
  title: string;
  exists: boolean;
  degree: number;
  x: number;
  y: number;
}

export interface RenderEdge {
  from: string;
  to: string;
}

export interface GraphRenderer {
  resize(width: number, height: number, dpr: number): void;
  setViewport(x: number, y: number, scale: number): void;
  setTheme(colors: GraphColors): void;
  setDisplay(display: DisplaySettings): void;
  setGraph(nodes: RenderNode[], edges: RenderEdge[]): void;
  setPositions(positions: ReadonlyMap<string, { x: number; y: number }>): void;
  setHover(id: string | null): void;
  setActive(id: string | null): void;
  draw(): void;
  hitTest(sx: number, sy: number): string | null;
  destroy(): void;
}

export type WorkerIn =
  | {
      type: 'sync';
      nodes: { id: string; x?: number; y?: number }[];
      edges: { source: string; target: string }[];
      forces: ForceSettings;
      alpha: number;
    }
  | { type: 'forces'; forces: ForceSettings }
  | { type: 'drag'; id: string; x: number; y: number; end?: boolean }
  | { type: 'stop' };

export type WorkerOut = {
  type: 'tick';
  nodes: { id: string; x: number; y: number }[];
  settled: boolean;
};
