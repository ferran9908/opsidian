import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { uptime } from 'node:os';
import { dirname, join } from 'node:path';
import { Vault } from '@opsidian/notebook';
import {
  SyncEngine,
  Unauthorized,
  httpTransport,
  pair,
  pathKey,
  type SyncState,
} from '@opsidian/sync';
import { isGitHub, repositoryLabel, type GitHubAccount } from './github';
import type { Host, MirrorRecord, MirrorStatus } from './host';
import './storage';

/**
 * Keeps a notebook in a git repository, such as one on GitHub, in both directions.
 *
 * The copy is a device like any other: a folder on the host machine that is also a git
 * checkout, kept in step with the host by the same sync engine the Mac and iPhone run. Around
 * it, each round commits what changed, merges what was pushed to the repository meanwhile,
 * lets the engine send that to the host, and pushes. So edits made on GitHub reach every
 * device, and conflicts are settled the way sync settles them: lines that differ combine, and
 * edits to the same lines are kept as two files. Nothing is ever force-pushed.
 */

/** The address the copy's device knows the host by. It never leaves this process. */
const HERE = 'http://opsidian.local';
const DEVICE = 'GitHub';
/** Never committed: sync's own state, the trash, and files half-written by a save. */
const EXCLUDE = ['/.opsidian/', '/.trash/', '*.opsidian-pending', '.DS_Store'];

export class GitError extends Error {
  constructor(
    message: string,
    /** The repository could not be reached; trying again later may be enough. */
    readonly offline = false,
  ) {
    super(message);
  }
}

interface Run {
  code: number;
  out: string;
  err: string;
}

