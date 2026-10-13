# Desktop notebook

First slice of milestone 2, 2026-10-13. The desktop app now works on a real folder of Markdown notes. Milestone 2 is not complete; the gaps are listed below.

## What works

- **Notebooks.** A welcome screen creates a notebook folder (default `~/Documents/Opsidian/<name>`) or opens an existing folder of Markdown files. The last notebook reopens on launch.
- **Notes and folders.** The sidebar lists folders and `.md` notes. New note (`⌘N`), new note inside a folder, new top-level folder, and move to trash.
- **Names.** A note's filename is its title, as in Obsidian. Editing the title above the text renames the file.
- **Links.** `[[Name]]`, `[[Name|alias]]` and `[[Name#Heading]]`. Completion after `[[` offers the notebook's notes. Clicking a link opens the note; a link to a note that does not exist is drawn dashed and creates the note when followed.
- **Backlinks.** Each note lists the notes that link to it, with the linking line.
- **Find.** `⌘K`, `⌘O` or `⌘P` searches note names and text, and can create a note from the query. Back and forward with the toolbar or `⌘⌥←` / `⌘⌥→`.
- **Images.** Attached images are copied to `attachments/` and served to the editor through `opsidian://vault/…`, not loaded into memory up front.
- **Edits from other programs.** The notebook folder is watched. If the open note changes on disk and has no unsaved edits, the editor follows the file. If it has unsaved edits, the newer file is kept and the edit is saved beside it as `<name> (conflicted copy <time>).md`.

## Storage rules

Paths are notebook-relative. Hidden entries (`.obsidian`, `.git`, `.trash`) and symlinks are never listed, read or written, so a note cannot reach outside the notebook. Saves are atomic and serialized, and each save names the revision it started from. Trash is the notebook's own `.trash` folder. The link graph and search index live in memory in the main process and are rebuilt from the files on open.

`OPSIDIAN_VAULT_DIR` opens a specific folder for development and tests without remembering it.

## Not built yet

- Renaming a note does not rewrite `[[links]]` to it in other notes.
- Renaming, moving or deleting folders; moving notes between folders; nested folder creation.
- Heading targets in links are parsed and shown but do not scroll to the heading.
- `![[embed]]` syntax, non-image attachments, and attachment cleanup.
- A SQLite index. The in-memory index has not been measured on a large notebook.
- Restoring from trash inside the app, and version history.
- The "Connect to a notebook" screen from the Paper design, which depends on sync.

## Checks

`pnpm check` covers link parsing and resolution, the index, and the vault on a real temporary folder: conflicts, deletion while editing, rename collisions, trash, symlink and path escapes, and external changes. `pnpm test:desktop` drives the production Electron build through creating, renaming, linking, navigating, searching, attaching, external edits, conflicts, trash, and close-and-reopen. `pnpm bench:desktop` prints paste and typing timings for 96 KB and 1 MB notes.
