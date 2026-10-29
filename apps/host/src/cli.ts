import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Host, listBackups, restoreBackup, type Moved } from './host';
import {
  addresses,
  chooseAddress,
  defaultPort,
  developing,
  drawQr,
  invitationLink,
  isTailscale,
  parseArgs,
  place,
  productionHome,
  reachableAt,
  readConfig,
  writeConfig,
  type Config,
} from './home';
import { service, type Service } from './service';
import { github, readAccount, statusLine } from './github-cli';
import { repositoryLabel } from './github';
import { Mirrors, scheduleOf } from './mirror';
import { takeOver, type TakeOverProgress } from './move';
import {
  fetchRelease,
  installedVersion,
  latestRelease,
  newer,
  pending,
  rollBack,
  settled,
  swapIn,
} from './update';

const VERSION = process.env.OPSIDIAN_VERSION ?? 'development';
// Said back in messages the way it was typed: from this repository, through npx, or installed.
const me =
  process.env.npm_lifecycle_event === 'start'
    ? 'pnpm'
    : process.env.npm_command === 'exec'
      ? 'npx opsidian'
      : 'opsidian';

const { flags, words } = parseArgs(process.argv.slice(2));

const where = place();
const when = (time: number) => new Date(time).toLocaleString();
const fail = (text: string): never => {
  throw new Error(text);
};
/** A whole number from a flag, or the fallback; anything else is refused before it is saved. */
const whole = (name: string, fallback: number, low: number, high: number): number => {
  const given = flags.get(name);
  if (given === undefined) return fallback;
  const value = Number(given);
  if (!Number.isInteger(value) || value < low || value > high)
    fail(`--${name} takes a whole number from ${low} to ${high}.`);
  return value;
};
/** Where backups go and how, from the flags over what was set before. */
const backupFrom = (folder: string, before?: Config['backup']): NonNullable<Config['backup']> => ({
  folder: resolve(folder),
  keep: whole('keep', before?.keep ?? 14, 1, 1000),
  hour: whole('hour', before?.hour ?? 3, 0, 23),
});
const HELP = `Opsidian ${VERSION}: a host for your notebooks, so every device syncs through it.

  ${me} host start            Run the host in the background, now and after restarts
      [--port 4810] [--address IP] [--backup FOLDER] [--keep 14] [--hour 3]
  ${me} host status           Whether it is running, where, and what it holds
  ${me} host invite "Name"    Let a device join a notebook (a new name makes a new notebook)
  ${me} host devices          Every device, and when it was added
  ${me} host remove DEVICE    Stop a device syncing, by its name or id
  ${me} host notebooks        Every notebook on the host
  ${me} host delete "Name"    Delete a notebook and its history from the host; devices keep
                              their notes. Says what goes first; --yes deletes it
  ${me} host backup FOLDER    Back up every night at 3 to FOLDER, and once now
  ${me} host backup now|off   Back up now, or stop backing up
  ${me} host backups          The backups there are
  ${me} host restore BACKUP   Put the host back to a backup
  ${me} host move             Move this host to another machine: prints what to run there
  ${me} host take-over ADDRESS CODE
                              Make this machine the host, taking everything over from the
                              one at ADDRESS. Devices follow by themselves.
  ${me} host github import you/notes      Make a notebook from a GitHub repository, and invite a device
  ${me} host github connect "Name" [REPO] Keep a notebook in a GitHub repository, both ways
  ${me} host github every 1h              How often notebooks go to GitHub: live, 15m, 1h
                                         (the default), 6h or 24h
  ${me} host github                       How each notebook on GitHub is doing; also login,
                                         sync, disconnect, logout
  ${me} host update           Install the newest version now, if there is one. The host also
                              does it by itself each night; host update auto off stops that
  ${me} host logs [-f]        What the host has been doing
  ${me} host stop             Stop it, and stop it starting by itself
  ${me} host reset            Start over as on a fresh install: every notebook, device, setting and
                              the GitHub sign-in go. Says what goes first; --yes resets
  ${me} host uninstall        Stop it and remove the program; --delete-data removes your notebooks too
  ${me} host run              Run in this terminal instead (for Docker, or to watch it)

Settings, data and the log are in ${where.home}.${
  developing()
    ? `\nThis is a development build, so it keeps its own host there, on port ${defaultPort()},\napart from the real one in ${productionHome()}.`
    : ''
}`;

/** Answers whether an Opsidian host is at an address, quickly. */
async function answers(address: string): Promise<boolean> {
  try {
    const response = await fetch(`http://${address}/v1`, { signal: AbortSignal.timeout(1500) });
    return ((await response.json()) as { opsidian?: string }).opsidian === 'host';
  } catch {
    return false;
  }
}

function needService(): Service {
  const found = service(where);
  if ('missing' in found) return fail(found.missing);
  return found;
}

async function needConfig(): Promise<Config> {
  return (
    (await readConfig(where)) ??
    fail(`No host is set up on this machine. Start one with:\n  ${me} host start`)
  );
}

/** The host's data, opened for a moment to read or change it. It is safe while the host runs. */
async function withHost<T>(work: (host: Host) => T | Promise<T>): Promise<T> {
  const host = new Host({ dataDir: flags.get('data') ?? where.data });
  try {
    return await work(host);
  } finally {
    await host.close();
  }
}

