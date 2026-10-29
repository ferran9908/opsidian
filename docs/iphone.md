# The iPhone app

The iPhone holds one notebook: a folder of Markdown files in the app's Documents folder. It reads, writes, searches and syncs that folder with the same code the Mac uses.

## What it does

- **Connect.** Scan the invitation the hosting Mac shows, or enter the host address and code by hand. A link of the form `opsidian://connect?host=…&code=…` fills the form in; the Connect button still has to be pressed.
- **Start without a host.** A notebook can begin on the phone and be connected later. What is already written is uploaded when it connects.
- **Opening.** The app opens on the note that was open last (the first time, the one changed most recently), as Obsidian does. There is no home screen in between.
- **Files.** The sidebar button, or a swipe in from the left edge, slides in the files: the notebook's name with sync under it, Settings, and the same four buttons as the Mac (new note, new folder, sort A to Z or Z to A, collapse all) above the tree. Holding a note or folder offers rename, move, history, share and trash; a folder also offers a new note or folder inside. The notebook's name opens the trash.
- **Moving around.** A bar at the bottom has back and forward through the notes opened, a new note, search, and the note's menu (Source mode, attach a photo or file, rename, move, history, share, trash). The book at the top switches to reading view, where nothing can be edited. Settings chooses whether notes open in editing, source or reading view, and light, dark or automatic appearance; these stay on the iPhone.
- **Write.** The shared editor, with a toolbar above the keyboard for undo, redo, heading, bold, italic, lists, checkboxes, links and attachments. Typing `[[` offers note names.
- **Find.** Search covers note names and their text. With no match it offers to create the note.
- **Organise.** Rename, move to a folder, create folders, and move to the trash. A note is renamed by editing its title at the top of the note, or from its menu. Like the note itself, the title saves as it is typed: the note is renamed a moment after typing stops, with no need to press Done. A name that cannot be used yet (empty, taken, or with a slash) is left as typed; on leaving the title it is refused with a notice and the note keeps its name. A new, empty Untitled note opens with its title selected. Renaming rewrites links in other notes, exactly as on the Mac. `pnpm test:mobile-editor` edits the title in the editor page as generated. The trash lists what was removed, here or on another device, and puts things back.
- **Attach.** Photos from the library or camera, and any file, are stored under `attachments/` and linked from the note.
- **Connection check.** When sync is not working, the sync screen offers "See what is in the way", which tries each step and names the first that fails.
- **Sync.** One line under the notebook's name in the files says how sync is going; tapping it opens the details, as does Settings. Edits from another device appear in the open note. Overlapping edits are kept as two notes, and the note says so. A notebook kept on GitHub shows its repository there, with **Sync with GitHub now**, which has the host copy it at once.
- **History.** Lists the versions the host holds and restores any of them.

## How it is built

- **`packages/notebook`** is the notebook itself: the folder, its index, link rewriting, the trash, and the store sync works through. It used to live in the desktop app. It talks to the device through a small `Platform` interface (`platform.ts`) instead of Node.
- **The Mac's platform** is `apps/desktop/electron/storage.ts`, a thin wrapper over Node's file system. Nothing about the Mac's behaviour changed.
- **The iPhone's platform** is `apps/mobile/src/platform.ts`, over Expo's file system. `apps/mobile/src/notebook.ts` opens the notebook and wires sync to the keychain and the network.
- **The editor** is the shared CodeMirror editor in a web view. `packages/editor/src/mobile.ts` is its side of the conversation; `apps/mobile/src/screens/note.tsx` is the app's. The web page can only ask for the note it is showing, images, and embeds. It has no network access.
- **Screens** are plain React Native in `apps/mobile/src/screens`, drawn to the designs on the "iPhone app — journeys" page of the Paper file.

## What is different on a phone

- **Saving a file.** iOS has no single step that replaces a file. A save writes the new text beside the old file, marks it complete, then swaps it in. If the app dies between those steps, the next launch finishes or discards the save (`recover`). A crash never leaves a half-written note.
- **Change times.** iOS reports them to the second. The platform counts its own writes so two saves in a row are still told apart.
- **Letter case.** An iPhone's disk treats `Travel` and `travel` as different folders; a Mac's does not. The host already keeps one spelling per folder, and the phone follows it.
- **Background.** iOS suspends the app soon after it leaves the screen. The editor saves when the app is backgrounded, and sync catches up the moment it returns. Nothing syncs while the app is closed.
- **Credentials.** The device's credential is in the iOS keychain, never in the notebook folder, and does not move to another device with a backup.
- **Plain `http`.** The host is reached over Tailscale or the home network, so the app allows unencrypted connections. This has to be revisited before an App Store release.

## Running it

1. Copy `apps/mobile/.env.example` to `.env.local` and set `APPLE_TEAM_ID`.
2. Connect the iPhone and run `pnpm ios` from the repository root. This builds a self-contained app that does not need the Mac afterwards.
3. On the host Mac, run `pnpm host start`, then `pnpm host invite "Personal"`, and enter what it prints in the app. This is a development host (port 4811, `~/.opsidian-dev`); a real one is `npx opsidian host start`.

`pnpm dev:mobile` starts the development server instead, for a development build that reloads as code changes.

## How it was tested

The shared notebook code is covered by the existing tests, which all still pass after the move, plus `tests/notebook.test.ts`. The app itself was run in the iPhone simulator against a real host and a second device: pairing, the first download, an edit from the other device reaching the open note, typing on the phone reaching the other device, rename with link rewriting, move, trash and restore, a conflict made while the host was down, restoring from history, disconnecting and reconnecting, and recovery of interrupted saves.

## Not built, or not verified

- **Not verified on a real iPhone:** typing feel, the keyboard toolbar under a finger, dictation, and behaviour when iOS suspends and resumes the app.
- **Not verified at all:** picking a photo, taking a photo and choosing a file. These open iOS's own pickers, which the simulator tests could not drive.
- **No swipe-back gesture.** Screens go back with the button at the top left.
- **No dark-mode design pass.** The app follows the system setting using the dark theme tokens.
- **One notebook per phone.** There is no switcher.
- **No background sync, no notifications, no iPad layout.**
- **Empty folders do not sync,** as on the Mac.
