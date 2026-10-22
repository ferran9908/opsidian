/**
 * Signing in to GitHub and finding a repository, for keeping a notebook there. Shared by the
 * command line and the Mac app; nothing here touches the disk.
 *
 * Sign-in uses GitHub's device flow: the person is shown a short code, enters it on GitHub in
 * any browser, and this side receives a token. It works the same on a server with no browser
 * as on a Mac, and nothing secret is ever typed or pasted.
 */

/** Opsidian's OAuth app on GitHub. Not a secret: the device flow needs only the id. */
export const CLIENT_ID = process.env.OPSIDIAN_GITHUB_CLIENT_ID || 'Ov23liOpsidianPending';
const API = process.env.OPSIDIAN_GITHUB_API || 'https://api.github.com';
const WEB = process.env.OPSIDIAN_GITHUB_WEB || 'https://github.com';

/** Who is signed in, and the token that acts for them. */
export interface GitHubAccount {
  token: string;
  login: string;
  id: number;
  name?: string;
}
export interface Repository {
  /** `owner/name`. */
  fullName: string;
  private: boolean;
  /** Where git fetches and pushes it. */
  url: string;
  /** Whether it has no commits yet. */
  empty: boolean;
  pushedAt?: string;
  canPush: boolean;
}
export interface DeviceCode {
  /** What the person types on GitHub, such as `WDJB-MJHT`. */
  code: string;
  /** Where they type it. */
  url: string;
  /** Kept by this side to collect the token. */
  device: string;
  interval: number;
  expires: number;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;

async function form(request: Fetch, path: string, body: Record<string, string>) {
  const response = await request(`${WEB}${path}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok && !answer.error)
    throw new GitHubError(`GitHub answered ${response.status}.`, response.status);
  return answer;
}

/** Asks GitHub for a code to show the person. */
export async function startSignIn(request: Fetch = fetch): Promise<DeviceCode> {
  const answer = await form(request, '/login/device/code', {
    client_id: CLIENT_ID,
    scope: 'repo',
  });
  if (answer.error)
    throw new GitHubError(
      answer.error === 'device_flow_disabled' ||
        answer.error === 'unauthorized_client' ||
        answer.error === 'Not Found'
        ? 'GitHub sign-in is not set up for this copy of Opsidian.'
        : String(answer.error_description ?? answer.error),
    );
  return {
    code: answer.user_code as string,
    url: answer.verification_uri as string,
    device: answer.device_code as string,
    interval: Number(answer.interval) || 5,
    expires: Date.now() + (Number(answer.expires_in) || 900) * 1000,
  };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new GitHubError('Signing in was cancelled.'));
    });
  });

/** Waits until the person has entered the code on GitHub, and returns who they are. */
export async function finishSignIn(
  started: DeviceCode,
  options: { signal?: AbortSignal; request?: Fetch } = {},
): Promise<GitHubAccount> {
  const request = options.request ?? fetch;
  let interval = started.interval;
  while (Date.now() < started.expires) {
    await sleep(interval * 1000, options.signal);
    const answer = await form(request, '/login/oauth/access_token', {
      client_id: CLIENT_ID,
      device_code: started.device,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }).catch((error: unknown) => {
      // A dropped connection while waiting is only a reason to ask again.
      if (error instanceof GitHubError) throw error;
      return { error: 'authorization_pending' } as Record<string, unknown>;
    });
    if (typeof answer.access_token === 'string') return account(answer.access_token, request);
    if (answer.error === 'authorization_pending') continue;
    if (answer.error === 'slow_down') {
      interval = Number(answer.interval) || interval + 5;
      continue;
    }
    if (answer.error === 'access_denied')
      throw new GitHubError('Signing in was cancelled on GitHub.');
    if (answer.error === 'expired_token') break;
    throw new GitHubError(String(answer.error_description ?? answer.error));
  }
  throw new GitHubError('The code expired before it was entered. Try again.');
}

async function api<T>(
  token: string,
  path: string,
  init: RequestInit = {},
  request: Fetch = fetch,
): Promise<T> {
  const response = await request(`${API}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  const body = (await response.json().catch(() => undefined)) as
    (T & { message?: string; errors?: { message?: string }[] }) | undefined;
  if (response.status === 401)
    throw new GitHubError('GitHub no longer accepts this sign-in. Sign in again.', 401);
  if (!response.ok)
    throw new GitHubError(
      body?.errors?.[0]?.message ?? body?.message ?? `GitHub answered ${response.status}.`,
      response.status,
    );
  return body as T;
}

/** The account a token belongs to. */
export async function account(token: string, request: Fetch = fetch): Promise<GitHubAccount> {
  const user = await api<{ login: string; id: number; name?: string | null }>(
    token,
    '/user',
    {},
    request,
  );
  return { token, login: user.login, id: user.id, ...(user.name ? { name: user.name } : {}) };
}

interface RawRepository {
  full_name: string;
  private: boolean;
  clone_url: string;
  size: number;
  pushed_at?: string | null;
  created_at?: string;
  permissions?: { push?: boolean };
}
const repository = (raw: RawRepository): Repository => ({
  fullName: raw.full_name,
  private: raw.private,
  url: raw.clone_url,
  // GitHub sets `pushed_at` at creation; a repository nobody has pushed to has the same time.
  empty: raw.size === 0 && (!raw.pushed_at || raw.pushed_at === raw.created_at),
  ...(raw.pushed_at ? { pushedAt: raw.pushed_at } : {}),
  canPush: raw.permissions?.push !== false,
});

/** Repositories the account can write to, most recently changed first. */
export async function repositories(
  signedIn: GitHubAccount,
  request: Fetch = fetch,
): Promise<Repository[]> {
  const found: Repository[] = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await api<RawRepository[]>(
      signedIn.token,
      `/user/repos?sort=pushed&per_page=100&page=${page}`,
      {},
      request,
    );
    found.push(...batch.map(repository).filter((each) => each.canPush));
    if (batch.length < 100) break;
  }
  return found;
}

/** One repository, by `owner/name`. */
export async function findRepository(
  signedIn: GitHubAccount,
  fullName: string,
  request: Fetch = fetch,
): Promise<Repository> {
  try {
    return repository(await api<RawRepository>(signedIn.token, `/repos/${fullName}`, {}, request));
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404)
      throw new GitHubError(`GitHub has no repository ${fullName} that ${signedIn.login} can see.`);
    throw error;
  }
}

