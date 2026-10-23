import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Host } from '../apps/host/src/host';
import {
  GitError,
  Mirror,
  Mirrors,
  backoff,
  describe as message,
  explainGit,
  isBehind,
  type MirrorOptions,
} from '../apps/host/src/mirror';
import { statusLine } from '../apps/host/src/github-cli';
import { parseRepository, repositoryName } from '../apps/host/src/github';
import { Vault } from '../apps/desktop/electron/vault';
import { SyncEngine, httpTransport, pair, type SyncState } from '../packages/sync/src/index';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
async function folder(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'opsidian-mirror-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const IDENTITY = ['-c', 'user.name=Someone', '-c', 'user.email=someone@example.com'];
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', [...IDENTITY, '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });

/** A repository standing in for GitHub, and a person's own clone of it to commit from. */
async function repository(files: Record<string, string | Uint8Array> = {}) {
  const remote = join(await folder(), 'notes.git');
  await mkdir(remote);
  git(remote, 'init', '--bare', '--quiet');
  const person = join(await folder(), 'clone');
  git(dirname(person), 'clone', '--quiet', remote, person);
  const self = {
    remote,
    person,
    async write(path: string, content: string | Uint8Array) {
      await mkdir(dirname(join(person, path)), { recursive: true });
      await writeFile(join(person, path), content);
    },
    read: (path: string) => readFile(join(person, path), 'utf8'),
    has: (path: string) => existsSync(join(person, path)),
    /** Commits and pushes what the person changed, as if on GitHub. */
    push(text = 'Edit on GitHub') {
      git(person, 'add', '--all');
      git(person, 'commit', '--quiet', '-m', text);
      git(person, 'push', '--quiet', 'origin', 'HEAD:main');
    },
    pull() {
      git(person, 'pull', '--quiet', '--no-rebase', 'origin', 'main');
    },
    log: () => git(person, 'log', '--format=%s', 'origin/main').trim().split('\n'),
    tracked: () => git(person, 'ls-files').trim().split('\n').filter(Boolean).sort(),
  };
  if (Object.keys(files).length) {
    for (const [path, content] of Object.entries(files)) await self.write(path, content);
    self.push('Notes so far');
  }
  return self;
}
type Repository = Awaited<ReturnType<typeof repository>>;

async function startHost() {
  const dataDir = await folder();
  const host = new Host({ dataDir, maxWait: 1 });
  const url = await host.listen(0, '127.0.0.1');
  const mirrors = new Mirrors({ host, dataDir, quiet: 50, interval: 400 });
  cleanup.push(async () => {
    await mirrors.stop();
    await host.close();
  });
  return { host, url, dataDir, mirrors };
}
type Server = Awaited<ReturnType<typeof startHost>>;

/** A device with its own folder, synced by hand. */
async function device(server: Server, notebook = 'Notes') {
  const { code } = server.host.invite(notebook);
  const paired = await pair(server.url, code, 'Mac');
  const root = await folder();
  const vault = await Vault.open(root);
  cleanup.push(() => vault.close());
  const fresh: SyncState = {
    version: 1,
    host: server.url,
    notebook: paired.notebook.id,
    device: paired.device.id,
    deviceName: 'Mac',
    cursor: 0,
    files: {},
  };
  return {
    root,
    async sync() {
      const engine = new SyncEngine(
        vault.syncStore(),
        httpTransport(server.url, paired.token),
        (await vault.syncState()) ?? structuredClone(fresh),
        () => {},
        { wait: 0 },
      );
      await engine.sync();
      await engine.stop();
      return engine.status;
    },
    async write(path: string, content: string | Uint8Array) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    },
    read: (path: string) => readFile(join(root, path), 'utf8'),
    has: (path: string) => existsSync(join(root, path)),
    remove: (path: string) => rm(join(root, path)),
  };
}

/** Every visible file under a folder, with its content. */
async function tree(root: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  const walk = async (directory: string, prefix: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = prefix + entry.name;
      if (entry.isDirectory()) await walk(join(directory, entry.name), `${path}/`);
      else found[path] = await readFile(join(directory, entry.name), 'utf8');
    }
  };
  await walk(root, '');
  return found;
}

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3, 255]);

