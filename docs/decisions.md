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
- pnpm workspace; CSS Modules and semantic theme tokens.

## Superseded proposals

- **Tauri desktop:** initially chosen for footprint, replaced by Electron for a controlled desktop browser runtime and simpler Node code sharing.
- **App-managed content database with Markdown export:** replaced by actual Markdown vaults.
- **Web-first notes client:** corrected to a desktop-first product; the website is a download/setup entry point.
- **Agent-first product:** explicitly rejected. Optional assistance may follow the core notebook.
- **Third-party cloud storage as the default sync transport:** replaced by a user-chosen Writer host.

## Explicitly unresolved

- Final note title/filename behavior and external-rename identity strategy.
- Supported Markdown/Obsidian syntax compatibility matrix.
- iPhone editor acceptance after real-device testing.
- Sync wire schema, merge implementation, journal layout, retention and rebootstrap rules.
- Background-host packaging, co-located app/host coordination, and host migration.
- Certificate and onboarding experience for public versus Tailscale hosts.
- Attachment caching, size policies, and history/backup retention.
- Final typography, mobile designs, and conflict/history UI.
- Release distribution details, signing, and App Store requirements.

These are implementation design tasks, not reasons to block the editor prototype.

## Future AI direction

Potential features: organize a messy thought, answer questions over notes with citations, and suggest related notes. A machine-hosted agent and supported Codex/ChatGPT sign-in were explored. No AI integration is committed for the initial milestones; re-check product access and integration documentation when that work begins.

## Prototype implementation — 2026-09-28

Milestone 1 uses a fixed single-note directory to isolate editor validation from vault management. Desktop writes Markdown atomically through Electron IPC. Mobile uses a SQLite latest-content recovery journal before materializing its app-owned Markdown file; this is prototype recovery state, not a replacement for the planned file-based vault or a sync journal. Native iPhone keyboard acceptance remains unresolved.