/** Makes a new, private repository on the account. */
export async function createRepository(
  signedIn: GitHubAccount,
  name: string,
  request: Fetch = fetch,
): Promise<Repository> {
  try {
    return repository(
      await api<RawRepository>(
        signedIn.token,
        '/user/repos',
        {
          method: 'POST',
          body: JSON.stringify({
            name,
            private: true,
            description: 'Notes kept by Opsidian',
            has_issues: false,
            has_wiki: false,
            has_projects: false,
          }),
        },
        request,
      ),
    );
  } catch (error) {
    if (error instanceof GitHubError && error.status === 422)
      throw new GitHubError(`${signedIn.login} already has a repository called ${name}.`);
    throw error;
  }
}

/** A repository name made from a notebook's name: `My Notes` becomes `my-notes`. */
export const repositoryName = (notebook: string) =>
  notebook
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 100) || 'notes';

/**
 * Reads what someone typed as a repository: `owner/name`, a GitHub page or clone address,
 * or any other address git understands, which is used as it is.
 */
export function parseRepository(typed: string): { fullName?: string; url: string } {
  const text = typed.trim();
  const short = text.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  const web =
    text.match(
      /^(?:https?:\/\/|git@)(?:www\.)?github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i,
    ) ??
    (text.startsWith(`${WEB}/`)
      ? text.slice(WEB.length).match(/^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/)
      : null);
  const found = short ?? web;
  if (found && !/^\.|^\//.test(text)) {
    const fullName = `${found[1]}/${found[2]}`;
    // An SSH address stays SSH: whoever typed it has keys set up for it.
    return { fullName, url: text.startsWith('git@') ? text : `${WEB}/${fullName}.git` };
  }
  return { url: text };
}

/** Whether git should be given the GitHub sign-in for this address. */
export const isGitHub = (url: string) => url.startsWith(`${WEB}/`);

/** The repository's page, for showing to people. */
export function repositoryLabel(url: string): string {
  const { fullName } = parseRepository(url);
  return fullName ?? url;
}
