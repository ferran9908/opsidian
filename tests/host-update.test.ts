import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { newer, unpack } from '../apps/host/src/update';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
async function folder() {
  const directory = await mkdtemp(join(tmpdir(), 'opsidian-update-test-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A package as npm packs it, holding `files` under `package/`. */
async function pack(files: Record<string, string | Buffer>): Promise<Buffer> {
  const root = await folder();
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, 'package', path, '..'), { recursive: true });
    await writeFile(join(root, 'package', path), content);
  }
  execFileSync('tar', ['-czf', join(root, 'package.tgz'), '-C', root, 'package']);
  return readFile(join(root, 'package.tgz'));
}

describe('versions', () => {
  it('are compared by number, and a build that is not numbered is never updated', () => {
    expect(newer('0.1.24', '0.1.9')).toBe(true);
    expect(newer('0.2.0', '0.1.99')).toBe(true);
    expect(newer('1.0.0', '0.9.9')).toBe(true);
    expect(newer('0.1.9', '0.1.24')).toBe(false);
    expect(newer('0.1.9', '0.1.9')).toBe(false);
    expect(newer('0.1.24', 'development')).toBe(false);
    expect(newer('0.1.24-beta', '0.1.1')).toBe(false);
  });

  it('come out of a package as npm packs it', async () => {
    const tgz = await pack({ 'dist/opsidian.mjs': 'program', 'bin/opsidian.mjs': 'launcher' });
    expect(unpack(tgz, 'package/dist/opsidian.mjs')?.toString()).toBe('program');
    expect(unpack(tgz, 'package/dist/other.mjs')).toBeUndefined();
  });
});