/** The address a device is given. In Docker the host cannot see its own, so it is told. */
async function deviceAddress(): Promise<string> {
  if (process.env.OPSIDIAN_ADDRESS) return process.env.OPSIDIAN_ADDRESS;
  if (existsSync('/.dockerenv'))
    fail(
      'Inside Docker the host cannot see the address devices reach it at.\n' +
        'Run the container with -e OPSIDIAN_ADDRESS=100.x.y.z:4810 (the server’s Tailscale address).',
    );
  const config = await readConfig(where);
  return reachableAt({
    address: flags.get('address') ?? config?.address ?? '0.0.0.0',
    port: whole('port', config?.port ?? defaultPort(), 1, 65535),
  });
}

async function lastLines(count: number): Promise<string> {
  const text = await readFile(where.log, 'utf8').catch(() => '');
  return text.trimEnd().split('\n').slice(-count).join('\n');
}

function backupLine(config: Config): string {
  if (!config.backup) return 'Off';
  const { folder, keep, hour } = config.backup;
  return `Every night at ${String(hour).padStart(2, '0')}:00 to ${folder}, keeping ${keep}`;
}

/**
 * Where this machine's host listens, from the flags over what was set before. An address given
 * with --address is kept until another is given. One chosen here is chosen again each time, so
 * a Mac that fell back to its home network moves to Tailscale once it has it.
 */
async function listening(before: Config | undefined): Promise<{ config: Config; note?: string }> {
  const port = whole('port', before?.port ?? defaultPort(), 1, 65535);
  let address = flags.get('address');
  let manual = address !== undefined || before?.manual === true;
  let note: string | undefined;
  if (address === 'all') {
    address = '0.0.0.0';
    note =
      'The host listens on every address. It has no sign-in of its own: make sure a firewall keeps it off the open internet.';
  } else if (!address) {
    const found = addresses();
    if (
      manual &&
      before &&
      (before.address === '0.0.0.0' || found.some((each) => each.ip === before.address))
    )
      address = before.address;
    else {
      manual = false;
      const chosen = chooseAddress(found, process.platform);
      if ('error' in chosen) return fail(chosen.error);
      address = chosen.ip;
      note = chosen.note;
    }
  }

  const config: Config = { ...before, port, address };
  if (manual) config.manual = true;
  else delete config.manual;
  const folder = flags.get('backup');
  if (folder) config.backup = backupFrom(folder, before?.backup);
  else if (flags.has('keep') || flags.has('hour'))
    config.backup = backupFrom(
      before?.backup?.folder ?? fail('--keep and --hour go with --backup FOLDER.'),
      before?.backup,
    );
  return { config, ...(note ? { note } : {}) };
}

/** Fails if something other than this machine's own host already answers where it will listen. */
async function portFree(manager: Service, before: Config | undefined, config: Config) {
  // Something already answering, while ours is not running, is another host: most likely the
  // Opsidian app on this Mac.
  const moving =
    !(await manager.state()).running ||
    before?.port !== config.port ||
    before.address !== config.address;
  if (moving && (await answers(reachableAt(config))))
    fail(
      `Another Opsidian host is already using port ${config.port} here, perhaps the Opsidian app.\n` +
        `Turn hosting off there, or start this one with --port ${config.port + 1}.`,
    );
}

/** Hands the host to the service manager and waits until it answers. */
async function launch(manager: Service, config: Config): Promise<void> {
  // The service runs a copy of this program kept beside the data. npx keeps what it fetches in a
  // cache that can be cleared, so the copy is what keeps the host independent of it.
  const self = fileURLToPath(import.meta.url);
  if (self !== where.program) {
    await mkdir(dirname(where.program), { recursive: true });
    await copyFile(self, where.program);
  }
  await writeConfig(where, config);
  await manager.install();

  const reach = reachableAt(config);
  const by = Date.now() + 15_000;
  while (!(await answers(reach))) {
    if (Date.now() > by)
      fail(
        `The host did not start. The end of its log:\n\n${await lastLines(15)}\n\n` +
          `The rest is in ${where.log}.`,
      );
    await new Promise((done) => setTimeout(done, 300));
  }
}

const kindOf = (config: Config) =>
  isTailscale(config.address)
    ? '(Tailscale only)'
    : config.address === '0.0.0.0'
      ? '(every address)'
      : '(this network only)';

async function start(): Promise<void> {
  const manager = needService();
  const before = await readConfig(where);
  const { config, note } = await listening(before);
  await portFree(manager, before, config);
  await launch(manager, config);

  // Without it, a Linux user's service stops at logout and does not come back after a reboot.
  const advice = await manager.advice();
  console.log(
    [
      '✓ Opsidian host is running in the background',
      `  Address    http://${reachableAt(config)}   ${kindOf(config)}`,
      `  Data       ${where.data}`,
      `  Backups    ${backupLine(config)}`,
      `  Logs       ${me} host logs`,
      advice
        ? '  Runs until you log out, for now (see below).'
        : '  Starts by itself when this machine restarts.',
    ].join('\n'),
  );
  for (const extra of [note, advice]) if (extra) console.log(`\n${extra}`);
  console.log(`\nNext: ${me} host invite "Personal"`);
}

