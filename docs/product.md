# Product and user experience

## Purpose

Opsidian is an approachable, Markdown-first notebook inspired by Obsidian, with sync hosted on a machine the user chooses. The practical usability test is whether the founder can configure a host, send his girlfriend an invitation, and let her take notes without a technical walkthrough.

The product is not agent-first. AI assistance may be added later. Free sync means Opsidian charges no sync subscription; the chosen machine, storage, hosting, and app distribution can still have costs.

## Platforms and entry point

- Desktop app first, initially macOS.
- iPhone companion distributed through TestFlight. An App Store release is not planned for now.
- `ferran.sh/opsidian` is the intended download/setup entry point. A full browser notes client is not in the current plan.
- A notebook can begin as a folder on the current machine or connect to a vault hosted on a VPS or Tailscale-reachable device.
- Remote notebooks keep a local working copy; editing never depends on a live network mount.

## Initial capabilities

- Markdown notes and ordinary folders.
- Autosave, offline editing, and honest local-save/sync status.
- Search, `[[wiki links]]`, and backlinks.
- Images and file attachments.
- Renames, deletion recovery, revision history, and recoverable sync conflicts.
- Light, dark, and system appearance.
- External Markdown editing on desktop, reconciled into the same revision pipeline.

## Editing target

Default to Obsidian-style Live Preview: formatted content renders inline, with syntax exposed near the editing cursor. Also provide Source mode and Reading view.

The shared editor should support headings, lists, checkboxes, emphasis, code, links, and inline images. Note suggestions appear after `[[`. Full Obsidian syntax compatibility is not promised: aliases, embeds, heading/block references, tables, frontmatter, and other extensions need an explicit compatibility matrix before implementation claims.

On iPhone, bundle the editor locally inside a WebView hosted by a native app. Provide a keyboard toolbar for formatting, links, attachments, undo/redo, and keyboard dismissal. Validate dictation, autocorrect, touch selection, cursor visibility, composition input, and app suspension early.

## Main desktop experience

The layout follows Obsidian's. The sidebar is the file tree, with four small buttons above it (new note, new folder, sort, collapse all) and, at its foot, the notebook's name (switch notebooks, trash, show in Finder), help and Settings. The editor gets the rest of the window: back and forward, where the note is, reading view and a ⋯ menu for the note. There is no formatting toolbar; formatting is by shortcut, Markdown and the text's right-click menu. Backlinks appear beneath the note. A status bar in the bottom corner holds the word count and sync; saving speaks up only when it fails.

Current design proposals include one notebook open at a time, Command-K quick search, Command-N new note, and immediate writing without a creation dialog. Whether a note's first line becomes its filename/title remains to be specified; changes must not accidentally trigger repeated renames.

## Setup

Create a notebook locally, open an existing folder, or connect with an invitation. Host administrators handle infrastructure; everyday users should not need terminal commands or server addresses. A manual connection path is available for advanced setup.

Tailscale hosts require the client device to have suitable network access. An Opsidian invitation does not itself install or authenticate Tailscale.

## Deferred

Graph view (start with a local graph later), agents, ChatGPT/Codex integration, plugins, canvas, browser editing, and real-time collaborative cursors. Future agents should work through the same file/revision pipeline.