describe('keeping a notebook in a git repository', () => {
  it('imports a repository into a new notebook, and devices receive it', async () => {
    const github = await repository({
      'Welcome.md': '# Welcome\n\nSee [[Projects/Plan]].\n',
      'Projects/Plan.md': '- one\n- two\n',
      'attachments/diagram.png': PNG,
      '.obsidian/app.json': '{}',
      '.gitignore': '.DS_Store\n',
    });
    const server = await startHost();

    const status = await server.mirrors.connect('Notes', github.remote);
    expect(status.state).toBe('synced');
    expect(server.host.notebooks()).toMatchObject([{ name: 'Notes', files: 3 }]);
    expect(server.host.devices().map((each) => each.name)).toEqual(['GitHub']);

    const mac = await device(server);
    await mac.sync();
    expect(await tree(mac.root)).toMatchObject({
      'Welcome.md': '# Welcome\n\nSee [[Projects/Plan]].\n',
      'Projects/Plan.md': '- one\n- two\n',
    });
    expect(new Uint8Array(await readFile(join(mac.root, 'attachments/diagram.png')))).toEqual(PNG);
    // Hidden files are not synced, and stay in the repository as they were.
    expect(mac.has('.obsidian/app.json')).toBe(false);
    github.pull();
    expect(github.tracked()).toContain('.obsidian/app.json');
    expect(github.log()).toEqual(['Notes so far']);
  });

  it('lets two copies of one notebook in one process take turns, never clone at once', async () => {
    // As when importing: the import's own copy and the background one start together.
    const github = await repository({ 'Welcome.md': '# Welcome\n' });
    const server = await startHost();
    server.host.addMirror('Notes', github.remote);
    const [first, second] = [copyOf(server), copyOf(server)];
    const results = await Promise.all([first.sync(), second.sync()]);
    expect(results.map((each) => each.state)).toEqual(['synced', 'synced']);
    expect(server.host.notebooks()).toMatchObject([{ name: 'Notes', files: 1 }]);
    expect(existsSync(join(server.dataDir, 'mirrors', `${first.notebook}.cloning`))).toBe(false);
  });

  it('sends an existing notebook to an empty repository, without sync’s own files', async () => {
    const github = await repository();
    const server = await startHost();
    const mac = await device(server);
    await mac.write('Ideas.md', 'An idea\n');
    await mac.write('Journal/Monday.md', 'Rain.\n');
    await mac.sync();

    expect((await server.mirrors.connect('Notes', github.remote)).state).toBe('synced');
    github.pull();
    expect(github.tracked()).toEqual(['Ideas.md', 'Journal/Monday.md']);
    expect(await github.read('Journal/Monday.md')).toBe('Rain.\n');
    expect(github.log()[0]).toMatch(/^Add Ideas, Monday/);
  });

  it('carries edits, renames and deletions both ways', async () => {
    const github = await repository({ 'A.md': 'a\n', 'B.md': 'b\n', 'C.md': 'c\n' });
    const server = await startHost();
    await server.mirrors.connect('Notes', github.remote);
    const mac = await device(server);
    await mac.sync();

    // From a device to the repository.
    await mac.write('A.md', 'a, edited on the Mac\n');
    await mac.write('New.md', 'new\n');
    await mac.remove('B.md');
    await mac.sync();
    await server.mirrors.sync('Notes');
    github.pull();
    expect(github.tracked()).toEqual(['A.md', 'C.md', 'New.md']);
    expect(await github.read('A.md')).toBe('a, edited on the Mac\n');

    // From the repository to a device.
    await github.write('C.md', 'c, edited on GitHub\n');
    git(github.person, 'mv', 'New.md', 'Renamed.md');
    git(github.person, 'rm', '--quiet', 'A.md');
    await github.write('Folder/Deep.md', 'deep\n');
    github.push();
    await server.mirrors.sync('Notes');
    await mac.sync();
    expect(await tree(mac.root)).toEqual({
      'C.md': 'c, edited on GitHub\n',
      'Renamed.md': 'new\n',
      'Folder/Deep.md': 'deep\n',
    });
    // A deletion from the repository puts the note in the device's trash, not out of existence.
    expect(await readdir(join(mac.root, '.trash'))).toContain('A.md');
  });

  it('combines edits to different lines, and keeps both versions of the same line', async () => {
    const github = await repository({
      'Plan.md': 'one\ntwo\nthree\nfour\nfive\n',
      'Clash.md': 'first draft\n',
    });
    const server = await startHost();
    await server.mirrors.connect('Notes', github.remote);
    const mac = await device(server);
    await mac.sync();

    await mac.write('Plan.md', 'one, from the Mac\ntwo\nthree\nfour\nfive\n');
    await mac.write('Clash.md', 'the Mac’s draft\n');
    await mac.sync();
    await github.write('Plan.md', 'one\ntwo\nthree\nfour\nfive, from GitHub\n');
    await github.write('Clash.md', 'GitHub’s draft\n');
    github.push();

    await server.mirrors.sync('Notes');
    await mac.sync();
    const files = await tree(mac.root);
    expect(files['Plan.md']).toBe('one, from the Mac\ntwo\nthree\nfour\nfive, from GitHub\n');
    expect(files['Clash.md']).toBe('the Mac’s draft\n');
    const copy = Object.keys(files).find((path) =>
      path.startsWith('Clash (conflicted copy GitHub'),
    );
    expect(copy).toBeDefined();
    expect(files[copy!]).toBe('GitHub’s draft\n');

    github.pull();
    expect(await github.read('Plan.md')).toBe(files['Plan.md']);
    expect(await github.read('Clash.md')).toBe('the Mac’s draft\n');
    expect(await github.read(copy!)).toBe('GitHub’s draft\n');
    // No conflict markers anywhere.
    for (const content of Object.values(files)) expect(content).not.toMatch(/^(<<<<<<<|>>>>>>>)/m);
  });

  it('keeps an edit made on one side when the other side deleted the file', async () => {
    const github = await repository({ 'Kept.md': 'v1\n', 'Gone.md': 'v1\n' });
    const server = await startHost();
    await server.mirrors.connect('Notes', github.remote);
    const mac = await device(server);
    await mac.sync();

    await mac.write('Kept.md', 'v2 from the Mac\n');
    await mac.remove('Gone.md');
    await mac.sync();
    git(github.person, 'rm', '--quiet', 'Kept.md');
    await github.write('Gone.md', 'v2 from GitHub\n');
    github.push();

    await server.mirrors.sync('Notes');
    await mac.sync();
    expect(await tree(mac.root)).toEqual({
      'Kept.md': 'v2 from the Mac\n',
      'Gone.md': 'v2 from GitHub\n',
    });
    github.pull();
    expect(github.tracked()).toEqual(['Gone.md', 'Kept.md']);
  });

  it('tries again when the repository moves on while it is pushing, and never forces', async () => {
    const github = await repository({ 'Base.md': 'base\n' });
    const server = await startHost();
    await server.mirrors.connect('Notes', github.remote);
    const mac = await device(server);
    await mac.sync();

    // The first time the host pushes, someone else's commit lands first.
    const racer = join(await folder(), 'racer');
    git(dirname(racer), 'clone', '--quiet', github.remote, racer);
    await writeFile(join(racer, 'Racer.md'), 'got there first\n');
    git(racer, 'add', '--all');
    git(racer, 'commit', '--quiet', '-m', 'Race');
    const hook = join(github.remote, 'hooks', 'pre-receive');
    const marker = join(await folder(), 'raced');
    await writeFile(
      hook,
      `#!/bin/sh
if [ ! -e "${marker}" ]; then
  touch "${marker}"
  unset GIT_DIR GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
  cd "${racer}" && git push --quiet origin HEAD:main >/dev/null 2>&1
fi
exit 0
`,
    );
    await chmod(hook, 0o755);

    await mac.write('Mine.md', 'mine\n');
    await mac.sync();
    expect((await server.mirrors.sync('Notes')).state).toBe('synced');
    expect(existsSync(marker)).toBe(true);
    github.pull();
    expect(github.tracked()).toEqual(['Base.md', 'Mine.md', 'Racer.md']);
    await mac.sync();
    expect(await mac.read('Racer.md')).toBe('got there first\n');
  });

  it('recovers from a round interrupted in the middle of git work', async () => {
    const github = await repository({ 'Note.md': 'one\n' });
    const server = await startHost();
    await server.mirrors.connect('Notes', github.remote);
    const [record] = server.host.mirrors();
    const checkout = join(server.dataDir, 'mirrors', record!.notebook);

    // A crash during a merge: a lock left behind and a merge half done.
    await github.write('Note.md', 'two from GitHub\n');
    github.push();
    git(checkout, 'fetch', '--quiet', 'origin');
    await writeFile(join(checkout, 'Note.md'), 'two locally\n');
    git(checkout, 'commit', '--quiet', '-am', 'Local');
    try {
      git(checkout, 'merge', 'origin/main');
    } catch {
      // Conflicts, as intended.
    }
    expect(existsSync(join(checkout, '.git', 'MERGE_HEAD'))).toBe(true);
    await writeFile(join(checkout, '.git', 'index.lock'), '');
    await writeFile(`${checkout}.lock`, '999999 0');

    expect((await server.mirrors.sync('Notes')).state).toBe('synced');
    github.pull();
    const files = await tree(github.person);
    expect(files['Note.md']).toBe('two locally\n');
    expect(Object.values(files)).toContain('two from GitHub\n');
  });

  it('carries on after the host restarts, as the same device', async () => {
    const github = await repository({ 'Note.md': 'one\n' });
    const first = await startHost();
    await first.mirrors.connect('Notes', github.remote);
    await first.host.close();

    const host = new Host({ dataDir: first.dataDir, maxWait: 1 });
    const url = await host.listen(0, '127.0.0.1');
    const mirrors = new Mirrors({ host, dataDir: first.dataDir });
    cleanup.push(async () => {
      await mirrors.stop();
      await host.close();
    });
    await github.write('Note.md', 'two\n');
    github.push();
    expect((await mirrors.sync('Notes')).state).toBe('synced');
    expect(
      host
        .devices()
        .filter((each) => !each.revoked)
        .map((each) => each.name),
    ).toEqual(['GitHub']);
    const mac = await device({ host, url, dataDir: first.dataDir, mirrors });
    await mac.sync();
    expect(await mac.read('Note.md')).toBe('two\n');
  });

  it('holds back deletions when most of the notebook vanishes from the repository at once', async () => {
    const notes = Object.fromEntries(
      Array.from({ length: 12 }, (_, n) => [`Note ${n}.md`, `note ${n}\n`]),
    );
    const github = await repository(notes);
    const server = await startHost();
    await server.mirrors.connect('Notes', github.remote);
    const mac = await device(server);
    await mac.sync();

    for (const path of Object.keys(notes).slice(1)) git(github.person, 'rm', '--quiet', path);
    github.push();
    const held = await server.mirrors.sync('Notes');
    expect(held.held).toBe(11);
    expect(held.message).toMatch(/deletions are waiting to be confirmed/);
    await mac.sync();
    expect(Object.keys(await tree(mac.root))).toHaveLength(12);

    expect((await server.mirrors.sync('Notes', true)).held).toBeUndefined();
    await mac.sync();
    expect(Object.keys(await tree(mac.root))).toEqual(['Note 0.md']);
  });

  it('keeps everything in step by itself while the host runs', async () => {
    const github = await repository({ 'Note.md': 'one\n' });
    const server = await startHost();
    await server.mirrors.connect('Notes', github.remote);
    server.host.setMirrorSchedule('live');
    server.mirrors.start();
    const mac = await device(server);
    await mac.sync();

    await mac.write('From the Mac.md', 'typed\n');
    await mac.sync();
    await expect
      .poll(
        () => {
          git(github.person, 'fetch', '--quiet', 'origin');
          return git(github.person, 'ls-tree', '--name-only', 'origin/main');
        },
        { timeout: 10_000, interval: 100 },
      )
      .toContain('From the Mac.md');

    await github.write('From GitHub.md', 'pushed\n');
    github.pull();
    github.push();
    await expect
      .poll(
        async () => {
          await mac.sync();
          return mac.has('From GitHub.md');
        },
        { timeout: 10_000, interval: 100 },
      )
      .toBe(true);
  });

  it('stops when disconnected, leaving the repository and the notebook as they are', async () => {
    const github = await repository({ 'Note.md': 'one\n' });
    const server = await startHost();
    await server.mirrors.connect('Notes', github.remote);
    const [record] = server.host.mirrors();
    await server.mirrors.disconnect('Notes');
    expect(server.host.mirrors()).toEqual([]);
    expect(server.host.devices()).toMatchObject([{ name: 'GitHub', revoked: true }]);
    expect(existsSync(join(server.dataDir, 'mirrors', record!.notebook))).toBe(false);
    expect(server.host.notebooks()).toMatchObject([{ name: 'Notes', files: 1 }]);
    github.pull();
    expect(github.tracked()).toEqual(['Note.md']);
  });

  it('says plainly when the repository cannot be reached', async () => {
    const server = await startHost();
    await expect(
      server.mirrors.connect('Notes', join(await folder(), 'nothing-here.git')),
    ).rejects.toThrow(/could not be found|does not appear/);
    expect(server.host.mirrors()[0]?.status).toMatchObject({ state: 'error' });
  });
});

