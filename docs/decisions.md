# Decision log

Captured from the planning conversation on 2026-09-28.

## Agreed direction

| Decision                                  | Rationale                                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Name: Opsidian                            | Wordplay on Obsidian and self-hosted operations. Availability/trademark checks have not been performed. |
| One monorepo                              | Desktop, mobile, host, and shared behavior evolve together.                                             |
| Obsidian-inspired notebook first          | Writing, Markdown, links, backlinks, and attachments are the product priorities.                        |
| Real Markdown vaults                      | Files remain usable by other editors and future agents.                                                 |
| Desktop first; macOS and iPhone initially | Matches the intended everyday devices.                                                                  |
| Free self-hosted sync                     | The host can be the current Mac, a VPS, or a Tailscale-reachable machine.                               |
| Local copies on every client              | Editing remains usable offline or while the host sleeps.                                                |
| Paper design with light and dark modes    | Three desktop flows have been designed and positively received.                                         |
| Graph and AI later                        | Neither was required to deliver reliable note-taking. The local graph is now built; AI is still later.  |

## Current technical baseline

The build order was accepted after discussing this baseline. These choices guide the implementation; the editor prototype is an explicit validation gate.

- Electron + React + TypeScript + Vite for desktop.
- CodeMirror 6 with custom Live Preview and wiki-link behavior.
- React Native + Expo for iPhone, initially embedding the shared editor in a local WebView.
- Markdown/attachment files plus SQLite indexes and durable sync state.
- Node.js LTS + Fastify for the host.
- One host per synced notebook; revision-based sync with recoverable conflicts.
- Shared pure TypeScript logic and separate platform adapters.
- pnpm workspace; Tailwind v4 with shadcn/ui-named theme tokens.

## Superseded proposals

- **Tauri desktop:** initially chosen for footprint, replaced by Electron for a controlled desktop browser runtime and simpler Node code sharing.
- **App-managed content database with Markdown export:** replaced by actual Markdown vaults.
- **Web-first notes client:** corrected to a desktop-first product; the website is a download/setup entry point.
- **Agent-first product:** explicitly rejected. Optional assistance may follow the core notebook.
- **Third-party cloud storage as the default sync transport:** replaced by a user-chosen Opsidian host.

## Explicitly unresolved

- External-rename identity strategy, and whether renaming rewrites links in other notes.
- Supported Markdown/Obsidian syntax compatibility matrix.
- iPhone editor acceptance after real-device testing.
- Sync wire schema, merge implementation, journal layout, retention and rebootstrap rules.
- Background-host packaging and co-located app/host coordination. (Host migration: see "Moving the host — 2026-10-23".)
- Certificate and onboarding experience for public versus Tailscale hosts.
- Attachment caching, size policies, and history/backup retention.
- Final typography, mobile designs, and conflict/history UI.
- Release distribution details and signing.

These are implementation design tasks, not reasons to block the editor prototype.

## Desktop notebook implementation — 2026-10-13

- **Obsidian palette, Tailwind and shadcn/ui.** Requested by the user so the theme is portable. Replaces the maritime palette and CSS Modules.
- **Filename is the title.** Follows Obsidian. Replaces the earlier "first line becomes the title" idea from the UX discussion.
- **In-memory index for now.** Links and search are indexed in memory in the Electron main process. SQLite with FTS5 remains the plan; it was deferred, not rejected.
- **Conflicts keep both versions.** A save that finds a changed file leaves the file alone and writes the edit as a `conflicted copy` note. This is the local rule only; sync conflict handling is still undesigned.
- **Large paste was not slow.** The 4.6 s figure in the prototype notes measured `webContents.insertText`, the native text-input path. A real clipboard paste of the same 96 KB note reaches the editor in about 25 ms, and 1 MB in about 50 ms.

## Desktop notebook completion — 2026-10-13

