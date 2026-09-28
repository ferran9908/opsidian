import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const electron = require('electron');
const root = await mkdtemp(join(tmpdir(), 'opsidian-smoke-'));
const env = { ...process.env, OPSIDIAN_VAULT_DIR: root };
delete env.ELECTRON_RUN_AS_NODE;
delete env.OPSIDIAN_RENDERER_URL;
try {
  for (const phase of ['write', 'read']) {
    await new Promise((resolve, reject) => {
      const child = spawn(electron, ['scripts/desktop-smoke.cjs'], {
        env: { ...env, OPSIDIAN_SMOKE_PHASE: phase },
        stdio: 'inherit',
      });
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`Electron smoke exited ${code}`)),
      );
    });
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
