# Sync

Milestone 3, 2026-10-14. A notebook can be kept in step between devices through a host you run yourself. This document is the protocol design and a record of what is built.

## What you get

- Every device has a full copy of the notebook as ordinary files and works offline.
- With both devices online, a change saved on one reaches the other in about a second. The test measures roughly 200 ms on one machine.
- It is not live co-editing. What travels is saved versions of files, not keystrokes.
- Nothing is deleted by sync. A file removed elsewhere goes to the notebook's `.trash`. Edits that cannot be combined are kept as two files.

## Running it

To try sync from this repository:

```sh
pnpm host run                   # in this terminal; port 4811, data in ~/.opsidian-dev/host
pnpm host invite "Personal"     # prints an address and a single-use code
```

`pnpm host` is a development build, so it keeps its own host in `~/.opsidian-dev` on port 4811, apart from a real one on the same machine. To leave it running in the background, use `pnpm host start`. A real host is installed with `npx opsidian host start` (port 4810, `~/.opsidian`); see [hosting](hosting.md#beside-development-on-the-same-machine).

On the first Mac, open the notebook, click the sync line at the bottom of the sidebar, and enter the address and code. On the second Mac, run `invite` again for a fresh code, then choose **Connect to a notebook** on the welcome screen. Each invitation works once and expires after 15 minutes.

Other commands: `host devices` lists paired devices, `host remove DEVICE` stops one syncing (by its name, or its id when two share a name), `host notebooks` lists what the host holds, and `host delete "Name"` deletes a notebook from it (see [deleting a notebook](hosting.md#deleting-a-notebook)).

**The connection is not encrypted by the host.** Use it over Tailscale, on a network you trust, or behind an HTTPS reverse proxy such as Caddy. Certificates and a guided setup are milestone 5.

## Model

The host keeps, for each notebook, a numbered log of accepted changes and the content of every version. Each file has an identity that stays with it through renames. A file's state on the host is `{ seq, file, path, hash, size }`; `seq` is its position in the log and a null `hash` means deleted.

A device remembers, per file, the last state it agreed with the host (`.opsidian/sync.json` in the notebook folder), and a cursor: the log position it has applied up to. It keeps no queue of pending changes. What is pending is whatever differs between the folder and that remembered state, worked out by looking. A crash therefore cannot corrupt or lose a queue.

The host orders changes and never merges. A device proposes a change naming the version it started from. If the file has moved on, the host refuses, and the device pulls, reconciles locally, and tries again.

```text
sync round (repeats until nothing is left to do)
  look at the folder: path -> content hash
  pull changes since the cursor; for each file changed on the host:
    unchanged here            -> take the host's version (write, move, or trash)
    changed here, text        -> three-way merge with the last agreed version
      different lines         -> write the merge; it is sent in the push below
      same lines              -> host's version stays; this device's goes beside it
    changed here, not text    -> keep both, as above
    deleted there, edited here -> the edit survives and is sent as the file's return
    deleted here, edited there -> the edit survives and the file comes back
  save state and cursor
  push what still differs: deletions, then changes and renames, then new files
    accepted   -> remember the new version
    stale      -> another round
    path taken -> another round; the pull moves one of the two aside
```

Every local change sync makes is conditional: a write or move happens only if the file still has the content the decision was based on. If the user or another program changed it in the meantime, the round starts over.

## Why failures are safe

- **A request sent twice has one effect.** A change's id is derived from its content, and the host records the answer it gave. Content is stored by its hash.
- **A lost answer is harmless.** If the host accepted a change but the device never heard, the next pull shows the device its own change, which matches what is on disk.
- **A crash between any two steps is recoverable.** State is saved after the files it describes. On restart the folder is ahead of the state, and the next round finds that the "difference" already matches the host. The test kills the engine at every step of a scenario that merges, clashes, moves, trashes and creates.
- **A damaged transfer is refused.** The host checks every upload against its hash, and a device checks every download.
- **Clocks do not matter.** Order comes from the host's log. Timestamps are for display.
- **A folder that suddenly looks mostly empty is not trusted.** If half or more of the notebook (and at least ten files) vanish at once, or every file does, however few, the deletions are held until confirmed in the sync dialog, in case the disk was unmounted or a restore was under way.
- **A notebook folder that disappears is not a deletion.** A device remembers which folder on disk its notebook is, not only its path. If the folder is deleted, moved, or on a disk that is detached, sync stops: nothing is sent, and nothing is written where it was, so the folder is never made again holding only sync's record of every file, which would look like every note deleted. An empty folder made at the same path is not taken for the notebook either. Put back where it was, it carries on. See [a notebook folder that goes missing](#a-notebook-folder-that-goes-missing).

## A notebook folder that goes missing

Deleting a notebook's folder on one device is not a way to delete the notebook: the host and every other device keep it. The Mac app notices within a couple of seconds, stops syncing that notebook, and says so, keeping the note on screen with any text it could not save. Then:

- **Put the folder back where it was**, from the Trash for example, and it carries on by itself.
- **Download it again** fills a new, empty folder at the same place from the host, as the same device, so no invitation is needed. The Mac remembers which host each folder synced with in its own data (`notebooks.json`, beside the encrypted credentials), because the folder's own record went with it.
- **Find it…** opens the folder where it was moved to.
- **Stop syncing it**, for a notebook deleted on purpose, removes this Mac from the host and forgets the credential.

A folder that is missing when the app starts is never made again, empty; the welcome screen offers the same choices. The iPhone keeps its notebook inside the app, out of reach of the Files app, so it does not have this screen; its sync stops in the same way if the folder is ever not there.

## Identity and renames

A move made in the app is reported to sync directly, so the file keeps its identity and history. A move made in Finder or another program is recognised when exactly one file disappeared and one appeared with the same content. A file that is renamed and edited outside the app before the next sync is seen as one file deleted and another created: nothing is lost, but its history starts again.

Two files cannot hold the same path, compared without regard to letter case, since a Mac's disk does not distinguish them. For the same reason a name cannot be a file on one device and a folder on another, and every file in a folder shares one spelling of the folder's name: the first file there decides it, and the host respells later arrivals. Renaming a folder's letter case in the app respells it everywhere. A change of letter case made in Finder is put back, because the app cannot tell it from the disk simply keeping an old spelling. When two devices create the same name, the first to reach the host keeps it and the other is renamed as a conflicted copy. When two devices rename one file differently, the first rename to reach the host stands.

## When something cannot sync

One file that cannot be applied or accepted does not hold up the rest. Everything else syncs, the sidebar says how many files could not, and the sync dialog gives the reason for the first. The host's change is tried again each round, with a growing wait.

A file over 100 MB is left exactly as it is on every device: not uploaded, not overwritten, and not treated as deleted.

## Typing while a change arrives

Sync writes to the file on disk, never into the editor. The editor's own save names the version it started from. If the file has changed, the app combines the two the same way sync does and shows the result, keeping the cursor in place and anything typed in the meantime. If the newest keystrokes touch the very lines that changed elsewhere, they are saved as a separate note.

## Pairing and access

`invite` creates a 12-character single-use code. A device exchanges it for a credential scoped to one notebook, which the desktop app stores outside the notebook folder, encrypted with the Mac's keychain. The host stores only hashes of codes and credentials. Guessing is limited to 20 attempts a minute. A removed device is refused immediately, told that it was removed, and keeps its files; its sync status offers to stop syncing there.

A device that stops syncing (**Settings → Sync → Stop syncing** on a Mac, **Disconnect this iPhone** on the phone) asks the host to remove it, so its credential is no use to anyone afterwards, and then forgets the host. If the host cannot be reached, the device still stops and says that the host lists it until it is removed there: in **Settings → Devices** on a hosting Mac, or with `host remove`.

By default it also deletes its copy: the Mac moves the notebook's folder to its Trash, and the iPhone deletes the notebook it holds and starts afresh. Untick **Move the folder to the Trash** on the Mac, or turn off **Delete the notes from this iPhone**, to keep it. The copy goes only if every note in it reached the host: before leaving, the device sends what is left, and if anything is still waiting, held back by the deletion guard, or refused (a name that cannot sync, a file too large), or the host does not answer within 20 seconds, the copy stays and the device says why. Files that never sync, such as `.obsidian`, go with the folder to the Mac's Trash. A notebook a Mac hosts itself is never deleted this way; neither is one whose host removed the device, since what it holds cannot be checked against the host any more.

The host checks the credential before it reads a request's body, counts wrong invitation codes per caller, and caps what one notebook may store (50 GB by default).

The host validates every path and refuses anything hidden, absolute, or containing `..`. A device validates paths again before acting on them, so a compromised host cannot write outside the notebook folder.

## Wire protocol, version 1

All paths begin `/v1`. Everything except `pair` needs `Authorization: Bearer <credential>`.

| Request                             | Purpose                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| `POST /pair` `{code, device}`       | Spend an invitation. Returns the notebook, the device id and its credential.                     |
| `GET /changes?since=N&wait=S`       | Latest state of each file changed after `N`. Held open up to `S` seconds when idle.              |
| `POST /ops` `{ops}`                 | Propose changes. Each answer is `accepted`, `stale`, `path-taken`, `missing-blob` or `invalid`.  |
| `HEAD` / `GET` / `PUT /blobs/:hash` | File content, addressed by sha256. An upload that does not match its hash is refused.            |
| `GET /files/:id/history`            | Every version of a file, newest first.                                                           |
| `GET /whoami`                       | The device's and notebook's names, for the connection check.                                     |
| `DELETE /device`                    | The device stops syncing: the host removes it, and refuses its credential from then on.          |
| `GET /github`                       | `{copy}`: the notebook's copy in a repository and how it is doing; `{}` when it has none.        |
| `POST /github/sync`                 | Runs a round of that copy now and answers `{copy}` once done. `409`, `429` or `503` say why not. |

A host that has moved answers every request from a device it knows with `410` and `{ moved: "http://new-address" }`. The device checks that the new address is an Opsidian host that accepts its credential, then keeps the same state and carries on there. Moving itself uses `POST /v1/move` with a code from `host move`, then `/v1/move/files`, `/file`, `/freeze`, `/database` and `/finish` with the credential that returns. While frozen, changes are answered `503`. See [hosting](hosting.md#moving-the-host-to-another-machine).

## Not built

- **Pruning history.** The host keeps every version forever. That is what lets a device return after any absence without bringing old data back, and it means the host's disk only grows.
- **Encrypted transport and public-host setup.** See above.
- **A signed, installable host.** The Mac app can host from its settings and a server can run the Docker image ([hosting](hosting.md)), but neither is a signed download yet.
- **A browsable copy on the host.** The host stores versions by content hash, not as a folder of Markdown files. To read a notebook on the host machine, connect a device to it, or keep it on GitHub ([hosting](hosting.md#keeping-notebooks-on-github)).
- **Empty folders.** Folders exist on other devices only once they contain a file.
- **Files over 100 MB** are not synced.
- **Sync while the iPhone app is closed.** The phone uses the same engine and syncs whenever the app is open. See [the iPhone app](iphone.md).
- **Rotating a device credential.**

## Checks

- `tests/sync.test.ts` runs a real host and real notebook folders: propagation, identity through renames, letter-case renames, files trading names, merging, clashes, delete against edit, name collisions, joining two existing copies, the deletion guard, one unsyncable file among others, an oversized file, a two-second liveness bound, repeated requests, a connection that drops 20% of requests, damaged transfers, a crash at every step, and three devices doing random offline work with random connection failures. The random test checks that all devices end identical and that no line anyone wrote is missing unless someone removed it. `OPSIDIAN_FUZZ_SEEDS=200 pnpm test` runs it longer.
- `tests/mirror.test.ts` keeps notebooks in real git repositories: importing one into a new notebook, sending a notebook to an empty one, edits, renames and deletions both ways, lines combined and clashes kept twice, edit against deletion, a push that loses a race, a crash in the middle of a merge, a host restart, the deletion guard, the background loop, and disconnecting. `pnpm test:github` drives the Mac app's GitHub screens against a stand-in for GitHub that speaks real git.
- `tests/move.test.ts` moves a host between real hosts with real devices: everything taken along, devices following by themselves, an edit made while changes are paused, the history keeping its identity, wrong and spent codes, a machine that already hosts refused, a move that fails part-way given up on both sides, moving back with only what is missing sent, and the GitHub checkouts copied with their file modes and links. `pnpm test:move` drives the Mac app taking a headless host over through Settings and then offering it on.
- `pnpm test:sync` starts the host program and the production desktop app. It connects a local notebook with an invitation, has a second device edit the open note and add another, edits one note from both sides at once, restores an earlier version from history, and joins the notebook from a second, empty app.
