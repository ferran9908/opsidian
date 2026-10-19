# Build order

Milestone 1 is implemented as a single-note prototype and is awaiting real-iPhone acceptance. Milestone 2 is implemented and passes its automated exit checks; whether it is usable as a daily notebook is for the user to judge. See [the desktop notebook](desktop-notebook.md). Milestone 3 is implemented and passes its automated checks; it has not yet been run between two physical Macs. See [sync](sync.md). Milestone 4 is implemented and was exercised in the iPhone simulator against a real host; its exit gate needs a real iPhone. See [the iPhone app](iphone.md). Milestone 5 is implemented: hosting from the Mac app, invitations with a QR code, device management, backup and restore, a connection check, and a server image. It passes its automated checks; the exit gate needs a person setting it up unaided. See [hosting](hosting.md). Milestone 6 is pending. See also [prototype setup and validation](editor-prototype.md).

## 1. Prove the editor on Mac and iPhone

Build a minimal Electron app and an Expo development app with the shared CodeMirror editor. Implement headings, lists, checkboxes, live formatting, wiki-link suggestions, inline images, Source mode, and local persistence.

**Exit gate:** Real-iPhone typing, autocorrect, dictation, selection, undo, composition, and keyboard behavior are acceptable. Long notes remain responsive. Edits survive normal close/reopen. Decide whether the shared WebView editor is the right mobile foundation before expanding the app.

## 2. Build the local desktop notebook

Implement the Paper interface, light/dark/system themes, vault creation/opening, note/folder operations, autosave, external-edit reconciliation, search, backlinks, attachments, trash, and durable save recovery.

**Exit gate:** Opsidian is usable as a daily Mac notebook. Saved work survives restarts and tested crashes. External edits are detected without silently replacing unsaved content. Other editors can still use the vault.

## 3. Make two desktop clients sync reliably

Implement the host and pair two distinct vault copies. Add queues, revisions, attachments, renames, deletion records, history, and conflict recovery. Begin with a development host, then deploy to the chosen machine.

**Exit gate:** Clients converge after reconnecting; conflicting work stays recoverable. Exercise duplicate requests, interrupted transfers, concurrent offline edits, rename collisions, delete-versus-edit, clock skew, and crashes between journal/database/filesystem operations. Status accurately distinguishes local durability from completed sync.

## 4. Build the iPhone companion

Expand the prototype with pairing, notebook navigation, search, backlinks, photo/file attachments, editing toolbar, and the shared sync implementation. Handle suspension, resume, network changes, and interrupted saves.

**Exit gate:** Write offline on the phone, reconnect, and see the changes on Mac; verify the reverse. Mobile lifecycle tests pass on a real device.

## 5. Make setup approachable

Package the Mac host and document/package VPS deployment. Add invitations, connection diagnostics, revocation, backup/restore, empty states, and helpful errors. Explain any Tailscale prerequisite in setup.

**Exit gate:** Configure a host, send an invitation, and let a nontechnical user connect and write without a walkthrough. Restore a notebook and its history from backup successfully.

## 6. Release

Ship signed desktop builds and updates. Test iPhone builds through TestFlight. An App Store release is not planned for now. Publish downloads and setup guidance at `ferran.sh/opsidian` when release work is authorized.

**Exit gate:** Someone outside the development setup can install, connect, write, sync, and update. Verify database/vault migrations preserve content and support recovery.

## Validation strategy

Use behavioral tests for parsing, persistence, and sync; multi-client integration tests with controlled failures; and real-device editor checks. Avoid treating static screenshots or empty package typechecks as product acceptance.

Initial performance targets from planning are provisional: under 100 ms for typical note opening and search, smooth typing/scrolling during sync, and quick usable startup. Define representative devices and vault fixtures, then measure release builds. Do not promise numerical targets until benchmarked.

## Later

A fuller graph (tag nodes, attachments, time-lapse), AI assistance, ChatGPT subscription integration, plugins, canvas, and real-time collaboration are outside these milestones. The local graph is in the desktop app; see [graph](graph.md).