const HOUR = 60 * 60_000;
/** The repository's latest commit on main. */
const remoteHead = (github: Repository) => git(github.remote, 'rev-parse', 'main').trim();
/** The files on main in the repository. */
const remoteFiles = (github: Repository) =>
  git(github.remote, 'ls-tree', '-r', '--name-only', 'main').trim().split('\n');

/** A second process's view of a copy, run by hand, on a clock the test moves. */
function copyOf(server: Server, options: Partial<MirrorOptions> = {}) {
  const mirror = new Mirror(server.host.mirrors()[0]!, {
    host: server.host,
    dataDir: server.dataDir,
    spread: 0,
    ...options,
  });
  cleanup.push(() => mirror.stop());
  return mirror;
}
/** Background copies on an hourly schedule, on a clock `ahead` of the real one. */
function hourly(server: Server, ahead = 0, log?: (text: string) => void) {
  server.host.setMirrorSchedule('1h');
  const mirrors = new Mirrors({
    host: server.host,
    dataDir: server.dataDir,
    spread: 0,
    now: () => Date.now() + ahead,
    ...(log ? { log } : {}),
  });
  cleanup.push(() => mirrors.stop());
  return mirrors;
}

describe('copying on a schedule', () => {
  it('makes one commit of every edit since the round before', async () => {
    const github = await repository({ 'Note.md': 'one\n' });
    const server = await startHost();
    await server.mirrors.connect('Notes', github.remote);
    const mac = await device(server);
    await mac.sync();
    const mirror = copyOf(server);

    await mac.write('A.md', 'a\n');
    await mac.sync();
    await mac.write('B.md', 'b\n');
    await mac.sync();
    await mac.write('Note.md', 'two\n');
    await mac.sync();
    expect((await mirror.scheduled()).state).toBe('synced');
    github.pull();
    expect(github.log()).toHaveLength(2);
    expect(github.log()[0]).toBe('Edit Note; Add A, B');
    expect(github.tracked()).toEqual(['A.md', 'B.md', 'Note.md']);
  });

  it('only asks which commit the repository is at when nothing changed', async () => {
    const github = await repository({ 'Note.md': 'one\n' });
    const server = await startHost();
    await server.mirrors.connect('Notes', github.remote);
    let clock = Date.now();
    const mirror = copyOf(server, { now: () => clock });
    const [record] = server.host.mirrors();
    const fetched = join(server.dataDir, 'mirrors', record!.notebook, '.git', 'FETCH_HEAD');
    const before = { head: remoteHead(github), fetched: statSync(fetched).mtimeMs };

    clock += HOUR;
    const status = await mirror.scheduled();
    expect(status).toMatchObject({ state: 'synced', at: clock, next: clock + HOUR });
    // Nothing fetched, committed or pushed: only `ls-remote`, which leaves no trace.
    expect(remoteHead(github)).toBe(before.head);
    expect(statSync(fetched).mtimeMs).toBe(before.fetched);
    expect(server.host.mirrors()[0]!.status).toMatchObject({ at: clock });

    // The same small question notices a push made on GitHub, and the round brings it in.
    await github.write('Note.md', 'two, from GitHub\n');
    github.push();
    clock += HOUR;
    await mirror.scheduled();
    expect(statSync(fetched).mtimeMs).not.toBe(before.fetched);
    const mac = await device(server);
    await mac.sync();
    expect(await mac.read('Note.md')).toBe('two, from GitHub\n');
  });

  it('waits for its time, and catches up at once when the host was down past it', async () => {
    const github = await repository({ 'Note.md': 'one\n' });
    const server = await startHost();
    const connected = await server.mirrors.connect('Notes', github.remote);
    const mac = await device(server);
    await mac.sync();
    await mac.write('Waiting.md', 'written while the copy waits\n');
    await mac.sync();

    const onTime = hourly(server);
    onTime.start();
    await expect
      .poll(() => server.host.mirrors()[0]!.status?.next, { timeout: 5000, interval: 50 })
      .toBe(connected.at! + HOUR);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(remoteFiles(github)).toEqual(['Note.md']);
    await onTime.stop();

    // Two hours later by the clock, as when the host starts again after being off.
    hourly(server, 2 * HOUR).start();
    await expect
      .poll(() => remoteFiles(github), { timeout: 10_000, interval: 100 })
      .toContain('Waiting.md');
  });

  it('sends what is waiting when the host stops', async () => {
    const github = await repository({ 'Note.md': 'one\n' });
    const server = await startHost();
    await server.mirrors.connect('Notes', github.remote);
    const mac = await device(server);
    await mac.sync();
    const mirrors = hourly(server);
    mirrors.start();
    await expect
      .poll(() => server.host.mirrors()[0]!.status?.next, { timeout: 5000, interval: 50 })
      .toBeDefined();

    await mac.write('Last.md', 'typed just before stopping\n');
    await mac.sync();
    await mirrors.stop(20_000);
    expect(remoteFiles(github)).toContain('Last.md');

    // Nothing waiting: stopping asks nothing of the repository.
    const head = remoteHead(github);
    const again = hourly(server);
    again.start();
    await again.stop(20_000);
    expect(remoteHead(github)).toBe(head);
  });

  it('backs off for an hour when the repository asks it to slow down', async () => {
    const github = await repository({ 'Note.md': 'one\n' });
    const server = await startHost();
    await server.mirrors.connect('Notes', github.remote);
    const mac = await device(server);
    await mac.sync();
    await mac.write('New.md', 'new\n');
    await mac.sync();
    const hook = join(github.remote, 'hooks', 'pre-receive');
    await writeFile(hook, '#!/bin/sh\necho "error: 429 Too Many Requests" >&2\nexit 1\n');
    await chmod(hook, 0o755);

    const logged: string[] = [];
    const ahead = 2 * HOUR;
    const started = Date.now() + ahead;
    hourly(server, ahead, (text) => logged.push(text)).start();
    await expect
      .poll(() => server.host.mirrors()[0]!.status?.message, { timeout: 10_000, interval: 50 })
      .toMatch(/asked Opsidian to slow down; it will try again at \d\d:\d\d/);
    const status = server.host.mirrors()[0]!.status!;
    expect(status.state).toBe('offline');
    expect(status.next! - started).toBeGreaterThanOrEqual(HOUR);
    // Said once, not once a minute.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(logged).toHaveLength(1);
    expect(remoteFiles(github)).toEqual(['Note.md']);
  });
});

