import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import qrcode from 'qrcode-generator';

/**
 * Where a host installed with `opsidian host start` keeps everything: its settings, its data,
 * its log, and the copy of the program the service runs. `OPSIDIAN_HOME` moves it, for tests
 * and for Docker.
 */
export function place(home = process.env.OPSIDIAN_HOME || join(homedir(), '.opsidian')) {
  return {
    home,
    config: join(home, 'host.json'),
    data: join(home, 'host'),
    log: join(home, 'host.log'),
    program: join(home, 'bin', 'opsidian.mjs'),
  };
}
export type Place = ReturnType<typeof place>;

export interface Config {
  port: number;
  /** The one address the host listens on, chosen when it was started. */
  address: string;
  backup?: { folder: string; keep: number; hour: number };
  /** The last scheduled backup that did not work, until one does. */
  failed?: { at: number; message: string };
}

export const DEFAULT_PORT = 4810;

export async function readConfig(where: Place): Promise<Config | undefined> {
  try {
    return JSON.parse(await readFile(where.config, 'utf8')) as Config;
  } catch {
    return undefined;
  }
}
export async function writeConfig(where: Place, config: Config): Promise<void> {
  await mkdir(where.home, { recursive: true });
  // Written whole and then moved into place, so a crash never leaves half a file.
  await writeFile(`${where.config}.tmp`, `${JSON.stringify(config, null, 2)}\n`);
  await rename(`${where.config}.tmp`, where.config);
}

export interface Address {
  kind: 'tailscale' | 'network';
  ip: string;
}

/** Tailscale hands out addresses from 100.64.0.0/10. */
export const isTailscale = (ip: string) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);

/**
 * Addresses other devices could use to reach this machine, Tailscale first. Bridges made for
 * containers and virtual machines are left out: no other device can reach them.
 */
export function addresses(): Address[] {
  const found: Address[] = [];
  for (const [name, list] of Object.entries(networkInterfaces()))
    for (const each of list ?? []) {
      if (each.family !== 'IPv4' || each.internal) continue;
      if (isTailscale(each.address)) found.push({ kind: 'tailscale', ip: each.address });
      else if (!/^(docker|br-|veth|virbr|vmnet|bridge|utun|cni|flannel|lxc|tun|wg)/.test(name))
        found.push({ kind: 'network', ip: each.address });
    }
  return found.sort((a, b) => Number(b.kind === 'tailscale') - Number(a.kind === 'tailscale'));
}

/**
 * Which address a new host should listen on. Only Tailscale's, when there is one: the host has
 * no sign-in of its own, so it must not be reachable from the open internet. Without Tailscale
 * a Mac falls back to the home network; a server refuses, since its address is usually public.
 */
export function chooseAddress(
  found: Address[],
  platform: NodeJS.Platform,
): { ip: string; note?: string } | { error: string } {
  const tailscale = found.find((each) => each.kind === 'tailscale');
  if (tailscale) return { ip: tailscale.ip };
  const network = found.find((each) => each.kind === 'network');
  if (platform === 'darwin' && network)
    return {
      ip: network.ip,
      note: 'Tailscale is not running, so only devices on this network can sync. Install Tailscale to sync from anywhere.',
    };
  return {
    error:
      'Tailscale is not running on this machine. The host has no sign-in of its own, so it only listens on a Tailscale address.\n' +
      'Install Tailscale (https://tailscale.com/download) and start again, or choose an address yourself with --address.',
  };
}

/** The address a device should be given: the one listened on, or the best one when that is all of them. */
export function reachableAt(config: Pick<Config, 'address' | 'port'>, found = addresses()): string {
  const ip = config.address === '0.0.0.0' ? (found[0]?.ip ?? '127.0.0.1') : config.address;
  return `${ip}:${config.port}`;
}

export const invitationLink = (address: string, code: string) =>
  `opsidian://connect?host=${encodeURIComponent(address)}&code=${encodeURIComponent(code)}`;

/**
 * A QR code drawn with half blocks, two rows of modules to a line. The colours are set
 * explicitly, black on white, so a phone can read it whatever the terminal's theme.
 */
export function drawQr(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  const quiet = 2;
  const dark = (y: number, x: number) =>
    y >= 0 && x >= 0 && y < size && x < size && qr.isDark(y, x);
  const lines: string[] = [];
  for (let y = -quiet; y < size + quiet; y += 2) {
    let line = '';
    for (let x = -quiet; x < size + quiet; x++) {
      const top = dark(y, x);
      const bottom = dark(y + 1, x);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(`\x1b[30;47m${line}\x1b[0m`);
  }
  return lines.join('\n');
}
