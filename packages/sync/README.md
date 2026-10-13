# @opsidian/sync

The wire protocol and the device-side engine that reconciles a notebook folder with a host. Platform-independent: storage and transport are passed in (`SyncStore`, `Transport`). The desktop app supplies a store over its vault; the iPhone app will supply its own.

See [sync](../../docs/sync.md) for the design.
