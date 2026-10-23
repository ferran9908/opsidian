import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Place } from './home';

const run = promisify(execFile);
export const LABEL = 'sh.ferran.opsidian.host';
/** The service's name for one host: the real one keeps the plain name, any other has its tag. */
export const labelOf = (where: Place) => (where.instance ? `${LABEL}.${where.instance}` : LABEL);
export const unitOf = (where: Place) =>
  `opsidian-host${where.instance ? `-${where.instance}` : ''}.service`;

export interface ServiceState {
  running: boolean;
  pid?: number;
}

/**
 * The system's own service manager keeps the host running: launchd on a Mac, systemd on Linux.
 * They start it at login or boot and start it again if it stops, which a process that merely
 * detached from the terminal would not get.
 */
export interface Service {
  /** Where its definition is written. */
  readonly file: string;
  /** What `start` should mention once the host runs, if anything. */
  advice(): Promise<string | undefined>;
  install(): Promise<void>;
  remove(): Promise<void>;
  state(): Promise<ServiceState>;
}

/**
 * Before services were named per folder, every host had the plain name. One defined that way
 * for this very folder is this host's own, from an older version: it is replaced, not left
 * running beside the new one. Anyone else's is left alone.
 */
async function olderOwn(file: string, where: Place): Promise<boolean> {
  if (!where.instance) return false;
  const text = await readFile(file, 'utf8').catch(() => '');
  return (
    text.includes(`Environment=${quote(`OPSIDIAN_HOME=${where.home}`)}`) ||
    text.includes(`<string>${xml(where.home)}</string>`)
  );
}

/** A systemd word: quoted, with its own escapes for `$` and `%`, which it would otherwise expand. */
const quote = (value: string) =>
  `"${value
    .replace(/(["\\])/g, '\\$1')
    .replace(/\$/g, '$$$$')
    .replace(/%/g, '%%')}"`;
const xml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The command the service runs: this Node, the installed copy of the program, `host run`. */
export const command = (where: Place, node = process.execPath) => [
  node,
  where.program,
  'host',
  'run',
];

export function launchdPlist(where: Place, node = process.execPath): string {
  const args = command(where, node)
    .map((each) => `    <string>${xml(each)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${labelOf(where)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OPSIDIAN_HOME</key>
    <string>${xml(where.home)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <!-- Room to send the last changes to GitHub when stopping; the default is 20 seconds. -->
  <key>ExitTimeOut</key>
  <integer>40</integer>
  <key>StandardOutPath</key>
  <string>${xml(where.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(where.log)}</string>
</dict>
</plist>
`;
}

export function systemdUnit(where: Place, system: boolean, node = process.execPath): string {
  return `[Unit]
Description=Opsidian host
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${command(where, node).map(quote).join(' ')}
Environment=${quote(`OPSIDIAN_HOME=${where.home}`)}
Restart=always
RestartSec=5
StandardOutput=append:${where.log}
StandardError=append:${where.log}

[Install]
WantedBy=${system ? 'multi-user.target' : 'default.target'}
`;
}

class Launchd implements Service {
  private readonly target = `gui/${process.getuid!()}`;
  private readonly label: string;
  readonly file: string;
  constructor(private readonly where: Place) {
    this.label = labelOf(where);
    this.file = join(homedir(), 'Library', 'LaunchAgents', `${this.label}.plist`);
  }

  async advice() {
    return undefined;
  }
  private async retireOlder() {
    const older = join(dirname(this.file), `${LABEL}.plist`);
    if (older === this.file || !(await olderOwn(older, this.where))) return;
    await run('launchctl', ['bootout', `${this.target}/${LABEL}`]).catch(() => {});
    await rm(older, { force: true });
  }
  async install() {
    await this.retireOlder();
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, launchdPlist(this.where));
    // Loading it again is how launchd picks up a changed definition or a new program. Unloading
    // finishes after the command returns, and loading before then fails, so it is waited for.
    await run('launchctl', ['bootout', `${this.target}/${this.label}`]).catch(() => {});
    for (let tries = 0; tries < 50 && (await this.loaded()); tries++)
      await new Promise((done) => setTimeout(done, 100));
    await run('launchctl', ['bootstrap', this.target, this.file]);
  }
  private async loaded() {
    return run('launchctl', ['print', `${this.target}/${this.label}`]).then(
      () => true,
      () => false,
    );
  }
  async remove() {
    await this.retireOlder();
    await run('launchctl', ['bootout', `${this.target}/${this.label}`]).catch(() => {});
    // Without its file it does not come back at the next login.
    await rm(this.file, { force: true });
  }
  async state(): Promise<ServiceState> {
    try {
      const { stdout } = await run('launchctl', ['print', `${this.target}/${this.label}`]);
      const pid = Number(stdout.match(/^\s*pid = (\d+)/m)?.[1]);
      return { running: /^\s*state = running/m.test(stdout), ...(pid ? { pid } : {}) };
    } catch {
      return { running: false };
    }
  }
}

