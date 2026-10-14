import { parentPort } from 'node:worker_threads';
import { Host, restoreBackup } from '../../host/src/host';

/**
 * The Mac app's host, on a thread of its own. The host's database work is synchronous, and a
 * backup copies the whole database in one step; on the app's main thread that would stall
 * every window until it finished. Here it only ever delays the host itself.
 */
export type HostRequest =
  | { op: 'open'; dataDir: string; port: number }
  | { op: 'close' }
  | { op: 'restore'; dataDir: string; folder: string; name: string }
  | { op: 'snapshot' }
  | { op: 'invite'; notebook: string }
  | { op: 'cancelInvitation'; id: string }
  | { op: 'revoke'; id: string }
  | { op: 'backup'; folder: string; keep: number };

export type HostReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; message: string; code?: string | undefined };

let host: Host | undefined;

async function handle(request: HostRequest): Promise<unknown> {
  if (request.op === 'open') {
    if (host) return;
    const opened = new Host({ dataDir: request.dataDir });
    try {
      await opened.listen(request.port, '0.0.0.0');
    } catch (reason) {
      await opened.close().catch(() => {});
      throw reason;
    }
    host = opened;
    return;
  }
  if (request.op === 'close') {
    await host?.close();
    host = undefined;
    return;
  }
  if (request.op === 'restore') {
    if (host) throw new Error('Stop the host before restoring.');
    return restoreBackup(request.dataDir, request.folder, request.name);
  }
  if (!host) throw new Error('This Mac is not hosting.');
  switch (request.op) {
    case 'snapshot':
      return {
        notebooks: host.notebooks(),
        devices: host.devices(),
        invitations: host.invitations(),
      };
    case 'invite':
      return host.invite(request.notebook);
    case 'cancelInvitation':
      return host.cancelInvitation(request.id);
    case 'revoke':
      return host.revoke(request.id);
    case 'backup':
      return host.backup(request.folder, request.keep);
  }
}

parentPort!.on('message', ({ id, request }: { id: number; request: HostRequest }) => {
  void handle(request).then(
    (value) => parentPort!.postMessage({ id, ok: true, value } satisfies HostReply),
    (reason: unknown) =>
      parentPort!.postMessage({
        id,
        ok: false,
        message: reason instanceof Error ? reason.message : String(reason),
        code: (reason as NodeJS.ErrnoException)?.code,
      } satisfies HostReply),
  );
});
