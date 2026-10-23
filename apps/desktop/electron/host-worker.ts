import { parentPort } from 'node:worker_threads';
import { Host, restoreBackup } from '../../host/src/host';
import { Mirrors, scheduleOf, type Schedule } from '../../host/src/mirror';
import type { GitHubAccount } from '../../host/src/github';

/**
 * The Mac app's host, on a thread of its own. The host's database work is synchronous, and a
 * backup copies the whole database in one step; on the app's main thread that would stall
 * every window until it finished. Here it only ever delays the host itself.
 */
export type HostRequest =
  | { op: 'open'; dataDir: string; port: number }
  /** `flush`: how long to give copies to send what GitHub does not have yet, if anything. */
  | { op: 'close'; flush?: number }
  | { op: 'restore'; dataDir: string; folder: string; name: string }
  | { op: 'snapshot' }
  | { op: 'invite'; notebook: string }
  | { op: 'cancelInvitation'; id: string }
  | { op: 'revoke'; id: string }
  | { op: 'backup'; folder: string; keep: number }
  | { op: 'account'; account: GitHubAccount | undefined }
  | { op: 'mirrors' }
  | { op: 'schedule'; every: Schedule }
  | { op: 'keep'; notebook: string; remote: string }
  | { op: 'mirror'; notebook: string; confirm?: boolean }
  | { op: 'unmirror'; notebook: string };

export type HostReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; message: string; code?: string | undefined };

let host: Host | undefined;
let mirrors: Mirrors | undefined;
/** The GitHub sign-in, handed over by the app, which keeps it in the keychain. */
let account: GitHubAccount | undefined;

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
    // Notebooks kept on GitHub sync on this thread too, beside the host they belong to.
    mirrors = new Mirrors({ host, dataDir: request.dataDir, account: async () => account });
    mirrors.start();
    return;
  }
  if (request.op === 'close') {
    await mirrors?.stop(request.flush);
    mirrors = undefined;
    await host?.close();
    host = undefined;
    return;
  }
  if (request.op === 'account') {
    account = request.account;
    mirrors?.kick();
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
        mirrors: host.mirrors().map(({ token: _token, ...each }) => each),
        every: scheduleOf(host),
      };
    case 'invite':
      return host.invite(request.notebook);
    case 'cancelInvitation':
      return host.cancelInvitation(request.id);
    case 'revoke':
      return host.revoke(request.id);
    case 'backup':
      return host.backup(request.folder, request.keep);
    // What the app needs to show, without the copies' device credentials.
    case 'mirrors':
      return host.mirrors().map(({ token: _token, ...each }) => each);
    case 'schedule':
      host.setMirrorSchedule(request.every);
      // Each copy plans its next round again now, rather than at its next look.
      mirrors?.refresh();
      return;
    case 'keep':
      return mirrors!.connect(request.notebook, request.remote);
    case 'mirror':
      return mirrors!.sync(request.notebook, request.confirm);
    case 'unmirror':
      return mirrors!.disconnect(request.notebook);
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