/** Which devices have heard where the host went, for `status` and `move` on the old host. */
function movedLines(moved: Moved): string[] {
  const told = moved.devices.filter((each) => each.told);
  const waiting = moved.devices.filter((each) => !each.told);
  const name = (device: Moved['devices'][number]) =>
    `${device.name}${device.seen ? ` (last seen ${when(device.seen)})` : ''}`;
  return [
    `→ Moved to ${moved.to} on ${when(moved.at)}. This machine only points devices there now.`,
    `  Followed   ${told.map((each) => each.name).join(', ') || 'none yet'}`,
    ...(waiting.length
      ? [
          `  Not yet    ${waiting.map(name).join(', ')}`,
          '             Each follows the next time it syncs, while this machine is still here to tell it.',
        ]
      : [`  Every device has followed. Stop this one with: ${me} host stop`]),
  ];
}

async function status(): Promise<void> {
  const config = await needConfig();
  const manager = service(where);
  const state = 'missing' in manager ? { running: false } : await manager.state();
  const reach = reachableAt(config);
  const answering = state.running && (await answers(reach));
  const version = (await installedVersion(where)) ?? VERSION;
  const { notebooks, devices, mirrors, schedule, moved } = await withHost((host) => ({
    notebooks: host.notebooks(),
    devices: host.devices().filter((device) => !device.revoked),
    mirrors: host.mirrors(),
    schedule: scheduleOf(host),
    moved: host.moved(),
  }));
  if (moved) {
    console.log(
      [
        ...movedLines(moved),
        answering ? `  Still running here, at http://${reach}` : '  Stopped here.',
        `  Data       ${where.data} (an old copy, as it was when the host moved)`,
      ].join('\n'),
    );
    return;
  }
  let backups = backupLine(config);
  if (config.backup) {
    const latest = (await listBackups(config.backup.folder).catch(() => []))[0];
    backups += `\n             Last: ${latest ? when(latest.at) : 'none yet'}`;
    if (config.failed)
      backups += `\n             Failed ${when(config.failed.at)}: ${config.failed.message}`;
  }
  console.log(
    [
      answering
        ? `✓ Running${state.pid ? ` (process ${state.pid})` : ''}`
        : state.running
          ? `… Starting, or failing to start. See ${me} host logs`
          : `✗ Stopped. Start it with ${me} host start`,
      `  Address    http://${reach}`,
      `  Version    ${version}`,
      `  Updates    ${existsSync(where.program) ? updatesLine(config) : 'Not here: this host is not run from an installed copy'}`,
      `  Notebooks  ${notebooks.map((each) => `${each.name} (${each.files} files)`).join(', ') || 'none yet'}`,
      `  Devices    ${devices.length}`,
      `  Backups    ${backups}`,
      ...mirrors.map(
        (record, at) =>
          `  ${at ? '          ' : 'GitHub   '}  ${record.name} → ${repositoryLabel(record.remote)}  ${statusLine(record.status, schedule, { running: answering })}`,
      ),
      `  Data       ${where.data}`,
    ].join('\n'),
  );
}

async function invite(name = words.join(' ') || 'Personal'): Promise<void> {
  const minutes = Number(flags.get('minutes') ?? 15);
  const { code, expires } = await withHost((host) => host.invite(name, minutes));
  const address = await deviceAddress();
  const link = invitationLink(address, code);
  if (process.stdout.isTTY) console.log(`\n${drawQr(link)}\n`);
  console.log(
    [
      `Invitation to “${name}”. Scan it with the Opsidian app, or type:`,
      `  Address  ${address}`,
      `  Code     ${code}`,
      `Works once, until ${when(expires)}.`,
    ].join('\n'),
  );
}

/** Backs up now, or sets where backups go and when, as asked. */
async function backup(): Promise<void> {
  const [what] = words;
  if (!what) fail(`Say where: ${me} host backup FOLDER, or ${me} host backup now`);
  const config = await readConfig(where);
  if (what === 'off') {
    if (config) {
      delete config.backup;
      delete config.failed;
      await writeConfig(where, config);
    }
    return console.log('Backups are off.');
  }
  let target = config?.backup;
  if (what !== 'now') {
    target = backupFrom(what!, target);
    // A host set up with `start` takes up the schedule; one run some other way backs up once.
    if (config) {
      await writeConfig(where, { ...config, backup: target });
      console.log(`Backing up: ${backupLine({ ...config, backup: target })}.`);
    }
  }
  if (!target) return fail(`Say where first: ${me} host backup FOLDER`);
  const made = await withHost((host) => host.backup(target.folder, target.keep));
  console.log(`Backed up ${made.notebooks.length} notebook(s) as ${made.name}.`);
}