- **The in-memory index stays.** Measured on 5,000 notes: 290 ms to open, 3 ms to search. SQLite with FTS5 is no longer planned for the local notebook; revisit it if sync needs a durable store or notebooks grow far beyond this.
- **Links are rewritten only when they would break.** After a rename or move, a link is changed only if it would no longer reach the same note, and then to the shortest text that does: the note's name, or its path when the name is shared.
- **Trash stays Obsidian's `.trash`,** flat, with a hidden manifest recording where each item came from so it can be put back. Emptying it moves the contents to the Mac's Trash rather than deleting them.
- **An edit waits at most a second.** The crash test showed that uninterrupted typing was never saved until a pause, because each keystroke restarted the 160 ms timer. The save queue now also writes at least once a second.
- **Temporary save files are hidden,** so Obsidian, the file watcher and the note list never see them.
- **Images up to 25 MB on desktop.** They are served from disk, so the 5 MB limit that suits the phone's in-memory images does not apply.

## Sync implementation — 2026-10-14

- **Near real time, not live co-editing.** Confirmed with the user. Saved versions travel; a change reaches the other device in about a second. A CRDT stays out of scope.
- **The host orders, devices reconcile.** The host accepts a change only if it was made from the file's current version, and never merges. Merging is three-way and line-based, on the device.
- **No pending queue.** A device derives what to send by comparing its folder with the last state it agreed with the host, so there is no queue to corrupt.
- **File identity is a host-issued id per file.** App-made moves are reported exactly; outside moves are recognised by unchanged content. No ids are written into notes.
- **History is never pruned for now.** This removes tombstone collection and rebootstrap from the first version, at the cost of host disk.
- **The host stores versions by content hash,** not a Markdown folder, so the desktop app and a host on the same Mac never write the same files.
- **Sync state lives in `.opsidian/` in the notebook; the credential does not.** It is kept in the app's own data, encrypted with the keychain.
- **Still open:** transport encryption and certificates, packaging the host, history retention, host migration.

## iPhone app — 2026-10-14

- **The phone runs the Mac's notebook code, not a second implementation.** The vault and sync service moved to `packages/notebook` behind a `Platform` interface, so link rewriting, the trash, merging and every sync fix are shared.
- **One notebook per phone,** in the app's Documents folder. A notebook can start on the phone and connect later.
- **Saves are made crash-safe in the app,** because iOS cannot replace a file in one step: write beside, mark complete, swap, and finish the swap at next launch if interrupted.
- **Sync runs only while the app is open.** Background sync is not attempted.
- **Plain `http` is allowed,** matching the Tailscale-only decision for the host. To revisit before an App Store release.
- **Pairing is typed.** An `opsidian://connect` link fills the form but never connects by itself, so a link cannot attach a notebook to someone else's host.
- **No navigation library and no icon library.** The app has a dozen screens and a plain stack is enough.

## Setup — 2026-10-14

- **The Mac app can be the host.** Hosting is a switch in Settings that runs the same host inside the app and keeps it alive from the menu bar. There is no second program to install. A server runs the same host from a Docker image.
- **Encryption is left to Tailscale.** The host is published on a home network or a Tailscale address, never the open internet, so no certificates are managed.
- **Backups are snapshots in a folder the user chooses,** with content stored once and shared between snapshots. History is still never pruned.
- **A restore changes the host's `generation`.** Devices that see a new one keep their files, take the restored host's version of each as the agreed starting point, and send their differences up as ordinary changes. This avoids conflicted copies after a restore; the cost is that deletions made after the backup are undone.
- **An invitation is also a link,** `opsidian://connect`, shown as a QR code. Scanning or opening it only fills in the form.
- **The connection check never sends a device's credential to an address** until that address has answered as an Opsidian host.
- **Not built:** signed and packaged apps, automatic updates (milestone 6); pruning old history; backing up from a Mac that is not the host.

## Local graph — 2026-10-19

- **Local first.** The open note and a 1–3 hop neighbourhood, both directions. A toggle shows the whole notebook on the same view. A separate global-graph product is not the first job.
- **One snapshot from the index.** `NoteIndex.graph()` walks every note once, using the same resolver as the editor. Per-note `backlinks()` would have been quadratic and could have drifted.
- **Unresolved targets are nodes.** They can be hidden, and clicking one creates the note, matching a dashed wiki link.
- **Worker, then freeze.** d3-force runs off the typing path. When the layout settles, the worker and the draw loop sleep. Display sliders redraw only.
- **Canvas now, WebGL later.** A `GraphRenderer` interface keeps that door open. Path is identity; a rename is a new node unless exactly one path left and one arrived.
- **Still later:** tag and attachment nodes, time-lapse, hover previews, a mobile renderer, 3D.

