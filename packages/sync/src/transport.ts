import {
  Moved,
  Unauthorized,
  type Changes,
  type GitHubCopy,
  type NoteShare,
  type Op,
  type OpResult,
  type Pairing,
  type RemoteFile,
  type Transport,
} from './protocol';

type Fetch = typeof fetch;
const trim = (host: string) => host.replace(/\/+$/, '');

async function fail(response: Response): Promise<never> {
  const body = (await response.json().catch(() => undefined)) as
    { error?: string; moved?: unknown } | undefined;
  if (response.status === 401) throw new Unauthorized(body?.error);
  if (response.status === 410 && typeof body?.moved === 'string') throw new Moved(body.moved);
  throw new Error(body?.error ?? `The host answered ${response.status}.`);
}

/** Trades a single-use invitation for this device's credential. */
export async function pair(
  host: string,
  code: string,
  device: string,
  request: Fetch = fetch,
): Promise<Pairing> {
  const response = await request(`${trim(host)}/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, device }),
  });
  if (!response.ok) await fail(response);
  return (await response.json()) as Pairing;
}

/**
 * Asks the host to forget this device, as it stops syncing. Resolves to whether the host
 * heard: false when it could not be reached, so it still lists the device until it is
 * removed there. A credential the host already refuses has nothing left to remove.
 */
export async function leave(host: string, token: string, request: Fetch = fetch): Promise<boolean> {
  // Not AbortSignal.timeout, which the iPhone's JavaScript engine lacks.
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 5000);
  try {
    const response = await request(`${trim(host)}/v1/device`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
      signal: stop.signal,
    });
    return response.ok || response.status === 401;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** The host over HTTP. */
export function httpTransport(host: string, token: string, request: Fetch = fetch): Transport {
  const base = `${trim(host)}/v1`;
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await request(base + path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...init.headers },
    });
    if (!response.ok && !(init.method === 'HEAD' && response.status === 404)) await fail(response);
    return response;
  };
  return {
    async changes(since, wait, signal) {
      const response = await call(`/changes?since=${since}&wait=${wait}`, signal ? { signal } : {});
      return (await response.json()) as Changes;
    },
    async push(ops: Op[]) {
      const response = await call('/ops', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops }),
      });
      return ((await response.json()) as { results: OpResult[] }).results;
    },
    hasBlob: async (hash) => (await call(`/blobs/${hash}`, { method: 'HEAD' })).ok,
    getBlob: async (hash) => new Uint8Array(await (await call(`/blobs/${hash}`)).arrayBuffer()),
    async putBlob(hash, bytes) {
      await call(`/blobs/${hash}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes as never,
      });
    },
    async history(file) {
      const response = await call(`/files/${encodeURIComponent(file)}/history`);
      return ((await response.json()) as { versions: RemoteFile[] }).versions;
    },
  };
}

/**
 * The device's notebook's copy on GitHub, or undefined when it is not kept there. With
 * `sync`, the host runs a round of it now, whatever the schedule, and answers once it is done.
 */
export async function github(
  host: string,
  token: string,
  options: { sync?: boolean; request?: Fetch } = {},
): Promise<GitHubCopy | undefined> {
  // Not AbortSignal.timeout, which the iPhone's JavaScript engine lacks. A round sends and
  // fetches the notebook's changes, so it is given longer than a question.
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), options.sync ? 120_000 : 10_000);
  let response: Response;
  try {
    response = await (options.request ?? fetch)(
      `${trim(host)}/v1/github${options.sync ? '/sync' : ''}`,
      {
        method: options.sync ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${token}` },
        signal: stop.signal,
      },
    );
  } catch {
    throw new Error(
      stop.signal.aborted
        ? 'The host took too long to answer. The copy may still finish there.'
        : 'The host could not be reached.',
    );
  } finally {
    clearTimeout(timer);
  }
  // A host from before devices could ask.
  if (response.status === 404)
    throw new Error('The host is too old to sync with GitHub from here. Update it first.');
  if (!response.ok) await fail(response);
  return ((await response.json()) as { copy?: GitHubCopy }).copy;
}

/** A request to the host about shared notes, which a host from before sharing does not know. */
async function sharing(
  host: string,
  token: string,
  path: string,
  init: RequestInit,
  request: Fetch,
): Promise<Response> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 20_000);
  let response: Response;
  try {
    response = await request(`${trim(host)}/v1/shares${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...init.headers },
      signal: stop.signal,
    });
  } catch {
    throw new Error(
      stop.signal.aborted ? 'The host took too long to answer.' : 'The host could not be reached.',
    );
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 404) {
    // Fastify's own answer for a route the host does not have, as opposed to the host's.
    const body = (await response
      .clone()
      .json()
      .catch(() => undefined)) as { error?: unknown } | undefined;
    if (body?.error === 'Not Found')
      throw new Error('The host is too old to share notes. Update it first.');
  }
  if (!response.ok) await fail(response);
  return response;
}

/** The notes this device's notebook shares right now. */
export async function shares(
  host: string,
  token: string,
  request: Fetch = fetch,
): Promise<NoteShare[]> {
  const response = await sharing(host, token, '', {}, request);
  return ((await response.json()) as { shares: NoteShare[] }).shares;
}

/**
 * Asks the host to show a note to anyone with the link, for `hours`, or until stopped when
 * no hours are given. The host serves the note as it has it now, so the device sends its own
 * changes first.
 */
export async function share(
  host: string,
  token: string,
  path: string,
  hours: number | undefined,
  request: Fetch = fetch,
): Promise<NoteShare> {
  const response = await sharing(
    host,
    token,
    '',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, ...(hours ? { hours } : {}) }),
    },
    request,
  );
  return (await response.json()) as NoteShare;
}

/** Stops a shared link working. */
export async function unshare(
  host: string,
  token: string,
  id: string,
  request: Fetch = fetch,
): Promise<void> {
  await sharing(host, token, `/${encodeURIComponent(id)}`, { method: 'DELETE' }, request);
}
