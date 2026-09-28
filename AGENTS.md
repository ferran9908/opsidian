# Working on Opsidian

Read README.md and docs/decisions.md before implementation. Consult the relevant architecture and milestone documentation for the task.

## Product constraints

- Desktop first, initially macOS, with an iPhone companion.
- Real Markdown files and attachments are the content foundation.
- Editing and local saving must work without the host or internet.
- Sync uses a user-chosen host: the current Mac, a VPS, or a reachable Tailscale device.
- No required central account or paid sync service.
- Match Obsidian-style editing behavior; do not assume full plugin or format compatibility.
- Graph view, AI, plugins, and simultaneous multiplayer editing are deferred.

## Engineering boundaries

- Electron is the current desktop choice. Tauri was considered and superseded.
- Shared core and sync code must not import platform-specific filesystem or UI APIs.
- Never silently overwrite conflicting note content or pending local edits.
- Treat search indexes as rebuildable and sync journals/history as durable data.
- Keep sync, file I/O, and indexing off the typing path.
- Render note content as untrusted content; expose a narrow typed native bridge.
- Keep user vaults, secrets, pairing credentials, and local test data out of Git.
- Do not claim unimplemented app or sync functionality based on scaffold checks.

## Validation

Run pnpm check for relevant changes. Add behavioral tests when implementing persistence, Markdown parsing, sync, and recovery. Verify the editor on an actual iPhone; a simulator alone does not settle keyboard and touch behavior.

Update the decision log when an architectural choice changes. Preserve the distinction between an agreed direction, an implementation proposal, and an unresolved question.
