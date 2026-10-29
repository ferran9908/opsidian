# Desktop notebook

Milestone 2, last updated 2026-10-13. The desktop app works on a real folder of Markdown notes and covers everything the milestone lists. What it deliberately leaves out is at the end.

## What works

- **Notebooks.** A welcome screen creates a notebook folder (default `~/Documents/Opsidian/<name>`) or opens an existing folder of Markdown files. The last notebook reopens on launch.
- **Notes and folders.** The sidebar lists folders and `.md` notes. Right-click a note or folder to rename it, move it, show it in Finder or move it to the trash; right-click a folder to add a note or a folder inside it. Drag a note or folder onto a folder, or onto the empty part of the list for the top level. **Move to…** does the same from the keyboard.
- **Names.** A note's filename is its title, as in Obsidian. Editing the title above the text renames the file.
- **Links survive renames and moves.** Renaming or moving a note or folder rewrites every `[[link]]` and `![[embed]]` that pointed at it, keeping headings and aliases as written. A link is only rewritten when it would otherwise stop reaching the same note, so links by name are left alone when a note merely changes folder. Markdown image and file paths into a renamed folder are rewritten too.
- **Links.** `[[Name]]`, `[[Name|alias]]`, `[[Name#Heading]]` and `[[#Heading]]`. Completion after `[[` offers the notebook's notes. Clicking a link opens the note and, with a heading, scrolls to it. A link to a note that does not exist is drawn dashed and creates the note when followed. Dragging a note from the sidebar into the text inserts a link to it.
- **Embeds.** `![[Note]]` and `![[Note#Heading]]` show the note or section in place, read-only. `![[photo.png]]` shows an image found by name anywhere in the notebook.
- **Backlinks.** Each note lists the notes that link to it, with the linking line.
- **Local graph.** The constellation button above the note, or `⌘G`, shows the open note and the notes linked to it. Depth is 1–3 hops, both ways. Hover lights a note's neighbours; click opens a note, or creates it when the target does not exist yet. Settings on the right match Obsidian's forces and display sliders and are remembered. See [graph](graph.md).
- **Find.** `⌘K` or `⌘O` searches note names and text, and can create a note from the query. Back and forward with the arrows above the note or `⌘⌥←` / `⌘⌥→`.
- **Commands.** `⌘P` opens the command palette, as in Obsidian: type to narrow, Enter to run. Its one command so far is **Sync with GitHub**, which saves the note being written and has the host copy the notebook to GitHub now, whatever the schedule, from any Mac that syncs the notebook. The result shows above the note.
- **Images.** Paste or drop an image into a note, or choose **Attach image** from the text's right-click menu. Images are stored in `attachments/` under a readable name (`Pasted image.png`, or the original file name) and served to the editor through `opsidian://vault/…` rather than loaded into memory. PNG, JPEG, GIF and WebP up to 25 MB.
- **Trash.** Notes and folders go to the notebook's `.trash` folder, which Obsidian also uses. **Trash**, in the menu under the notebook's name, lists what is there and restores an item to where it was, recreating its folder if needed and choosing a free name if the old one is taken. **Empty trash** moves the contents to the Mac's Trash after a confirmation.
- **A notebook folder that goes missing.** If the open notebook's folder is deleted, moved or on a disk that is detached, the app says so instead of carrying on in a folder that is not there. The note on screen keeps any unsaved text, which can be copied out. Putting the folder back where it was, from the Trash for example, carries on by itself. A notebook that synced can be downloaded again into its old place as the same device, with no invitation, or given up, which removes this Mac from its host. A folder that is missing at launch is never made again, empty; the welcome screen offers the same choices.
- **Edits from other programs.** The notebook folder is watched. If the open note changes on disk and has no unsaved edits, the editor follows the file. If it has unsaved edits, the newer file is kept and the edit is saved beside it as `<name> (conflicted copy <time>).md`.
- **Writing.** Live Preview draws headings, bold, italic, strikethrough, code, round bullets, checkboxes, numbered lists, quotes behind an accent rule, and tables, in Obsidian's default typography. Clicking a table shows its Markdown with the cursor in the cell clicked; it is drawn again once the cursor leaves. Source mode, from the ⋯ menu above the note, shows plain Markdown. Reading view (the book button, or `⌘E`) shows the note drawn and cannot be edited. Settings → Editor chooses which of the three a note opens in. Right-click the text for cut, copy, paste, formatting, a note link or an image.

