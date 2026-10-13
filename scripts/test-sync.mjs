// Starts a real host, drives the desktop app against it, and plays a second device itself.
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const electron = require('electron');
const hostProgram = 'apps/host/dist/opsidian-host.mjs';
const root = await mkdtemp(join(tmpdir(), 'opsidian-synctest-'));
const data = join(root, 'host');
const port = 4900 + Math.floor(Math.random() * 500);
const address = `http://127.0.0.1:${port}`;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, label) => {
  for (let n = 0; n < 400; n++) {
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
};
const invite = () =>
  /: ([A-Z0-9-]{14})/.exec(
    execFileSync('node', [hostProgram, 'invite', 'Notes', '--data', data, '--port', String(port)], {
      encoding: 'utf8',
    }),
  )[1];

const host = spawn(
  'node',
  [hostProgram, 'serve', '--data', data, '--port', String(port), '--address', '127.0.0.1'],
  {
    stdio: 'ignore',
  },
);
const launch = (extra) => {
  const env = {
    ...process.env,
    OPSIDIAN_SYNC_HOST: `127.0.0.1:${port}`,
    OPSIDIAN_SYNC_SHARED: root,
    ...extra,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.OPSIDIAN_RENDERER_URL;
  return new Promise((resolve, reject) => {
    const child = spawn(electron, ['scripts/desktop-sync.cjs'], { env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (exit) =>
      exit === 0 ? resolve() : reject(new Error(`Electron exited ${exit}`)),
    );
  });
};
try {
  await until(
    () =>
      fetch(`${address}/v1`).then(
        (r) => r.ok,
        () => false,
      ),
    'the host',
  );

  // The other device: paired like any other, speaking the protocol by hand.
  const paired = await (
    await fetch(`${address}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: invite(), device: 'Other Mac' }),
    })
  ).json();
  const auth = { authorization: `Bearer ${paired.token}` };
  const api = async (path, init = {}) => {
    const response = await fetch(`${address}/v1${path}`, {
      ...init,
      headers: { ...auth, ...init.headers },
    });
    assert.ok(response.ok, `${path}: ${response.status}`);
    return response;
  };
  const current = async (path) =>
    (await (await api('/changes?since=0&wait=0')).json()).changes.find(
      (file) => file.path === path && file.hash,
    );
  /** Changes a file as the other device would, retrying if the app got there first. */
  const change = async (path, edit) => {
    for (;;) {
      const before = await current(path);
      const text = before ? await (await api(`/blobs/${before.hash}`)).text() : '';
      const bytes = Buffer.from(edit(text));
      await api(`/blobs/${sha(bytes)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes,
      });
      const op = {
        id: sha(`${path}${Date.now()}${Math.random()}`),
        file: before?.file ?? sha(path).slice(0, 32),
        base: before?.seq ?? 0,
        path,
        hash: sha(bytes),
        size: bytes.length,
      };
      const { results } = await (
        await api('/ops', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ops: [op] }),
        })
      ).json();
      if (results[0].status === 'accepted') return;
      assert.equal(results[0].status, 'stale');
    }
  };

  const first = launch({
    OPSIDIAN_VAULT_DIR: join(root, 'vault'),
    OPSIDIAN_PROFILE_DIR: join(root, 'profile-a'),
    OPSIDIAN_SYNC_CODE: invite(),
    OPSIDIAN_SYNC_PHASE: 'connect',
  });
  let failed;
  first.catch((error) => (failed = error));
  const marker = (name) =>
    until(() => (failed ? Promise.reject(failed) : existsSync(join(root, name))), name);

  await marker('connected');
  await until(() => current('Sunday.md'), 'the note on the host');
  await change('From afar.md', () => 'Written on the other Mac.\n');
  await change('Sunday.md', (text) => `${text}\n\nA line from the other Mac.`);
  await writeFile(join(root, 'edited'), '');

  await marker('typing');
  await delay(700);
  await change('Sunday.md', (text) => `${text}\n\nappended remotely`);
  await writeFile(join(root, 'appended'), '');

  await marker('restored');
  const final = await readFile(join(root, 'final'), 'utf8');
  await until(
    async () => (await (await api(`/blobs/${(await current('Sunday.md')).hash}`)).text()) === final,
    'the restored version on the host',
  );
  await writeFile(join(root, 'confirmed'), '');
  await first;

  await launch({
    OPSIDIAN_PROFILE_DIR: join(root, 'profile-b'),
    OPSIDIAN_SYNC_PARENT: join(root, 'second-mac'),
    OPSIDIAN_SYNC_CODE: invite(),
    OPSIDIAN_SYNC_PHASE: 'join',
    OPSIDIAN_VAULT_DIR: '',
  });
} finally {
  host.kill();
  await rm(root, { recursive: true, force: true });
}
