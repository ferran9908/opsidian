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
/**
 * Opsidian's own folders in a notebook: sync state, which belongs to one device, and the
 * trash, whose notes the repository's history already has. Never part of the repository.
 */
const OWN = ['.opsidian', '.trash'];

export class GitError extends Error {
  constructor(
    message: string,
    /** The repository could not be reached; trying again later may be enough. */
    readonly offline = false,
    /**
     * The repository asked to be left alone for a while, as GitHub does when it throttles: how
     * long it asked for in milliseconds, or 0 when it did not say.
     */
    readonly throttled?: number,
  ) {
    super(message);
  }
}

/** How often copies go to their repositories. */
export const SCHEDULES = ['live', '15m', '1h', '6h', '24h'] as const;
export type Schedule = (typeof SCHEDULES)[number];
/**
 * Hourly unless changed. The copy is a backup, and a round an hour makes fewer commits that
 * each say more, and asks the repository for far less than following every edit does.
 */
export const DEFAULT_SCHEDULE: Schedule = '1h';
export const isSchedule = (value: unknown): value is Schedule =>
  SCHEDULES.includes(value as Schedule);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const PERIOD: Record<Schedule, number> = {
  // Live rounds follow changes; this is how often it looks at the repository meanwhile.
  live: MINUTE,
  '15m': 15 * MINUTE,
  '1h': HOUR,
  '6h': 6 * HOUR,
  '24h': 24 * HOUR,
};
/** The time between scheduled rounds. */
export const period = (schedule: Schedule): number => PERIOD[schedule];
/** The schedule a host has: the default when it has none, or one this version does not know. */
export function scheduleOf(host: Pick<Host, 'mirrorSchedule'>): Schedule {
  try {
    const saved = host.mirrorSchedule();
    return isSchedule(saved) ? saved : DEFAULT_SCHEDULE;
  } catch {
    return DEFAULT_SCHEDULE;
  }
}
/**
 * Whether a copy has gone unconfirmed for twice as long as its schedule allows, so it can no
 * longer be trusted as a recent backup. Live copies count as every five minutes, so a minute's
 * hiccup is no warning.
 */
export function isBehind(
  status: MirrorStatus | undefined,
  schedule: Schedule,
  now = Date.now(),
): boolean {
  if (!status?.at) return false;
  return now - status.at > 2 * Math.max(PERIOD[schedule], 5 * MINUTE);
}

/**
 * How long to wait after a round failed, for the `count`th time in a row. When the repository
 * asked to slow down: at least an hour, doubling while it keeps asking, and longer if it said
 * so. Otherwise a short wait that doubles, never longer than the schedule's own period or an
 * hour, so a scheduled copy retries a dropped connection well before its next round.
 */
export function backoff(error: unknown, count: number, schedule: Schedule): number {
  const times = 2 ** Math.max(0, Math.min(count - 1, 10));
  if (error instanceof GitError && error.throttled !== undefined)
    return Math.min(Math.max(HOUR * times, error.throttled), 24 * HOUR);
  if (schedule === 'live') return Math.min(5000 * times, 10 * MINUTE);
  return Math.min(MINUTE * times, PERIOD[schedule], HOUR);
}

/** The ways GitHub, and git servers like it, say they are being asked too often. */
const THROTTLED =
  /\b(HTTP|error:?|status:?)\s*429\b|rate.?limit|abuse detection|too many requests/i;

/** Says what went wrong with a git command in words a person can act on. */
export function explainGit(output: string, remote: string, command = 'git'): GitError {
  const text = output.trim();
  const where = repositoryLabel(remote);
  if (/ENOENT|spawn git/.test(text)) return new GitError('git is not installed on this machine.');
  // Before the others: a throttled request also says "unable to access", and GitHub's
  // secondary limit answers 403, which would read as a refused sign-in.
  if (THROTTLED.test(text)) {
    const hint = text.match(/retry[- ]after:?\s*(\d+)/i);
    return new GitError(
      `${isGitHub(remote) ? 'GitHub' : where} asked Opsidian to slow down.`,
      true,
      hint ? Number(hint[1]) * 1000 : 0,
    );
  }
  if (
    /Authentication failed|could not read Username|terminal prompts disabled|Invalid username or password|403|Permission to .* denied|Write access to repository not granted|Permission denied \(publickey/i.test(
      text,
    )
  )
    return new GitError(
      isGitHub(remote)
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

/** Whether `task` settles within `ms`; it carries on regardless. */
function within(task: Promise<unknown>, ms: number): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    task.then(done, done);
  });
}
/** A time of day, as a person would say it: 14:05. */
const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
/** A number from 0 to 1, always the same for a notebook, to spread copies apart in time. */
function share(notebook: string): number {
  let hash = 2166136261;
  for (const char of notebook) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) / 2 ** 32;
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

