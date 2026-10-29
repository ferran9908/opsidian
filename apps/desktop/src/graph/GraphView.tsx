import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { RotateCcw, Settings2 } from 'lucide-react';
import {
  filterGraph,
  graphFingerprint,
  localGraph,
  noteTitle,
  type NoteGraph,
} from '@opsidian/core';
import { bridge } from '../bridge';
import { createCanvasRenderer } from './canvas-renderer';
import {
  displayOf,
  forcesOf,
  GRAPH_DEFAULTS,
  loadGraphSettings,
  saveGraphSettings,
  type GraphSettings,
} from './settings';
import type { GraphRenderer, WorkerIn, WorkerOut } from './types';
import { cn } from '@/lib/utils';

interface Props {
  center: string | null;
  version: number;
  dark: boolean;
  onOpen(path: string): void;
  onCreate(name: string): void;
  /** A tag node was clicked. */
  onTag(tag: string): void;
}

interface Camera {
  x: number;
  y: number;
  scale: number;
}

function readColors() {
  const css = getComputedStyle(document.documentElement);
  const take = (name: string) => css.getPropertyValue(name).trim();
  return {
    node: take('--graph-node'),
    unresolved: take('--graph-node-unresolved'),
    active: take('--graph-node-active'),
    highlight: take('--graph-node-highlight'),
    tag: take('--graph-node-tag'),
    link: take('--graph-link'),
    linkHighlight: take('--graph-link-highlight'),
    label: take('--graph-label'),
    background: take('--background'),
  };
}

function visibleGraph(
  snapshot: NoteGraph,
  settings: GraphSettings,
  center: string | null,
): NoteGraph {
  const scoped =
    settings.global || !center ? snapshot : localGraph(snapshot, center, settings.depth);
  return filterGraph(scoped, {
    orphans: settings.orphans,
    existingOnly: settings.existingOnly,
    ...(center ? { keep: center } : {}),
  });
}

function fit(camera: Camera, nodes: { x: number; y: number }[], width: number, height: number) {
  if (!nodes.length || width < 8 || height < 8) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x);
    maxY = Math.max(maxY, node.y);
  }
  const pad = 88;
  const spanX = Math.max(maxX - minX, 48);
  const spanY = Math.max(maxY - minY, 48);
  camera.scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY, 1.5);
  camera.scale = Math.max(camera.scale, 0.18);
  camera.x = width / 2 - ((minX + maxX) / 2) * camera.scale;
  camera.y = height / 2 - ((minY + maxY) / 2) * camera.scale;
}

function recenter(camera: Camera, node: { x: number; y: number }, width: number, height: number) {
  camera.x = width / 2 - node.x * camera.scale;
  camera.y = height / 2 - node.y * camera.scale;
}

