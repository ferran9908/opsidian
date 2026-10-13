# @opsidian/host

The host for synced notebooks: a small Fastify server with a SQLite change log and a content-addressed store of every file version. It handles pairing, ordering of changes, and history. It never merges and never reads note text.

From the repository root:

```sh
pnpm host serve
pnpm host invite "Personal"
```

`pnpm build:host` writes `dist/opsidian-host.mjs`, a single file that runs on any machine with Node 22 or later. See [sync](../../docs/sync.md) for the protocol and what is not built yet.