## GitHub — 2026-10-22

- **A notebook can be kept in a GitHub repository, both ways.** Requested by the user, for an off-site copy that stays readable, and for starting a host from notes already on GitHub. Built for the headless host (Linux and macOS) and the Mac app.
- **GitHub is a device, not a second sync protocol.** The host keeps a git checkout of the notebook in its data folder and syncs it with the same engine as the Mac and iPhone, through the host's own routes in-process. Around that, each round commits, merges what was pushed to GitHub, lets the engine send it on, and pushes. So merging, conflicted copies, the deletion guard and file identity are the ones sync already has. The alternative, writing files straight from the host's database into git, would have needed a second merge implementation.
- **git merges; clashes are kept twice.** Where both sides changed the same lines, the notebook's version keeps the name and GitHub's is written beside it as `conflicted copy GitHub`. Nothing is force-pushed. A push that loses a race fetches, merges and tries again.
- **The host does it, not a device.** It is always on, and it is the only place every change passes through. The host already keeps the full history, so the repository is a copy, not the backup of record.
- **Sign-in is GitHub's device flow, with the `repo` scope.** Chosen for the smoothest setup on both a Mac and a headless server: a code to enter on github.com, nothing to paste or store by hand. A deploy key per repository was considered; it is safer in scope but asks the user to add a key on GitHub for each repository. Fine-grained tokens expire and must be pasted. A GitHub App would allow per-repository access but complicates making a new repository. The token is kept in the keychain on a Mac and in a file readable only by the user on a server, and is handed to git per command through a credential helper, so it is never written into git's configuration or the machine's own credential store.
- **The system's git is used,** not a JavaScript implementation, for its merging and its handling of large repositories. A Mac without the command line tools is offered them by macOS the first time.
- **Needs an OAuth app registered on GitHub** with the device flow enabled; its client id is in `apps/host/src/github.ts`. Until it is, the command line can sign in with a token (`gh auth token | opsidian host github login --with-token`).
- **Not built:** Git LFS, choosing a branch other than the repository's default, and the iPhone app (which never hosts).

## GitHub schedule — 2026-10-23

