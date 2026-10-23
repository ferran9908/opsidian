// Moves a host between machines through the real programs: a headless host hands over to the
// Mac app, which then offers its own host on to the next machine.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const electron = require('electron');
const root = await mkdtemp(join(tmpdir(), 'opsidian-move-'));
const port = 5900 + Math.floor(Math.random() * 400);
const old = `127.0.0.1:${port}`;
const home = join(root, 'old');
const cli = (...args) =>
  execFileSync(process.execPath, ['apps/host/bin/opsidian.mjs', 'host', ...args], {
    env: { ...process.env, OPSIDIAN_HOME: home },
    encoding: 'utf8',
  });
const code = (output) => output.match(/[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/)[0];

// The machine that hosts at first: a headless host, as on a Mac mini or a server.
await mkdir(home, { recursive: true });
await writeFile(join(home, 'host.json'), JSON.stringify({ port, address: '127.0.0.1' }));
const host = spawn(process.execPath, ['apps/host/bin/opsidian.mjs', 'host', 'run'], {
  env: { ...process.env, OPSIDIAN_HOME: home },
  stdio: 'inherit',
});
const env = {
  ...process.env,
  OPSIDIAN_VAULT_DIR: join(root, 'Notes'),
  OPSIDIAN_PROFILE_DIR: join(root, 'profile'),
  OPSIDIAN_HOST_PORT: String(port + 500),
  OPSIDIAN_OLD_HOST: old,
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.OPSIDIAN_RENDERER_URL;
try {
  for (let tries = 0; ; tries++) {
    const answered = await fetch(`http://${old}/v1`).then(
      (response) => response.ok,
      () => false,
    );
    if (answered) break;
    if (tries > 100) throw new Error('The headless host did not start.');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  env.OPSIDIAN_INVITE_CODE = code(cli('invite', 'Notes'));
  env.OPSIDIAN_MOVE_CODE = code(cli('move'));
  await new Promise((resolve, reject) => {
    const child = spawn(electron, ['scripts/desktop-move.cjs'], { env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (exit) =>
      exit === 0 ? resolve() : reject(new Error(`The move test exited ${exit}`)),
    );
  });
  // The headless host knows where it went, and that the Mac followed.
  const told = cli('move');
  assert.match(told, /Moved to http:\/\/[\d.]+:\d+/);
  assert.match(told, /Every device has followed/);
  console.log('PASS the old host says where it went, and that every device followed');
} finally {
  host.kill();
  await rm(root, { recursive: true, force: true });
}