/** When this machine started, to the minute. */
const booted = () => String(Math.round((Date.now() / 1000 - uptime()) / 60));
const alive = (pid: number) => {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (reason) {
    return (reason as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Finds out whether git is installed, and says how to get it if not. */
export async function gitVersion(): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('git', ['--version'], { timeout: 30_000 }, (error, stdout) => {
      if (error || !/^git version/.test(stdout))
        return reject(
          new GitError(
            process.platform === 'darwin'
              ? 'Keeping a notebook on GitHub needs git. Install it by running: xcode-select --install'
              : 'Keeping a notebook on GitHub needs git. Install it with your package manager, for example: sudo apt install git',
          ),
        );
      resolve(stdout.trim());
    }),
  );
}

export interface MirrorOptions {
  host: Host;
  /** The host's data folder; copies are kept in `mirrors` inside it. */
  dataDir: string;
  /** The GitHub sign-in, read before each round so signing in again takes effect at once. */
  account?: () => Promise<GitHubAccount | undefined>;
  /** How often to look for changes pushed to the repository. Default one minute. */
  interval?: number;
  /** How long to let a burst of edits gather before committing them. Default ten seconds. */
  quiet?: number;
  log?: (text: string) => void;
  now?: () => number;
}

/** One notebook's copy in a repository. */
export class Mirror {
  readonly folder: string;
  private vault: Vault | undefined;
  private running = false;
  private wake: (() => void) | undefined;
  private looping: Promise<void> | undefined;
  private work: Promise<unknown> = Promise.resolve();
  private allowDeletions = false;
  private stopped = false;

  constructor(
    private record: MirrorRecord,
    private readonly options: MirrorOptions,
  ) {
    this.folder = join(options.dataDir, 'mirrors', record.notebook);
  }

  get notebook(): string {
    return this.record.notebook;
  }
  get remote(): string {
    return this.record.remote;
  }
  private get label(): string {
    return repositoryLabel(this.record.remote);
  }
  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  // Git.

  private async git(args: string[], options: { ok?: boolean; quiet?: boolean } = {}) {
    const signedIn = isGitHub(this.record.remote) ? await this.options.account?.() : undefined;
    const config = [
      // Whatever the machine's own git settings, nothing may prompt, sign, run hooks, or keep
      // the token: this runs unattended.
      ['core.hooksPath', '/dev/null'],
      ['commit.gpgSign', 'false'],
      ['tag.gpgSign', 'false'],
      ['core.quotePath', 'false'],
      ['core.autocrlf', 'false'],
      ['init.defaultBranch', 'main'],
      ['merge.renames', 'true'],
      ['user.name', signedIn?.name ?? signedIn?.login ?? 'Opsidian'],
      [
        'user.email',
        signedIn
          ? `${signedIn.id}+${signedIn.login}@users.noreply.github.com`
          : 'opsidian@localhost',
      ],
      ...(signedIn
        ? [
            // Empty values clear the machine's own helpers, including those for GitHub's
            // address alone, so the token is neither replaced by them nor stored in them.
            ['credential.helper', ''],
            ['credential.https://github.com.helper', ''],
            [
              'credential.helper',
              '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$OPSIDIAN_GIT_TOKEN"; }; f',
            ],
          ]
        : []),
    ].flatMap(([name, value]) => ['-c', `${name}=${value}`]);
    const result = await new Promise<Run>((resolve) =>
      execFile(
        'git',
        [...config, ...args],
        {
          cwd: existsSync(this.folder) ? this.folder : dirname(this.folder),
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
            GIT_ASKPASS: '',
            SSH_ASKPASS: '',
            // A host that has never been seen is refused rather than asked about.
            GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
            LC_ALL: 'C',
            ...(signedIn ? { OPSIDIAN_GIT_TOKEN: signedIn.token } : {}),
          },
          maxBuffer: 64 * 1024 * 1024,
          timeout: 10 * 60_000,
          encoding: 'buffer',
        },
        (error, stdout, stderr) =>
          resolve({
            code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
            out: stdout.toString('utf8'),
            err: stderr.toString('utf8'),
          }),
      ),
    );
    if (result.code !== 0 && !options.ok) throw this.explain(result.err || result.out, args[0]);
    return result;
  }
  /** Says what went wrong in words a person can act on. */
  private explain(output: string, command = 'git'): GitError {
    const text = output.trim();
    const where = this.label;
    if (/ENOENT|spawn git/.test(text)) return new GitError('git is not installed on this machine.');
    if (
      /Authentication failed|could not read Username|terminal prompts disabled|Invalid username or password|403|Permission to .* denied|Write access to repository not granted|Permission denied \(publickey/i.test(
        text,
      )
    )
      return new GitError(
        isGitHub(this.record.remote)
          ? `GitHub did not let this host write to ${where}. Sign in to GitHub again, with an account that can push to it.`
          : `${where} did not accept this machine’s credentials.`,
      );
    if (
      /Repository not found|does not appear to be a git repository|repository '.*' (not found|does not exist)/i.test(
        text,
      )
    )
      return new GitError(`${where} could not be found, or this account cannot see it.`);
    if (
      /Could not resolve host|unable to access|Connection (timed out|refused|reset)|Operation timed out|Network is unreachable|early EOF|The remote end hung up/i.test(
        text,
      )
    )
      return new GitError(`${where} could not be reached. Opsidian will keep trying.`, true);
    const last = text.split('\n').filter(Boolean).at(-1) ?? `git ${command} failed.`;
    return new GitError(last.replace(/^(fatal|error): /, ''));
  }

  private async head(): Promise<string | undefined> {
    const found = await this.git(['rev-parse', '--verify', '-q', 'HEAD'], { ok: true });
    return found.code === 0 ? found.out.trim() : undefined;
  }
  private async branch(): Promise<string> {
    return (await this.git(['symbolic-ref', '--short', 'HEAD'])).out.trim();
  }

  /** Clones the repository, the first time. */
  private async prepare(): Promise<void> {
    if (!existsSync(join(this.folder, '.git'))) {
      const staging = `${this.folder}.cloning`;
      await rm(staging, { recursive: true, force: true });
      await mkdir(dirname(this.folder), { recursive: true });
      // Cloned beside and moved into place, so a half-finished clone is never mistaken for one.
      await this.git(['clone', '--quiet', '--no-recurse-submodules', this.record.remote, staging]);
      if (existsSync(this.folder))
        throw new GitError(`Something is already in ${this.folder}. Move it away and try again.`);
      await rename(staging, this.folder);
    }
    const exclude = join(this.folder, '.git', 'info', 'exclude');
    const listed = await readFile(exclude, 'utf8').catch(() => '');
    const missing = EXCLUDE.filter((line) => !listed.split('\n').includes(line));
    if (missing.length) {
      await mkdir(dirname(exclude), { recursive: true });
      await appendFile(
        exclude,
        `${listed && !listed.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`,
      );
    }
  }

  /** Puts right what a crash in the middle of git work left behind. */
  private async recover(): Promise<void> {
    // Only this program uses this checkout, and only one round at a time.
    await rm(join(this.folder, '.git', 'index.lock'), { force: true });
    if (existsSync(join(this.folder, '.git', 'MERGE_HEAD')))
      // Everything was committed before the merge began, so abandoning it loses nothing; the
      // round merges again.
      await this.git(['merge', '--abort'], { ok: true });
  }

  /** Commits whatever differs from the last commit. True if there was anything. */
  private async commit(): Promise<boolean> {
    await this.git(['add', '--all']);
    const staged = await this.git(['diff', '--cached', '--name-status', '--no-renames', '-z']);
    const parts = staged.out.split('\0').filter(Boolean);
    if (!parts.length) return false;
    const changes: { kind: string; path: string }[] = [];
    for (let at = 0; at + 1 < parts.length; at += 2)
      changes.push({ kind: parts[at]!, path: parts[at + 1]! });
    await this.git(['commit', '--quiet', '--no-verify', '-m', describe(changes)]);
    return true;
  }

  /** The repository's latest commit on our branch, or nothing if it has none yet. */
  private async fetch(branch: string): Promise<string | undefined> {
    const remote = `refs/remotes/origin/${branch}`;
    const fetched = await this.git(
      ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:${remote}`],
      { ok: true },
    );
    if (fetched.code !== 0) {
      if (/couldn't find remote ref/i.test(fetched.err)) return undefined;
      throw this.explain(fetched.err, 'fetch');
    }
    return (await this.git(['rev-parse', '--verify', '-q', remote])).out.trim();
  }

  /**
   * Brings in what was pushed to the repository. Lines changed on only one side combine;
   * where both sides changed the same lines, this side's version keeps the name and the
   * repository's is kept beside it as a conflicted copy.
   */
  private async merge(commit: string): Promise<void> {
    const merged = await this.git(
      [
        'merge',
        '--quiet',
        '--no-edit',
        '--no-verify',
        '-m',
        'Bring in changes from GitHub',
        commit,
      ],
      { ok: true },
    );
    if (merged.code === 0) return;
    const unmerged = await this.git(['ls-files', '--unmerged', '-z']);
    const stages = new Map<string, Map<number, string>>();
    for (const line of unmerged.out.split('\0').filter(Boolean)) {
      const match = line.match(/^\d+ ([0-9a-f]+) (\d)\t(.*)$/s);
      if (!match) continue;
      const [, blob, stage, path] = match;
      const each = stages.get(path!) ?? new Map<number, string>();
      each.set(Number(stage), blob!);
      stages.set(path!, each);
    }
    if (!stages.size) {
      // Not a conflict between versions, such as a file in the way: start over next round.
      await this.git(['merge', '--abort'], { ok: true });
      throw this.explain(merged.err || merged.out, 'merge');
    }
    const taken = new Set(
      (await this.git(['ls-files', '-z'])).out
        .split('\0')
        .filter(Boolean)
        .map((path) => pathKey(path)),
    );
    for (const [path, versions] of stages) {
      const ours = versions.get(2);
      const theirs = versions.get(3);
      const file = join(this.folder, path);
      if (ours) await this.writeBlob(file, ours);
      else if (theirs) await this.writeBlob(file, theirs);
      else {
        // Deleted on both sides.
        await rm(file, { force: true });
        continue;
      }
      if (ours && theirs && ours !== theirs) {
        const aside = this.aside(path, taken);
        taken.add(pathKey(aside));
        await this.writeBlob(join(this.folder, aside), theirs);
      }
    }
    await this.git(['add', '--all']);
    await this.git(['commit', '--quiet', '--no-verify', '--no-edit']);
  }
  private async writeBlob(file: string, blob: string): Promise<void> {
    const bytes = await this.blob(blob);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  private blob(blob: string): Promise<Buffer> {
    return new Promise((resolve, reject) =>
      execFile(
        'git',
        ['cat-file', 'blob', blob],
        { cwd: this.folder, encoding: 'buffer', maxBuffer: 200 * 1024 * 1024 },
        (error, stdout) => (error ? reject(this.explain(String(error))) : resolve(stdout)),
      ),
    );
  }
  /** A free name beside `path`, named the way sync names a version it could not combine. */
  private aside(path: string, taken: Set<string>): string {
    const slash = path.lastIndexOf('/') + 1;
    const dot = path.lastIndexOf('.');
    const stem = dot > slash ? path.slice(0, dot) : path;
    const extension = dot > slash ? path.slice(dot) : '';
    const time = new Date(this.now())
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ')
      .replaceAll(':', '.');
    for (let count = 0; ; count++) {
      const candidate = `${stem} (conflicted copy ${DEVICE} ${time}${count ? ` ${count}` : ''})${extension}`;
      if (!taken.has(pathKey(candidate))) return candidate;
    }
  }

  /**
   * Sends this branch to the repository. False if the repository moved on since `seen`, as
   * when someone pushed in the meantime; git words that differently on every server, so it
   * is told by looking again.
   */
  private async push(branch: string, seen: string | undefined): Promise<boolean> {
    const pushed = await this.git(
      ['push', '--quiet', '--no-verify', 'origin', `HEAD:refs/heads/${branch}`],
      { ok: true },
    );
    if (pushed.code === 0) return true;
    if ((await this.fetch(branch).catch(() => seen)) !== seen) return false;
    throw this.explain(pushed.err, 'push');
  }

  // The host.

  private async device(): Promise<{ engine: SyncEngine; state: SyncState }> {
    const vault = (this.vault ??= await Vault.open(this.folder));
    let state = await vault.syncState();
    if (!state || !this.record.token || state.device !== this.record.device) {
      // The first round, or the copy's device was set up again: join as a new device. The
      // engine then meets the host as a device joining with files of its own.
      const { host } = this.options;
      const { code } = host.invite(this.record.name, 5);
      const paired = await pair(HERE, code, DEVICE, host.local);
      host.setMirrorDevice(this.record.notebook, paired.device.id, paired.token);
      this.record = { ...this.record, device: paired.device.id, token: paired.token };
      state = {
        version: 1,
        host: HERE,
        notebook: paired.notebook.id,
        notebookName: paired.notebook.name,
        device: paired.device.id,
        deviceName: DEVICE,
        cursor: 0,
        files: {},
      };
      await vault.syncStore().save(state);
    }
    const engine = new SyncEngine(
      vault.syncStore(),
      httpTransport(HERE, this.record.token!, this.options.host.local),
      state,
      () => {},
      { wait: 0 },
    );
    if (this.allowDeletions) engine.confirmDeletions();
    return { engine, state };
  }
  /** Brings the folder and the host into step. */
  private async exchange(): Promise<{ held?: number; problem?: string }> {
    const { engine } = await this.device();
    try {
      await engine.sync();
    } catch (error) {
      if (error instanceof Unauthorized)
        throw new GitError(
          `The GitHub device was removed from this host, so ${this.record.name} is no longer kept in ${this.label}. Connect it again to carry on.`,
        );
      throw error;
    } finally {
      await engine.stop();
    }
    const status = engine.status;
    return {
      ...(status.held ? { held: status.held } : {}),
      ...(status.problems ? { problem: status.message } : {}),
    };
  }

  // Rounds.

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.work.then(task);
    this.work = result.catch(() => {});
    return result;
  }

  /**
   * One full round: the host into the folder, the folder into a commit, the repository's new
   * commits into the folder and on to the host, and the result back to the repository.
   */
  sync(): Promise<MirrorStatus> {
    return this.serial(() => this.locked(() => this.round()));
  }

  private async round(): Promise<MirrorStatus> {
    this.report({ ...this.record.status, state: 'syncing' });
    try {
      await this.prepare();
      await this.recover();
      let outcome = await this.exchange();
      await this.commit();
      const branch = await this.branch();
      for (let attempt = 0; ; attempt++) {
        const remote = await this.fetch(branch);
        const head = await this.head();
        if (remote && remote !== head) {
          const behind =
            !head ||
            (await this.git(['merge-base', '--is-ancestor', remote, 'HEAD'], { ok: true })).code !==
              0;
          if (behind) {
            await this.merge(remote);
            outcome = await this.exchange();
            await this.commit();
          }
        }
        const now = await this.head();
        if (!now || now === remote || (await this.push(branch, remote))) break;
        if (attempt >= 5)
          throw new GitError(
            `${this.label} kept changing while Opsidian was sending to it. It will try again.`,
          );
      }
      // The repository's history has whatever went to the trash, so the copy needs no trash.
      await rm(join(this.folder, '.trash'), { recursive: true, force: true });
      this.allowDeletions = false;
      const commit = await this.head();
      return this.report({
        state: outcome.problem ? 'error' : 'synced',
        at: this.now(),
        ...(commit ? { commit } : {}),
        ...(outcome.held
          ? {
              held: outcome.held,
              message: `Most of the notebook disappeared from ${this.label} at once, so ${outcome.held} deletions are waiting to be confirmed.`,
            }
          : {}),
        ...(outcome.problem ? { message: outcome.problem } : {}),
      });
    } catch (error) {
      const offline = error instanceof GitError && error.offline;
      this.report({
        ...this.record.status,
        state: offline ? 'offline' : 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private report(status: MirrorStatus): MirrorStatus {
    const { state, at, commit, held, message } = status;
    const clean: MirrorStatus = {
      state,
      ...(at ? { at } : {}),
      ...(commit ? { commit } : {}),
      ...(held ? { held } : {}),
      ...(message ? { message } : {}),
    };
    this.record = { ...this.record, status: clean };
    try {
      this.options.host.setMirrorStatus(this.record.notebook, clean);
    } catch {
      // The host closing is no reason to fail the round.
    }
    return clean;
  }

  /**
   * Holds the copy for one process at a time: the background host and a command typed at the
   * same moment must not both commit in it.
   */
  private async locked<T>(task: () => Promise<T>): Promise<T> {
    const lock = `${this.folder}.lock`;
    // A process number alone could be reused after a restart, by something else entirely.
    const me = `${process.pid} ${booted()}`;
    await mkdir(dirname(lock), { recursive: true });
    for (let tries = 0; ; tries++) {
      try {
        const file = await open(lock, 'wx');
        await file.writeFile(me);
        await file.close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const [pid, boot] = (await readFile(lock, 'utf8').catch(() => '')).split(' ');
        const owner = Number(pid);
        if (owner === process.pid || boot !== booted() || !alive(owner))
          // Left behind by a process that has gone: nobody holds it.
          await rm(lock, { force: true });
        else if (this.stopped || tries > 600)
          throw new GitError('The copy is busy in another process. Try again shortly.');
        else await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    try {
      return await task();
    } finally {
      await rm(lock, { force: true });
    }
  }

  /** Lets the deletions a round held back go through, and syncs. */
  confirmDeletions(): Promise<MirrorStatus> {
    this.allowDeletions = true;
    return this.sync();
  }

  /** Keeps the copy in step until `stop`. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.looping = this.loop();
  }
  async stop(): Promise<void> {
    this.running = false;
    this.stopped = true;
    this.wake?.();
    await this.looping?.catch(() => {});
    await this.work.catch(() => {});
    this.vault?.close();
    this.vault = undefined;
  }
  /** Something changed: sync without waiting. */
  kick(): void {
    this.wake?.();
  }

  private async loop(): Promise<void> {
    let delay = 5000;
    while (this.running) {
      try {
        await this.sync();
        delay = 5000;
        await this.idle();
      } catch (error) {
        if (!this.running) break;
        this.options.log?.(`${this.record.name} → ${this.label}: ${(error as Error).message}`);
        await this.pause(delay);
        delay = Math.min(delay * 2, 10 * 60_000);
      }
    }
  }
  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }
  /**
   * Waits for a change on the host, then a little longer so a burst of typing becomes one
   * commit; or for the time to look at the repository again.
   */
  private async idle(): Promise<void> {
    const interval = this.options.interval ?? 60_000;
    const until = Date.now() + interval;
    const transport = httpTransport(HERE, this.record.token!, this.options.host.local);
    while (this.running && Date.now() < until) {
      const cursor = (await this.vault?.syncState())?.cursor ?? 0;
      let woken = false;
      const changed = await Promise.race([
        transport
          .changes(cursor, Math.max(1, Math.min(25, Math.ceil((until - Date.now()) / 1000))))
          .then((answer) => answer.head !== cursor || answer.changes.length > 0)
          .catch(() => false),
        this.pause(until - Date.now()).then(() => {
          woken = true;
          return false;
        }),
      ]);
      if (woken) return;
      if (changed) {
        await this.pause(this.options.quiet ?? 10_000);
        return;
      }
    }
  }
}

/** A commit message that says what changed: names when there are few, a count otherwise. */
export function describe(changes: { kind: string; path: string }[]): string {
  const name = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  const groups: [string, typeof changes][] = [
    ['Edit', changes.filter((each) => each.kind !== 'A' && each.kind !== 'D')],
    ['Add', changes.filter((each) => each.kind === 'A')],
    ['Remove', changes.filter((each) => each.kind === 'D')],
  ];
  const subject = groups
    .filter(([, group]) => group.length)
    .map(([verb, group]) =>
      group.length <= 3
        ? `${verb} ${group.map((each) => name(each.path)).join(', ')}`
        : `${verb} ${group.length} files`,
    )
    .join('; ');
  const body = changes.map((each) => `${each.kind}  ${each.path}`).join('\n');
  return `${subject.length > 72 ? `${changes.length} changes from Opsidian` : subject}\n\n${body}`;
}

/** Every copy a host keeps, started and stopped as they are added and removed. */
export class Mirrors {
  private readonly running = new Map<string, Mirror>();
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Whether copies run here in the background, or only when asked, as from a command. */
  private started = false;

  constructor(private readonly options: MirrorOptions) {}

  private make(record: MirrorRecord): Mirror {
    return new Mirror(record, this.options);
  }
  /** Starts every copy, and looks for new or removed ones every few seconds. */
  start(): void {
    this.started = true;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 5000);
  }
  async stop(): Promise<void> {
    this.started = false;
    clearInterval(this.timer);
    await Promise.all([...this.running.values()].map((each) => each.stop()));
    this.running.clear();
  }
  /** Matches what runs to what the host's settings say. */
  refresh(): void {
    if (!this.started) return;
    let records: MirrorRecord[];
    try {
      records = this.options.host.mirrors();
    } catch {
      return;
    }
    const wanted = new Map(records.map((record) => [record.notebook, record]));
    for (const [notebook, mirror] of this.running)
      if (wanted.get(notebook)?.remote !== mirror.remote) {
        this.running.delete(notebook);
        void mirror.stop();
      }
    for (const [notebook, record] of wanted)
      if (!this.running.has(notebook)) {
        const mirror = this.make(record);
        this.running.set(notebook, mirror);
        mirror.start();
      }
  }
  kick(notebook?: string): void {
    for (const [id, mirror] of this.running) if (!notebook || id === notebook) mirror.kick();
  }

  /**
   * Keeps notebook `name` in `remote`, making the notebook if it is new, and runs the first
   * round now: importing what the repository has, sending what the notebook has, or both.
   */
  async connect(name: string, remote: string): Promise<MirrorStatus> {
    await gitVersion();
    const record = this.options.host.addMirror(name, remote);
    const mirror = this.running.get(record.notebook) ?? this.make(record);
    try {
      return await mirror.sync();
    } finally {
      if (!this.running.has(record.notebook)) await mirror.stop();
      this.refresh();
    }
  }
  /** Syncs one copy now, through whichever process holds it. */
  async sync(name: string, confirm = false): Promise<MirrorStatus> {
    const record = this.find(name);
    const mirror = this.running.get(record.notebook) ?? this.make(record);
    try {
      return await (confirm ? mirror.confirmDeletions() : mirror.sync());
    } finally {
      if (!this.running.has(record.notebook)) await mirror.stop();
    }
  }
  /** Stops keeping a copy. The repository keeps everything it has; the local checkout goes. */
  async disconnect(name: string): Promise<void> {
    const record = this.find(name);
    const mirror = this.running.get(record.notebook);
    this.running.delete(record.notebook);
    await mirror?.stop();
    this.options.host.removeMirror(record.notebook);
    const folder = join(this.options.dataDir, 'mirrors', record.notebook);
    await rm(folder, { recursive: true, force: true });
    await rm(`${folder}.lock`, { force: true });
  }
  private find(name: string): MirrorRecord {
    const all = this.options.host.mirrors();
    const found =
      all.find((each) => each.name === name) ??
      all.find((each) => each.name.toLowerCase() === name.toLowerCase());
    if (!found) throw new Error(`“${name}” is not kept in a repository.`);
    return found;
  }
}
