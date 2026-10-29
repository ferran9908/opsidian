// Drives the Mac app through leaving a host and starting over: stopping sync with the folder
// moved to the Trash, the folder kept when the host is out of reach, deleting a notebook it
// hosts, and resetting everything. A headless host plays the server the Mac syncs with.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const electron = require('electron');
const root = await mkdtemp(join(tmpdir(), 'opsidian-leaving-'));
const port = 6300 + Math.floor(Math.random() * 400);
const home = join(root, 'server');
const cli = (...args) =>
  execFileSync(process.execPath, ['apps/host/bin/opsidian.mjs', 'host', ...args], {
    env: { ...process.env, OPSIDIAN_HOME: home },
    encoding: 'utf8',
  });
const code = (output) => output.match(/[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/)[0];

await mkdir(home, { recursive: true });
await writeFile(join(home, 'host.json'), JSON.stringify({ port, address: '127.0.0.1' }));
const host = spawn(process.execPath, ['apps/host/bin/opsidian.mjs', 'host', 'run'], {
  env: { ...process.env, OPSIDIAN_HOME: home },
  stdio: 'inherit',
});
const env = {
  ...process.env,
  OPSIDIAN_VAULT_DIR: join(root, 'Client'),
  OPSIDIAN_PROFILE_DIR: join(root, 'profile'),
  OPSIDIAN_BACKUP_DIR: join(root, 'backups'),
  OPSIDIAN_HOST_PORT: String(port + 500),
  OPSIDIAN_HOST_ADDRESS: '127.0.0.1',
  OPSIDIAN_SERVER: `http://127.0.0.1:${port}`,
  OPSIDIAN_SERVER_PID: String(host.pid),
  OPSIDIAN_SERVER_HOME: home,
  OPSIDIAN_NODE: process.execPath,
  // The Trash used on Linux, kept inside the test's folder.
  XDG_DATA_HOME: join(root, 'xdg'),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.OPSIDIAN_RENDERER_URL;
try {
  for (let tries = 0; ; tries++) {
    if (
      await fetch(`${env.OPSIDIAN_SERVER}/v1`).then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    if (tries > 100) throw new Error('The headless host did not start.');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  env.OPSIDIAN_CODE_1 = code(
    cli('invite', 'Notes', '--address', '127.0.0.1', '--port', String(port)),
  );
  env.OPSIDIAN_CODE_2 = code(
    cli('invite', 'Notes', '--address', '127.0.0.1', '--port', String(port)),
  );
  await new Promise((resolve, reject) => {
    const child = spawn(electron, ['scripts/desktop-leaving.cjs'], { env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (status) =>
      status === 0 ? resolve() : reject(new Error(`The leaving test exited ${status}`)),
    );
  });
} finally {
  host.kill();
  await rm(root, { recursive: true, force: true });
}
