import { networkInterfaces, homedir } from 'node:os';
import { join } from 'node:path';
import { Host, listBackups, restoreBackup } from './host';

const [command = 'help', ...rest] = process.argv.slice(2);
const flags = new Map<string, string>();
const words: string[] = [];
for (let position = 0; position < rest.length; position++) {
  const word = rest[position]!;
  if (word.startsWith('--')) flags.set(word.slice(2), rest[++position] ?? '');
  else words.push(word);
}
const dataDir =
  flags.get('data') ?? process.env.OPSIDIAN_HOST_DATA ?? join(homedir(), '.opsidian-host');
const port = Number(flags.get('port') ?? process.env.OPSIDIAN_HOST_PORT ?? 4810);
const when = (time: number) => new Date(time).toLocaleString();

/** Addresses another device could use to reach this machine. */
function addresses(): string[] {
  const found: string[] = [];
  for (const [name, list] of Object.entries(networkInterfaces()))
    for (const address of list ?? [])
      if (address.family === 'IPv4' && !address.internal)
        found.push(
          `http://${address.address}:${port}${name.startsWith('utun') ? '  (Tailscale or VPN)' : ''}`,
        );
  return found;
}

const host = new Host({ dataDir });
try {
  if (command === 'serve') {
    await host.listen(port, flags.get('address') ?? '0.0.0.0');
    console.log(`Opsidian host is running. Data: ${dataDir}`);
    console.log(
      ['Reach it at:', `http://127.0.0.1:${port}  (this machine)`, ...addresses()].join('\n  '),
    );
    console.log('Invite a device with:  opsidian-host invite "Notebook name"');
    const stop = () => void host.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } else {
    if (command === 'invite') {
      const name = words.join(' ') || 'Personal';
      const minutes = Number(flags.get('minutes') ?? 15);
      const { code, expires } = host.invite(name, minutes);
      console.log(`Invitation to “${name}”: ${code}`);
      console.log(`Works once, until ${when(expires)}.`);
      console.log(['Host address to enter on the device:', ...addresses()].join('\n  '));
    } else if (command === 'devices') {
      for (const device of host.devices())
        console.log(
          `${device.id}  ${device.name}  (${device.notebook})  added ${when(device.created)}${device.revoked ? '  REVOKED' : ''}`,
        );
    } else if (command === 'revoke') {
      const id = words[0] ?? '';
      console.log(host.revoke(id) ? 'That device can no longer sync.' : 'No device has that id.');
    } else if (command === 'notebooks') {
      for (const notebook of host.notebooks())
        console.log(`${notebook.name}: ${notebook.files} files, ${notebook.head} changes`);
    } else if (command === 'backup') {
      const folder = words[0];
      if (!folder) throw new Error('Say where: opsidian-host backup FOLDER');
      const backup = await host.backup(folder, Number(flags.get('keep') ?? 14));
      console.log(`Backed up ${backup.notebooks.length} notebook(s) as ${backup.name}.`);
    } else if (command === 'backups') {
      for (const backup of await listBackups(words[0] ?? ''))
        console.log(
          `${backup.name}  ${backup.notebooks.map((n) => `${n.name}: ${n.files} files`).join(', ')}`,
        );
    } else if (command === 'restore') {
      const [folder, name] = words;
      if (!folder || !name) throw new Error('Say which: opsidian-host restore FOLDER BACKUP-NAME');
      // The data is replaced underneath, so nothing may have it open. Stop `serve` first.
      await host.close();
      await restoreBackup(dataDir, folder, name);
      console.log('Restored. Start the host again; devices will catch up by themselves.');
      process.exit(0);
    } else
      console.log(
        [
          'opsidian-host serve [--port 4810] [--address 0.0.0.0] [--data DIR]',
          'opsidian-host invite "Notebook name" [--minutes 15]',
          'opsidian-host devices',
          'opsidian-host revoke DEVICE-ID',
          'opsidian-host notebooks',
          'opsidian-host backup FOLDER [--keep 14]',
          'opsidian-host backups FOLDER',
          'opsidian-host restore FOLDER BACKUP-NAME   (with the host stopped)',
        ].join('\n'),
      );
    await host.close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
