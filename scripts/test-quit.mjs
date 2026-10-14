// Quitting must end the app from every screen: the welcome screen, the editor with unsaved typing
// (which must be saved first), the editor with Settings open, and a page that has stopped.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const electron = require('electron');

async function quitFrom(screen, limit) {
  const root = await mkdtemp(join(tmpdir(), 'opsidian-quit-'));
  const env = {
    ...process.env,
    OPSIDIAN_QUIT_SCREEN: screen,
    OPSIDIAN_PROFILE_DIR: join(root, 'profile'),
  };
  if (screen !== 'welcome') env.OPSIDIAN_VAULT_DIR = join(root, 'vault');
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.OPSIDIAN_RENDERER_URL;
  const started = Date.now();
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(electron, ['scripts/desktop-quit.cjs'], { env, stdio: 'inherit' });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`FAIL quitting from the ${screen} screen left the app running`));
      }, limit);
      child.on('error', reject);
      child.on('exit', (exit) => {
        clearTimeout(timer);
        resolve(exit);
      });
    });
    if (code !== 0) throw new Error(`FAIL the ${screen} run exited ${code}`);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (screen === 'editor' || screen === 'settings') {
      const saved = await readFile(join(root, 'vault', 'Note.md'), 'utf8');
      if (!saved.includes('typed just before quitting'))
        throw new Error(`FAIL quitting from the ${screen} screen lost what was typed`);
      console.log(`PASS quit from the ${screen} screen in ${seconds} s, and saved what was typed`);
    } else console.log(`PASS quit from the ${screen} screen in ${seconds} s`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await quitFrom('welcome', 20_000);
await quitFrom('editor', 20_000);
await quitFrom('settings', 20_000);
// The window gives a page that has stopped ten seconds before closing without it.
await quitFrom('frozen', 30_000);
