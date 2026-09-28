# Opsidian

A Markdown-first desktop notebook with free, self-hosted sync and an eventual iPhone companion. Inspired by Obsidian's editing behavior, with a calm interface and straightforward device pairing.

## Status

Milestone 1's single-note editor prototype is implemented: runnable Electron desktop, a shared CodeMirror editor, and an Expo iPhone shell. Local saving and desktop integration tests are in place. **Real-iPhone editing acceptance is still pending.** Sync and full notebook management are not implemented.

## Get started

Use Node 24 and pnpm 12.4.1.

```sh
pnpm install
pnpm dev:desktop
```

`pnpm dev:preview` opens a browser development preview. `pnpm dev:mobile` starts Expo after bundling the shared editor. See [prototype setup, storage, and device checks](docs/editor-prototype.md).

Run `pnpm check` for formatting, typechecks, and behavioral tests. Run `pnpm test:desktop` for a real Electron save/restart smoke test. `pnpm format` formats the repository.

## Workspace

| Path              | Responsibility                                             |
| ----------------- | ---------------------------------------------------------- |
| `apps/desktop`    | Electron + React desktop app, initially macOS              |
| `apps/mobile`     | React Native + Expo iPhone app                             |
| `apps/host`       | Node + Fastify vault host                                  |
| `packages/core`   | Vault domain, Markdown/link semantics, platform interfaces |
| `packages/editor` | Shared CodeMirror editing behavior                         |
| `packages/sync`   | Revision protocol and synchronization logic                |
| `packages/theme`  | Shared light/dark semantic colors                          |
| `docs`            | Product, architecture, design, decisions, and milestones   |

Workspace dependencies should use `workspace:*`. Add dependencies when their implementation begins; keep app runtime code out of shared packages.

## Decisions and plans

- [Product and user experience](docs/product.md)
- [Stack and architecture](docs/architecture.md)
- [Build order and acceptance gates](docs/build-order.md)
- [Design reference](docs/design.md)
- [Decision log and open questions](docs/decisions.md)

Next acceptance gate: validate the shared editor on a real iPhone before expanding notebook functionality.
