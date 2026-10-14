# opsidian

Host your own [Opsidian](https://ferran.sh/opsidian) notebooks. One machine hosts them; your Mac and iPhone sync through it. Your notes stay on your machines, as Markdown files.

Needs Node 24 or later, on macOS or Linux.

```sh
npx opsidian host start
```

It starts in the background and comes back by itself after a crash or a restart. Then let a device join:

```sh
npx opsidian host invite "Personal"
```

Scan the code it prints with the Opsidian app, or type the address and code. A name the host has not seen makes a new notebook.

## Keep it private

The host has no sign-in of its own, so it should only be reachable by your devices. Install [Tailscale](https://tailscale.com) on the host and on each device: the host then listens only on its Tailscale address, and syncs from anywhere. Without Tailscale, a Mac uses your home network; a server refuses to start unless you choose an address with `--address`.

## Commands

| Command                                                  | What it does                                                |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| `host start [--port 4810] [--address IP] [--backup DIR]` | Runs the host in the background, now and after restarts     |
| `host status`                                            | Whether it is running, where, and what it holds             |
| `host invite "Name"`                                     | A single-use invitation to a notebook, valid for 15 minutes |
| `host devices` / `host revoke DEVICE`                    | Every device; stop one syncing                              |
| `host notebooks`                                         | Every notebook on the host                                  |
| `host backup DIR` / `now` / `off`                        | Back up every night at 3 and once now; back up now; stop    |
| `host backups` / `host restore BACKUP`                   | The backups there are; put the host back to one             |
| `host logs [-f]`                                         | What the host has been doing                                |
| `host stop`                                              | Stops it, and stops it starting by itself                   |
| `host uninstall [--delete-data]`                         | Removes it; your notebooks stay unless you say otherwise    |
| `host run`                                               | Runs in the terminal instead, for Docker or to watch it     |

Install it with `npm install -g opsidian` to type `opsidian host …` instead.

Everything lives in `~/.opsidian`: settings, the notebooks' data, the log, and the copy of the program the service runs. On a Mac, launchd runs it; on Linux, systemd. On Linux, a non-root user may be asked to run `sudo loginctl enable-linger` once, so the host keeps running after logging out.

## Licence

`MIT OR Apache-2.0`, at your choice.
