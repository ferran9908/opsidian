# Design reference

[Writer — Desktop experience in Paper](https://app.paper.design/file/01M3KWMDKWJ67VKBBZN72Z9V8A)

The Paper file still uses the earlier working label Writer. The product and repository name is now **Opsidian**. Renaming the Paper file and its copy has not been performed as part of repository setup.

## Existing screens

1. Writing and linked notes: sidebar, editor, attachment, backlinks, local-save and sync statuses.
2. Create a notebook: local folder default, existing vault path, remote-host option.
3. Connect with an invitation: recognized host/notebook and offline-copy explanation.

All three have light and dark variants, with dark variants positioned below the light versions. These are editable static mockups, not a functional prototype or an exhaustive UX specification. Remote-host provisioning, conflicts, history, and mobile screens still need design work.

## Visual direction

Obsidian's default palette, generous writing space, restrained borders, a compact sidebar, and minimal chrome. The Paper screens were recoloured on 2026-10-13 from the CSS variables of the installed Obsidian app; the earlier maritime palette is superseded. The colours live in `packages/theme` as shadcn/ui tokens and a Tailwind theme.

Note typography was matched the same day, from the same CSS: 16px text at line height 1.5, a bold 1.618em (about 26px) title, headings from 1.618em down to 1em with weights 700 to 600 and line heights 1.2 to 1.5, bold 200 heavier than its surroundings, 0.875em code, and a 700px writing column. The values are in `packages/editor/src/style.css` and the title in `apps/desktop/src/NoteEditor.tsx`; the editor artboards in Paper use the same sizes. Blockquotes keep their muted colour and have no accent bar yet, and the setup screens keep their own larger headings.

The first proposed typography was Instrument Sans plus Newsreader, but Paper retained System Sans-Serif. Typography is therefore still open; do not claim the custom fonts are implemented.

When implementing, read exact JSX/computed styles from Paper rather than inferring dimensions from screenshots. Adapt the design to real interaction states, accessibility, window resizing, and native platform behavior.
