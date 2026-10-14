# Hosting a notebook

One machine hosts a notebook and every device syncs through it. The host keeps the notebook's full history; it is the only thing that needs backing up. There are two ways to run one, and they are the same host underneath.

Opsidian does not encrypt the connection itself. Devices reach the host over your home network or over [Tailscale](https://tailscale.com), which encrypts everything between your own devices. Do not expose a host to the open internet.

## On a Mac

Use this when a Mac at home stays on.

1. Open the notebook in Opsidian and open Settings (the gear, or ⌘,).
2. Under **Sync**, choose **Turn on hosting**. This Mac starts hosting the open notebook and connects its own copy to it.
3. Choose **Invite a device**. On the iPhone, open Opsidian, choose Connect, and scan the code. On another Mac, choose "Connect to a notebook" on the welcome screen and type the address and the code.

While hosting, Opsidian stays in the menu bar when its window is closed, so devices keep syncing. The Mac has to be awake. An installed copy of the app also starts at login; the development build does not.

To sync away from home, install Tailscale on the Mac and on each device and sign in to the same account. Settings then shows the Tailscale address to use.

The host's data is kept in the app's own folder (`~/Library/Application Support/Opsidian/host`), separate from every notebook folder.

The host runs on a thread of its own, so serving devices, backing up and restoring never hold up the app's windows.

Each notebook folder on this Mac is its own notebook on the host, even when two folders have the same name. The second one to be hosted is named with a number, such as "Personal 2", and invitations use that name.

## On a server

Use this for a host that is always on. The server needs Docker and Tailscale.

1. Install Tailscale on the server and note its Tailscale address (`tailscale ip -4`).
2. Build and start the host, published only on the Tailscale address:

   ```sh
   docker build -t opsidian-host .
   docker run -d --name opsidian-host --restart unless-stopped \
     -p 100.x.y.z:4810:4810 -v opsidian-data:/data opsidian-host
   ```

3. Make an invitation and enter it on each device, with `100.x.y.z:4810` as the address:

   ```sh
   docker exec opsidian-host opsidian-host invite "Personal"
   ```

Publishing on the Tailscale address, rather than on every address, is what keeps the host off the public internet. Other commands work the same way: `devices`, `revoke DEVICE-ID`, `notebooks`.

Without Docker, `pnpm build:host` produces one file, `apps/host/dist/opsidian-host.mjs`, that runs with Node 24 alone.

## Devices

On a hosting Mac, **Settings → Devices** lists every device, when it was last seen, and invitations not yet used. Removing a device stops it syncing at once; the notes on it stay there. On a server, use `opsidian-host devices` and `opsidian-host revoke`.

## Backups

A backup is a snapshot of the host: every notebook with its full history.

- **On a Mac:** in **Settings → Backups**, choose a folder, how often, and how many to keep. Failed backups are shown there with the reason.
- **On a server:** run `opsidian-host backup FOLDER` from cron, for example nightly. `--keep 14` sets how many snapshots stay.

The folder holds `snapshots/` (one database per backup) and `blobs/` (note and file content, stored once and only ever added to). Because content is shared, each backup after the first is small and quick. Put the folder on a different disk from the host.

## Restoring

Restoring puts the host back to a backup.

- **On a Mac:** in **Settings → Backups**, choose **Restore…** beside a backup.
- **On a server:** stop the host, run `opsidian-host restore FOLDER BACKUP-NAME`, and start it again. `opsidian-host backups FOLDER` lists the names.

What happens next is automatic:

- The Mac app first backs up what the host holds now, so a restore can itself be undone.
- Each device notices the host's history changed, keeps all its notes, and sends back up whatever it wrote since the backup.
- Notes deleted after the backup come back, because the backup still has them.
- A device that joined after the backup is unknown to the restored host and needs a new invitation.
- A device removed after the backup stays removed.
- A device that had not synced for a while keeps working: only what it agreed with the host after the backup is treated as new.

To move a host to a new machine, back up, then restore the backup into the new machine's empty host and point devices at the new address by connecting them again.

## When it will not connect

**Settings → Connection check** on the Mac, and "See what is in the way" on the iPhone's sync screen, try each step in order and stop at the first that fails:

1. The device is on a network.
2. The host answers at its address. If the address is a Tailscale one, the usual cause is Tailscale being off on the device, or the host machine being asleep.
3. The host still accepts the device. If not, it was removed or the host was set up again; connect with a new invitation.