describe('throttling and warnings', () => {
  it('tells GitHub slowing down apart from other failures', () => {
    const remote = 'https://github.com/you/notes.git';
    for (const output of [
      "fatal: unable to access 'https://github.com/you/notes.git/': The requested URL returned error: 429",
      'error: RPC failed; HTTP 429 curl 22 The requested URL returned error: 429',
      'remote: You have exceeded a secondary rate limit. Please wait a few minutes.\nfatal: unable to access: The requested URL returned error: 403',
      'remote: You have triggered an abuse detection mechanism.',
      'Too Many Requests',
    ]) {
      const error = explainGit(output, remote);
      expect(error.throttled, output).toBe(0);
      expect(error.message).toBe('GitHub asked Opsidian to slow down.');
    }
    expect(explainGit('HTTP 429\nRetry-After: 7200', remote).throttled).toBe(7200_000);
    expect(explainGit('fatal: Could not resolve host: github.com', remote)).toMatchObject({
      offline: true,
      throttled: undefined,
    });
    expect(explainGit('remote: Permission to you/notes.git denied. 403', remote).message).toMatch(
      /Sign in to GitHub again/,
    );
  });

  it('waits at least an hour after throttling, and a short while after other failures', () => {
    const throttled = new GitError('slow down', true, 0);
    expect(backoff(throttled, 1, '1h')).toBe(HOUR);
    expect(backoff(throttled, 2, 'live')).toBe(2 * HOUR);
    expect(backoff(new GitError('slow down', true, 3 * HOUR), 1, '1h')).toBe(3 * HOUR);
    expect(backoff(throttled, 20, '1h')).toBe(24 * HOUR);
    const offline = new GitError('could not be reached', true);
    expect(backoff(offline, 1, 'live')).toBe(5000);
    expect(backoff(offline, 20, 'live')).toBe(10 * 60_000);
    expect(backoff(offline, 1, '1h')).toBe(60_000);
    expect(backoff(offline, 20, '15m')).toBe(15 * 60_000);
    expect(backoff(offline, 20, '24h')).toBe(HOUR);
  });

  it('says when a copy was last made, and warns once it is overdue', () => {
    const now = Date.UTC(2026, 9, 23, 12);
    const fresh = { state: 'synced', at: now - 12 * 60_000, next: now + 48 * 60_000 } as const;
    expect(statusLine(fresh, '1h', { now })).toBe('✓ copied 12 min ago, next in 48 min');
    expect(isBehind(fresh, '1h', now)).toBe(false);
    const stale = {
      state: 'offline',
      at: now - 3 * HOUR,
      message: 'you/notes could not be reached. Opsidian will keep trying.',
    } as const;
    expect(isBehind(stale, '1h', now)).toBe(true);
    expect(statusLine(stale, '1h', { now })).toBe(
      '! not copied for 3 h: you/notes could not be reached. Opsidian will keep trying.',
    );
    expect(statusLine({ ...fresh, at: now - 3 * HOUR }, '1h', { now, running: false })).toBe(
      '! not copied for 3 h: the host is not running.',
    );
    expect(isBehind(stale, '6h', now)).toBe(false);
  });
});