async function restore(): Promise<void> {
  const config = await readConfig(where);
  const name = words.at(-1);
  const folder = words.length > 1 ? resolve(words[0]!) : config?.backup?.folder;
  if (!name || !folder)
    return fail(`Say which: ${me} host restore BACKUP, or restore FOLDER BACKUP`);
  const data = flags.get('data') ?? where.data;
  const found = service(where);
  const manager = 'missing' in found ? undefined : found;
  const managed = (await manager?.state())?.running === true;
  // A host this program does not manage, such as `host run` in Docker or a terminal, must be
  // stopped by whoever started it: its data is about to be replaced underneath it.
  const port = config?.port ?? defaultPort();
  const live = [`127.0.0.1:${port}`, ...(config ? [reachableAt(config)] : [])];
  if (!managed && (await Promise.all(live.map(answers))).some(Boolean))
    fail('The host is running. Stop it first (Ctrl+C, or docker stop), then restore.');
  if (managed) await manager!.remove();
  try {
    // What the host holds now is backed up first, so a restore can itself be undone. Nothing is
    // pruned by this copy, so it can never push out the backup being restored.
    if (existsSync(join(data, 'host.sqlite'))) {
      const keep = (await listBackups(folder)).length + 1;
      const safety = await withHost((host) => host.backup(folder, keep));
      console.log(`Backed up what the host held first, as ${safety.name}.`);
    }
    await restoreBackup(data, folder, name);
    console.log('Restored. Devices catch up by themselves.');
  } finally {
    if (managed) await manager!.install();
  }
}

