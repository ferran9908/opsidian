// Drives the desktop app through hosting, invitations, devices, backups and the connection check.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const electron = require('electron');
const root = await mkdtemp(join(tmpdir(), 'opsidian-hosting-'));
const env = {
  ...process.env,
  OPSIDIAN_VAULT_DIR: join(root, 'Notes'),
  OPSIDIAN_PROFILE_DIR: join(root, 'profile'),
  OPSIDIAN_BACKUP_DIR: join(root, 'backups'),
  OPSIDIAN_HOST_PORT: String(5400 + Math.floor(Math.random() * 500)),
  // The app's host listens on this machine only, never on its network addresses.
  OPSIDIAN_HOST_ADDRESS: '127.0.0.1',
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.OPSIDIAN_RENDERER_URL;
try {
  await new Promise((resolve, reject) => {
    const child = spawn(electron, ['scripts/desktop-hosting.cjs'], { env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`The hosting test exited ${code}`)),
    );
  });
} finally {
  await rm(root, { recursive: true, force: true });
}
