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

## Without the app: a Mac or a server

Use this for a host that is always on, with no window: a Mac mini at home, or a Linux server. It needs Node 24 or later and, for anything but the home network, Tailscale.

```sh
npx opsidian host start
npx opsidian host invite "Personal"
```

`start` returns at once and the host keeps running. launchd (on a Mac) or systemd (on Linux) runs it, starts it at login or boot, and starts it again if it stops. `invite` prints a QR code to scan with the iPhone app, plus the address and code to type. `host status` shows whether it is running, its address, notebooks, devices and backups. `host stop` stops it, and stops it starting by itself.

It listens only on the machine's Tailscale address. Without Tailscale, a Mac uses the home network and says so. A Linux server refuses to start, because its address is usually public; `--address` chooses one anyway. Settings, data and the log are in `~/.opsidian`.

On Linux, a user that is not root may be asked to run `sudo loginctl enable-linger USER` once. Without it, systemd stops the user's services at logout and does not start them at boot. As root, the host is a system service and this does not apply.

The Mac app and a headless host cannot both use port 4810 on one Mac. `start` says so if the app is already hosting; turn hosting off in the app, or use `--port`.

### With Docker

```sh
docker build -t opsidian-host .
docker run -d --name opsidian-host --restart unless-stopped \
  -p 100.x.y.z:4810:4810 -e OPSIDIAN_ADDRESS=100.x.y.z:4810 \
  -v opsidian-data:/data opsidian-host
docker exec opsidian-host opsidian host invite "Personal"
```

`100.x.y.z` is the server's Tailscale address (`tailscale ip -4`). Publishing only on it keeps the host off the public internet. `OPSIDIAN_ADDRESS` tells the host the address to put in invitations, which it cannot see from inside the container.

## Keeping notebooks on GitHub

A hosted notebook can also be kept in a GitHub repository, as ordinary Markdown files. It works in both directions: changes made on any device go to GitHub, every hour unless you choose otherwise, and an edit pushed to GitHub, or made on github.com, comes back to every device. The host does this, so it works while devices are asleep, and it needs git on the host machine (on a Mac, `xcode-select --install` provides it).

It is also how to bring notes that already live on GitHub, such as an Obsidian vault kept with git, into Opsidian, or to set up a new host from them.

**In the Mac app:** Settings → GitHub. Sign in with GitHub (the code is copied and GitHub opens in the browser), then choose **Keep on GitHub…** beside a notebook and pick a repository or make a new private one. **Import from GitHub**, there or on the welcome screen, makes a new notebook from a repository, hosted on this Mac, and opens it.

**Without the app:**

```sh
npx opsidian host github import you/notes      # a new notebook from a repository, then an invitation to it
npx opsidian host github connect "Personal"    # keep an existing notebook in a repository; asks which one
npx opsidian host github                       # how each one is doing
npx opsidian host github every 1h              # how often: live, 15m, 1h, 6h or 24h
```

