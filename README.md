# Opsidian

A Markdown-first desktop notebook with free, self-hosted sync and an eventual iPhone companion. Inspired by Obsidian's editing behavior, with a calm interface and straightforward device pairing.

## Status

The desktop app is a local notebook over a folder of Markdown notes: notes and folders, wiki links that survive renames, embeds, backlinks, search, pasted images, and a trash you can restore from. See [what the desktop notebook does](docs/desktop-notebook.md). The iPhone app holds the same notebook: browse, write, search, organise, attach photos, and sync. See [the iPhone app](docs/iphone.md); **it has been run in the simulator but not yet accepted on a real iPhone.** Sync works through a host you run yourself, either from the Mac app's settings or on a server; see [sync](docs/sync.md) and [hosting](docs/hosting.md).

## Get started

Use Node 24 and pnpm 12.4.1.

```sh
pnpm install
pnpm dev:desktop
```

`pnpm dev:preview` opens a browser development preview. `pnpm ios` builds and installs the iPhone app on a connected phone; `pnpm dev:mobile` starts Expo for a development build. See [prototype setup, storage, and device checks](docs/editor-prototype.md).

Run `pnpm check` for formatting, typechecks, and behavioral tests. Run `pnpm test:desktop` to drive the real Electron app end to end and then kill it mid-save to check nothing is lost, and `pnpm test:sync` to run it against a real host. `pnpm format` formats the repository.

## Workspace

| Path                | Responsibility                                             |
| ------------------- | ---------------------------------------------------------- |
| `apps/desktop`      | Electron + React desktop app, initially macOS              |
| `apps/mobile`       | React Native + Expo iPhone app                             |
| `apps/host`         | Node + Fastify vault host                                  |
| `packages/core`     | Vault domain, Markdown/link semantics, platform interfaces |
| `packages/editor`   | Shared CodeMirror editing behavior                         |
| `packages/notebook` | The notebook folder: index, links, trash, sync store       |
| `packages/sync`     | Revision protocol and synchronization logic                |
| `packages/theme`    | Obsidian palette as shadcn tokens and a Tailwind theme     |
| `docs`              | Product, architecture, design, decisions, and milestones   |

Workspace dependencies should use `workspace:*`. Add dependencies when their implementation begins; keep app runtime code out of shared packages.

## Decisions and plans

- [Product and user experience](docs/product.md)
- [Stack and architecture](docs/architecture.md)
- [Build order and acceptance gates](docs/build-order.md)
- [Design reference](docs/design.md)
- [Decision log and open questions](docs/decisions.md)

Open acceptance gate: validate the shared editor on a real iPhone.

## Licence

Code is available under the [MIT License](LICENSE-MIT) or the [Apache License 2.0](LICENSE-APACHE), at your choice. Documentation and design, including the logo, are dedicated to the public domain under [CC0 1.0](LICENSE-CC0). See [LICENSE](LICENSE) for details.