- **Copies go to GitHub hourly by default.** Requested by the user, who keeps notebooks on GitHub as a backup and asked for "every hour-ish" without hitting GitHub's limits. Until now each copy followed every change: a commit and push about ten seconds after each burst of typing, and a fetch every minute per notebook.
- **Why hourly:** the intent is a backup, which an hour's lag does not weaken; history is quieter, one commit per round holding everything since the last; and GitHub is asked far less. A round where neither side changed is one `git ls-remote`, so an idle notebook costs one small request an hour; a busy one at most three (check, fetch, push).
- **One setting per host,** with the choices live, 15 minutes, 1 hour, 6 hours and 24 hours. Live is the previous behaviour, kept for those who want GitHub to follow along. **Sync now** and `host github sync` still run a round at once.
- **The setting lives in the host's database,** not in `host.json` or the Mac app's `hosting.json`, so every way of running a host reads the same value (the service, `host run` in Docker, which has no settings file, and the Mac app's host thread), and the command line can change it while the host runs. A restore from backup brings back the setting the backup had.
- **Stopping the host flushes,** within 20 seconds on a server and 8 in the Mac app so quitting never hangs. A host that was off catches up soon after it starts. Copies are spread a little apart so a host with many notebooks does not ask GitHub for all of them at once.
- **Git traffic is not GitHub's REST API.** The API's 5,000 requests an hour covers only sign-in and listing or making repositories, never background rounds. Git requests are throttled by GitHub's undocumented secondary limits instead; when GitHub says so, the copy waits at least an hour and shows when it will try again.
- **The host's own history remains the backup of record.** GitHub is a readable off-site copy; status warns when it is more than twice the schedule behind, rather than staying silent.

## Moving the host — 2026-10-23

- **A host can move between machines at any time, and devices follow by themselves.** Requested by the user, for switching among a Mac mini, a VPS and a MacBook. This settles "host migration", listed as unresolved above.
- **The whole host moves, not one notebook.** Devices, history and GitHub copies go together, so a move is one step and nothing is left split between machines.
- **The new machine pulls, with a single-use code made on the old host** (`host move` there, `host take-over ADDRESS CODE` here, or Settings in the app). A device's own credential was considered as the authority, so that a MacBook could take over without touching the old host. It was rejected: any device, including a lost phone, could then redirect every other device to a host of its choosing.
- **Copy live, then pause briefly.** File contents and the GitHub checkouts are copied while devices keep syncing; changes are then refused (`503`) only while what changed meanwhile and a consistent copy of the database are taken. Devices need no queue for this, since what they have not sent is worked out from the folder.
- **The history keeps its identity.** The database moves whole, `generation` included, so devices carry on exactly where they were instead of meeting the host afresh as after a restore. The new machine refuses to replace a host that is not an old copy left by moving away.
- **The old host points the way, and devices check before following.** It answers devices it knows with `410` and the new address. A device follows only if the new address answers as an Opsidian host and accepts its credential, which only the same host can. The new host starts serving before the old one is told, so devices sent there find it running. A device that missed the move can be given the address by hand, with the same check.
- **The GitHub schedule moves with the host,** since it is kept in the host's database.
- **Not moved:** the GitHub sign-in (kept per machine, in the keychain or a file only its user can read), backup settings, and unused invitations.
- **Not built:** changing the address by hand on the iPhone (it follows a move by itself, through the shared sync service), and a way to undo a finished move other than moving back.

## Opsidian's own files in a repository — 2026-10-23

- **`.opsidian` and `.trash` are taken out of a repository that has them,** in one labelled commit, and added to its `.gitignore`. Found when connecting the user's existing vault repository, which had a Mac's sync state and trash committed by hand. Left in place, the host's copy would have committed its own sync state on every round and handed it to every clone. Untracking them in each copy's checkout only was considered; a merge of someone else's commit would still have overwritten the copy's state. A merge that brings them back sets the copy's own folders aside and restores them afterwards.
- This narrows "hidden files are left alone": other hidden files, such as `.obsidian` and `.DS_Store`, still are.

## Hosting beside development — 2026-10-23

- **One machine can host real notebooks and be where Opsidian is developed.** Requested by the user, who wants this server to be their host and keeps developing on it.
- **A service per data folder.** The real host in `~/.opsidian` keeps `opsidian-host.service` (and `sh.ferran.opsidian.host`); every other folder's service is named after it. Before, every host on an account shared one name, so starting or removing a test host replaced or stopped the real one. A service an older version made for a folder other than `~/.opsidian` under the plain name is taken over by that folder's next `start` or `stop`.
- **`pnpm host` is a development build** with its own home, `~/.opsidian-dev`, and port 4811. It refuses `~/.opsidian` unless `--production` is given, since a work-in-progress build could change the real database. Separate users or containers were considered; they need root or Docker, which a development server may not have.
- **Tests run with a home of their own**, set before any test file, and the hosts they start listen on `127.0.0.1`, not on a server's public address.
- **The Mac app's development runs keep their own data,** in `Opsidian Development`, and host on port 4811. This replaces "the app's data folder is `Opsidian` for installed and development copies alike" from the release decisions: a development run could otherwise rewrite the installed app's host. Data development runs left in `Opsidian` stays there, unused by them.

## Disconnecting, and a notebook folder that goes missing — 2026-10-25

- **Stopping sync on a device removes it from the host.** Requested by the user, to make disconnecting a client easy. Before, "Stop syncing" only forgot the host on the device: the host kept listing it, with a credential that still worked. The device now asks the host to remove it (`DELETE /v1/device`) and then forgets the credential. If the host cannot be reached it stops anyway and says the host still lists it. A removed device is told so, distinctly from other failures, and offered to stop syncing there. `host remove` (formerly `host revoke`, still accepted) takes a name as well as an id.
- **A missing notebook folder is not a deletion.** Raised by the user: what happens when a synced folder in Documents is deleted? Sync was safe only by accident, and two paths could empty the notebook everywhere: saving sync's state made the folder again (`mkdir -p`) holding only its record of every file, which the next round sent as every note deleted unless the deletion guard caught it; and the app made a missing remembered folder again, empty, at launch. Now a notebook is the folder on disk it was opened as, not just its path: if it is gone, or a different folder stands there, sync reads and writes nothing until it is back, and only folders being made for a new notebook are ever created.
- **The deletion guard also holds back every file vanishing at once,** however small the notebook. It had needed at least ten.
- **Each folder's host is remembered outside the folder,** in the Mac app's `notebooks.json`, without credentials. A deleted folder takes its own record with it, so this is what lets it be downloaded again as the same device, without an invitation, or given up so the host forgets the device. Asking for a new invitation instead was considered; it would leave the old device behind on the host and needs the host machine at hand.
- **While the folder is missing, the open note stays on screen** with any unsaved text, which can be copied out; putting the folder back where it was carries on by itself. The iPhone keeps its notebook inside the app, out of the Files app's reach, so it has no such screen.

## Deleting a notebook from the host — 2026-10-29

- **A notebook can be deleted from its host,** from Settings → Sync on a hosting Mac or with `host delete "Name"`. Requested by the user, who had disconnected a host's devices and found no way to remove the notebook itself; until now only `host uninstall --delete-data`, which takes every notebook, could. This is deletion asked for by name, not pruning: "history is never pruned" still holds for notebooks that are kept.
- **Only the host's own machine can delete.** A device's credential was considered, so a Mac connected to a server could delete from its Settings. It was rejected for the reason a device cannot move the host: any device, including a lost phone, could then delete what every other device holds. The device's "Stop syncing" dialog says where to delete instead.
- **The command line asks by saying what goes.** Without `--yes`, `host delete` lists the files, history, devices and GitHub copy that would go, deletes nothing, and exits non-zero. An interactive prompt was not used, since nothing else in the command line asks one and a server is often driven by scripts.
- **A backup comes first, when backups are set up,** and nothing is deleted if it fails. Without backups, deleting cannot be undone, and both the dialog and the command say so.
- **Its devices stay in the database, removed.** Deleting their rows was simpler, but a restore from an older backup would then have let them back in. Kept, they are refused, told that the notebook was deleted rather than that they were removed, and stay refused after a restore.
- **Everything else of the notebook goes at once:** its files, log, stored content, invitations, settled-change records and its GitHub checkout. The repository on GitHub is left as it is. A copy running in another process, as when `host delete` runs beside the service, is stopped and its checkout removed when that process next looks at its copies.

## Starting over, and deleting a device's copy — 2026-10-29

- **A host can be reset to how it was before it was set up,** from Settings → Sync on a hosting Mac or with `host reset`. Requested by the user, who had deleted the Mac app's data folder by hand. Asked how much a reset should take, the user chose everything, as on a fresh install, over the host's data alone: on a Mac the host, settings, backup settings, the GitHub sign-in and its access to every host; on a server the whole host folder and its service. `host uninstall --delete-data` already did the server's part; `reset` adds saying what goes, refusing a host it does not manage that is still running, and the backup.
- **Notebook folders survive a reset.** On a hosting Mac they hold the only copy outside the host's history, so they keep their notes and stop syncing, and each host the Mac synced with is told to forget it. Hosts that cannot be reached still list it until it is removed there.
- **The Mac's reset is typed, not clicked:** the dialog asks for the word `reset`, the only action in the app that does, since it takes every hosted notebook at once. The app restarts afterwards rather than emptying itself in place, so nothing from before survives in memory.
- **Stopping sync on a device deletes its copy, by default.** Requested by the user. The user chose a checkbox, on by default, over always deleting, and asked for the iPhone too. The Mac moves the folder to its Trash, where it can be recovered; the iPhone, which has no Trash, deletes its notebook and starts afresh.
- **Only a copy the host has in full is deleted.** This narrows "every file stays" from the 2026-10-25 decisions. Before leaving, the device sends what is left and checks that nothing is waiting, held back by the deletion guard, or refused, within 20 seconds; otherwise the copy stays and the device says why. Deleting whenever asked was rejected: an offline device would lose every edit the host never received. A notebook a Mac hosts itself is never deleted this way, nor one whose host had already removed the device.
- **Still to check on a real iPhone:** the switch in the Disconnect sheet, and the app starting afresh once its notebook is deleted. It has been typechecked, not run.

## Updating the host — 2026-10-29

- **The host for servers is published to npm on every change,** by the release workflow, with the same version as that run's Mac app. Raised by the user, who found the server on this machine still on the version installed by hand: npm had only 0.1.1, published once by hand, and nothing updated an installed host, which runs its own copy of the program in `bin`.
- **Installed hosts update themselves each night, and `host update` does it on demand.** The user asked for both. The time is 04:00, after the default backup hour, so a backup made that night precedes the change; another is made just before when backups are set up.
- **Published by npm's trusted publishing,** with no token in GitHub's secrets. A token was the alternative; it would have to be renewed, and could publish from anywhere if it leaked. A maintainer links the package to the workflow once (`docs/release.md`).
- **npm, not the GitHub release.** Attaching the program to the Mac app's release would have needed no npm setup, but a release is made only when the Mac app changes, and `npx opsidian host start` installs from npm anyway, so one place serves new and existing hosts.
- **Checked before it replaces anything.** The download must match the checksum npm publishes for it, say the version it claims, and start as an empty host of its own. Then it replaces the program, keeping the old one, and the host exits for its service to start the new one; launchd and systemd both start it again whenever it stops. A version that fails to start on the host's data, except for its address not being there yet, puts the old program back and is not tried again. A version that starts and then fails later is not caught; going back is `host update` once a fixed version is out, or a backup.
- **Only a host `host start` installed is updated:** not one run in Docker, whose image is the version, nor `host run` by hand, nor a development build.

## Tables — 2026-10-29

- **Live Preview and Reading view draw tables,** on the Mac and on the iPhone, which share the editor. Raised by the user, whose tables showed as raw bars on both.
- **Clicking a table shows its Markdown, with the cursor in the cell clicked.** This is how Obsidian behaved before its in-place table editor (Obsidian 1.5), and how the editor already treats headings and links. Obsidian's current behaviour, where the table stays drawn and only the cell clicked is edited, with menus for rows and columns, was considered and left for later at the user's choice: it needs an editor inside each cell, and touch and keyboard behaviour on the iPhone that has to be checked on a device. The table parser and the drawn table are the parts it would build on.
- **Cells are drawn as text, never as HTML.** Bold, italic, strikethrough, code and wiki links are drawn; anything else, including HTML, shows as written.
- **Only tables at the top level of a note are drawn.** A table in a quote or list stays as text, since drawing it would hide the quote marks or the list around it.
- **Columns are sized to be read, and a wide table scrolls sideways.** Raised by the user, whose table squeezed dates and titles into slivers. A column whose cells are all short, such as dates or numbers, stays on one line; any other column keeps a minimum width, and words break only when they cannot fit on a line of their own. Columns cannot be resized: a Markdown table has nowhere to keep a width, Obsidian does not offer it either, and widths kept per device would not travel with the note.
- **Web addresses in cells are drawn short.** A bare address shows without `https://` or `www.`, cut with an ellipsis past 30 characters; `[text](address)` shows its text. The whole address shows on hover and stays in the file unchanged. They cannot be opened from the table yet: that needs the editor to ask the app to open an address, which neither the Mac nor the iPhone app has.
- **Still to check on a real iPhone:** tapping a cell to edit it, and scrolling a wide table sideways inside the note.

## Future AI direction

Potential features: organize a messy thought, answer questions over notes with citations, and suggest related notes. A machine-hosted agent and supported Codex/ChatGPT sign-in were explored. No AI integration is committed for the initial milestones; re-check product access and integration documentation when that work begins.

## Prototype implementation — 2026-09-28

Milestone 1 uses a fixed single-note directory to isolate editor validation from vault management. Desktop writes Markdown atomically through Electron IPC. Mobile uses a SQLite latest-content recovery journal before materializing its app-owned Markdown file; this is prototype recovery state, not a replacement for the planned file-based vault or a sync journal. Native iPhone keyboard acceptance remains unresolved.

## Release — 2026-10-14

- **The name is Opsidian everywhere.** The earlier working label "Writer" is retired, including the download page, which becomes `ferran.sh/opsidian`.
- **TestFlight only for the iPhone.** An App Store release is not planned for now. The plain `http` allowance therefore does not need an App Store review justification yet.
- **Permissive licences.** Code is `MIT OR Apache-2.0`, at the user's choice; Apache adds an explicit patent grant. Documentation and design, including the logo, are CC0 1.0. CC0 does not cover trademarks, so the name and logo still identify the project. See `LICENSE`.
- **The Mac app's host runs on a worker thread,** not on the app's main thread. Its database work is synchronous, and a backup copies the whole database in one step; on the main thread that stalled every window for as long as it took (310 ms for a 300 MB host in the test). A thread costs far less memory than a separate process, which matters for an app that stays in the menu bar.
- **A host notebook belongs to one folder.** The app remembers which folder each hosted notebook is, by path. A second folder with the same name becomes "Name 2" instead of merging into the first.
- **Logo: Two halves.** An O made of two arcs, two devices meeting. Chosen over five other directions and six generated by GPT-6.1 Sol because it says what Opsidian does, stays clear at 16 px for the menu bar, and looks nothing like Obsidian's crystal. Sources are in `design/logo`.
- **The Apple Developer Program membership is in place,** so Mac signing, notarisation and TestFlight are not blocked on it.
- **A headless host is an npm package, `opsidian`.** `npx opsidian host start` returns at once and leaves the host running. Every command sits under `host`, leaving room for others later.
- **The system's service manager keeps it running:** launchd on a Mac, systemd on Linux (a user service, or a system one for root). A process that merely detached from the terminal would not restart after a crash or a reboot. `start` copies the program to `~/.opsidian/bin`, because the service must not depend on npx's cache, which can be cleared.
- **It listens only on Tailscale's address by default.** The host has no sign-in of its own. Without Tailscale a Mac falls back to the home network and says so; a Linux server refuses, since its address is usually public, unless an address is given with `--address`.
- **Backups are scheduled inside the host,** the same daily rule the Mac app uses, so a server needs no cron.
- **The Mac app is packaged with electron-builder** and updated with electron-updater from GitHub releases. Everything the app runs is bundled at build time, so no `node_modules` are shipped. Separate Apple silicon and Intel downloads keep each half the size of a universal one.
- **The repository becomes public,** so its releases page can serve updates without a token. The code was already permissively licensed; the history was checked for secrets first.
- **The app's data folder is `Opsidian`** for installed copies (development runs: see "Hosting beside development — 2026-10-23"). Development copies used `@opsidian/desktop`; that data is not moved, because device credentials are encrypted with a keychain key named after the app, and the name changed.
- **Every push to `main` that changes the Mac app is a release,** built and published by GitHub Actions as `<major>.<minor>.<run number>`. T3 Code's nightly-then-promote channels were considered; with one developer, a single channel is enough. Tests gate the release; releases run one at a time and are never cancelled midway.
- **Updates follow Agentic Studio's pattern:** one update state owned by the main process, offered in the window and Settings, downloaded when asked, and read from the latest release's `latest-mac.yml` directly rather than GitHub's cached release list, which made the app say it was up to date when it was not.
- **The iPhone app ships through EAS, as T3 Code's does:** builds and TestFlight submission by EAS, and JavaScript-only changes over the air (expo-updates, fingerprint runtime version), decided per push by comparing fingerprints. Building with Xcode on GitHub Actions was the alternative; it would make every change a full TestFlight build.
- **The iPhone app's layout follows Obsidian's too.** It opens on the last note rather than a home screen, the files slide in from the left, and a bottom bar holds back, forward, new note, search and the note's menu. Its icons are drawn with views, not an icon library, so the change ships over the air without a new TestFlight build.
- **The window waits to close only for what registered work to save.** It had waited for a reply only the editor gave, so quitting hung on every other screen.
- **The Mac app's layout follows Obsidian's.** Sync status moved from the sidebar to a status bar in the bottom corner, as Obsidian Sync shows it; the notebook menu, help and Settings sit at the foot of the sidebar; the note's own actions are in a ⋯ menu beside a reading-view switch; and the formatting toolbar gave way to the right-click menu. Settings has two groups, Options (General, Editor, Appearance) and Sync (Sync, Devices, Backups), with one row per setting. Designs are on the "Cleanup — like Obsidian" page in Paper.