The first command that needs GitHub signs in by showing a code to enter at github.com/login/device, in any browser, so it works on a server with no screen. `connect` lists your repositories and offers to make a new private one; a repository can also be named as `you/notes`, a GitHub link, an SSH address (`git@github.com:you/notes.git`, which uses the machine's own SSH keys), or any other address git understands. `host github sync` syncs now, whatever the schedule; `disconnect` stops; `logout` forgets the sign-in. In Docker, run them with `docker exec -it opsidian-host opsidian host github …`.

What happens to the notes:

- **Each round is one commit** from your GitHub account, named after what changed ("Edit Plan; Add Ideas"), holding every edit made since the round before. See [how often](#how-often) below.
- **Edits on both sides are combined** line by line. When both sides changed the same lines, the notebook's version keeps the name and GitHub's is kept beside it as a `conflicted copy GitHub` note, on GitHub and on every device. Nothing is ever force-pushed.
- **A repository that already has notes is joined, not replaced.** Connecting a notebook to one combines the two: nothing is deleted, and a note that differs is kept twice.
- **Hidden files are left alone.** Folders such as `.obsidian` and `.github`, and files such as `.gitignore`, stay in the repository untouched and are not sent to devices. The notebook's trash is not committed: the repository's history already has every deleted note.
- **Opsidian's own folders never stay in the repository.** If a notebook folder was pushed to GitHub by hand with its `.opsidian` (one device's sync state) or `.trash`, the first round takes them out in one commit, "Stop tracking Opsidian's own files", and adds them to `.gitignore`. They stay in the repository's history. Otherwise the host's own sync state would be committed every round.
- **A repository that suddenly looks mostly empty is not trusted.** If half or more of the notebook disappears from GitHub at once, the deletions wait to be confirmed with **Confirm deletions** or `host github sync --confirm-deletions`.
- **Files over 100 MB** stay out, as they do in sync. Git LFS is not supported.

### How often

One setting for the whole host, in **Settings → GitHub → Copy to GitHub** on a Mac or with `host github every` elsewhere. It applies to every notebook kept on GitHub and takes effect at once, without a restart.

| Choice             | What happens                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `1h`               | The default. Once an hour, everything changed since the last round goes as one commit.           |
| `15m`, `6h`, `24h` | The same, every 15 minutes, every 6 hours, or once a day.                                        |
| `live`             | About ten seconds after each burst of typing, as its own commit; GitHub is checked every minute. |

Edits made on GitHub come back in the same rounds, so on the hourly schedule they reach devices within the hour. **Sync now** in the app, or `host github sync`, runs a round at once whatever the schedule.

- **A host that was off catches up.** When it starts and the last round is older than the schedule, it runs one soon after starting. Several notebooks are spread a little apart, so they do not all ask GitHub in the same second.
- **Stopping sends what is waiting.** Quitting the app, turning hosting off, or stopping the host (`host stop`, Ctrl+C, a restart) first sends what GitHub does not have yet. It waits 8 seconds at most in the app, so quitting never hangs, and 20 seconds on a server; whatever does not make it goes in the first round after the next start, and the log says so. In Docker, `docker stop` allows 10 seconds by default; `docker stop -t 30` gives it time.
- **It says when a copy is overdue.** `host github`, `host status` and the app show when each notebook was last copied and when the next round is ("copied 12 min ago, next in 48 min"). Once the last copy is more than twice the schedule old, they say so as a warning ("not copied for 3 h: you/notes could not be reached").

**What it asks of GitHub.** Rounds use git over HTTPS (`ls-remote`, `fetch`, `push`), which GitHub's API limit of 5,000 requests an hour does not cover; the API is used only to sign in and to list or make repositories. GitHub still slows down clients that ask too often, so a round is frugal: when neither the notebook nor the repository changed, it only asks GitHub which commit the repository is at, one small request, and stops there. Per notebook:

| Choice | Nothing changed                 | Something changed                               |
| ------ | ------------------------------- | ----------------------------------------------- |
| `1h`   | 1 small request an hour         | at most 3 an hour (check, fetch, push)          |
| `live` | about 60 small requests an hour | the same, plus a push after each burst of edits |

If GitHub does ask Opsidian to slow down (it answers "too many requests" or "rate limit"), the copy waits at least an hour, longer if GitHub says so or keeps asking, and the status says when it will try again. Other failures, such as no network, are retried soon (after a minute; five seconds when live), then less and less often, but never later than the next scheduled round would be.

The sign-in lets Opsidian read and write your repositories; it is kept on the host machine only (in the keychain on a Mac, readable by you alone in `~/.opsidian` on a server). Signing out stops the copies until you sign in again. To withdraw the access entirely, revoke Opsidian at github.com/settings/applications. The host keeps its own checkout of each repository in its data folder; GitHub is a copy, and the host's history and backups stay the place to restore from.

## Moving the host to another machine

The host can move at any time: from a Mac mini to a server, from a server to the MacBook you work on, and back. Everything goes with it — every notebook and its whole history, every device and its access, the notebooks kept on GitHub — and nothing has to be set up again on any device.

**From a host without the app** (a Mac mini, a server), on the host:

```sh
npx opsidian host move
```

It prints a single-use code and the command to run on the machine that will host from now on:

```sh
npx opsidian host take-over 100.101.1.2:4810 ABCD-EFGH-JKLM
```

`take-over` copies the host, starts it as a background service the way `host start` does (it takes the same `--port` and `--address`), and prints what it took over. In Docker, run it with the container stopped and its volume mounted: `docker run --rm -v opsidian-data:/data -e OPSIDIAN_ADDRESS=100.x.y.z:4810 opsidian-host opsidian host take-over …`, then start the container.

**In the Mac app**, on the hosting Mac: **Settings → Sync → Move…** shows the code and the command for a server. On a Mac taking over: **Settings → Sync → Take over hosting…**; when that Mac already syncs through the host, its address is filled in, so only the code is typed.

What happens:

1. **The notes are copied while devices keep syncing.** Content the new machine already has, as when a host moves back to where it was before, is not sent again.
2. **Changes pause for a few seconds** while the last of them and the host's database are copied. A device that saves meanwhile keeps the edit and sends it once it has followed; the status bar says the host is moving.
3. **The new machine starts serving, and the old host starts pointing devices to it.** Each device follows by itself the next time it syncs: it checks that the new address is the same host, one that already knows this device, and carries on from where it was. Nothing is downloaded again and nothing becomes a conflicted copy, because the history keeps its identity.

The old host keeps pointing devices to the new address until it is stopped. `host status` there, or Settings → Sync in the app, lists which devices have followed. Once all of them have, stop it (`host stop`, or **Stop** in the app). A device that was away the whole time and never heard can be pointed at the new address by hand: on a Mac, **Settings → Sync → Host moved? → Change address…**. It is accepted only if the host there already knows that device.

A few things belong to a machine rather than to the host, so they do not move:

- **The GitHub sign-in.** The copies on GitHub move, with their history, but the new machine needs its own sign-in (`host github login`, or Settings → GitHub) before it carries on with them.
- **Backups.** Set them up again on the new machine. The old machine stops backing up, since what it holds is now an old copy.
- **Unused invitations**, which named the old address.

The new machine refuses to take over if it already hosts notebooks of its own, so a host is never overwritten by accident. A machine whose host moved away holds only an old copy, so a host can be moved back to it. If the copy fails part-way, it is given up on both sides and the old host carries on as before; after five minutes without hearing from the new machine, the old host gives up by itself.

## Beside development on the same machine

A machine can host your real notebooks and be where Opsidian is developed and tested, without one touching the other:

|              | Real host                                                                 | Development and tests                                            |
| ------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Started with | `npx opsidian host start` (or the installed `opsidian`)                   | `pnpm host …` in the repository                                  |
| Data         | `~/.opsidian`                                                             | `~/.opsidian-dev`; tests use a new temporary folder each run     |
| Port         | 4810, on the Tailscale address                                            | 4811; tests use random ports on `127.0.0.1` only                 |
| Service      | `opsidian-host.service` (`sh.ferran.opsidian.host` on a Mac)              | named after its folder, such as `opsidian-host-a75a2422.service` |
| Program      | its own copy in `~/.opsidian/bin`, unchanged by rebuilding the repository | the repository's build                                           |

Starting, stopping or removing a development host never touches the real one, because each data folder's service has its own name. `pnpm host` refuses to act on `~/.opsidian` at all, whether through `OPSIDIAN_HOME` or `--data`, unless `--production` is added. The automated tests set their own `OPSIDIAN_HOME` before anything runs.

The Mac app works the same way: a development run (`pnpm dev:desktop`) keeps its data in `Opsidian Development` and hosts on port 4811, so it can run beside the installed app.

Backups and the copy on GitHub protect the real host's data whatever happens on the machine. Keep backups in a folder outside `~/.opsidian`.

## Devices

On a hosting Mac, **Settings → Devices** lists every device, when it was last seen, and invitations not yet used. Removing a device stops it syncing at once; the notes on it stay there. Without the app, use `host devices` and `host remove`, which takes a device's name, or its id when two share a name. A device that stops syncing by itself removes itself, so it does not linger in the list.

## Deleting a notebook

Stopping sync on a device, or removing it, never deletes the notebook: the host keeps it, with its whole history, for every other device. To delete it from the host:

- **On a hosting Mac:** in **Settings → Sync**, choose **Delete…** beside the notebook under _Notebooks hosted here_. The dialog says how much goes, which devices stop syncing it, and whether a backup is made first.
- **Without the app:** `host delete "Name"` says the same, and deletes nothing; `host delete "Name" --yes` deletes it. The name may be typed in any letter case. It works while the host is running.

What happens:

- **The host keeps nothing of it:** its files, every version, and their content go. Other notebooks are untouched, and the name can be used again for a new, empty notebook.
- **Devices keep their notes.** Each one that synced it is removed, and is told the notebook was deleted from the host. Its folder stays as it is; its sync status offers to stop syncing there. If the notebook is the one open on the hosting Mac, that Mac stops syncing it first, keeping its folder.
- **Its copy on GitHub stops,** and the host's checkout of it goes. The repository stays as it is.
- **It can be undone only from a backup.** When backups are set up, the host is backed up first, and nothing is deleted if that backup fails. Restoring the backup brings the notebook back with its history; the devices it had stay removed, so each joins again with a new invitation. Older backups keep the notebook too, until they are replaced.

To delete everything a host holds at once, [start over](#starting-over).

A device cannot delete a notebook from the host, only the host's own machine can: a lost phone must not be able to delete what every other device holds. On a host that moved to another machine, delete notebooks on the new one.

## Starting over

Resetting puts a host back as it was before it was first set up, as on a fresh install.

- **On a Mac:** in **Settings → Sync**, choose **Reset…** under _Reset Opsidian on this Mac_ and type `reset`. Everything Opsidian keeps on the Mac goes: the host with every notebook and its history, the GitHub sign-in, settings, backup settings, and its access to any other host. Each host it synced with is told, so none lists it afterwards. Notebook folders stay, with every note, no longer syncing. The app then restarts, as when first installed.
- **Without the app:** `host reset` says what goes and deletes nothing; `host reset --yes` stops the service and removes the host's folder (`~/.opsidian`, or `OPSIDIAN_HOME`): every notebook, device and setting, the GitHub sign-in and the log. A host started by hand or in Docker must be stopped first. Start again with `host start`.

When backups are set up, the host is backed up first and nothing is reset if that fails; backups already in the folder are kept, so restoring one undoes the reset. Without backups, it cannot be undone. Devices keep their notes and stop syncing; repositories on GitHub stay as they are.

## Backups

A backup is a snapshot of the host: every notebook with its full history.

- **On a Mac:** in **Settings → Backups**, choose a folder, how often, and how many to keep. Failed backups are shown there with the reason.
- **Without the app:** `host backup FOLDER` backs up every night at 3 and once now, or `host start --backup FOLDER`. `--keep 14` sets how many stay; `--hour` moves the time. The host runs the schedule itself, so no cron is needed, and `host status` shows the last backup and any failure. `host backup now` backs up at once; `host backup off` stops.

The folder holds `snapshots/` (one database per backup) and `blobs/` (note and file content, stored once and only ever added to). Because content is shared, each backup after the first is small and quick. Put the folder on a different disk from the host.

## Restoring

Restoring puts the host back to a backup.

- **On a Mac:** in **Settings → Backups**, choose **Restore…** beside a backup.
- **Without the app:** `host restore BACKUP-NAME`. It stops the host, backs up what it holds first, restores, and starts it again. `host backups` lists the names.

What happens next is automatic:

- The Mac app first backs up what the host holds now, so a restore can itself be undone.
- Each device notices the host's history changed, keeps all its notes, and sends back up whatever it wrote since the backup.
- Notes deleted after the backup come back, because the backup still has them.
- A device that joined after the backup is unknown to the restored host and needs a new invitation.
- A device removed after the backup stays removed.
- A device that had not synced for a while keeps working: only what it agreed with the host after the backup is treated as new.

To move a host to a new machine, see [moving the host](#moving-the-host-to-another-machine). A backup can also be restored into a new machine's empty host, but devices then have to be connected again.

## When it will not connect

**Settings → Connection check** on the Mac, and "See what is in the way" on the iPhone's sync screen, try each step in order and stop at the first that fails:

1. The device is on a network.
2. The host answers at its address. If the address is a Tailscale one, the usual cause is Tailscale being off on the device, or the host machine being asleep.
3. The host still accepts the device. If not, it was removed or the host was set up again; connect with a new invitation.
