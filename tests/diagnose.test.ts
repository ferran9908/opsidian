import { describe, expect, it } from 'vitest';
import { diagnose, onTailscale } from '../packages/sync/src/index';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** A host that answers as told, and remembers what it was asked. */
function host(answers: { root?: () => Response; whoami?: () => Response }) {
  const asked: string[] = [];
  const request = (async (url: string) => {
    const path = new URL(url).pathname;
    asked.push(path);
    const answer = path === '/v1' ? answers.root : answers.whoami;
    if (!answer) throw new TypeError('fetch failed');
    return answer();
  }) as unknown as typeof fetch;
  return { asked, request };
}
const online = async () => true;
const states = (checks: { state: string }[]) => checks.map((check) => check.state);

describe('the connection check', () => {
  it('knows a Tailscale address when it sees one', () => {
    expect(onTailscale('http://100.119.32.51:4810')).toBe(true);
    expect(onTailscale('100.64.0.1:4810')).toBe(true);
    expect(onTailscale('https://mac.tail1234.ts.net')).toBe(true);
    expect(onTailscale('http://100.128.0.1:4810')).toBe(false);
    expect(onTailscale('192.168.1.4:4810')).toBe(false);
    expect(onTailscale('not a host')).toBe(false);
  });

  it('passes every step when the host answers and accepts the device', async () => {
    const { request, asked } = host({
      root: () => json({ opsidian: 'host', protocol: 1 }),
      whoami: () => json({ device: 'Mac', notebook: 'Notes' }),
    });
    const checks = await diagnose('http://192.168.1.4:4810/', 'token', {
      device: 'this Mac',
      online,
      request,
    });
    expect(states(checks)).toEqual(['ok', 'ok', 'ok']);
    expect(asked).toEqual(['/v1', '/v1/whoami']);
    expect(checks[0]!.title).toBe('This Mac is online');
  });

  it('stops at an unreachable host and points at Tailscale when the address is one', async () => {
    const { request, asked } = host({});
    const tailscale = await diagnose('http://100.119.32.51:4810', 'token', {
      device: 'this iPhone',
      online,
      request,
    });
    expect(states(tailscale)).toEqual(['ok', 'failed', 'skipped']);
    expect(tailscale[1]).toMatchObject({ tailscale: true });
    expect(tailscale[1]!.detail).toContain('Tailscale is on');
    // The device's credential is never sent to something that has not proved to be a host.
    expect(asked).toEqual(['/v1']);
    const home = await diagnose('http://192.168.1.4:4810', 'token', {
      device: 'this iPhone',
      online,
      request,
    });
    expect(home[1]!.tailscale).toBeUndefined();
    expect(home[1]!.detail).toContain('same network');
  });

  it('does not hand the credential to something that is not a host', async () => {
    const { request, asked } = host({ root: () => json({ router: 'admin page' }) });
    const checks = await diagnose('http://192.168.1.1', 'token', {
      device: 'this Mac',
      online,
      request,
    });
    expect(states(checks)).toEqual(['ok', 'failed', 'skipped']);
    expect(checks[1]!.title).toContain('not an Opsidian host');
    expect(asked).toEqual(['/v1']);
  });

  it('says when the host has stopped accepting the device, or its credential is gone', async () => {
    const refused = host({
      root: () => json({ opsidian: 'host' }),
      whoami: () => json({ error: 'no' }, 401),
    });
    const removed = await diagnose('http://host:4810', 'token', {
      device: 'this Mac',
      online,
      request: refused.request,
    });
    expect(states(removed)).toEqual(['ok', 'ok', 'failed']);
    expect(removed[2]!.detail).toContain('new invitation');
    const lost = await diagnose('http://host:4810', undefined, {
      device: 'this Mac',
      online,
      request: refused.request,
    });
    expect(states(lost)).toEqual(['ok', 'ok', 'failed']);
    expect(lost[2]!.title).toContain('lost its connection details');
  });

  it('reports being offline, but still tries a host that may be on the same Wi-Fi', async () => {
    const offline = async () => false;
    const down = await diagnose('http://192.168.1.4:4810', 'token', {
      device: 'this iPhone',
      online: offline,
      request: host({}).request,
    });
    expect(states(down)).toEqual(['failed', 'failed', 'skipped']);
    expect(down[0]!.detail).toContain('Wi-Fi');
    const reachable = await diagnose('http://192.168.1.4:4810', 'token', {
      device: 'this iPhone',
      online: offline,
      request: host({ root: () => json({ opsidian: 'host' }), whoami: () => json({}) }).request,
    });
    expect(states(reachable)).toEqual(['ok', 'ok', 'ok']);
  });

  it('gives up on a host that never answers', async () => {
    const request = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      )) as unknown as typeof fetch;
    const checks = await diagnose('http://host:4810', 'token', {
      device: 'this Mac',
      online,
      request,
      timeout: 30,
    });
    expect(states(checks)).toEqual(['ok', 'failed', 'skipped']);
  });
});