class Systemd implements Service {
  private readonly system = process.getuid!() === 0;
  private readonly unit: string;
  readonly file: string;
  private readonly flags = this.system ? [] : ['--user'];
  constructor(private readonly where: Place) {
    this.unit = unitOf(where);
    this.file = this.system
      ? `/etc/systemd/system/${this.unit}`
      : join(homedir(), '.config', 'systemd', 'user', this.unit);
  }

  private readonly user = userInfo().username;

  private ctl(...args: string[]) {
    return run('systemctl', [...this.flags, ...args]);
  }
  private async lingers() {
    const { stdout } = await run('loginctl', ['show-user', this.user, '--property=Linger']).catch(
      () => ({ stdout: '' }),
    );
    return /Linger=yes/.test(stdout);
  }
  async advice() {
    if (this.system || (await this.lingers())) return undefined;
    return `To keep it running after you log out and start it when the server boots, run once:\n  sudo loginctl enable-linger ${this.user}`;
  }
  async install() {
    // A user's services stop when they log out and wait for them to log in after a reboot,
    // unless the user may linger. Most systems let people allow that for themselves.
    if (!this.system && !(await this.lingers()))
      await run('loginctl', ['enable-linger', this.user]).catch(() => {});
    await this.retireOlder();
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, systemdUnit(this.where, this.system));
    await this.ctl('daemon-reload').catch((reason: Error) => {
      if (/connect to bus/i.test(reason.message))
        throw new Error(
          `systemd is not running services for ${this.user} in this shell, which happens after su or sudo -u.\n` +
            `Log in as ${this.user} directly (for example over SSH), or run as root.`,
        );
      throw reason;
    });
    await this.ctl('enable', this.unit);
    await this.ctl('restart', this.unit);
  }
  private async retireOlder() {
    const plain = 'opsidian-host.service';
    const older = join(dirname(this.file), plain);
    if (older === this.file || !(await olderOwn(older, this.where))) return;
    await this.ctl('disable', '--now', plain).catch(() => {});
    await rm(older, { force: true });
  }
  async remove() {
    await this.retireOlder();
    await this.ctl('disable', '--now', this.unit).catch(() => {});
    await rm(this.file, { force: true });
    await this.ctl('daemon-reload').catch(() => {});
  }
  async state(): Promise<ServiceState> {
    const { stdout } = await this.ctl('show', this.unit, '--property=ActiveState,MainPID').catch(
      () => ({
        stdout: '',
      }),
    );
    const pid = Number(stdout.match(/MainPID=(\d+)/)?.[1]);
    return { running: /ActiveState=active/.test(stdout), ...(pid ? { pid } : {}) };
  }
}

/** This machine's service manager, or why there is none to use. */
export function service(where: Place): Service | { missing: string } {
  if (process.platform === 'darwin') return new Launchd(where);
  if (process.platform === 'linux') {
    if (existsSync('/run/systemd/system')) return new Systemd(where);
    return {
      missing:
        'This machine does not run systemd, so the host cannot be set up to run by itself.\n' +
        'Run `opsidian host run` under your own supervisor, or use the Docker image.',
    };
  }
  return { missing: 'Running a host in the background works on macOS and Linux.' };
}
