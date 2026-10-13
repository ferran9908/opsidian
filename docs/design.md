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

Only colour was matched. Type sizes and weights still follow the original Paper design, which is larger than Obsidian's defaults (16px text, bold 26px title).

The first proposed typography was Instrument Sans plus Newsreader, but Paper retained System Sans-Serif. Typography is therefore still open; do not claim the custom fonts are implemented.

When implementing, read exact JSX/computed styles from Paper rather than inferring dimensions from screenshots. Adapt the design to real interaction states, accessibility, window resizing, and native platform behavior.
