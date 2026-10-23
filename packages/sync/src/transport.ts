import {
  Moved,
  Unauthorized,
  type Changes,
  type Op,
  type OpResult,
  type Pairing,
  type RemoteFile,
  type Transport,
} from './protocol';

type Fetch = typeof fetch;
const trim = (host: string) => host.replace(/\/+$/, '');

async function fail(response: Response): Promise<never> {
  if (response.status === 401) throw new Unauthorized();
  const body = (await response.json().catch(() => undefined)) as
    { error?: string; moved?: unknown } | undefined;
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
