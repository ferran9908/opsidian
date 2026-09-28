# Design reference

[Writer — Desktop experience in Paper](https://app.paper.design/file/01M3KWMDKWJ67VKBBZN72Z9V8A)

The Paper file still uses the earlier working label Writer. The product and repository name is now **Opsidian**. Renaming the Paper file and its copy has not been performed as part of repository setup.

## Existing screens

1. Writing and linked notes: sidebar, editor, attachment, backlinks, local-save and sync statuses.
2. Create a notebook: local folder default, existing vault path, remote-host option.
3. Connect with an invitation: recognized host/notebook and offline-copy explanation.

All three have light and dark variants, with dark variants positioned below the light versions. These are editable static mockups, not a functional prototype or an exhaustive UX specification. Remote-host provisioning, conflicts, history, and mobile screens still need design work.

## Visual direction

Quiet maritime colors, generous writing space, restrained borders, a compact sidebar, and minimal chrome. Dark mode uses graphite surfaces, soft white text, and mist-blue accents. Initial semantic colors are in `packages/theme/src/index.ts`.

The first proposed typography was Instrument Sans plus Newsreader, but Paper retained System Sans-Serif. Typography is therefore still open; do not claim the custom fonts are implemented.

When implementing, read exact JSX/computed styles from Paper rather than inferring dimensions from screenshots. Adapt the design to real interaction states, accessibility, window resizing, and native platform behavior.
