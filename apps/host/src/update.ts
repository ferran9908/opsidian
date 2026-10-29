import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { Place } from './home';

/**
 * Updating a host installed with `host start`, which runs its own copy of the program in
 * `bin`. A new version comes from npm, is checked against what npm says it published, and is
 * tried out in an empty host of its own before it replaces the installed one. The one it
 * replaces is kept, so a version that cannot start on this host's data is put back.
 */

/** Where new versions are looked for. Tests point it at a stand-in. */
const registry = () =>
  (process.env.OPSIDIAN_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/+$/, '');

export interface Release {
  version: string;
  /** Where npm keeps the package. */
  tarball: string;
  /** `sha512-…`, as npm publishes it. */
  integrity: string;
}

/** An update that has been put in place and not yet seen to start. */
export interface Trying {
  from: string;
  to: string;
  at: number;
}

/** The newest version on npm. */
export async function latestRelease(): Promise<Release> {
  const response = await fetch(`${registry()}/opsidian/latest`, {
    signal: AbortSignal.timeout(15_000),
  }).catch(() => {
    throw new Error('npm could not be reached to look for a new version.');
  });
  if (!response.ok)
    throw new Error(`npm answered ${response.status} when asked for the latest version.`);
  const body = (await response.json()) as {
    version?: unknown;
    dist?: { tarball?: unknown; integrity?: unknown };
  };
  const { version, dist } = body;
  if (
    typeof version !== 'string' ||
    typeof dist?.tarball !== 'string' ||
    typeof dist.integrity !== 'string' ||
    !dist.integrity.startsWith('sha512-')
  )
    throw new Error('npm did not say where the latest version is.');
  return { version, tarball: dist.tarball, integrity: dist.integrity };
}

/** Whether `a` is a newer version than `b`. A build that is not numbered, such as `development`, is neither. */
export function newer(a: string, b: string): boolean {
  const parse = (value: string) =>
    /^\d+\.\d+\.\d+$/.test(value) ? value.split('.').map(Number) : undefined;
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let at = 0; at < 3; at++) if (x[at] !== y[at]) return x[at]! > y[at]!;
  return false;
}

/** One file from a package as npm packs it: a gzipped tar. */
export function unpack(tgz: Uint8Array, wanted: string): Buffer | undefined {
  const tar = gunzipSync(tgz);
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0[\s\S]*$/, '');
    const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1);
    const body = at + 512;
    if (name === wanted && (type === '0' || type === '')) return tar.subarray(body, body + size);
    at = body + Math.ceil(size / 512) * 512;
  }
  return undefined;
}

const previousOf = (where: Place) => join(dirname(where.program), 'opsidian.previous.mjs');
const markerOf = (where: Place) => join(dirname(where.program), 'update.json');

/** Runs Node on a program and resolves to what it printed, or fails with it. */
function node(program: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [program, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(out.trim()))));
  });
}

/** The version the installed program says it is, if it is there and runs. */
export function installedVersion(where: Place): Promise<string | undefined> {
  return node(where.program, ['--version']).catch(() => undefined);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Starts a program as a host of its own, empty and on this machine only, and stops it once it
 * listens. Fails if it never does: it does not load, needs a newer Node, or stops by itself.
 */
async function tryOut(program: string, version: string): Promise<void> {
  const said = await node(program, ['--version']).catch((reason: Error) => {
    throw new Error(`The new version does not run here: ${reason.message.split('\n')[0]}`);
  });
  if (said !== version) throw new Error(`The download says it is ${said}, not ${version}.`);
  const home = await mkdtemp(join(tmpdir(), 'opsidian-update-'));
  try {
    const port = await freePort();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [program, 'host', 'run', '--port', String(port), '--address', '127.0.0.1'],
        { env: { ...process.env, OPSIDIAN_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      let done = false;
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.kill();
        if (error) reject(error);
        else resolve();
      };
      const last = () => out.trim().split('\n').slice(-3).join(' ');
      const timer = setTimeout(
        () => finish(new Error(`The new version did not start within 20 seconds. ${last()}`)),
        20_000,
      );
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        if (/is listening on/.test(out)) finish();
      });
      child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
      child.on('exit', (code) =>
        finish(new Error(`The new version stopped as it started (${code}). ${last()}`)),
      );
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * Downloads a release beside the installed program, checks that it is exactly what npm
 * published and that it starts, and resolves to where it is. Nothing is replaced yet.
 */
export async function fetchRelease(where: Place, release: Release): Promise<string> {
  const response = await fetch(release.tarball, { signal: AbortSignal.timeout(120_000) }).catch(
    () => {
      throw new Error('The new version could not be downloaded.');
    },
  );
  if (!response.ok) throw new Error(`npm answered ${response.status} for the new version.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== release.integrity)
    throw new Error('The download does not match what npm published, so it was not used.');
  const program = unpack(bytes, 'package/dist/opsidian.mjs');
  if (!program) throw new Error('The download holds no program.');
  // Still ending in .mjs, which is how Node knows to run it as a module.
  const next = join(dirname(where.program), 'opsidian.next.mjs');
  await mkdir(dirname(next), { recursive: true });
  await writeFile(next, program);
  try {
    await tryOut(next, release.version);
  } catch (reason) {
    await rm(next, { force: true });
    throw reason;
  }
  return next;
}

/**
 * Puts a checked program in place of the installed one, keeping that one, and notes that the
 * update has yet to be seen starting. The host runs it from its next start.
 */
export async function swapIn(where: Place, next: string, trying: Trying): Promise<void> {
  await copyFile(where.program, previousOf(where));
  await writeFile(markerOf(where), JSON.stringify(trying));
  await rename(next, where.program);
}

/** The update waiting to be seen starting, if any. */
export async function pending(where: Place): Promise<Trying | undefined> {
  try {
    return JSON.parse(await readFile(markerOf(where), 'utf8')) as Trying;
  } catch {
    return undefined;
  }
}

/** The new version started: nothing is left to put back. */
export function settled(where: Place): Promise<void> {
  return rm(markerOf(where), { force: true });
}

/** Puts back the program an update replaced. */
export async function rollBack(where: Place): Promise<void> {
  const back = `${where.program}.back`;
  await copyFile(previousOf(where), back);
  await rename(back, where.program);
  await settled(where);
}
