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
| Graph and AI later                        | Neither is required to deliver reliable note-taking.                                                    |

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
- **Third-party cloud storage as the default sync transport:** replaced by a user-chosen Writer host.

## Explicitly unresolved

- External-rename identity strategy, and whether renaming rewrites links in other notes.
- Supported Markdown/Obsidian syntax compatibility matrix.
- iPhone editor acceptance after real-device testing.
- Sync wire schema, merge implementation, journal layout, retention and rebootstrap rules.
- Background-host packaging, co-located app/host coordination, and host migration.
- Certificate and onboarding experience for public versus Tailscale hosts.
- Attachment caching, size policies, and history/backup retention.
- Final typography, mobile designs, and conflict/history UI.
- Release distribution details, signing, and App Store requirements.

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

## Future AI direction

Potential features: organize a messy thought, answer questions over notes with citations, and suggest related notes. A machine-hosted agent and supported Codex/ChatGPT sign-in were explored. No AI integration is committed for the initial milestones; re-check product access and integration documentation when that work begins.

## Prototype implementation — 2026-09-28

Milestone 1 uses a fixed single-note directory to isolate editor validation from vault management. Desktop writes Markdown atomically through Electron IPC. Mobile uses a SQLite latest-content recovery journal before materializing its app-owned Markdown file; this is prototype recovery state, not a replacement for the planned file-based vault or a sync journal. Native iPhone keyboard acceptance remains unresolved.