/** Says what deleting a notebook takes away; with --yes, backs the host up and deletes it. */
async function deleteNotebook(): Promise<void> {
  const name = words.join(' ').trim();
  if (!name) return fail(`Say which: ${me} host delete "Name". ${me} host notebooks lists them.`);
  const found = await withHost((host) => {
    const notebook = host.findNotebook(name);
    if (!notebook) return undefined;
    const mirror = host.mirrors().find((each) => each.notebook === notebook.id);
    const devices = host
      .devices()
      .filter((each) => !each.revoked && each.notebook === notebook.name)
      .filter((each) => each.id !== mirror?.device);
    return { notebook, devices, mirror };
  });
  if (!found)
    return fail(`There is no notebook called “${name}” here. ${me} host notebooks lists them.`);
  const { notebook, devices, mirror } = found;
  const config = await readConfig(where);
  if (!flags.has('yes') && !flags.has('y')) {
    const megabytes = (notebook.bytes / 1024 / 1024).toFixed(1);
    const many = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;
    console.log(
      [
        `Deleting “${notebook.name}” takes from this host:`,
        `  ${many(notebook.files, 'file')}, and their whole history: ${many(notebook.versions, 'version')}, ${megabytes} MB`,
        devices.length
          ? `  ${devices.map((each) => each.name).join(', ')}, which stop syncing it and keep the notes they have`
          : '  No device syncs it now.',
        ...(mirror
          ? [`  Its copy on GitHub, which stops. ${repositoryLabel(mirror.remote)} stays as it is.`]
          : []),
        config?.backup
          ? `The host is backed up first, to ${config.backup.folder}; restoring that backup brings it back.`
          : 'Backups are off, so it cannot be brought back.',
        '',
        `To delete it: ${me} host delete "${notebook.name}" --yes`,
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }
  if (config?.backup) {
    const { folder, keep } = config.backup;
    const made = await withHost((host) => host.backup(folder, keep)).catch((reason: unknown) =>
      fail(
        `Nothing was deleted: the backup made first failed. ${(reason as Error).message}\n` +
          `Fix that and try again, or turn backups off with: ${me} host backup off`,
      ),
    );
    console.log(`Backed up the host first, as ${made.name}.`);
  }
  await withHost((host) =>
    new Mirrors({
      host,
      dataDir: flags.get('data') ?? where.data,
      account: () => readAccount(where),
    }).deleteNotebook(notebook.name),
  );
  console.log(
    `Deleted “${notebook.name}” from the host. Devices that synced it keep their notes, and are told it was deleted.`,
  );
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
/** The hour new versions are looked for each night. */
const updateHour = (config: Config | undefined) => config?.update?.hour ?? 4;
const clock = (hour: number) => `${String(hour).padStart(2, '0')}:00`;
/** Remembers a version that would not install or start, so it is not tried again. */
async function updateFailed(version: string, message: string): Promise<void> {
  const now = await readConfig(where);
  if (now)
    await writeConfig(where, {
      ...now,
      update: { ...now.update, failed: { version, at: Date.now(), message } },
    });
}
function updatesLine(config: Config): string {
  const update = config.update;
  let line =
    update?.auto === false
      ? `Off. Update with: ${me} host update`
      : `By itself, each night at ${clock(updateHour(config))}${update?.checked ? `; last looked ${when(update.checked)}` : ''}`;
  if (update?.failed)
    line += `\n             ${update.failed.version} did not install on ${when(update.failed.at)}: ${update.failed.message}`;
  return line;
}

/** Installs the newest version from npm, or turns installing by itself on or off. */
async function update(): Promise<void> {
  const config = await needConfig();
  const [what, value] = words;
  if (what === 'auto') {
    if (value !== 'on' && value !== 'off')
      return fail(`Say which: ${me} host update auto on, or ${me} host update auto off`);
    await writeConfig(where, { ...config, update: { ...config.update, auto: value === 'on' } });
    return console.log(
      value === 'on'
        ? `The host installs new versions by itself, each night at ${clock(updateHour(config))}.`
        : `The host no longer updates by itself. Update it with: ${me} host update`,
    );
  }
  if (what)
    return fail(
      `${me} host update installs the newest version; auto on|off sets whether it does so by itself.`,
    );
  if (!existsSync(where.program))
    return fail(
      `This host does not run from ${where.program}, so it cannot be updated here.\n` +
        `In Docker, pull the new image. Otherwise set it up with: ${me} host start`,
    );
  const current = (await installedVersion(where)) ?? 'unknown';
  const release = await latestRelease();
  if (!newer(release.version, current))
    return console.log(`Up to date: ${current} is the newest version.`);
  console.log(`Updating from ${current} to ${release.version}…`);
  const next = await fetchRelease(where, release).catch(async (reason: Error) => {
    await updateFailed(release.version, reason.message);
    return fail(`Nothing was changed. ${reason.message}`);
  });
  if (config.backup) {
    const { folder, keep } = config.backup;
    const made = await withHost((host) => host.backup(folder, keep)).catch(
      async (reason: unknown) => {
        await rm(next, { force: true });
        return fail(
          `Nothing was changed: the backup made first failed. ${(reason as Error).message}`,
        );
      },
    );
    console.log(`Backed up the host first, as ${made.name}.`);
  }
  const found = service(where);
  const manager = 'missing' in found ? undefined : found;
  const running = (await manager?.state())?.running === true;
  await swapIn(where, next, { from: current, to: release.version, at: Date.now() });
  if (!manager || !running)
    return console.log(`Installed ${release.version}. It runs from the next ${me} host start.`);
  await manager.install();
  // The new version says it started by clearing the note of the update; one that failed to
  // start has put the old one back by itself, which then answers instead.
  const reach = reachableAt(config);
  for (const by = Date.now() + 30_000; Date.now() < by; await sleep(500))
    if (!(await pending(where)) && (await answers(reach))) {
      if ((await installedVersion(where)) !== release.version) break;
      return console.log(`✓ Updated to ${release.version}.`);
    }
  if (await pending(where)) {
    await rollBack(where);
    await manager.install();
    await updateFailed(release.version, 'It did not start within 30 seconds.');
  }
  return fail(
    `${release.version} did not start, so ${current} was put back. The end of the log:\n\n${await lastLines(15)}`,
  );
}

/**
 * Wipes this machine's host, as before it was first set up: notebooks, devices, settings, the
 * GitHub sign-in and the service. Says what goes first; with --yes, backs up and wipes.
 */
async function reset(): Promise<void> {
  if (flags.has('data'))
    fail(`Reset works on a whole host folder. Point OPSIDIAN_HOME at it instead of --data.`);
  if (!existsSync(where.home)) return console.log(`Nothing to reset: ${where.home} is not there.`);
  const config = await readConfig(where);
  const held = existsSync(join(where.data, 'host.sqlite'))
    ? await withHost((host) => ({
        notebooks: host.notebooks(),
        devices: host.devices().filter((each) => !each.revoked),
        mirrors: host.mirrors(),
      }))
    : { notebooks: [], devices: [], mirrors: [] };
  const signedIn = await readAccount(where);
  if (!flags.has('yes') && !flags.has('y')) {
    const github = new Set(held.mirrors.map((each) => each.device));
    const devices = held.devices.filter((each) => !github.has(each.id));
    console.log(
      [
        `Resetting takes everything in ${where.home}:`,
        `  Notebooks  ${held.notebooks.map((each) => `${each.name} (${each.files} files)`).join(', ') || 'none'}, with their whole history`,
        `  Devices    ${devices.length ? `${devices.map((each) => each.name).join(', ')}, which stop syncing and keep the notes they have` : 'none'}`,
        ...(held.mirrors.length || signedIn
          ? [
              `  GitHub     ${signedIn ? `the sign-in as ${signedIn.login}` : 'no sign-in'}${held.mirrors.length ? `, and ${held.mirrors.length} copies, which stop; the repositories stay` : ''}`,
            ]
          : []),
        `  Settings   the address, port and backup settings, and the service that keeps it running`,
        config?.backup
          ? `The host is backed up first, to ${config.backup.folder}. Backups there are kept.`
          : 'Backups are off, so none of it can be brought back.',
        '',
        `To reset: ${me} host reset --yes`,
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }
  const found = service(where);
  const manager = 'missing' in found ? undefined : found;
  const managed = (await manager?.state())?.running === true;
  // A host this program does not manage, such as `host run` in Docker or a terminal, must be
  // stopped by whoever started it: its data is about to go from under it.
  const port = config?.port ?? defaultPort();
  const live = [`127.0.0.1:${port}`, ...(config ? [reachableAt(config)] : [])];
  if (!managed && (await Promise.all(live.map(answers))).some(Boolean))
    fail('The host is running. Stop it first (Ctrl+C, or docker stop), then reset.');
  if (config?.backup && held.notebooks.length) {
    const { folder, keep } = config.backup;
    const made = await withHost((host) => host.backup(folder, keep + 1)).catch((reason: unknown) =>
      fail(
        `Nothing was reset: the backup made first failed. ${(reason as Error).message}\n` +
          `Fix that and try again, or turn backups off with: ${me} host backup off`,
      ),
    );
    console.log(`Backed up the host first, as ${made.name}.`);
  }
  // Only a service that was set up: one never started has nothing to stop.
  if (manager && (managed || existsSync(manager.file))) await manager.remove();
  await rm(where.home, { recursive: true, force: true });
  console.log(
    `Reset. Nothing of the host is left in ${where.home}.\n` +
      `To host again: ${me} host start, then ${me} host invite "Personal"`,
  );
}

/** Prints what to run on the machine that will host from now on. */
async function move(): Promise<void> {
  const moved = await withHost((host) => host.moved());
  if (moved) return console.log(movedLines(moved).join('\n'));
  const address = await deviceAddress();
  // The other machine copies from the running host, which keeps serving devices meanwhile.
  if (!(await answers(address)) && !(await answers(`127.0.0.1:${address.split(':').at(-1)}`)))
    fail(`The host is not running, so nothing can take it over. Start it first: ${me} host start`);
  const minutes = whole('minutes', 15, 1, 24 * 60);
  const { code, expires } = await withHost((host) => host.handoff(minutes));
  console.log(
    [
      'To move this host, with every notebook, its history and its devices, run this on the',
      'machine that will host from now on:',
      '',
      `  npx opsidian host take-over ${address} ${code}`,
      '',
      'Or, on a Mac with the Opsidian app: Settings → Sync → Take over hosting, and type:',
      `  Address  ${address}`,
      `  Code     ${code}`,
      '',
      `The code works once, until ${when(expires)}. Devices keep syncing while the notes are copied,`,
      'pause for a few seconds at the end, then follow by themselves: nothing to set up again on them.',
    ].join('\n'),
  );
}

/** Makes this machine the host, taking everything over from another. */
async function takeOverHere(): Promise<void> {
  const [from, code] = words;
  if (!from || !code)
    return fail(
      `Say where from: ${me} host take-over ADDRESS CODE\n` +
        `The current host prints both when you run ${me} host move there.`,
    );
  const data = flags.get('data') ?? where.data;
  const docker = existsSync('/.dockerenv');
  const before = await readConfig(where);
  // In Docker the container's own host is started by Docker, once the data is in place.
  const manager = docker ? undefined : needService();
  const { config, note } = docker
    ? { config: undefined, note: undefined }
    : await listening(before);
  const address = docker ? await deviceAddress() : reachableAt(config!);
  const running = (await manager?.state())?.running === true;
  if (manager && config) {
    if (!running) await portFree(manager, before, config);
  } else if (await answers(`127.0.0.1:${before?.port ?? defaultPort()}`))
    fail('A host is running here. Stop the container first, then take over with docker run --rm.');

  const tty = process.stdout.isTTY;
  const megabytes = (bytes: number) =>
    `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  let shown = '';
  const progress = (step: TakeOverProgress) => {
    const label = {
      connecting: `Asking ${from} to hand over…`,
      copying: 'Copying notes and history',
      pausing: 'Pausing changes for a moment to copy the last of them',
      finishing: 'Starting the host here and pointing devices to it…',
    }[step.phase];
    const amount =
      step.total > 0
        ? `  ${Math.floor((step.done / step.total) * 100)}%  (${megabytes(step.done)} of ${megabytes(step.total)})`
        : '';
    if (tty) process.stdout.write(`\r\x1b[2K  ${label}${amount}`);
    else if (shown !== step.phase) console.log(`  ${label}`);
    shown = step.phase;
  };
  let result;
  try {
    result = await takeOver({
      from,
      code,
      dataDir: data,
      to: `http://${address}`,
      progress,
      // A host already here, such as an old copy left by moving away, lets go of its data.
      beforeInstall: async () => {
        if (manager && (await manager.state()).running) await manager.remove();
      },
      afterInstall: async () => {
        if (manager && config) await launch(manager, config);
      },
    });
  } finally {
    if (tty) process.stdout.write('\r\x1b[2K');
  }
  const signedIn = await readAccount(where);
  const github = result.mirrors.filter((each) => /github\.com/i.test(each.remote));
  const advice = await manager?.advice();
  console.log(
    [
      '✓ This machine is the host now',
      `  Address    http://${address}${config ? `   ${kindOf(config)}` : ''}`,
      `  Notebooks  ${result.notebooks.map((each) => `${each.name} (${each.files} files)`).join(', ') || 'none'}`,
      `  Devices    ${result.devices}, each following by itself the next time it syncs`,
      `  Data       ${data}`,
      ...result.mirrors.map(
        (each, at) =>
          `  ${at ? '          ' : 'GitHub   '}  ${each.name} → ${repositoryLabel(each.remote)}`,
      ),
      `  Backups    ${config?.backup ? backupLine(config) : `Off on this machine. To back up: ${me} host backup FOLDER`}`,
    ].join('\n'),
  );
  if (github.length && !signedIn)
    console.log(
      `\nGitHub is signed in on the old machine, not this one. To carry on keeping notebooks there:\n  ${me} host github login`,
    );
  if (docker) console.log('\nNow start the container, with the same data volume.');
  for (const extra of [note, advice]) if (extra) console.log(`\n${extra}`);
  console.log(
    `\nThe old host only points devices here now. ${me} host status there shows who has followed;\n` +
      `once everyone has, stop it there with: ${me} host stop`,
  );
}

/** Runs the host in this process until it is told to stop. This is what the service runs. */
async function runHere(): Promise<void> {
  const config = await readConfig(where);
  const port = whole('port', config?.port ?? defaultPort(), 1, 65535);
  const address = flags.get('address') ?? config?.address ?? '0.0.0.0';
  const data = flags.get('data') ?? where.data;
  const log = (text: string) => console.log(`${new Date().toISOString()}  ${text}`);
  // The copy `host start` installed, as the service runs it, rather than `host run` by hand or
  // in Docker: only it is updated here.
  const installed = resolve(fileURLToPath(import.meta.url)) === resolve(where.program);
  const trying = installed ? await pending(where) : undefined;
  let host: Host;
  try {
    host = new Host({ dataDir: data });
    try {
      await host.listen(port, address);
    } catch (reason) {
      await host.close();
      // When it is Tailscale's address that is missing, it is usually still starting up; the
      // service manager tries again shortly.
      throw Object.assign(
        new Error(
          `Could not listen on ${address}:${port}: ${(reason as Error).message}` +
            ((reason as NodeJS.ErrnoException).code === 'EADDRNOTAVAIL'
              ? '. That address is not on this machine right now; is Tailscale running?'
              : ''),
        ),
        { code: (reason as NodeJS.ErrnoException).code },
      );
    }
  } catch (reason) {
    // A version just installed that cannot start on this host's data goes, and the one before
    // it comes back when the service starts the host again. An address that is not there yet
    // is no fault of the version.
    const code = (reason as NodeJS.ErrnoException).code;
    if (trying?.to === VERSION && code !== 'EADDRNOTAVAIL' && code !== 'EADDRINUSE') {
      await rollBack(where);
      await updateFailed(VERSION, (reason as Error).message);
      log(`${VERSION} did not start, so ${trying.from} was put back: ${(reason as Error).message}`);
    }
    throw reason;
  }
  if (trying) {
    await settled(where);
    if (trying.to === VERSION) log(`Updated from ${trying.from} to ${VERSION}.`);
  }
  log(`Opsidian host ${VERSION} is listening on ${address}:${port}. Data: ${data}`);

  // Notebooks kept on GitHub sync from here, beside the host. New ones, added with
  // `host github connect`, are noticed within a few seconds.
  const mirrors = new Mirrors({ host, dataDir: data, account: () => readAccount(where), log });
  const moved = host.movedTo();
  // A host that moved away only points devices to where it went: its copy is an old one, and
  // must not be sent to GitHub or backed up as if it were current.
  if (moved) log(`This host moved to ${moved.to}. It only tells devices so now.`);
  else mirrors.start();
  // While another machine copies this host, nothing beside it may write to the data.
  host.moveHooks = {
    pause: async () => {
      log('Another machine is taking this host over. Copies on GitHub are paused meanwhile.');
      await mirrors.stop();
    },
    resume: () => {
      log('The move was given up. This machine carries on as the host.');
      mirrors.start();
    },
  };

  // Backups are scheduled here, so a server needs no cron. Settings are read each time, so
  // `host backup` changes them without a restart.
  let busy = false;
  const backUpIfDue = async () => {
    const latest = await readConfig(where);
    if (busy || !latest?.backup || host.movedTo()) return;
    const { folder, keep, hour } = latest.backup;
    const due = new Date();
    due.setHours(hour, 0, 0, 0);
    if (Date.now() < due.getTime()) return;
    const last = (await listBackups(folder).catch(() => []))[0]?.at ?? 0;
    // One attempt a day, whether it works or not; a failure shows in `host status`.
    if (last >= due.getTime() || (latest.failed?.at ?? 0) >= due.getTime()) return;
    busy = true;
    try {
      const made = await host.backup(folder, keep);
      delete latest.failed;
      log(`Backed up ${made.notebooks.length} notebook(s) as ${made.name}.`);
    } catch (reason) {
      latest.failed = { at: Date.now(), message: (reason as Error).message };
      log(`Backup failed: ${latest.failed.message}`);
    } finally {
      busy = false;
    }
    // Settings may have changed meanwhile; only the outcome is written back.
    const now = (await readConfig(where)) ?? latest;
    if (latest.failed) now.failed = latest.failed;
    else delete now.failed;
    await writeConfig(where, now);
  };
  const timer = setInterval(() => void backUpIfDue().catch(() => {}), 10 * 60 * 1000);
  void backUpIfDue().catch(() => {});

  // New versions are installed each night, after the backup. The service starts the new one
  // as soon as this one has stopped.
  let updating = false;
  let stopping = false;
  const updateIfDue = async () => {
    if (!installed || updating || busy || stopping || host.movedTo()) return;
    const latest = await readConfig(where);
    if (!latest || latest.update?.auto === false) return;
    const due = new Date();
    due.setHours(updateHour(latest), 0, 0, 0);
    if (Date.now() < due.getTime() || (latest.update?.checked ?? 0) >= due.getTime()) return;
    updating = true;
    try {
      // One look a day, whether it works or not.
      await writeConfig(where, { ...latest, update: { ...latest.update, checked: Date.now() } });
      const release = await latestRelease();
      if (!newer(release.version, VERSION) || latest.update?.failed?.version === release.version)
        return;
      log(`Version ${release.version} is out. Installing it…`);
      const next = await fetchRelease(where, release).catch(async (reason: Error) => {
        await updateFailed(release.version, reason.message);
        throw reason;
      });
      if (latest.backup) {
        busy = true;
        try {
          const made = await host.backup(latest.backup.folder, latest.backup.keep);
          log(`Backed up ${made.notebooks.length} notebook(s) as ${made.name} before updating.`);
        } catch (reason) {
          await rm(next, { force: true });
          throw reason;
        } finally {
          busy = false;
        }
      }
      await swapIn(where, next, { from: VERSION, to: release.version, at: Date.now() });
      log(`Restarting as ${release.version}.`);
      stop();
    } catch (reason) {
      log(`Update failed: ${(reason as Error).message}`);
    } finally {
      updating = false;
    }
  };
  const updates = setInterval(() => void updateIfDue().catch(() => {}), 10 * 60 * 1000);
  void updateIfDue().catch(() => {});

  const stop = () => {
    // Asked twice, as with a second Ctrl+C: stop without waiting for GitHub.
    if (stopping) process.exit(0);
    stopping = true;
    clearInterval(timer);
    clearInterval(updates);
    log('Stopping.');
    // What has not reached GitHub yet is sent first, for 20 seconds at most.
    void mirrors
      .stop(20_000)
      .then(() => host.close())
      .then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function main(): Promise<void> {
  if (flags.has('version') || flags.has('v')) return console.log(VERSION);
  const [area, ...rest] = words.splice(0, 2);
  // Every command lives under `host`, leaving room for others beside it later.
  if (area !== 'host' || flags.has('help') || flags.has('h')) return console.log(HELP);
  // A development build never acts on the real host's data by accident: not by a stray
  // OPSIDIAN_HOME, not by --data. Its own host lives in ~/.opsidian-dev.
  const real = resolve(productionHome());
  const data = flags.get('data');
  if (
    developing() &&
    !flags.has('production') &&
    (resolve(where.home) === real ||
      (data && (resolve(data) === real || resolve(data).startsWith(real + sep))))
  )
    fail(
      `This is a development build, and ${real} belongs to the real host on this machine.\n` +
        'Use the installed opsidian command for it, or add --production to act on it from here anyway.',
    );
  const command = rest[0];
  switch (command) {
    case 'start':
      return start();
    case 'run':
      return runHere();
    case 'status':
      return status();
    case 'invite':
      return invite();
    case 'github':
      return github({
        me,
        where,
        flags,
        words,
        withHost,
        invite,
        running: async () => {
          const config = await readConfig(where);
          return Boolean(config) && (await answers(reachableAt(config!)));
        },
      });
    case 'devices':
      return withHost((host) => {
        const all = host.devices();
        if (!all.length) console.log('No devices yet.');
        for (const device of all)
          console.log(
            `${device.id}  ${device.name}  (${device.notebook})  added ${when(device.created)}${device.revoked ? '  REMOVED' : ''}`,
          );
      });
    case 'revoke':
    case 'remove':
      return withHost((host) => {
        const found = host.findDevices(words.join(' '));
        if (found.length === 1) {
          host.revoke(found[0]!.id);
          console.log(`${found[0]!.name} can no longer sync. The notes on it stay there.`);
        } else if (found.length) {
          console.log('More than one device has that name. Give the id of the one to remove:');
          for (const device of found)
            console.log(`  ${device.id}  ${device.name}  (${device.notebook})`);
          process.exitCode = 1;
        } else {
          console.log(`No device is called that. ${me} host devices lists them.`);
          process.exitCode = 1;
        }
      });
    case 'notebooks':
      return withHost((host) => {
        const all = host.notebooks();
        if (!all.length) console.log(`No notebooks yet. ${me} host invite "Name" makes one.`);
        for (const notebook of all)
          console.log(`${notebook.name}: ${notebook.files} files, ${notebook.head} changes`);
      });
    case 'delete':
      return deleteNotebook();
    case 'reset':
      return reset();
    case 'update':
      return update();
    case 'backup':
      return backup();
    case 'backups': {
      const folder = words[0] ? resolve(words[0]) : (await readConfig(where))?.backup?.folder;
      if (!folder) return fail(`Say where: ${me} host backups FOLDER`);
      const all = await listBackups(folder);
      if (!all.length) console.log(`No backups in ${folder} yet.`);
      for (const each of all)
        console.log(
          `${each.name}  ${each.notebooks.map((n) => `${n.name}: ${n.files} files`).join(', ')}`,
        );
      return;
    }
    case 'restore':
      return restore();
    case 'move':
      return move();
    case 'take-over':
    case 'takeover':
      return takeOverHere();
    case 'logs': {
      if (!existsSync(where.log)) return console.log('No log yet.');
      const follow = flags.has('follow') || flags.has('f');
      spawn('tail', ['-n', '50', ...(follow ? ['-f'] : []), where.log], { stdio: 'inherit' });
      return;
    }
    case 'stop':
      await needService().remove();
      return console.log(
        `Stopped. It will not start by itself again until you run ${me} host start.\n` +
          `Your notebooks are kept in ${where.data}.`,
      );
    case 'uninstall': {
      const manager = service(where);
      if (!('missing' in manager)) await manager.remove();
      if (flags.has('delete-data')) {
        await rm(where.home, { recursive: true, force: true });
        return console.log(`Removed the host and everything it held (${where.home}).`);
      }
      await rm(dirname(where.program), { recursive: true, force: true });
      await rm(where.log, { force: true });
      return console.log(
        `Removed the host. Your notebooks and settings are still in ${where.home};\n` +
          `start again to use them, or delete that folder.`,
      );
    }
    default:
      return console.log(HELP);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
