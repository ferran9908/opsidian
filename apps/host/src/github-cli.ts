import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import {
  GitHubError,
  account,
  createRepository,
  findRepository,
  finishSignIn,
  parseRepository,
  repositories,
  repositoryLabel,
  repositoryName,
  startSignIn,
  type GitHubAccount,
  type Repository,
} from './github';
import type { Host, MirrorStatus } from './host';
import { Mirrors, gitVersion } from './mirror';
import type { Place } from './home';

/** The GitHub sign-in on this machine, if there is one. */
export async function readAccount(where: Place): Promise<GitHubAccount | undefined> {
  try {
    const saved = JSON.parse(await readFile(where.github, 'utf8')) as GitHubAccount;
    return saved.token ? saved : undefined;
  } catch {
    return undefined;
  }
}
async function saveAccount(where: Place, signedIn: GitHubAccount): Promise<void> {
  await mkdir(where.home, { recursive: true });
  const temporary = `${where.github}.tmp`;
  await writeFile(temporary, JSON.stringify(signedIn), { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, where.github);
}

/** How long ago, in words. */
export function ago(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(at).toLocaleDateString();
}

/** One line on how a copy is doing. */
export function statusLine(status: MirrorStatus | undefined): string {
  if (!status) return 'waiting for its first sync';
  const last = status.at ? `, last in step ${ago(status.at)}` : '';
  if (status.held) return `! ${status.message}`;
  switch (status.state) {
    case 'synced':
      return `✓ up to date${last}`;
    case 'syncing':
      return `… syncing${last}`;
    case 'offline':
      return `… cannot reach it${last}. ${status.message ?? ''}`.trim();
    case 'error':
      return `✗ ${status.message ?? 'Not syncing.'}`;
  }
}

interface Context {
  me: string;
  where: Place;
  flags: Map<string, string>;
  words: string[];
  withHost<T>(work: (host: Host) => T | Promise<T>): Promise<T>;
  /** Whether the background host is running, so changes keep flowing after this command. */
  running(): Promise<boolean>;
  /** Shows an invitation to a notebook. */
  invite(name: string): Promise<void>;
}

const fail = (text: string): never => {
  throw new Error(text);
};

async function ask(question: string): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question(question)).trim();
  } finally {
    prompt.close();
  }
}
const interactive = () => process.stdin.isTTY && process.stdout.isTTY;