## Storage rules

Paths are notebook-relative. Hidden entries (`.obsidian`, `.git`, `.trash`) and symlinks are never listed, read or written, so a note cannot reach outside the notebook. Trash is the notebook's own `.trash` folder; where each item came from is recorded in `.trash/.opsidian-origins.json`. The link graph and search index live in memory in the main process and are rebuilt from the files on open.

`OPSIDIAN_VAULT_DIR` opens a specific folder for development and tests without remembering it.

## Durability

- **Saves are atomic.** A note is written to a hidden temporary file, flushed to disk, then renamed over the original, so the file is always a whole earlier version or the whole new one. Temporary files a crash leaves behind are removed the next time the notebook opens.
- **Saves are serialized and checked.** Each save names the content it started from. If the file no longer holds that content, the edit is written as a conflicted copy instead.
- **Typing is saved as it happens.** An edit is written 160 ms after typing pauses, and during uninterrupted typing at least once a second, so a crash loses at most about a second of work.
- **Closing waits.** Closing the window, switching notes, renaming and moving all wait for the pending save. If a save fails, the status bar says so and offers a retry, and closing asks first.
- **A rename is not atomic across notes.** The note is renamed first and the links in other notes are rewritten after. A crash in between leaves some links pointing at the old name; no text is lost.
- **A linking note is rewritten only if it is exactly as indexed.** A note that is read-only, was changed a moment ago by another program, or is not valid UTF-8 is left untouched, and the app names the notes whose links it could not update.
- **Saving pauses during a rename, move or trash.** Text typed meanwhile is saved to the note's new place afterwards, and nothing is written back to a note that was just trashed.

## Measured

`tests/vault-scale.test.ts` builds a 5,000-note notebook (about 2 KB per note, five links each) and fails if these regress several-fold. On an Apple-silicon Mac:

| Operation                              | Time   |
| -------------------------------------- | ------ |
| Open the notebook and build the index  | 290 ms |
| Search, rare or common word            | 3 ms   |
| Backlinks for one note                 | 8 ms   |
| Rename a note, rewriting links in five | 130 ms |
| Rename a folder of 100 notes           | 70 ms  |

On these numbers the in-memory index is enough, so the planned SQLite index is not needed for a notebook this size. It rebuilds on every launch, which would become noticeable somewhere well beyond this. The same fixture also builds the link graph in one pass and lets the force layout settle; those budgets live in `tests/vault-scale.test.ts` and stay off the typing path. See [graph](graph.md).

`pnpm bench:desktop` prints paste and typing timings for 96 KB and 1 MB notes.

## Not in this milestone

- **Version history without sync.** History comes from the host, so a notebook that is not synced has none. See [sync](sync.md).
- **Other attachment types.** PDFs and other files are not imported or previewed.
- **Heading and block completion.** `[[Note#` does not suggest headings, and `[[Note^block]]` references are not supported.
- **Embeds inside embeds** are shown as links, and embeds are read-only.
- **Footnotes and callouts** are shown as plain Markdown in Live Preview.
- **Tables are edited as Markdown.** Cells cannot be edited in place, and rows and columns are added by typing bars. Tables inside quotes and lists, and images inside cells, are shown as written. Web addresses in cells are drawn short, with the whole address on hover, and cannot be opened from the table. Columns cannot be resized.
- **Code blocks made by indentation alone.** Links inside one are treated as real links; fenced blocks and code spans are not.

## Checks

- `pnpm check` runs formatting, typechecks and the behavioural tests: link parsing, resolution and rewriting, the index, the graph builder, the save queue, and the vault on a real temporary folder (conflicts, deletion while editing, renames and moves with link rewriting, folders, trash and restore, images, symlink and path escapes, external changes, the 5,000-note measurement including graph build and layout settle).
- `pnpm test:desktop` drives the production Electron build end to end: creating, renaming, linking, navigating, searching, attaching and pasting images, embeds, folders by menu and by drag, heading links, external edits, conflicts, trash and restore, and close-and-reopen. It then runs the crash test: the app is killed outright three times while typing and saving, and each time the note on disk must be a whole earlier version, hold everything typed more than 1.5 s before the kill, and reopen for further editing.
