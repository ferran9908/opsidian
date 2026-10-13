// Kills the desktop app outright while it is saving, several times, and checks that the note
// on disk is always a whole earlier version and that the app carries on from it.
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const electron = require('electron');
/** Edits older than this when the process dies must already be on disk. */
const SLACK = 1500;

for (const [round, lifetime] of [1700, 2600, 3900].entries()) {
  const root = await mkdtemp(join(tmpdir(), 'opsidian-crash-'));
  const vault = join(root, 'vault');
  const env = { ...process.env, OPSIDIAN_VAULT_DIR: vault, OPSIDIAN_PROFILE_DIR: join(root, 'p') };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.OPSIDIAN_RENDERER_URL;
  const run = (phase, stdio) =>
    spawn(electron, ['scripts/desktop-crash.cjs'], {
      env: { ...env, OPSIDIAN_CRASH_PHASE: phase },
      stdio,
      detached: true,
    });
  try {
    const typed = [];
    const killedAt = await new Promise((resolve, reject) => {
      const child = run('type', ['ignore', 'pipe', 'inherit']);
      let timer;
      child.stdout.on('data', (chunk) => {
        for (const match of chunk.toString().matchAll(/typed (\d+) (\d+)/g))
          typed.push({ line: Number(match[1]), at: Number(match[2]) });
        // No warning and no chance to flush: the whole process group dies at once.
        timer ??= setTimeout(() => process.kill(-child.pid, 'SIGKILL'), lifetime);
      });
      child.on('error', reject);
      child.on('exit', (code, signal) =>
        signal === 'SIGKILL'
          ? resolve(Date.now())
          : reject(new Error(`The app exited (${code}) before it could be killed`)),
      );
    });
    const content = await readFile(join(vault, 'Crash.md'), 'utf8');
    const lines = content.split('\n');
    assert.equal(lines.pop(), '', 'the note ends with a whole line');
    lines.forEach((line, position) => assert.equal(line, `line ${position + 1}`));
    const owed = typed.filter((entry) => entry.at < killedAt - SLACK).length;
    assert.ok(
      lines.length >= owed,
      `${lines.length} lines on disk, but ${owed} were typed more than ${SLACK} ms before the kill`,
    );
    assert.deepEqual(
      (await readdir(vault)).filter((entry) => !entry.startsWith('.')),
      ['Crash.md'],
    );
    await new Promise((resolve, reject) => {
      const child = run('verify', 'inherit');
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`Reopening after the crash exited ${code}`)),
      );
    });
    console.log(
      `PASS crash ${round + 1}: killed after ${typed.length} lines, ${lines.length} whole lines on disk, reopened and kept editing`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
