import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Vault } from '../apps/desktop/electron/vault';
import { GRAPH_DEFAULTS } from '../apps/desktop/src/graph/settings';
import { settleGraph } from '../apps/desktop/src/graph/simulation';

const NOTES = 5000;
const timed = async <T>(task: () => T | Promise<T>) => {
  const started = performance.now();
  const value = await task();
  return { value, ms: performance.now() - started };
};

// The index is in memory and rebuilt on open. This holds it to a large notebook: 5,000 notes
// of about 2 KB, each linking to five others. The limits are several times the measured
// figures (see docs/desktop-notebook.md), so they fail on a real regression, not on a slow run.
it('stays fast on a 5,000-note notebook', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opsidian-scale-'));
  try {
    const filler = 'The quick brown fox jumps over the lazy dog near the quiet river. '.repeat(28);
    for (let folder = 0; folder < 50; folder++) await mkdir(join(directory, `Folder ${folder}`));
    for (let note = 0; note < NOTES; note++) {
      const links = [1, 7, 31, 211, 1009].map((step) => `[[Note ${(note + step) % NOTES}]]`);
      await writeFile(
        join(directory, `Folder ${note % 50}`, `Note ${note}.md`),
        `# Note ${note}\n\n${filler}\n\nmarker${note} ${links.join(' ')}\n`,
      );
    }
    const opened = await timed(() => Vault.open(directory));
    const vault = opened.value;
    expect(vault.tree().notes).toHaveLength(NOTES);
    const search = await timed(() => vault.search('marker4321'));
    expect(search.value.map((result) => result.path)).toEqual(['Folder 21/Note 4321.md']);
    const common = await timed(() => vault.search('quick river'));
    expect(common.value).toHaveLength(30);
    const backlinks = await timed(() => vault.backlinks('Folder 0/Note 0.md'));
    expect(backlinks.value).toHaveLength(5);
    const renamed = await timed(() => vault.rename('Folder 0/Note 0.md', 'Renamed'));
    expect(renamed.value.rewritten).toHaveLength(5);
    expect(await readFile(join(directory, 'Folder 49/Note 4999.md'), 'utf8')).toContain(
      '[[Renamed]]',
    );
    const moved = await timed(() => vault.rename('Folder 1', 'Moved'));
    expect(vault.tree().notes.filter((path) => path.startsWith('Moved/'))).toHaveLength(100);
    const graph = await timed(() => vault.graph());
    expect(graph.value.nodes.length).toBeGreaterThanOrEqual(NOTES);
    expect(graph.value.edges).toHaveLength(NOTES * 5);
    const settled = await timed(() =>
      settleGraph(
        graph.value.nodes.map((node) => ({ id: node.path })),
        graph.value.edges.map((edge) => ({ source: edge.from, target: edge.to })),
        {
          center: GRAPH_DEFAULTS.center,
          repel: GRAPH_DEFAULTS.repel,
          link: GRAPH_DEFAULTS.link,
          distance: GRAPH_DEFAULTS.distance,
        },
        250,
      ),
    );
    expect(settled.value.nodes).toHaveLength(graph.value.nodes.length);
    expect(settled.value.ticks).toBeGreaterThan(0);
    console.log(
      `5,000 notes: open ${opened.ms.toFixed(0)} ms, rare-word search ${search.ms.toFixed(1)} ms, ` +
        `common-word search ${common.ms.toFixed(1)} ms, backlinks ${backlinks.ms.toFixed(1)} ms, ` +
        `rename with link rewrite ${renamed.ms.toFixed(0)} ms, folder rename ${moved.ms.toFixed(0)} ms, ` +
        `graph ${graph.ms.toFixed(1)} ms, settle ${settled.ms.toFixed(0)} ms (${settled.value.ticks} ticks)`,
    );
    expect(opened.ms).toBeLessThan(10000);
    expect(search.ms).toBeLessThan(250);
    expect(common.ms).toBeLessThan(250);
    expect(backlinks.ms).toBeLessThan(250);
    expect(renamed.ms).toBeLessThan(3000);
    expect(moved.ms).toBeLessThan(3000);
    expect(graph.ms).toBeLessThan(250);
    expect(settled.ms).toBeLessThan(20000);
    vault.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
