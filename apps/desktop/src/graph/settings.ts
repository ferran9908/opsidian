import type { DisplaySettings, ForceSettings } from './types';

export interface GraphSettings extends ForceSettings, DisplaySettings {
  orphans: boolean;
  existingOnly: boolean;
  depth: number;
  global: boolean;
}

export const GRAPH_DEFAULTS: GraphSettings = {
  center: 30,
  repel: 50,
  link: 40,
  distance: 90,
  arrows: false,
  textFade: 60,
  nodeSize: 1,
  linkThickness: 1,
  orphans: true,
  existingOnly: false,
  depth: 1,
  global: false,
};

const KEY = 'opsidian.graph.settings';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function number(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

export function loadGraphSettings(): GraphSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '') as Partial<GraphSettings>;
    return {
      center: number(saved.center, GRAPH_DEFAULTS.center, 0, 100),
      repel: number(saved.repel, GRAPH_DEFAULTS.repel, 0, 100),
      link: number(saved.link, GRAPH_DEFAULTS.link, 0, 100),
      distance: number(saved.distance, GRAPH_DEFAULTS.distance, 30, 250),
      arrows: typeof saved.arrows === 'boolean' ? saved.arrows : GRAPH_DEFAULTS.arrows,
      textFade: number(saved.textFade, GRAPH_DEFAULTS.textFade, 0, 100),
      nodeSize: number(saved.nodeSize, GRAPH_DEFAULTS.nodeSize, 0.4, 2.5),
      linkThickness: number(saved.linkThickness, GRAPH_DEFAULTS.linkThickness, 0.4, 3),
      orphans: typeof saved.orphans === 'boolean' ? saved.orphans : GRAPH_DEFAULTS.orphans,
      existingOnly:
        typeof saved.existingOnly === 'boolean' ? saved.existingOnly : GRAPH_DEFAULTS.existingOnly,
      depth: number(saved.depth, GRAPH_DEFAULTS.depth, 1, 3),
      global: typeof saved.global === 'boolean' ? saved.global : GRAPH_DEFAULTS.global,
    };
  } catch {
    return { ...GRAPH_DEFAULTS };
  }
}

export function saveGraphSettings(settings: GraphSettings): void {
  localStorage.setItem(KEY, JSON.stringify(settings));
}

export function forcesOf(settings: GraphSettings): ForceSettings {
  return {
    center: settings.center,
    repel: settings.repel,
    link: settings.link,
    distance: settings.distance,
  };
}

export function displayOf(settings: GraphSettings): DisplaySettings {
  return {
    arrows: settings.arrows,
    textFade: settings.textFade,
    nodeSize: settings.nodeSize,
    linkThickness: settings.linkThickness,
  };
}
