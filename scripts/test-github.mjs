// Drives the desktop app through signing in to GitHub, keeping a notebook there, and importing one.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const electron = require('electron');
const root = await mkdtemp(join(tmpdir(), 'opsidian-github-'));
const env = {
  ...process.env,
  OPSIDIAN_VAULT_DIR: join(root, 'Notes'),
  OPSIDIAN_PROFILE_DIR: join(root, 'profile'),
  OPSIDIAN_GITHUB_ROOT: join(root, 'github'),
  OPSIDIAN_HOST_PORT: String(5400 + Math.floor(Math.random() * 500)),
  // Notebooks imported from GitHub are made here, not in the real Documents folder.
  HOME: join(root, 'home'),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.OPSIDIAN_RENDERER_URL;
try {
  await new Promise((resolve, reject) => {
    const child = spawn(electron, ['scripts/desktop-github.cjs', ...process.argv.slice(2)], {
      env,
      stdio: 'inherit',
    });
    // A hang, such as a prompt nobody can answer, fails the test instead of the whole run.
    const limit = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('The GitHub test took more than five minutes.'));
    }, 5 * 60_000);
    child.on('exit', () => clearTimeout(limit));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`The GitHub test exited ${code}`)),
    );
  });
} finally {
  await rm(root, { recursive: true, force: true });
}
