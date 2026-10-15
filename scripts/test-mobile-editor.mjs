// The iPhone app's editor page, tested in Electron's Chromium as generated.
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const electron = require('electron');
// The page is a TypeScript module; a CommonJS copy lets the Electron script require it.
const source = await readFile('apps/mobile/generated/editor-html.ts', 'utf8');
await writeFile(
  'apps/mobile/generated/editor-html.cjs',
  source.replace('export const editorHtml =', 'exports.editorHtml ='),
);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
await new Promise((resolve, reject) => {
  const child = spawn(electron, ['scripts/mobile-editor.cjs'], { env, stdio: 'inherit' });
  child.on('error', reject);
  child.on('exit', (code) =>
    code === 0 ? resolve() : reject(new Error(`The mobile editor test exited ${code}`)),
  );
});
