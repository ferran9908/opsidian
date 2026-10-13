# Editor prototype

Milestone 1 implementation, 2026-09-28. This is a single-note editor experiment. The real-iPhone acceptance gate remains open.

## Run

Use Node 24 and pnpm 12.4.1, then `pnpm install`.

- `pnpm dev:desktop`: build Electron main/preload, start Vite, launch the Mac app.
- `pnpm dev:preview`: browser UI preview at http://127.0.0.1:5173. Its IndexedDB data is separate from desktop files.
- `pnpm dev:mobile`: bundle the shared editor locally and start Expo for a development build.
- `pnpm build:mobile-editor` followed by `pnpm --filter @opsidian/mobile exec expo run:ios --device`: create/install the iOS development app with Xcode and signing configured. Rebuild the editor bundle after editing shared editor code; restart Metro if the generated module is cached.

No host, account, network service, or subscription is required to edit. The website/download flow, multi-note vault management, sync, and App Store packaging are later work.

> The desktop sections below describe the milestone 1 prototype. The desktop app has since moved to a real notebook folder; see [desktop-notebook.md](desktop-notebook.md). The mobile sections and the iPhone acceptance list are current.

## What works

Electron + React desktop and Expo + React Native WebView share CodeMirror 6 behavior: headings, emphasis, lists, task toggles, link suggestions, local raster images, undo/redo, Live Preview, and Source mode. Live Preview reveals syntax around the selection. Desktop includes the Paper-derived shell and light/dark/system themes. Mobile includes a keyboard toolbar and light/dark toggle.

Wiki suggestions use three sample titles. A link remains ordinary `[[Markdown]]`; opening another note is intentionally deferred. This is a subset of Obsidian editing, not full syntax or plugin compatibility. HTML and remote images are not rendered. Imported PNG, JPEG, GIF, and WebP images are limited to 5 MB each.

## Storage and boundaries

Desktop uses `~/Documents/Opsidian Prototype/Sunday.md` and an adjacent `attachments` directory. Set `OPSIDIAN_VAULT_DIR` to choose a prototype directory. The first Markdown heading controls the displayed title, not the filename. The renderer has no Node access and uses narrow preload IPC. Electron owns native dialogs and filesystem writes.

Writes are serialized and debounced. A saved indication follows native acknowledgement. Desktop writes a temporary file, fsyncs it, renames it, and fsyncs the directory. Normal close flushes pending edits. If the note changed externally, the save is rejected and the pending text is preserved in `Recovered-<id>.md`; reopen after reconciling the files. This prototype detects changes on save; it does not yet watch/reload external edits or offer conflict UI. Detection is not an atomic lock against other editors. A sudden process kill can lose edits not yet acknowledged as saved.

Mobile stores `Opsidian/Sunday.md` and attachments in the app document directory. A SQLite WAL journal commits the latest text before materializing the file. On restart it restores the Markdown file from that journal, covering interruption between those operations. This mobile prototype directory is app-owned; external editing/import/export needs a separate reconciliation design. Backgrounding requests a flush, but iOS suspension can interrupt unacknowledged work. Saved status never means synced.

Image data is currently loaded into memory per note; lazy attachment caching and large-vault indexing are deferred. Neither adapter implements sync or arbitrary vault selection.

## Automated and local checks

- `pnpm check`: formatting, all package/app TypeScript checks, save queue and filesystem recovery tests.
- `pnpm test:desktop`: builds and launches the production Electron app in a temporary vault, checks actual editor/IPC behavior, closes and relaunches it, then removes the fixture. Requires a graphical macOS session.
- `pnpm build:mobile-editor`: creates the ignored local HTML bundle with no CDN dependencies.
- `pnpm --filter @opsidian/mobile exec expo export --platform ios --output-dir dist`: validates the iOS JavaScript/Hermes bundle; does not compile native iOS code.

Desktop smoke checks cover native typing, task toggles, Source mode, wiki suggestions, code-fence isolation, image import/rendering, a roughly 96 KB note, and close/restart persistence. Performance timing is a development smoke measurement, not a release benchmark. An early run took about 4.6 seconds to replace a 96 KB note, but that used `webContents.insertText`; a real clipboard paste of the same note takes about 25 ms to reach the editor (`pnpm bench:desktop`). Storage unit tests cover save ordering, undo during an in-flight save, retry after failure, empty notes, restart, external conflicts, first-write recovery, and image rejection.

## Required real-iPhone acceptance

Record device model, iOS version, build, and observations. This environment has no Xcode installation or enabled device access, so these checks have not been performed:

- Type quickly in paragraphs, headings, nested lists, and checklists. Confirm caret, autocorrect, punctuation, and smart replacements.
- Dictate, select by long press, drag handles, copy/paste multiline text, and use hardware-keyboard shortcuts.
- Compose accented text and a non-Latin IME; confirm composition is not interrupted or duplicated.
- Exercise undo/redo across toolbar edits, selection replacements, checkbox taps, and mode switches.
- Open/dismiss the keyboard, rotate, background/resume, and verify toolbar and scroll position around the caret.
- Import an image, cancel the picker, leave it open for a while, restart, and check the image persists offline.
- Type and background immediately; separately wait for Saved, force-quit, and reopen. Acknowledged text must survive.
- Repeat with a long note. Check scroll, selection, typing latency, and memory on the target iPhone.

Only after those checks should milestone 1 be accepted and the shared WebView approach treated as proven on iPhone.
