/**
 * Shared pages reach the internet through Tailscale Funnel: Tailscale terminates HTTPS on
 * `https://machine.tailnet.ts.net` and hands requests under `/s` to the host. Nothing else of
 * the host is published; the host itself still listens only on its Tailscale address, and the
 * sync routes stay off the internet.
 *
 * Funnel is Tailscale's own feature, turned on with its command line. The tailnet has to allow
 * it once, in Tailscale's admin console; the command says so, with a link, when it does not.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Where shared pages are mounted, on the machine's Funnel address. */
export const SHARE_PATH = '/s';

/** The Tailscale command line, wherever this machine keeps it. */
export function tailscaleBinary(platform = process.platform): string | undefined {
  const candidates =
    platform === 'darwin'
      ? [
          '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
          '/usr/local/bin/tailscale',
          '/opt/homebrew/bin/tailscale',
        ]
      : ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/usr/sbin/tailscale'];
  return candidates.find((path) => existsSync(path));
}

export interface FunnelState {
  /** `https://machine.tailnet.ts.net`, the address shared pages have. */
  base: string;
  /** Whether Funnel currently hands `/s` on to something. */
  on: boolean;
}

class FunnelError extends Error {}

function explain(reason: unknown): never {
  const text = reason instanceof Error ? reason.message : String(reason);
  const stderr = (reason as { stderr?: string }).stderr ?? '';
  const all = `${stderr}\n${text}`;
  if (/Funnel (is )?not (available|enabled)|funnel.*(attribute|policy|admin)/i.test(all)) {
    const link = /https:\/\/\S+/.exec(all)?.[0];
    throw new FunnelError(
      'Your tailnet does not allow Funnel yet. Turn it on once in Tailscale’s admin console' +
        (link ? `: ${link}` : ' (Access controls → add the “funnel” node attribute).'),
    );
  }
  if (/not logged in|Logged out|NeedsLogin/i.test(all))
    throw new FunnelError('Tailscale is not signed in on this machine.');
  if (/HTTPS.*(not enabled|disabled)|MagicDNS/i.test(all))
    throw new FunnelError(
      'Funnel needs HTTPS certificates and MagicDNS turned on for your tailnet, in Tailscale’s DNS settings.',
    );
  throw new FunnelError(stderr.trim() || text);
}

/** What `tailscale status --json` says about this machine, as far as Funnel needs. */
export interface TailscaleStatus {
  BackendState?: string;
  Self?: { ID?: string; DNSName?: string; CapMap?: Record<string, unknown> | null };
}

/**
 * Checks that this machine can serve Funnel, from Tailscale's status, and says exactly what
 * is missing otherwise. Tailscale's own command would print the same and then wait for it to
 * be put right, which a host cannot do; this tells instead.
 */
export function readyFor(status: TailscaleStatus): string {
  if (status.BackendState && status.BackendState !== 'Running')
    throw new FunnelError(
      status.BackendState === 'NeedsLogin'
        ? 'Tailscale is not signed in on this machine.'
        : 'Tailscale is not running on this machine.',
    );
  const name = status.Self?.DNSName?.replace(/\.$/, '');
  if (!name || !/\.ts\.net$/.test(name))
    throw new FunnelError(
      'This machine has no tailnet name. Turn on MagicDNS for your tailnet in Tailscale’s DNS settings.',
    );
  const can = status.Self?.CapMap ?? {};
  if (!('https' in can))
    throw new FunnelError(
      'HTTPS certificates are not turned on for your tailnet. Turn them on under DNS in Tailscale’s admin console: https://login.tailscale.com/admin/dns',
    );
  if (!('funnel' in can))
    throw new FunnelError(
      'Your tailnet does not allow Funnel yet. Allow it once for this machine, then run this again: ' +
        `https://login.tailscale.com/f/funnel?node=${status.Self?.ID ?? ''}`,
    );
  return name;
}

/** The machine's name on its tailnet, as Tailscale serves it: `machine.tailnet.ts.net`. */
export async function funnelHost(binary: string): Promise<string> {
  let status: TailscaleStatus;
  try {
    status = JSON.parse(
      (await run(binary, ['status', '--json'], { timeout: 20_000 })).stdout,
    ) as TailscaleStatus;
  } catch (reason) {
    explain(reason);
  }
  return readyFor(status);
}

/** Whether Funnel hands `/s` on right now, and where that is. */
export async function funnelState(binary: string): Promise<FunnelState> {
  const name = await funnelHost(binary);
  let text = '';
  try {
    text = (await run(binary, ['funnel', 'status', '--json'], { timeout: 20_000 })).stdout;
  } catch {
    // An older Tailscale without the flag; the state is read again after it is set.
  }
  // Tailscale's serve configuration: handlers under `Web["name:443"]`, and `AllowFunnel`.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const handled = new RegExp(`"${escaped}:443"\\s*:\\s*\\{[\\s\\S]*?"${SHARE_PATH}"`).test(text);
  const allowed = new RegExp(`"AllowFunnel"[\\s\\S]*?"${escaped}:443"\\s*:\\s*true`).test(text);
  return { base: `https://${name}`, on: handled && allowed };
}

/**
 * Publishes the host's shared pages on the internet: `https://machine.tailnet.ts.net/s/…`
 * reaches `http://<address>:<port>/s/…` here. `--bg` keeps it so across restarts.
 */
export async function funnelOn(binary: string, target: string): Promise<FunnelState> {
  const base = `https://${await funnelHost(binary)}`;
  try {
    await run(binary, [
      'funnel',
      '--bg',
      '--yes',
      '--https=443',
      `--set-path=${SHARE_PATH}`,
      target,
    ]);
  } catch (reason) {
    explain(reason);
  }
  return { base, on: true };
}

/** Takes the shared pages off the internet again. Anything else Funnel serves is left alone. */
export async function funnelOff(binary: string): Promise<void> {
  try {
    await run(binary, ['funnel', '--https=443', `--set-path=${SHARE_PATH}`, 'off'], {
      timeout: 60_000,
    });
  } catch (reason) {
    const text = `${(reason as { stderr?: string }).stderr ?? ''}${(reason as Error).message}`;
    // Already off, or Tailscale is not here any more: either way, nothing is served.
    if (!/not (found|configured|exist)|no such|nothing/i.test(text)) explain(reason);
  }
}

/** What Funnel should proxy to, for a host listening on `address:port`. */
export function funnelTarget(address: string, port: number): string {
  const ip = address === '0.0.0.0' || address === '::' ? '127.0.0.1' : address;
  return `http://${ip}:${port}${SHARE_PATH}`;
}
