import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
// One file with everything in it, so a host can be copied to a server and run with Node alone.
await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile: 'dist/opsidian.mjs',
  define: { 'process.env.OPSIDIAN_VERSION': JSON.stringify(version) },
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
  logLevel: 'warning',
});