/** The round each notebook's copy is in, in this process, by folder. */
const holders = new Map<string, Promise<void>>();

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
  /** Live copies: how often to look for changes pushed to the repository. Default one minute. */
  interval?: number;
  /** Live copies: how long to let a burst of edits gather before committing. Default 10 s. */
  quiet?: number;
  /**
   * Scheduled copies: at most how far apart notebooks' rounds are spread, so a host with many
   * does not ask the repository for all of them in the same second. Default a tenth of the
   * period, up to five minutes; a catch-up round on starting is spread over 30 s at most.
   */
  spread?: number;
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
  /** When the background rounds started, from which a catch-up round is spread. */
  private began = 0;
  /** Rounds that failed in a row, and of those, how many because the repository throttled. */
  private failures = 0;
  private throttles = 0;
  /** No background round before this, after a failure. */
  private retryAt = 0;
  private logged: string | undefined;

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
    return explainGit(output, this.record.remote, command);
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
    // A crash in the middle of a merge left this copy's own sync state set aside.
    await this.restoreOwn();
    if (existsSync(join(this.folder, '.git', 'MERGE_HEAD')))
      // Everything was committed before the merge began, so abandoning it loses nothing; the
      // round merges again.
      await this.git(['merge', '--abort'], { ok: true });
  }

  /**
   * Takes Opsidian's own files out of the repository when someone committed them, as happens
   * when a notebook folder was pushed to GitHub by hand. Otherwise this copy's sync state would
   * be committed every round, and handed to everyone who clones the repository. They leave in
   * one commit that says so, stay in the history, and are added to `.gitignore` so that other
   * clones do not commit them again.
   */
  private async untrackOwn(): Promise<void> {
    const tracked = await this.git(['ls-files', '-z', '--', ...OWN]);
    if (!tracked.out.split('\0').some(Boolean)) return;
    await this.git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...OWN]);
    const ignore = join(this.folder, '.gitignore');
    const text = await readFile(ignore, 'utf8').catch(() => '');
    const lines = text.split(/\r?\n/).map((line) => line.trim());
    const wanted = OWN.map((name) => `/${name}/`).filter(
      (line) =>
        ![line, line.slice(1), line.slice(0, -1), line.slice(1, -1)].some((form) =>
          lines.includes(form),
        ),
    );
    if (wanted.length) {
      await writeFile(
        ignore,
        `${text}${text && !text.endsWith('\n') ? '\n' : ''}# Opsidian's own: one device's sync state, and the notebook's trash\n${wanted.join('\n')}\n`,
      );
      await this.git(['add', '--', '.gitignore']);
    }
    await this.git([
      'commit',
      '--quiet',
      '--no-verify',
      '-m',
      "Stop tracking Opsidian's own files\n\nSync state belongs to one device, and the notebook's trash is already in this history. Both stay in the history, and .gitignore keeps them out from now on.",
    ]);
  }
  /** Where this copy's own folders wait while a merge brings in someone else's. */
  private get ownAside(): string {
    return join(this.folder, '.git', 'opsidian-own');
  }
  private async setOwnAside(): Promise<void> {
    await rm(this.ownAside, { recursive: true, force: true });
    await mkdir(this.ownAside, { recursive: true });
    for (const name of OWN)
      if (existsSync(join(this.folder, name)))
        await rename(join(this.folder, name), join(this.ownAside, name));
  }
  private async restoreOwn(): Promise<void> {
    if (!existsSync(this.ownAside)) return;
    for (const name of OWN) {
      if (!existsSync(join(this.ownAside, name))) continue;
      await rm(join(this.folder, name), { recursive: true, force: true });
      await rename(join(this.ownAside, name), join(this.folder, name));
    }
    await rm(this.ownAside, { recursive: true, force: true });
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
    // Someone committed Opsidian's own files again. This copy's sync state is set aside so the
    // merge cannot replace it, and comes back once the merge is done.
    const foreign = await this.git(['ls-tree', '-r', '--name-only', commit, '--', ...OWN]);
    if (!foreign.out.trim()) return this.combine(commit);
    await this.setOwnAside();
    try {
      await this.combine(commit);
    } finally {
      await this.restoreOwn();
    }
    await this.untrackOwn();
  }
  private async combine(commit: string): Promise<void> {
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
      // The engine takes in what it sent itself only on its next pass. Taken in now, the
      // host's latest change is the copy's own, so a scheduled round can tell that nothing
      // new has happened since.
      const after = await this.vault!.syncState();
      const transport = httpTransport(HERE, this.record.token!, this.options.host.local);
      if (after && (await transport.changes(after.cursor, 0)).head !== after.cursor)
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

  /**
   * A scheduled round. When neither side changed since the last one, it only asks the
   * repository which commit its branch is at, a single small request, and records that the
   * copy is still in step; otherwise it is a full round, and every edit since the last one
   * becomes one commit.
   */
  scheduled(): Promise<MirrorStatus> {
    return this.serial(() =>
      this.locked(async () => {
        let same: boolean;
        try {
          same = await this.unchanged();
        } catch (error) {
          this.report({
            ...this.record.status!,
            state: error instanceof GitError && error.offline ? 'offline' : 'error',
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        if (!same) return this.round();
        const at = this.now();
        return this.report({ ...this.record.status!, at, ...this.settled(at) });
      }),
    );
  }
  private async unchanged(): Promise<boolean> {
    const last = this.record.status;
    if (!last?.commit || (await this.pending())) return false;
    const listed = await this.git(['ls-remote', 'origin', `refs/heads/${await this.branch()}`]);
    return listed.out.split(/\s/)[0] === last.commit;
  }
  /**
   * Whether this side has something the repository may not: the host has changes the copy has
   * not taken, or the last round did not finish. Asks only the host, never the repository.
   */
  private async pending(): Promise<boolean> {
    const last = this.record.status;
    if (last?.state !== 'synced' || last.held || !this.record.token) return true;
    if (!existsSync(join(this.folder, '.git'))) return true;
    try {
      const state = await (this.vault ??= await Vault.open(this.folder)).syncState();
      if (!state || state.device !== this.record.device) return true;
      const answer = await httpTransport(HERE, this.record.token, this.options.host.local).changes(
        state.cursor,
        0,
      );
      return answer.head !== state.cursor || answer.changes.length > 0;
    } catch {
      return true;
    }
  }

  private async round(): Promise<MirrorStatus> {
    this.report({ ...this.record.status, state: 'syncing' });
    try {
      await this.prepare();
      await this.recover();
      await this.untrackOwn();
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
      const at = this.now();
      return this.report({
        state: outcome.problem ? 'error' : 'synced',
        at,
        ...this.settled(at),
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
    const { state, at, commit, held, message, next } = status;
    const clean: MirrorStatus = {
      state,
      ...(at ? { at } : {}),
      ...(commit ? { commit } : {}),
      ...(held ? { held } : {}),
      ...(message ? { message } : {}),
      ...(next ? { next } : {}),
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
  private locked<T>(task: () => Promise<T>): Promise<T> {
    // Within this process, two copies of one notebook (one importing, one in the background)
    // take turns here; the lock file is only for other processes. Without this, the second
    // found a lock with this process's number on it, took it for one left by a crash, and
    // cloned into the same folder at the same time.
    const before = holders.get(this.folder) ?? Promise.resolve();
    const mine = before.then(() => this.lockFile(task));
    const settled = mine.then(
      () => {},
      () => {},
    );
    holders.set(this.folder, settled);
    void settled.then(() => {
      if (holders.get(this.folder) === settled) holders.delete(this.folder);
    });
    return mine;
  }
  private async lockFile<T>(task: () => Promise<T>): Promise<T> {
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
          // Left behind by a process that has gone, or by this one before a crash or restart
          // of its host (in this process, copies take turns before reaching here): nobody holds it.
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
  /**
   * Stops the background rounds. With `flush`, first sends what the repository does not have
   * yet, waiting at most that many milliseconds in all: a host that is shutting down must not
   * hang on a slow network. What is cut short goes in the next round after a restart.
   */
  async stop(flush = 0): Promise<void> {
    const deadline = Date.now() + flush;
    this.running = false;
    this.stopped = true;
    this.wake?.();
    const quiet = Promise.all([this.looping?.catch(() => {}), this.work.catch(() => {})]);
    if (!flush) await quiet;
    else {
      let finished = await within(quiet, flush);
      // Not while the repository has asked to be left alone.
      const throttled = this.throttles > 0 && this.retryAt > this.now();
      if (finished && !throttled && (await this.pending())) {
        const last = this.sync().catch((error: unknown) =>
          this.options.log?.(`${this.record.name} → ${this.label}: ${(error as Error).message}`),
        );
        finished = await within(last, deadline - Date.now());
      }
      if (!finished) {
        this.options.log?.(
          `${this.record.name} → ${this.label}: stopped before the latest changes were sent; they go when the host starts again.`,
        );
        // The round still holds the folder; the process is ending anyway.
        return;
      }
    }
    this.vault?.close();
    this.vault = undefined;
  }
  /**
   * Something changed, such as the sign-in: a copy waiting after a failure tries again now,
   * and a live copy syncs at once. A throttled copy keeps waiting as the repository asked.
   */
  kick(): void {
    if (!this.throttles) this.retryAt = 0;
    this.wake?.();
  }
  /** The schedule changed: plan the next round again. */
  reschedule(): void {
    this.wake?.();
  }

  /**
   * When the next background round is due. Live: now, unless waiting after a failure. On a
   * schedule: a period after the last time the copy was in step, moved a little for each
   * notebook so they do not all go at once; and soon after starting if that time has passed,
   * as when the host was down, so a copy catches up.
   */
  private due(schedule: Schedule, at = this.record.status?.at ?? 0): number {
    if (schedule === 'live') return this.retryAt;
    const room = this.options.spread ?? Math.min(PERIOD[schedule] / 10, 5 * MINUTE);
    const offset = share(this.record.notebook);
    let due = at + PERIOD[schedule] + offset * room;
    if (due < this.began) due = this.began + offset * Math.min(room, 30_000);
    return Math.max(due, this.retryAt);
  }
  /**
   * Takes up the status another process wrote meanwhile, as `host github sync` does, so a
   * round made there counts and is not written over with an older one.
   */
  private reload(): void {
    try {
      const saved = this.options.host
        .mirrors()
        .find((each) => each.notebook === this.record.notebook)?.status;
      if (saved && (saved.at ?? 0) > (this.record.status?.at ?? 0))
        this.record = { ...this.record, status: saved };
    } catch {
      // The host closing; the loop is about to end.
    }
  }
  /** A round went through: forget past failures, and say when the next one is. */
  private settled(at: number): { next?: number } {
    this.failures = this.throttles = this.retryAt = 0;
    this.logged = undefined;
    const schedule = scheduleOf(this.options.host);
    return schedule === 'live' ? {} : { next: this.due(schedule, at) };
  }
  private failed(error: unknown, schedule: Schedule): void {
    const throttled = error instanceof GitError && error.throttled !== undefined;
    const count = throttled ? ++this.throttles : ++this.failures;
    this.retryAt = this.now() + backoff(error, count, schedule);
    const said = error instanceof Error ? error.message : String(error);
    if (throttled)
      // Not an error to fix: the status says when it carries on.
      this.report({
        ...this.record.status!,
        state: 'offline',
        message: `${said.replace(/\.$/, '')}; it will try again at ${clock(this.retryAt)}.`,
        next: this.retryAt,
      });
    // The same trouble again is in the status already; the log says when it changes.
    if (said !== this.logged)
      this.options.log?.(
        `${this.record.name} → ${this.label}: ${said}${throttled ? ` Next try at ${clock(this.retryAt)}.` : ''}`,
      );
    this.logged = said;
  }

  private async loop(): Promise<void> {
    this.began = this.now();
    while (this.running) {
      this.reload();
      const schedule = scheduleOf(this.options.host);
      const due = this.due(schedule);
      const wait = due - this.now();
      if (wait > 0) {
        const status = this.record.status;
        if (status && status.next !== due) this.report({ ...status, next: due });
        // In slices, so a Mac that slept past the time, or a changed schedule, is noticed.
        await this.pause(Math.min(wait, 5 * MINUTE));
        continue;
      }
      try {
        if (schedule === 'live') {
          await this.sync();
          await this.idle();
        } else await this.scheduled();
      } catch (error) {
        if (!this.running) break;
        this.failed(error, schedule);
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
  private schedule: Schedule | undefined;

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
  /**
   * Stops every copy. With `flush`, each first sends what its repository does not have yet,
   * all at once and within that many milliseconds, as when the host shuts down.
   */
  async stop(flush = 0): Promise<void> {
    this.started = false;
    clearInterval(this.timer);
    await Promise.all([...this.running.values()].map((each) => each.stop(flush)));
    this.running.clear();
  }
  /** Matches what runs to what the host's settings say, the schedule included. */
  refresh(): void {
    if (!this.started) return;
    let records: MirrorRecord[];
    try {
      records = this.options.host.mirrors();
    } catch {
      return;
    }
    const schedule = scheduleOf(this.options.host);
    if (this.schedule && schedule !== this.schedule)
      for (const mirror of this.running.values()) mirror.reschedule();
    this.schedule = schedule;
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
