# Opsidian

A Markdown-first desktop notebook with free, self-hosted sync and an eventual iPhone companion. Inspired by Obsidian's editing behavior, with a calm interface and straightforward device pairing.

## Status

Repository foundation only. Workspace boundaries, TypeScript configuration, formatting, design tokens, and decision documentation are present. Electron, Expo, CodeMirror, and the host runtime have **not** been scaffolded or installed yet. There is no runnable app or implemented sync engine.

## Get started

Use Node 24 (the local bootstrap used 24.18.1) and pnpm 12.4.1.

```sh
pnpm install
pnpm check
```

`pnpm format` formats the repository. `pnpm typecheck` checks the shared packages. A passing check verifies the scaffold, not application functionality.

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

Start with milestone 1: validate the same editor in Electron and on a real iPhone.