export function GraphView(props: Props) {
  const { center, version, dark, onOpen, onCreate, onTag } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const renderer = useRef<GraphRenderer | undefined>(undefined);
  const worker = useRef<Worker | undefined>(undefined);
  const camera = useRef<Camera>({ x: 0, y: 0, scale: 1 });
  const positions = useRef(new Map<string, { x: number; y: number }>());
  const size = useRef({ width: 0, height: 0, dpr: 1 });
  const fingerprint = useRef('');
  const fitted = useRef('');
  const lastCenter = useRef<string | null>(null);
  const pendingCenter = useRef<string | null>(null);
  const simulating = useRef(false);
  const dirty = useRef(false);
  const frame = useRef(0);
  const pointer = useRef<
    | { kind: 'pan'; x: number; y: number }
    | { kind: 'node'; id: string; x: number; y: number; moved: boolean }
    | undefined
  >(undefined);
  const snapshot = useRef<NoteGraph | undefined>(undefined);
  const settingsRef = useRef<GraphSettings>(loadGraphSettings());
  const centerRef = useRef(center);
  const forcesReady = useRef(false);
  const [settings, setSettings] = useState<GraphSettings>(settingsRef.current);
  const [panel, setPanel] = useState(true);
  const [hover, setHover] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [visibleCount, setVisibleCount] = useState(0);
  settingsRef.current = settings;
  centerRef.current = center;

  const paint = () => {
    const view = renderer.current;
    if (!view) return;
    view.setViewport(camera.current.x, camera.current.y, camera.current.scale);
    view.draw();
  };

  const requestDraw = () => {
    dirty.current = true;
    if (frame.current) return;
    const step = () => {
      frame.current = 0;
      if (!dirty.current && !simulating.current) return;
      dirty.current = false;
      paint();
      if (simulating.current || dirty.current) frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  };

  const applyVisible = (next: NoteGraph, reason: 'sync' | 'center' | 'filter') => {
    const view = renderer.current;
    if (!view) return;
    setVisibleCount(next.nodes.length);
    const nodes = next.nodes.map((node) => {
      const at = positions.current.get(node.path);
      return {
        id: node.path,
        title: node.title,
        exists: node.exists,
        ...(node.tag ? { tag: true } : {}),
        degree: node.inDegree + node.outDegree,
        x: at?.x ?? 0,
        y: at?.y ?? 0,
      };
    });
    view.setGraph(
      nodes,
      next.edges.map((edge) => ({ from: edge.from, to: edge.to })),
    );
    view.setActive(centerRef.current);
    view.setDisplay(displayOf(settingsRef.current));
    const key = graphFingerprint(next);
    if (key === fingerprint.current) {
      requestDraw();
      return;
    }
    fingerprint.current = key;
    const first = !fitted.current;
    worker.current?.postMessage({
      type: 'sync',
      nodes: next.nodes.map((node) => {
        const at = positions.current.get(node.path);
        return at ? { id: node.path, x: at.x, y: at.y } : { id: node.path };
      }),
      edges: next.edges.map((edge) => ({ source: edge.from, target: edge.to })),
      forces: forcesOf(settingsRef.current),
      alpha: first ? 1 : 0.28,
    } satisfies WorkerIn);
    if (reason === 'center' && centerRef.current) {
      pendingCenter.current = centerRef.current;
      const at = positions.current.get(centerRef.current);
      if (at) {
        recenter(camera.current, at, size.current.width, size.current.height);
        pendingCenter.current = null;
      }
    } else if (reason === 'filter') {
      fitted.current = '';
    }
    lastCenter.current = centerRef.current;
  };

  useEffect(() => {
    const element = canvas.current;
    const box = host.current;
    if (!element || !box) return;
    const view = createCanvasRenderer(element);
    renderer.current = view;
    view.setTheme(readColors());
    view.setDisplay(displayOf(settingsRef.current));
    const layout = new Worker(new URL('./graph-worker.ts', import.meta.url), { type: 'module' });
    worker.current = layout;
    layout.onmessage = (event: MessageEvent<WorkerOut>) => {
      const message = event.data;
      if (message.type !== 'tick') return;
      for (const node of message.nodes) positions.current.set(node.id, { x: node.x, y: node.y });
      view.setPositions(positions.current);
      const focus = pendingCenter.current ?? centerRef.current;
      if (!fitted.current && message.nodes.length && fingerprint.current) {
        fit(camera.current, message.nodes, size.current.width, size.current.height);
        fitted.current = fingerprint.current;
        if (focus && !settingsRef.current.global) {
          const at = positions.current.get(focus);
          if (at) {
            recenter(camera.current, at, size.current.width, size.current.height);
            pendingCenter.current = null;
          }
        }
      } else if (pendingCenter.current) {
        const at = positions.current.get(pendingCenter.current);
        if (at) {
          recenter(camera.current, at, size.current.width, size.current.height);
          pendingCenter.current = null;
        }
      }
      simulating.current = !message.settled;
      if (message.settled) {
        paint();
        return;
      }
      requestDraw();
    };
    const measure = () => {
      const bounds = box.getBoundingClientRect();
      size.current = {
        width: bounds.width,
        height: bounds.height,
        dpr: window.devicePixelRatio || 1,
      };
      view.resize(bounds.width, bounds.height, size.current.dpr);
      requestDraw();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    setReady(true);
    return () => {
      observer.disconnect();
      layout.postMessage({ type: 'stop' } satisfies WorkerIn);
      layout.terminate();
      view.destroy();
      renderer.current = undefined;
      worker.current = undefined;
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, []);

  useEffect(() => {
    renderer.current?.setTheme(readColors());
    requestDraw();
  }, [dark]);

  useEffect(() => {
    let cancelled = false;
    void bridge.graph({ tags: settings.tags }).then((graph) => {
      if (cancelled) return;
      snapshot.current = graph;
      applyVisible(visibleGraph(graph, settingsRef.current, centerRef.current), 'sync');
    });
    return () => {
      cancelled = true;
    };
  }, [version, settings.tags]);

  useEffect(() => {
    if (!snapshot.current || !ready) return;
    const reason = lastCenter.current === center ? 'filter' : 'center';
    applyVisible(visibleGraph(snapshot.current, settings, center), reason);
  }, [ready, center, settings.depth, settings.global, settings.orphans, settings.existingOnly]);

  useEffect(() => {
    renderer.current?.setDisplay(displayOf(settings));
    requestDraw();
  }, [settings.arrows, settings.textFade, settings.nodeSize, settings.linkThickness]);

  useEffect(() => {
    if (!worker.current || !fingerprint.current) return;
    if (!forcesReady.current) {
      forcesReady.current = true;
      return;
    }
    worker.current.postMessage({ type: 'forces', forces: forcesOf(settings) } satisfies WorkerIn);
  }, [settings.center, settings.repel, settings.link, settings.distance]);

  useEffect(() => {
    saveGraphSettings(settings);
  }, [settings]);

  const update = (patch: Partial<GraphSettings>) =>
    setSettings((current) => ({ ...current, ...patch }));

  const world = (event: { clientX: number; clientY: number }) => {
    const bounds = canvas.current?.getBoundingClientRect();
    if (!bounds) return { sx: 0, sy: 0, x: 0, y: 0 };
    const sx = event.clientX - bounds.left;
    const sy = event.clientY - bounds.top;
    return {
      sx,
      sy,
      x: (sx - camera.current.x) / camera.current.scale,
      y: (sy - camera.current.y) / camera.current.scale,
    };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    const at = world(event);
    const id = renderer.current?.hitTest(at.sx, at.sy) ?? null;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (id) {
      pointer.current = { kind: 'node', id, x: at.x, y: at.y, moved: false };
      worker.current?.postMessage({ type: 'drag', id, x: at.x, y: at.y } satisfies WorkerIn);
    } else {
      pointer.current = { kind: 'pan', x: at.sx, y: at.sy };
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const at = world(event);
    const drag = pointer.current;
    if (drag?.kind === 'pan') {
      camera.current.x += at.sx - drag.x;
      camera.current.y += at.sy - drag.y;
      drag.x = at.sx;
      drag.y = at.sy;
      requestDraw();
      return;
    }
    if (drag?.kind === 'node') {
      if (Math.hypot(at.x - drag.x, at.y - drag.y) > 2 / camera.current.scale) drag.moved = true;
      worker.current?.postMessage({
        type: 'drag',
        id: drag.id,
        x: at.x,
        y: at.y,
      } satisfies WorkerIn);
      return;
    }
    const id = renderer.current?.hitTest(at.sx, at.sy) ?? null;
    if (id === hover) return;
    setHover(id);
    renderer.current?.setHover(id);
    requestDraw();
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = pointer.current;
    pointer.current = undefined;
    if (drag?.kind === 'node') {
      worker.current?.postMessage({
        type: 'drag',
        id: drag.id,
        x: event.clientX,
        y: event.clientY,
        end: true,
      } satisfies WorkerIn);
      if (drag.moved) return;
      const graph = snapshot.current;
      const node = graph?.nodes.find((item) => item.path === drag.id);
      if (!node) return;
      if (node.tag) onTag(node.path.slice(1));
      else if (node.exists) onOpen(node.path);
      else onCreate(noteTitle(node.path));
    }
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const at = world(event);
    const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
    const next = Math.min(8, Math.max(0.08, camera.current.scale * factor));
    camera.current.x = at.sx - at.x * next;
    camera.current.y = at.sy - at.y * next;
    camera.current.scale = next;
    requestDraw();
  };

  const empty = !settings.global && !center;

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={host} className="absolute inset-0">
        <canvas
          ref={canvas}
          className="block h-full w-full touch-none"
          role="img"
          aria-label="Note graph"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => {
            if (pointer.current) return;
            setHover(null);
            renderer.current?.setHover(null);
            requestDraw();
          }}
          onWheel={onWheel}
          style={{
            cursor: pointer.current?.kind === 'pan' ? 'grabbing' : hover ? 'pointer' : 'grab',
          }}
        />
      </div>
      {empty && (
        <div className="text-muted-foreground pointer-events-none absolute inset-0 flex items-center justify-center text-sm">
          Open a note to see its local graph, or switch to the whole notebook.
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3">
        <div className="pointer-events-auto flex flex-wrap items-center gap-2">
          <div className="border-border bg-card/90 flex rounded-md border shadow-sm">
            {([1, 2, 3] as const).map((depth) => (
              <button
                key={depth}
                type="button"
                disabled={settings.global}
                className={cn(
                  'h-7 px-2.5 text-[12px] disabled:opacity-40',
                  !settings.global && settings.depth === depth
                    ? 'text-foreground font-medium'
                    : 'text-muted-foreground',
                )}
                onClick={() => update({ depth })}
              >
                {depth}
              </button>
            ))}
          </div>
          <div className="border-border bg-card/90 flex rounded-md border shadow-sm">
            <button
              type="button"
              className={cn(
                'h-7 px-2.5 text-[12px]',
                !settings.global ? 'text-foreground font-medium' : 'text-muted-foreground',
              )}
              onClick={() => update({ global: false })}
            >
              Local
            </button>
            <button
              type="button"
              className={cn(
                'h-7 px-2.5 text-[12px]',
                settings.global ? 'text-foreground font-medium' : 'text-muted-foreground',
              )}
              onClick={() => update({ global: true })}
            >
              All notes
            </button>
          </div>
          {visibleCount > 0 && (
            <span className="text-muted-foreground px-1 text-[12px]">
              {visibleCount} {visibleCount === 1 ? 'note' : 'notes'}
            </span>
          )}
        </div>
        <button
          type="button"
          aria-label="Graph settings"
          title="Graph settings"
          className={cn(
            'pointer-events-auto border-border bg-card/90 text-muted-foreground hover:text-foreground flex size-7 items-center justify-center rounded-md border shadow-sm',
            panel && 'text-foreground',
          )}
          onClick={() => setPanel((open) => !open)}
        >
          <Settings2 size={15} />
        </button>
      </div>
      {panel && (
        <aside className="border-border bg-card/95 absolute top-14 right-3 bottom-3 flex w-[240px] flex-col overflow-auto rounded-lg border p-3 shadow-sm">
          <h2 className="text-[13px] font-semibold">Forces</h2>
          <Slider
            label="Center force"
            min={0}
            max={100}
            value={settings.center}
            onChange={(centerForce) => update({ center: centerForce })}
          />
          <Slider
            label="Repel force"
            min={0}
            max={100}
            value={settings.repel}
            onChange={(repel) => update({ repel })}
          />
          <Slider
            label="Link force"
            min={0}
            max={100}
            value={settings.link}
            onChange={(link) => update({ link })}
          />
          <Slider
            label="Link distance"
            min={30}
            max={250}
            value={settings.distance}
            onChange={(distance) => update({ distance })}
          />
          <h2 className="mt-4 text-[13px] font-semibold">Display</h2>
          <Slider
            label="Text fade"
            min={0}
            max={100}
            value={settings.textFade}
            onChange={(textFade) => update({ textFade })}
          />
          <Slider
            label="Node size"
            min={0.4}
            max={2.5}
            step={0.1}
            value={settings.nodeSize}
            onChange={(nodeSize) => update({ nodeSize })}
          />
          <Slider
            label="Link thickness"
            min={0.4}
            max={3}
            step={0.1}
            value={settings.linkThickness}
            onChange={(linkThickness) => update({ linkThickness })}
          />
          <Toggle
            label="Arrows"
            checked={settings.arrows}
            onChange={(arrows) => update({ arrows })}
          />
          <Toggle
            label="Orphans"
            checked={settings.orphans}
            onChange={(orphans) => update({ orphans })}
          />
          <Toggle
            label="Existing files only"
            checked={settings.existingOnly}
            onChange={(existingOnly) => update({ existingOnly })}
          />
          <Toggle label="Tags" checked={settings.tags} onChange={(tags) => update({ tags })} />
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground mt-3 flex items-center gap-1.5 self-start text-[12px]"
            onClick={() => setSettings({ ...GRAPH_DEFAULTS })}
          >
            <RotateCcw size={12} /> Restore defaults
          </button>
        </aside>
      )}
    </div>
  );
}

function Slider(props: {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange(value: number): void;
}) {
  return (
    <label className="mt-2 block text-[12px]">
      <span className="text-muted-foreground flex justify-between">
        {props.label}
        <span className="text-faint tabular-nums">{props.value}</span>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.currentTarget.value))}
        className="accent-primary mt-1 w-full"
      />
    </label>
  );
}

function Toggle(props: { label: string; checked: boolean; onChange(value: boolean): void }) {
  return (
    <label className="mt-2 flex items-center justify-between text-[12px]">
      <span className="text-muted-foreground">{props.label}</span>
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
        className="accent-primary"
      />
    </label>
  );
}
