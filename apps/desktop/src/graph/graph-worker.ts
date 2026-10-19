import { applyForces, applyGraph, createSimulation, tick, type Simulation } from './simulation';
import type { WorkerIn } from './types';

let sim: Simulation | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;

function emit(settled: boolean) {
  if (!sim) return;
  postMessage({
    type: 'tick',
    nodes: sim.nodes.map((node) => ({ id: node.id, x: node.x, y: node.y })),
    settled,
  });
}

function loop() {
  timer = undefined;
  if (!sim || !running) return;
  let alive = true;
  for (let step = 0; step < 4; step++) {
    alive = tick(sim);
    if (!alive) break;
  }
  emit(!alive);
  if (alive) timer = setTimeout(loop, 16);
  else running = false;
}

function wake() {
  if (running) return;
  running = true;
  if (timer === undefined) timer = setTimeout(loop, 0);
}

onmessage = (event: MessageEvent<WorkerIn>) => {
  const message = event.data;
  if (message.type === 'sync') {
    if (!sim) sim = createSimulation(message.nodes, message.edges, message.forces);
    else {
      applyGraph(sim, message.nodes, message.edges);
      applyForces(sim, message.forces);
    }
    sim.alpha(message.alpha);
    wake();
    return;
  }
  if (message.type === 'forces') {
    if (!sim) return;
    applyForces(sim, message.forces);
    sim.alpha(Math.max(sim.alpha(), 0.35));
    wake();
    return;
  }
  if (message.type === 'drag') {
    if (!sim) return;
    const node = sim.node(message.id);
    if (!node) return;
    if (message.end) {
      node.fx = null;
      node.fy = null;
    } else {
      node.fx = message.x;
      node.fy = message.y;
      node.x = message.x;
      node.y = message.y;
    }
    sim.alpha(Math.max(sim.alpha(), 0.12));
    wake();
    return;
  }
  if (message.type === 'stop') {
    running = false;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }
};
