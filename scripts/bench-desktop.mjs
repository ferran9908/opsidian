import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const electron = require('electron');
const root = await mkdtemp(join(tmpdir(), 'opsidian-bench-'));
const env = {
  ...process.env,
  OPSIDIAN_VAULT_DIR: join(root, 'vault'),
  OPSIDIAN_PROFILE_DIR: join(root, 'profile'),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.OPSIDIAN_RENDERER_URL;
try {
  await new Promise((resolve) =>
    spawn(electron, ['scripts/desktop-bench.cjs'], { env, stdio: 'inherit' }).on('exit', resolve),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
