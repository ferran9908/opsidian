# Local graph

The graph is a picture of the notebook: notes are dots, wiki links are strings between them, and a pretend physics settles the dots so related notes sit near each other. It is meant to feel like Obsidian's local graph on a Mac, without turning the editor into a slideshow while it thinks.

## Why this shape

A whole-vault graph is a later curiosity. Everyday use is "what is around the note I am in?" so the first view is local: the open note, then rings of neighbours one, two or three hops out, following links both ways. Switching the same picture to every note is a toggle, not a second implementation.

The dots come from the same link index the editor already uses. One pass over the notes produces nodes and unique directed edges. Calling `backlinks()` for every note would have been quadratic and would have disagreed with the editor the moment the two resolvers drifted. Unresolved targets stay in the graph as their own dots, so "Existing files only" can hide them and clicking one can create the note, the same way a dashed `[[link]]` does.

**Tags** can be dots too, turned on with the **Tags** toggle in the graph's settings and off by default. Each tag is one dot, drawn as a green ring, with a string from every note that carries it, in its text or its frontmatter. Clicking a tag searches the notebook for it. Tags come from the same index as links, so they cost nothing extra to build.

Identity is the vault-relative path. That matches how the rest of the app talks about notes. It also means a rename is a new id: the layout tries to keep the old position when exactly one path left and one arrived, and otherwise the renamed note is a new dot. That is a known limit, not a hidden id scheme.

## How it stays out of the way

The force layout runs in a Web Worker. Typing never waits on it. Once the dots stop moving, both the worker and the draw loop go to sleep. Hover, pan, zoom and a real change to the links wake them; dragging a slider that only changes how things look (arrows, text fade, node size, link thickness) redraws and does not restart the physics.

Hover uses a quadtree, not a scan of every dot on every mouse move. Drawing is batched on a 2D canvas and skips work outside the viewport. The canvas talks to the rest of the app through a small `GraphRenderer` interface so a WebGL renderer can replace it later without rewriting the worker or the settings.

On a vault change the graph updates the dots and strings that actually changed, keeps the positions it already has, and reheats gently. An autosave that did not add or remove a link does not restart the layout. Opening the graph once keeps it mounted: hiding it to type, then showing it again, does not throw the dots back to a cold start. Changing the open note recentres the same view; it does not remount it.

## What we did not build

Attachment nodes need an index that does not exist yet. A time-lapse, hover page previews, a 3D view, and a React Native renderer are out. The shared `NoteIndex.graph()` is what a phone view would call later.

Canvas is the right first renderer. Somewhere past a few thousand visible dots it will lose to WebGL; the 5,000-note fixture is the current ceiling we measure against, and local graphs stay well under it. The seam is there for when that changes.

## Settings

The four forces (center, repel, link force, link distance) and the display sliders persist in `localStorage`. Restore defaults puts them back. Theme colours are `--graph-*` tokens in `@opsidian/theme`, light and dark.

## Checks

`tests/links.test.ts` covers the builder: duplicate links collapse, a note that links to itself is ignored, unresolved targets become nodes, degrees match the edges. `tests/vault-scale.test.ts` builds the 5,000-note fixture's graph and lets the same force layout settle it.