describe('a host updating itself', { timeout: 60_000 }, () => {
  const programs: Record<string, string> = {};
  let built: string;
  beforeAll(async () => {
    built = await mkdtemp(join(tmpdir(), 'opsidian-update-builds-'));
    for (const version of ['0.1.5', '0.1.9']) {
      programs[version] = join(built, `${version}.mjs`);
      await build({
        entryPoints: ['apps/host/src/cli.ts'],
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node24',
        outfile: programs[version],
        define: { 'process.env.OPSIDIAN_VERSION': JSON.stringify(version) },
        banner: {
          js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
        },
        logLevel: 'warning',
      });
    }
  });
  afterAll(() => rm(built, { recursive: true, force: true }));

  /** npm, as far as updating asks it anything: the latest version, and its package. */
  async function registry(version: string, options: { tamper?: boolean } = {}) {
    const tgz = await pack({ 'dist/opsidian.mjs': await readFile(programs[version]!) });
    const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
    const served = options.tamper ? Buffer.concat([tgz, Buffer.from('x')]) : tgz;
    const server: Server = createServer((request, response) => {
      if (request.url === '/opsidian/latest')
        return response.end(
          JSON.stringify({ version, dist: { tarball: `${url}/opsidian.tgz`, integrity } }),
        );
      if (request.url === '/opsidian.tgz') return response.end(served);
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    cleanup.push(() => new Promise((resolve) => server.close(resolve)));
    return url;
  }

  async function freePort() {
    const server = createNetServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    await new Promise((resolve) => server.close(resolve));
    return port;
  }

  /** A host as `host start` leaves it: settings, and the program copied into `bin`. */
  async function installed(version: string, settings: Record<string, unknown> = {}) {
    const home = await folder();
    await mkdir(join(home, 'bin'), { recursive: true });
    await copyFile(programs[version]!, join(home, 'bin', 'opsidian.mjs'));
    const port = await freePort();
    await writeFile(
      join(home, 'host.json'),
      JSON.stringify({ port, address: '127.0.0.1', ...settings }),
    );
    return { home, port, program: join(home, 'bin', 'opsidian.mjs') };
  }

  /** Runs the installed program as the service would, until it exits or `until` is seen. */
  function run(
    home: string,
    registryUrl: string,
    args: string[],
    until?: RegExp,
  ): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [join(home, 'bin', 'opsidian.mjs'), 'host', ...args], {
        env: { ...process.env, OPSIDIAN_HOME: home, OPSIDIAN_REGISTRY: registryUrl },
      });
      let out = '';
      const timer = setTimeout(() => child.kill(), 60_000);
      const take = (chunk: Buffer) => {
        out += chunk.toString();
        if (until?.test(out)) child.kill();
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, out });
      });
    });
  }
  const version = (program: string) =>
    execFileSync(process.execPath, [program, '--version'], { encoding: 'utf8' }).trim();

  it('installs a newer version on demand, keeping the one it replaces', async () => {
    const npm = await registry('0.1.9');
    const host = await installed('0.1.5');
    const done = await run(host.home, npm, ['update']);
    expect(done.out).toContain('Updating from 0.1.5 to 0.1.9…');
    // No service runs this test's host, so the new version waits for the next start.
    expect(done.out).toContain('Installed 0.1.9. It runs from the next');
    expect(version(host.program)).toBe('0.1.9');
    expect(version(join(host.home, 'bin', 'opsidian.previous.mjs'))).toBe('0.1.5');
    expect((await run(host.home, npm, ['update'])).out).toContain(
      'Up to date: 0.1.9 is the newest version.',
    );
  });

  it('refuses a download that is not what npm published', async () => {
    const npm = await registry('0.1.9', { tamper: true });
    const host = await installed('0.1.5');
    const done = await run(host.home, npm, ['update']);
    expect(done.code).toBe(1);
    expect(done.out).toContain('does not match what npm published');
    expect(version(host.program)).toBe('0.1.5');
    expect(existsSync(join(host.home, 'bin', 'opsidian.next.mjs'))).toBe(false);
  });

  it('updates by itself at night: backs up, installs, and the next start runs it', async () => {
    const npm = await registry('0.1.9');
    const backups = await folder();
    const host = await installed('0.1.5', {
      // Due whenever the test runs; the nightly backup is kept out of the way.
      update: { hour: 0 },
      backup: { folder: backups, keep: 3, hour: 23 },
    });
    const first = await run(host.home, npm, ['run']);
    expect(first.out).toContain('Version 0.1.9 is out. Installing it…');
    expect(first.out).toContain('before updating');
    expect(first.out).toContain('Restarting as 0.1.9.');
    // It stops by itself, for the service to start it again.
    expect(first.code).toBe(0);
    expect(version(host.program)).toBe('0.1.9');
    expect((await readdir(join(backups, 'snapshots'))).some((n) => n.endsWith('.sqlite'))).toBe(
      true,
    );

    // As the service starts it again.
    const second = await run(host.home, npm, ['run'], /is listening on/);
    expect(second.out).toContain('Updated from 0.1.5 to 0.1.9.');
    expect(second.out).toContain('Opsidian host 0.1.9 is listening');
    expect(existsSync(join(host.home, 'bin', 'update.json'))).toBe(false);
    const status = await run(host.home, npm, ['status']);
    expect(status.out).toContain('Version    0.1.9');
    expect(status.out).toMatch(/Updates {4}By itself, each night at 00:00; last looked/);
  });

  it('puts the old version back when the new one cannot start on the host’s data', async () => {
    const npm = await registry('0.1.9');
    const host = await installed('0.1.5', { update: { auto: false } });
    expect((await run(host.home, npm, ['update'])).out).toContain('Installed 0.1.9');
    // Data the new version cannot open, as a change it brings might not.
    await mkdir(join(host.home, 'host', 'host.sqlite'), { recursive: true });
    const failed = await run(host.home, npm, ['run']);
    expect(failed.code).not.toBe(0);
    expect(failed.out).toContain('0.1.9 did not start, so 0.1.5 was put back');
    expect(version(host.program)).toBe('0.1.5');
    const settings = JSON.parse(await readFile(join(host.home, 'host.json'), 'utf8'));
    expect(settings.update.failed).toMatchObject({ version: '0.1.9' });
    expect(existsSync(join(host.home, 'bin', 'update.json'))).toBe(false);
  });

  it('can be told not to update by itself', async () => {
    const npm = await registry('0.1.9');
    const host = await installed('0.1.5', { update: { hour: 0 } });
    expect((await run(host.home, npm, ['update', 'auto', 'off'])).out).toContain(
      'no longer updates by itself',
    );
    const ran = await run(host.home, npm, ['run'], /is listening on/);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(ran.out).not.toContain('Installing');
    expect(version(host.program)).toBe('0.1.5');
  });
});
