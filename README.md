# Opsidian

A Markdown-first desktop notebook with free, self-hosted sync and an eventual iPhone companion. Inspired by Obsidian's editing behavior, with a calm interface and straightforward device pairing.

## Status

The desktop app is a local notebook over a folder of Markdown notes: notes and folders, wiki links that survive renames, embeds, backlinks, search, pasted images, and a trash you can restore from. See [what the desktop notebook does](docs/desktop-notebook.md). The iPhone shell is still the single-note editor prototype from milestone 1, and **real-iPhone editing acceptance is still pending.** Sync is not implemented.

## Get started

Use Node 24 and pnpm 12.4.1.

```sh
pnpm install
pnpm dev:desktop
```

`pnpm dev:preview` opens a browser development preview. `pnpm dev:mobile` starts Expo after bundling the shared editor. See [prototype setup, storage, and device checks](docs/editor-prototype.md).

Run `pnpm check` for formatting, typechecks, and behavioral tests. Run `pnpm test:desktop` to drive the real Electron app end to end and then kill it mid-save to check nothing is lost. `pnpm format` formats the repository.

## Workspace

| Path              | Responsibility                                             |
| ----------------- | ---------------------------------------------------------- |
| `apps/desktop`    | Electron + React desktop app, initially macOS              |
| `apps/mobile`     | React Native + Expo iPhone app                             |
| `apps/host`       | Node + Fastify vault host                                  |
| `packages/core`   | Vault domain, Markdown/link semantics, platform interfaces |
| `packages/editor` | Shared CodeMirror editing behavior                         |
| `packages/sync`   | Revision protocol and synchronization logic                |
| `packages/theme`  | Obsidian palette as shadcn tokens and a Tailwind theme     |
| `docs`            | Product, architecture, design, decisions, and milestones   |

Workspace dependencies should use `workspace:*`. Add dependencies when their implementation begins; keep app runtime code out of shared packages.

## Decisions and plans

- [Product and user experience](docs/product.md)
- [Stack and architecture](docs/architecture.md)
- [Build order and acceptance gates](docs/build-order.md)
- [Design reference](docs/design.md)
- [Decision log and open questions](docs/decisions.md)

Open acceptance gate: validate the shared editor on a real iPhone.