describe('around the repository', () => {
  it('describes a commit by what changed', () => {
    expect(message([{ kind: 'M', path: 'Projects/Plan.md' }])).toBe(
      'Edit Plan\n\nM  Projects/Plan.md',
    );
    expect(
      message([
        { kind: 'A', path: 'a.md' },
        { kind: 'D', path: 'b.md' },
      ]).split('\n')[0],
    ).toBe('Add a; Remove b');
    expect(
      message(Array.from({ length: 5 }, (_, n) => ({ kind: 'M', path: `${n}.md` }))).split('\n')[0],
    ).toBe('Edit 5 files');
  });

  it('reads a repository however it is typed', () => {
    expect(parseRepository('you/notes')).toEqual({
      fullName: 'you/notes',
      url: 'https://github.com/you/notes.git',
    });
    expect(parseRepository('https://github.com/you/notes')).toMatchObject({
      fullName: 'you/notes',
    });
    expect(parseRepository('https://github.com/you/notes.git')).toMatchObject({
      url: 'https://github.com/you/notes.git',
    });
    expect(parseRepository('git@github.com:you/notes.git')).toEqual({
      fullName: 'you/notes',
      url: 'git@github.com:you/notes.git',
    });
    expect(parseRepository('/srv/git/notes.git')).toEqual({ url: '/srv/git/notes.git' });
    expect(repositoryName('My Notes — 2026')).toBe('my-notes-2026');
    expect(repositoryName('Café')).toBe('cafe');
  });
});
