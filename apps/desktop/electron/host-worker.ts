import { parentPort } from 'node:worker_threads';
import { Host, restoreBackup } from '../../host/src/host';
import { Mirrors, scheduleOf, type Schedule } from '../../host/src/mirror';
import { takeOver, type TakeOverProgress } from '../../host/src/move';
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
  | { op: 'deleteNotebook'; notebook: string }
  | { op: 'backup'; folder: string; keep: number }
  | { op: 'account'; account: GitHubAccount | undefined }
  | { op: 'mirrors' }
  | { op: 'schedule'; every: Schedule }
  | { op: 'keep'; notebook: string; remote: string }
  | { op: 'mirror'; notebook: string; confirm?: boolean }
  | { op: 'unmirror'; notebook: string }
  | { op: 'handoff' }
  | { op: 'takeOver'; dataDir: string; port: number; from: string; code: string; to: string };

export type HostReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; message: string; code?: string | undefined }
  /** How far a take-over has got, sent while it runs. */
  | { id: number; progress: TakeOverProgress };

let host: Host | undefined;
let mirrors: Mirrors | undefined;
/** The GitHub sign-in, handed over by the app, which keeps it in the keychain. */
let account: GitHubAccount | undefined;

async function open(dataDir: string, port: number): Promise<void> {
  if (host) return;
  const opened = new Host({ dataDir });
  try {
    // Every address, so devices can reach this Mac; tests keep it to this machine.
    await opened.listen(port, process.env.OPSIDIAN_HOST_ADDRESS || '0.0.0.0');
  } catch (reason) {
    await opened.close().catch(() => {});
    throw reason;
  }
  host = opened;
  // Notebooks kept on GitHub sync on this thread too, beside the host they belong to. A host
  // that moved away holds an old copy, which must not be sent there.
  const kept = new Mirrors({ host, dataDir, account: async () => account });
  mirrors = kept;
  if (!host.movedTo()) kept.start();
  host.moveHooks = { pause: () => kept.stop(), resume: () => kept.start() };
}
async function close(flush?: number): Promise<void> {
  await mirrors?.stop(flush);
  mirrors = undefined;
  await host?.close();
  host = undefined;
}

async function handle(request: HostRequest, id: number): Promise<unknown> {
  if (request.op === 'open') return open(request.dataDir, request.port);
  if (request.op === 'close') return close(request.flush);
  if (request.op === 'takeOver') {
    const was = Boolean(host);
    try {
      return await takeOver({
        from: request.from,
        code: request.code,
        dataDir: request.dataDir,
        to: request.to,
        progress: (progress) => parentPort!.postMessage({ id, progress } satisfies HostReply),
        // An old copy hosted here, left from moving away, lets go of its data first.
        beforeInstall: () => close(),
        afterInstall: () => open(request.dataDir, request.port),
      });
    } catch (reason) {
      // What was hosted here before is put back, as it was.
      if (was && !host) await open(request.dataDir, request.port).catch(() => {});
      throw reason;
    }
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
        moved: host.moved(),
        moving: host.busyMoving,
        every: scheduleOf(host),
      };
    case 'handoff':
      return host.handoff();
    case 'invite':
      return host.invite(request.notebook);
    case 'cancelInvitation':
      return host.cancelInvitation(request.id);
    case 'revoke':
      return host.revoke(request.id);
    case 'deleteNotebook':
      return mirrors!.deleteNotebook(request.notebook);
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
  void handle(request, id).then(
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
