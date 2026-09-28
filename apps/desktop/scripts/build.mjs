import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
export async function buildElectron() {
  await build({
    entryPoints: ['electron/main.ts', 'electron/preload.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    outdir: 'dist-electron',
    outExtension: { '.js': '.cjs' },
    sourcemap: true,
  });
}
await buildElectron();
if (!process.env.OPSIDIAN_DEV) await viteBuild();