/** Opens a page in the browser, when this machine has one. A server simply shows the link. */
function openPage(url: string): void {
  const opener =
    process.platform === 'darwin'
      ? 'open'
      : process.env.DISPLAY || process.env.WAYLAND_DISPLAY
        ? 'xdg-open'
        : undefined;
  if (!opener || !interactive()) return;
  const child = spawn(opener, [url], { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}

/** Signs in to GitHub, showing a code to enter there. */
async function signIn(context: Context): Promise<GitHubAccount> {
  if (context.flags.has('with-token')) {
    // For scripts: a token on standard input, as `gh auth login --with-token` takes it.
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const token = Buffer.concat(chunks).toString('utf8').trim();
    if (!token) fail('Give the token on standard input.');
    const signedIn = await account(token);
    await saveAccount(context.where, signedIn);
    console.log(`✓ Signed in to GitHub as ${signedIn.login}`);
    return signedIn;
  }
  const started = await startSignIn().catch((error: unknown) => {
    if (error instanceof GitHubError && /not set up/.test(error.message))
      throw new Error(
        `${error.message}\nSign in with a token instead, for example from the GitHub CLI:\n` +
          `  gh auth token | ${context.me} host github login --with-token`,
      );
    throw error;
  });
  console.log(
    [
      'Sign in to GitHub so this host can keep notebooks there:',
      '',
      `  1. Open   ${started.url}`,
      `  2. Enter  ${started.code}`,
      '',
      'Waiting for GitHub…',
    ].join('\n'),
  );
  openPage(started.url);
  const signedIn = await finishSignIn(started);
  await saveAccount(context.where, signedIn);
  console.log(`✓ Signed in to GitHub as ${signedIn.login}`);
  return signedIn;
}
async function needAccount(context: Context): Promise<GitHubAccount> {
  const saved = await readAccount(context.where);
  if (saved) return saved;
  if (!interactive() && !context.flags.has('with-token'))
    fail(`Sign in to GitHub first: ${context.me} host github login`);
  return signIn(context);
}

/** Lets the person pick one of their repositories, or make a new private one. */
async function chooseRepository(signedIn: GitHubAccount, suggested: string): Promise<Repository> {
  if (!interactive())
    fail('Say which repository, such as you/notes, or a new name to create a private one.');
  const all = (await repositories(signedIn)).slice(0, 15);
  console.log(`\n  0) A new private repository, ${signedIn.login}/${suggested}`);
  all.forEach((each, at) =>
    console.log(
      `  ${String(at + 1).padStart(2)}) ${each.fullName}${each.private ? '' : '  (public)'}${each.empty ? '  (empty)' : ''}`,
    ),
  );
  const answer = await ask('\nWhich one? ');
  const number = Number(answer);
  if (answer === '0' || answer === '') return createRepository(signedIn, suggested);
  if (Number.isInteger(number) && all[number - 1]) return all[number - 1]!;
  return resolveRepository(signedIn, answer, true);
}

/** The repository someone named, made for them if it is theirs and does not exist yet. */
async function resolveRepository(
  signedIn: GitHubAccount,
  typed: string,
  create: boolean,
): Promise<Repository> {
  const parsed = parseRepository(typed.includes('/') ? typed : `${signedIn.login}/${typed}`);
  if (!parsed.fullName) fail(`${typed} is not a GitHub repository.`);
  try {
    return await findRepository(signedIn, parsed.fullName!);
  } catch (error) {
    const [owner, name] = parsed.fullName!.split('/');
    if (!(error instanceof GitHubError) || owner !== signedIn.login || !name) throw error;
    if (!create) {
      if (!interactive()) throw error;
      const answer = await ask(`${parsed.fullName} does not exist. Create it, private? [Y/n] `);
      if (/^n/i.test(answer)) throw error;
    }
    return createRepository(signedIn, name);
  }
}

/** Where a notebook goes: the address git uses, and how to show it. */
async function target(
  context: Context,
  typed: string | undefined,
  suggested: string,
): Promise<{ url: string; label: string; empty?: boolean }> {
  if (typed) {
    const parsed = parseRepository(typed);
    // Anything that is not GitHub over https, such as an SSH address or a server of one's own,
    // is used as it is, with this machine's own git credentials.
    if (!parsed.fullName || parsed.url.startsWith('git@'))
      return { url: parsed.url, label: repositoryLabel(parsed.url) };
  }
  const signedIn = await needAccount(context);
  const found = typed
    ? await resolveRepository(signedIn, typed, false)
    : await chooseRepository(signedIn, suggested);
  if (!found.canPush) fail(`${signedIn.login} cannot push to ${found.fullName}.`);
  return { url: found.url, label: found.fullName, empty: found.empty };
}

async function showResult(context: Context, name: string, label: string, status: MirrorStatus) {
  const { notebooks } = await context.withHost((host) => ({ notebooks: host.notebooks() }));
  const files = notebooks.find((each) => each.name === name)?.files ?? 0;
  console.log(`\n✓ “${name}” is kept in ${label} (${files} files).`);
  if (status.held)
    console.log(
      `\n${status.message}\nIf that is intended: ${context.me} host github sync "${name}" --confirm-deletions`,
    );
  if (await context.running())
    console.log(
      'Changes reach GitHub within a minute of being made, and what is pushed there comes back to every device.',
    );
  else
    console.log(
      `The host is not running, so it will not keep in step until it is: ${context.me} host start`,
    );
}

/** `host github …` */
export async function github(context: Context): Promise<void> {
  const { me, where, words, flags } = context;
  const command = words.shift();
  const mirrors = (host: Host) =>
    new Mirrors({
      host,
      dataDir: flags.get('data') ?? where.data,
      account: () => readAccount(where),
    });

  switch (command) {
    case 'login':
      await signIn(context);
      return;
    case 'logout': {
      await rm(where.github, { force: true });
      console.log(
        'Signed out of GitHub on this machine. Notebooks kept there stop syncing until you sign in again.\n' +
          'To withdraw the access entirely, revoke Opsidian at https://github.com/settings/applications',
      );
      return;
    }
    case 'connect':
    case 'import': {
      await gitVersion();
      // `connect "Name" [repo]` keeps a notebook in a repository; `import repo ["Name"]` makes a
      // notebook from one and invites a device to it.
      const importing = command === 'import';
      const [first, second] = importing ? [words[1], words[0]] : [words[0], words[1]];
      if (importing && !second) fail(`Say which repository: ${me} host github import you/notes`);
      const known = await context.withHost((host) => host.notebooks().map((each) => each.name));
      const typedName =
        first ??
        (importing
          ? (parseRepository(second!).fullName?.split('/')[1] ?? 'Notes')
          : known.length === 1
            ? known[0]
            : fail(`Say which notebook: ${me} host github connect "Personal"`));
      const name = typedName!;
      const destination = await target(context, second, repositoryName(name));
      const fresh = !known.includes(name);
      console.log(
        fresh
          ? `\nMaking “${name}” from ${destination.label}…`
          : destination.empty
            ? `\nSending “${name}” to ${destination.label}…`
            : `\nJoining “${name}” and ${destination.label}…`,
      );
      if (!fresh && !destination.empty && interactive() && !flags.has('yes') && !flags.has('y')) {
        const answer = await ask(
          `Both already have notes. They will be combined, and any note that differs is kept twice. Continue? [Y/n] `,
        );
        if (/^n/i.test(answer)) return;
      }
      const status = await context.withHost((host) => mirrors(host).connect(name, destination.url));
      await showResult(context, name, destination.label, status);
      if (importing) {
        console.log('');
        await context.invite(name);
      }
      return;
    }
    case 'sync': {
      const name = words.join(' ');
      const all = await context.withHost((host) => host.mirrors());
      const chosen = name ? all.filter((each) => each.name === name) : all;
      if (!chosen.length)
        fail(name ? `“${name}” is not kept on GitHub.` : 'No notebook is kept on GitHub yet.');
      for (const record of chosen) {
        const status = await context.withHost((host) =>
          mirrors(host).sync(record.name, flags.has('confirm-deletions')),
        );
        console.log(`${record.name} → ${repositoryLabel(record.remote)}  ${statusLine(status)}`);
      }
      return;
    }
    case 'disconnect': {
      const name =
        words.join(' ') || fail(`Say which notebook: ${me} host github disconnect "Personal"`);
      await context.withHost((host) => mirrors(host).disconnect(name));
      console.log(
        `“${name}” is no longer kept on GitHub. The repository and the notebook both stay as they are.`,
      );
      return;
    }
    case undefined:
    case 'status': {
      const signedIn = await readAccount(where);
      const all = await context.withHost((host) => host.mirrors());
      console.log(
        signedIn
          ? `Signed in to GitHub as ${signedIn.login}`
          : `Not signed in to GitHub. ${me} host github login`,
      );
      if (!all.length)
        console.log(`No notebook is kept on GitHub yet. ${me} host github connect "Personal"`);
      for (const record of all)
        console.log(
          `  ${record.name} → ${repositoryLabel(record.remote)}  ${statusLine(record.status)}`,
        );
      return;
    }
    default:
      fail(`${me} host github has: login, connect, import, sync, disconnect, logout`);
  }
}
