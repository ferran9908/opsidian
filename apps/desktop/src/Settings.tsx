import { useEffect, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import type {
  BackupInfo,
  ConnectionCheck,
  HostingInfo,
  Invitation,
  SyncInfo,
} from '@opsidian/core';
import type { ThemePreference } from '@opsidian/theme';
import type { EditorMode } from '@opsidian/editor';
import { bridge, message } from './bridge';
import { syncLabel } from './SyncDialog';
import { UpdateSettings } from './updates';
import { defaultMode, setDefaultMode } from './preferences';
import { Button } from '@/components/ui/button';
import { GitHubSettings } from './GitHub';
import { FollowDialog, MoveDialog, MovedSettings, TakeOverDialog } from './MoveHost';

export type SettingsSection =
  'general' | 'editor' | 'appearance' | 'sync' | 'devices' | 'backups' | 'github' | 'check';
/** The sections down the left, in Obsidian's two kinds: how the app works, and sync. */
const GROUPS: [string, [SettingsSection, string][]][] = [
  [
    'Options',
    [
      ['general', 'General'],
      ['editor', 'Editor'],
      ['appearance', 'Appearance'],
    ],
  ],
  [
    'Sync',
    [
      ['sync', 'Sync'],
      ['devices', 'Devices'],
      ['backups', 'Backups'],
      ['github', 'GitHub'],
    ],
  ],
];

const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : bytes < 1024 ** 3
      ? `${Math.round(bytes / 1024 / 1024)} MB`
      : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const count = (value: number, one: string, many = `${one}s`) =>
  `${value.toLocaleString()} ${value === 1 ? one : many}`;
function ago(at: number | undefined): string {
  if (!at) return 'Not seen yet';
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 2) return 'In step now';
  if (minutes < 60) return `Last seen ${minutes} minutes ago`;
  if (minutes < 60 * 36) return `Last seen ${count(Math.round(minutes / 60), 'hour')} ago`;
  return `Last seen ${count(Math.round(minutes / 1440), 'day')} ago`;
}
const day = (at: number) =>
  new Date(at).toLocaleString([], {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

function Heading(props: {
  title: string;
  sub?: string | undefined;
  dot?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 pb-1">
      <div className="space-y-1.5">
        <h2 className="text-xl leading-7 font-bold">{props.title}</h2>
        {props.sub && (
          <p className="text-muted-foreground flex items-center gap-2 text-[13px] leading-5">
            {props.dot && <span className={`size-2 shrink-0 rounded-full ${props.dot}`} />}
            {props.sub}
          </p>
        )}
      </div>
      {props.action}
    </div>
  );
}
const Label = ({ children }: { children: ReactNode }) => (
  <h3 className="text-muted-foreground pb-2 text-xs font-semibold tracking-[0.08em] uppercase">
    {children}
  </h3>
);
/** One setting, as Obsidian lays it out: what it is on the left, its control on the right. */
export function Row(props: { name: ReactNode; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className="border-border flex items-center justify-between gap-6 border-t py-4">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">{props.name}</p>
        {props.description && (
          <div className="text-muted-foreground text-[13px] leading-5">{props.description}</div>
        )}
      </div>
      {props.children}
    </div>
  );
}
const select =
  'border-border bg-secondary h-8 shrink-0 rounded-md border px-2 text-[13px] outline-none';
export const Line = ({ children }: { children: ReactNode }) => (
  <div className="border-border flex min-h-11 items-center justify-between gap-4 border-t py-2 text-sm last:border-b">
    {children}
  </div>
);

/** The invitation as a code another device can scan, plus the two lines to type instead. */
function InviteDialog(props: { notebook: string; onClose(): void }) {
  const [invitation, setInvitation] = useState<Invitation>();
  const [error, setError] = useState('');
  const [left, setLeft] = useState('');
  const [copied, setCopied] = useState(false);
  const make = () =>
    void bridge.invite(props.notebook).then(setInvitation, (reason) => setError(message(reason)));
  useEffect(make, []);
  useEffect(() => {
    if (!invitation) return;
    const tick = () => {
      const seconds = Math.max(0, Math.round((invitation.expires - Date.now()) / 1000));
      setLeft(
        seconds
          ? `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}.`
          : 'Expired. Make a new code.',
      );
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [invitation]);
  const cells = invitation?.qr.length ?? 0;
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}
    >
      <div
        role="dialog"
        aria-label="Invite a device"
        className="bg-popover text-popover-foreground flex w-[min(720px,92vw)] gap-9 rounded-2xl p-9 shadow-2xl"
      >
        <div className="flex size-[220px] shrink-0 items-center justify-center rounded-xl bg-white p-3">
          {invitation && (
            <svg
              role="img"
              aria-label="Invitation code to scan"
              viewBox={`0 0 ${cells} ${cells}`}
              shapeRendering="crispEdges"
              className="size-full"
            >
              {invitation.qr.map((row, y) =>
                [...row].map((cell, x) =>
                  cell === '1' ? (
                    <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="#000" />
                  ) : null,
                ),
              )}
            </svg>
          )}
        </div>
        <div className="flex flex-1 flex-col gap-3.5">
          <h2 className="text-2xl font-bold tracking-tight">
            Invite a device to “{props.notebook}”
          </h2>
          <p className="text-muted-foreground text-sm leading-[21px]">
            On the iPhone, open Opsidian and scan this. On another Mac, choose “Connect to a
            notebook” and type the two lines below.
          </p>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <div>
            <Line>
              <span className="text-muted-foreground">Host address</span>
              <code id="invite-address" className="text-[13px] select-all">
                {invitation?.address}
              </code>
            </Line>
            <Line>
              <span className="text-muted-foreground">Invitation code</span>
              <code id="invite-code" className="text-[15px] font-bold tracking-[0.08em] select-all">
                {invitation?.code}
              </code>
            </Line>
          </div>
          <p className="text-muted-foreground text-[13px]">Works once. {left}</p>
          <div className="flex gap-2.5 pt-1">
            <Button
              variant="secondary"
              size="sm"
              disabled={!invitation}
              onClick={() => {
                void navigator.clipboard.writeText(invitation!.link);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy invitation link'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setCopied(false);
                make();
              }}
            >
              New code
            </Button>
            <Button size="sm" onClick={props.onClose}>
              Done
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Asks before something that cannot simply be undone with one more click. */
function Confirm(props: {
  title: string;
  action: string;
  children: ReactNode;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onMouseDown={(event) => event.target === event.currentTarget && props.onCancel()}
    >
      <div
        role="alertdialog"
        aria-label={props.title}
        className="bg-popover text-popover-foreground w-[min(600px,92vw)] space-y-4 rounded-2xl p-9 shadow-2xl"
      >
        <h2 className="text-2xl font-bold tracking-tight">{props.title}</h2>
        <div className="text-muted-foreground space-y-3 text-sm leading-[22px]">
          {props.children}
        </div>
        <div className="flex justify-end gap-2.5 pt-1">
          <Button variant="secondary" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button onClick={props.onConfirm}>{props.action}</Button>
        </div>
      </div>
    </div>
  );
}

interface Props {
  section: SettingsSection;
  notebook: string;
  sync: SyncInfo;
  theme: { preference: ThemePreference; set(preference: ThemePreference): void };
  onSection(section: SettingsSection): void;
  /** Opens the form for joining a host that already exists. */
  onConnect(): void;
  /** Opens the screen that makes a notebook from a GitHub repository. */
  onImport(): void;
  onClose(): void;
}

export function Settings(props: Props) {
  const { section, sync } = props;
  const [hosting, setHosting] = useState<HostingInfo>();
  const [backups, setBackups] = useState<BackupInfo>();
  const [checks, setChecks] = useState<ConnectionCheck[]>();
  const [inviting, setInviting] = useState(false);
  const [moving, setMoving] = useState<'move' | 'take-over' | 'follow'>();
  const [confirm, setConfirm] = useState<
    | { kind: 'stop' }
    | { kind: 'remove'; id: string; name: string }
    | { kind: 'restore'; name: string; at: number }
  >();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = (task: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    void task()
      .catch((reason) => setError(message(reason)))
      .finally(() => setBusy(false));
  };
  useEffect(() => {
    void bridge.hosting().then(setHosting);
    void bridge.backups().then(setBackups);
    const stop = bridge.onHosting(setHosting);
    // Device activity changes without the host announcing it.
    const timer = setInterval(() => void bridge.hosting().then(setHosting), 15000);
    return () => {
      stop();
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    const keys = (event: KeyboardEvent) =>
      event.key === 'Escape' && !inviting && !confirm && !moving && props.onClose();
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [inviting, confirm, moving]);
  const check = () => {
    setChecks(undefined);
    void bridge.checkConnection().then(setChecks, (reason) => setError(message(reason)));
  };
  useEffect(() => {
    setError('');
    if (section === 'check') check();
    if (section === 'backups') void bridge.backups().then(setBackups);
  }, [section]);

  const isHost = hosting?.hosting ?? false;
  // This notebook syncs through this very Mac, whether or not hosting is running right now.
  const own = Boolean(hosting && sync.host?.endsWith(`//127.0.0.1:${hosting.port}`));
  // The notebook an invitation is for: the open one when this Mac hosts it.
  const invited =
    hosting?.notebooks.find((each) => each.name === sync.notebook)?.name ??
    hosting?.notebooks[0]?.name ??
    props.notebook;
  const invite = (
    <Button className="shrink-0" onClick={() => setInviting(true)}>
      Add a device
    </Button>
  );
  const hostOnly = (what: string) => (
    <p className="text-muted-foreground text-[15px] leading-6">
      {what} are managed on the Mac that hosts the notebook.{' '}
      {sync.connected
        ? `This Mac is connected to a host at ${sync.host?.replace(/^https?:\/\//, '')}.`
        : 'Nothing is hosting this notebook yet.'}{' '}
      <button className="text-link" onClick={() => props.onSection('sync')}>
        Open Sync
      </button>
    </p>
  );

  const checkRow = (
    <Row
      name="Connection check"
      description="Something not arriving? This finds what is in the way."
    >
      <Button variant="secondary" onClick={() => props.onSection('check')}>
        Run check
      </Button>
    </Row>
  );
  const back = (
    <button
      className="text-muted-foreground hover:text-foreground -mt-1 text-[13px]"
      onClick={() => props.onSection('sync')}
    >
      ‹ Sync
    </button>
  );

  const takeOverRow = (
    <Row
      name="Host from this Mac instead"
      description="Moves the host here, with every notebook, its history and its devices. They follow by themselves."
    >
      <Button variant="secondary" className="shrink-0" onClick={() => setMoving('take-over')}>
        Take over hosting…
      </Button>
    </Row>
  );

  let body: ReactNode;
  if (!hosting) body = <p className="text-muted-foreground">Loading…</p>;
  else if (section === 'sync' && hosting.moved)
    body = (
      <>
        <MovedSettings
          moved={hosting.moved}
          busy={busy}
          onStop={() => run(() => bridge.stopHosting().then(setHosting))}
        />
        {sync.connected && <div>{checkRow}</div>}
      </>
    );
  else if (section === 'sync')
    body = isHost ? (
      <>
        <Heading
          dot="bg-success"
          title="Sync"
          sub={`This Mac is the host · ${count(hosting.devices.length, 'device')} · ${syncLabel(sync)}`}
          action={invite}
        />
        <section>
          <Label>Where devices reach it</Label>
          {hosting.addresses.map((each) => (
            <Line key={each.address}>
              <span>
                {each.kind === 'tailscale' ? 'Anywhere, over Tailscale' : 'On your home network'}
              </span>
              <code className="text-[13px] select-all">{each.address}</code>
            </Line>
          ))}
          {!hosting.addresses.length && (
            <Line>
              <span className="text-muted-foreground">
                This Mac is not on a network, so nothing can reach it yet.
              </span>
            </Line>
          )}
          {!hosting.addresses.some((each) => each.kind === 'tailscale') && (
            <p className="text-muted-foreground pt-2 text-[13px] leading-5">
              To sync away from home, install Tailscale on this Mac and on each device, and sign in
              to the same account on all of them.
            </p>
          )}
        </section>
        <section>
          <Label>Notebooks hosted here</Label>
          {hosting.notebooks.map((each) => (
            <Line key={each.name}>
              <span className="font-semibold">{each.name}</span>
              <span className="text-muted-foreground">
                {count(each.files, 'file')} · {count(each.versions, 'version')} · {size(each.bytes)}
              </span>
            </Line>
          ))}
        </section>
        {!sync.connected && (
          <div className="border-border flex items-center justify-between gap-6 rounded-xl border px-5 py-4 text-sm">
            <span>“{props.notebook}” is not hosted yet, so it lives only on this Mac.</span>
            <Button
              size="sm"
              className="shrink-0"
              disabled={busy}
              onClick={() => run(() => bridge.startHosting().then(setHosting))}
            >
              Host this notebook too
            </Button>
          </div>
        )}
        <div>
          <Row
            name={<label htmlFor="keep-running">Keep hosting when the window is closed</label>}
            description="Opsidian stays in the menu bar. Once installed, it also starts when you log in."
          >
            <input
              id="keep-running"
              type="checkbox"
              role="switch"
              className="accent-primary size-5"
              checked={hosting.keepRunning}
              onChange={(event) => run(() => bridge.setKeepRunning(event.target.checked))}
            />
          </Row>
          {sync.connected && checkRow}
          <Row
            name="Move hosting to another machine"
            description="To a server or another Mac, with every notebook, its history and its devices. They follow by themselves."
          >
            <Button variant="secondary" className="shrink-0" onClick={() => setMoving('move')}>
              Move…
            </Button>
          </Row>
          <Row name="Stop hosting" description="This Mac must be awake for devices to sync.">
            <Button variant="secondary" onClick={() => setConfirm({ kind: 'stop' })}>
              Stop hosting…
            </Button>
          </Row>
        </div>
      </>
    ) : sync.connected && own ? (
      <>
        <Heading
          dot="bg-faint"
          title="Hosting is off"
          sub={`This Mac hosts “${props.notebook}”, but hosting is not running, so no device can sync.`}
          action={
            <Button
              className="shrink-0"
              disabled={busy}
              onClick={() => run(() => bridge.startHosting().then(setHosting))}
            >
              Turn on hosting
            </Button>
          }
        />
        {hosting.error && (
          <p role="alert" className="text-destructive text-sm leading-5">
            {hosting.error}
          </p>
        )}
        <p className="text-muted-foreground text-sm leading-[22px]">
          Everything the host holds is still on this Mac. Your devices pick up where they left off
          when it is turned on again.
        </p>
        <div>{checkRow}</div>
      </>
    ) : sync.connected ? (
      <>
        <Heading
          dot={sync.state === 'synced' ? 'bg-success' : 'bg-faint'}
          title="Sync"
          sub={
            sync.message && sync.state !== 'synced'
              ? `${syncLabel(sync)}. ${sync.message}`
              : `${syncLabel(sync)} · “${props.notebook}” syncs through a host on another machine.`
          }
        />
        <section>
          <Line>
            <span className="text-muted-foreground">Notebook</span>
            <span>{sync.notebook}</span>
          </Line>
          <Line>
            <span className="text-muted-foreground">Host</span>
            <code className="text-[13px]">{sync.host?.replace(/^https?:\/\//, '')}</code>
          </Line>
          <Line>
            <span className="text-muted-foreground">This device</span>
            <span>{sync.device}</span>
          </Line>
        </section>
        <div>
          {checkRow}
          {takeOverRow}
          <Row
            name="Host moved?"
            description="If the host went to another machine while this Mac was away, give its new address."
          >
            <Button variant="secondary" className="shrink-0" onClick={() => setMoving('follow')}>
              Change address…
            </Button>
          </Row>
          <Row
            name="Stop syncing here"
            description="Every note stays on this Mac and on the host. You can join again later."
          >
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => run(() => bridge.disconnect())}
            >
              Stop syncing
            </Button>
          </Row>
        </div>
      </>
    ) : (
      <>
        <Heading
          dot="bg-faint"
          title="Sync"
          sub={`Sync is off. “${props.notebook}” lives only on this Mac; to see it on your other devices, one machine has to host it.`}
        />
        {hosting.error && (
          <p role="alert" className="text-destructive text-sm leading-5">
            {hosting.error}
          </p>
        )}
        <div>
          <Row
            name="Host on this Mac"
            description="Best if this Mac stays on. Your devices sync through it, at home or over Tailscale."
          >
            <Button
              className="shrink-0"
              disabled={busy}
              onClick={() => run(() => bridge.startHosting().then(setHosting))}
            >
              Turn on hosting
            </Button>
          </Row>
          <Row
            name="Join a host"
            description="Another Mac or a server is hosting already. You need an invitation from it."
          >
            <Button variant="secondary" className="shrink-0" onClick={props.onConnect}>
              Enter an invitation
            </Button>
          </Row>
          {takeOverRow}
        </div>
        <p className="text-muted-foreground text-[13px] leading-5">
          Prefer a server that is always on? See docs/hosting.md. Your notes are never stored by
          anyone but you.
        </p>
      </>
    );
  else if (section === 'devices')
    body = !isHost ? (
      <>
        <Heading title="Devices" />
        {hostOnly('Devices')}
      </>
    ) : (
      <>
        <Heading
          title="Devices"
          sub="Everything that can read and change the notebooks hosted here."
          action={invite}
        />
        <section>
          {hosting.devices.map((each) => {
            const live = each.self || (each.seen !== undefined && Date.now() - each.seen < 120000);
            return (
              <div
                key={each.id}
                className="border-border flex h-[60px] items-center gap-4 border-t text-sm last:border-b"
              >
                <span className={`size-2 rounded-full ${live ? 'bg-success' : 'bg-faint'}`} />
                <div className="flex-1">
                  <p className="font-semibold">{each.name}</p>
                  <p className="text-muted-foreground text-[13px]">
                    {each.self
                      ? 'This Mac · hosting'
                      : each.github
                        ? `Keeps “${each.notebook}” in ${each.github}`
                        : `${each.notebook} · joined ${day(each.created)}`}
                  </p>
                </div>
                <span className="text-muted-foreground w-44">
                  {each.self ? 'In step now' : ago(each.seen)}
                </span>
                <span className="w-16 text-right">
                  {each.github ? (
                    <button className="text-link" onClick={() => props.onSection('github')}>
                      GitHub
                    </button>
                  ) : (
                    !each.self && (
                      <button
                        className="text-destructive"
                        onClick={() => setConfirm({ kind: 'remove', id: each.id, name: each.name })}
                      >
                        Remove
                      </button>
                    )
                  )}
                </span>
              </div>
            );
          })}
          {hosting.invitations.map((each) => (
            <div
              key={each.id}
              className="border-border flex h-[60px] items-center gap-4 border-t text-sm last:border-b"
            >
              <span className="size-2 rounded-full bg-amber-500" />
              <div className="flex-1">
                <p className="font-semibold">Invitation, not used yet</p>
                <p className="text-muted-foreground text-[13px]">
                  {each.notebook} · expires{' '}
                  {new Date(each.expires).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
              </div>
              <span className="text-muted-foreground w-44">Waiting</span>
              <span className="w-16 text-right">
                <button
                  className="text-muted-foreground"
                  onClick={() => run(() => bridge.cancelInvitation(each.id).then(setHosting))}
                >
                  Cancel
                </button>
              </span>
            </div>
          ))}
        </section>
        <p className="text-muted-foreground text-[13px] leading-5">
          Removing a device stops it syncing at once. The notes already on it stay there, and it can
          be invited back.
        </p>
      </>
    );
  else if (section === 'backups')
    body = !isHost ? (
      <>
        <Heading title="Backups" />
        {hostOnly('Backups')}
      </>
    ) : (
      <>
        <Heading
          title="Backups"
          sub="A copy of every notebook this Mac hosts, with its full history."
          action={
            <Button
              className="shrink-0"
              disabled={busy || !backups?.folder}
              onClick={() => run(() => bridge.backUpNow().then(setBackups))}
            >
              {busy ? 'Working…' : 'Back up now'}
            </Button>
          }
        />
        <section>
          <Line>
            <span className="text-muted-foreground">Save backups to</span>
            <span className="flex min-w-0 gap-3.5">
              <span className="truncate">{backups?.folder ?? 'Not chosen yet'}</span>
              <button
                className="text-link shrink-0"
                onClick={() =>
                  run(() => bridge.chooseBackupFolder().then((next) => next && setBackups(next)))
                }
              >
                {backups?.folder ? 'Change…' : 'Choose…'}
              </button>
            </span>
          </Line>
          <Line>
            <span className="text-muted-foreground">How often</span>
            <select
              aria-label="How often"
              className="bg-transparent text-right outline-none"
              value={backups?.hour ?? 'never'}
              onChange={(event) =>
                run(() =>
                  bridge
                    .setBackupSchedule(
                      event.target.value === 'never' ? null : Number(event.target.value),
                      backups?.keep ?? 14,
                    )
                    .then(setBackups),
                )
              }
            >
              <option value="never">Only when I ask</option>
              {Array.from({ length: 24 }, (_unused, hour) => (
                <option key={hour} value={hour}>
                  Every day at {String(hour).padStart(2, '0')}:00
                </option>
              ))}
            </select>
          </Line>
          <Line>
            <span className="text-muted-foreground">Keep</span>
            <select
              aria-label="Keep"
              className="bg-transparent text-right outline-none"
              value={backups?.keep ?? 14}
              onChange={(event) =>
                run(() =>
                  bridge
                    .setBackupSchedule(backups?.hour ?? null, Number(event.target.value))
                    .then(setBackups),
                )
              }
            >
              {[7, 14, 30, 90].map((keep) => (
                <option key={keep} value={keep}>
                  The last {keep} backups
                </option>
              ))}
            </select>
          </Line>
        </section>
        <section>
          <Label>Recent backups</Label>
          {backups?.failed && (
            <Line>
              <span className="flex items-center gap-2.5">
                <span className="bg-destructive size-2 rounded-full" />
                {day(backups.failed.at)}
              </span>
              <span className="text-destructive">Failed: {backups.failed.message}</span>
            </Line>
          )}
          {backups?.backups.slice(0, 6).map((each) => (
            <Line key={each.name}>
              <span className="flex items-center gap-2.5">
                <span className="bg-success size-2 rounded-full" />
                {day(each.at)}
              </span>
              <span className="text-muted-foreground">
                {count(each.notebooks.length, 'notebook')} ·{' '}
                {size(each.notebooks.reduce((sum, one) => sum + one.bytes, 0))}
              </span>
              <button
                className="text-link"
                onClick={() => setConfirm({ kind: 'restore', name: each.name, at: each.at })}
              >
                Restore…
              </button>
            </Line>
          ))}
          {!backups?.backups.length && !backups?.failed && (
            <p className="text-muted-foreground border-border border-t pt-3 text-sm">
              {backups?.folder ? 'No backups yet.' : 'Choose a folder to start backing up.'}
            </p>
          )}
        </section>
      </>
    );
  else if (section === 'github')
    body = (
      <GitHubSettings
        hosting={hosting}
        notebook={props.notebook}
        onHost={() => run(() => bridge.startHosting().then(setHosting))}
        onImport={props.onImport}
        heading={(sub, action) => <Heading title="GitHub" sub={sub} action={action} />}
      />
    );
  else if (section === 'check') {
    const failed = checks?.find((each) => each.state === 'failed');
    body = !sync.connected ? (
      <>
        {back}
        <Heading title="Connection check" />
        <p className="text-muted-foreground text-[15px] leading-6">
          This notebook is not connected to a host, so there is nothing to check.{' '}
          <button className="text-link" onClick={() => props.onSection('sync')}>
            Open Sync
          </button>
        </p>
      </>
    ) : (
      <>
        {back}
        <Heading
          dot={!checks ? 'bg-faint' : failed ? 'bg-destructive' : 'bg-success'}
          title={
            !checks
              ? 'Checking…'
              : failed
                ? 'This Mac cannot sync right now'
                : 'Everything is connected'
          }
          sub={
            failed
              ? 'Your notes are safe here and will sync when this is fixed.'
              : checks
                ? `This Mac reaches its host and the host accepts it. ${syncLabel(sync)}.`
                : undefined
          }
          action={
            <Button variant="secondary" className="shrink-0" onClick={check}>
              Check again
            </Button>
          }
        />
        <section>
          {checks?.map((each) => (
            <div
              key={each.id}
              data-check={each.id}
              data-state={each.state}
              className={`border-border flex min-h-14 items-center gap-3.5 border-t py-3 text-sm last:border-b ${each.state === 'skipped' ? 'text-faint' : ''}`}
            >
              <span
                className={`w-5 font-bold ${each.state === 'ok' ? 'text-success' : each.state === 'failed' ? 'text-destructive' : ''}`}
              >
                {each.state === 'ok' ? '✓' : each.state === 'failed' ? '✕' : '–'}
              </span>
              <div className="flex-1 space-y-1">
                <p className={each.state === 'failed' ? 'font-semibold' : ''}>{each.title}</p>
                {each.detail && (
                  <p className="text-muted-foreground text-[13px] leading-5">{each.detail}</p>
                )}
              </div>
              {each.tailscale && (
                <button className="text-link shrink-0" onClick={() => void bridge.openTailscale()}>
                  Open Tailscale
                </button>
              )}
              {each.state === 'skipped' && <span>Not checked</span>}
            </div>
          ))}
        </section>
        <p className="text-muted-foreground text-[13px] leading-5">
          Each step is tried in order and stops at the first that fails, so the fix is always the
          first red line.
        </p>
      </>
    );
  } else if (section === 'general')
    body = (
      <>
        <Heading title="General" />
        <div>
          <UpdateSettings />
          <Row
            name="Help"
            description="How Opsidian works, how to host, and what to do when sync stops."
          >
            <Button variant="secondary" onClick={() => void bridge.openHelp()}>
              Open
            </Button>
          </Row>
        </div>
      </>
    );
  else if (section === 'editor')
    body = (
      <>
        <Heading title="Editor" />
        <div>
          <Row
            name={<label htmlFor="default-view">Default view for notes</label>}
            description="How a note opens. ⌘E switches between reading and editing, and ⋯ on a note turns Source mode on and off."
          >
            <select
              id="default-view"
              className={select}
              defaultValue={defaultMode()}
              onChange={(event) => setDefaultMode(event.target.value as EditorMode)}
            >
              <option value="live">Live Preview</option>
              <option value="source">Source mode</option>
              <option value="reading">Reading view</option>
            </select>
          </Row>
        </div>
      </>
    );
  else
    body = (
      <>
        <Heading title="Appearance" />
        <div>
          <Row
            name={<label htmlFor="theme">Theme</label>}
            description="Light, dark, or whatever this Mac is set to."
          >
            <select
              id="theme"
              className={select}
              value={props.theme.preference}
              onChange={(event) => props.theme.set(event.target.value as ThemePreference)}
            >
              <option value="system">Match this Mac</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </Row>
        </div>
      </>
    );

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/30"
      onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}
    >
      <div
        role="dialog"
        aria-label="Settings"
        className="border-border bg-background text-foreground relative flex h-[min(640px,90vh)] w-[min(960px,94vw)] overflow-hidden rounded-xl border shadow-2xl"
      >
        <nav className="border-border bg-sidebar text-sidebar-foreground flex w-[220px] shrink-0 flex-col gap-px border-r px-2.5 py-6 text-[13.5px]">
          {GROUPS.map(([group, sections]) => (
            <div key={group} className="flex flex-col gap-px pb-4">
              <p className="text-faint px-2.5 pb-1.5 text-[11.5px] font-semibold tracking-[0.06em] uppercase">
                {group}
              </p>
              {sections.map(([id, label]) => {
                const current = section === id || (id === 'sync' && section === 'check');
                return (
                  <button
                    key={id}
                    aria-current={current ? 'page' : undefined}
                    className={`rounded-md px-2.5 py-1.5 text-left ${current ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium' : 'hover:bg-sidebar-accent/60'}`}
                    onClick={() => props.onSection(id)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="flex-1 space-y-5 overflow-y-auto px-10 py-8">
          {error && (
            <p role="alert" className="text-destructive text-sm leading-5">
              {error}
            </p>
          )}
          {body}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close settings"
          className="absolute top-3 right-3"
          onClick={props.onClose}
        >
          <X />
        </Button>
      </div>
      {inviting && (
        <InviteDialog
          notebook={invited}
          onClose={() => {
            setInviting(false);
            void bridge.hosting().then(setHosting);
          }}
        />
      )}
      {moving === 'move' && (
        <MoveDialog
          onClose={() => {
            setMoving(undefined);
            void bridge.hosting().then(setHosting);
          }}
        />
      )}
      {moving === 'take-over' && (
        <TakeOverDialog
          address={sync.connected && !own ? sync.host : undefined}
          onDone={setHosting}
          onClose={() => setMoving(undefined)}
        />
      )}
      {moving === 'follow' && <FollowDialog onClose={() => setMoving(undefined)} />}
      {confirm?.kind === 'stop' && (
        <Confirm
          title="Stop hosting on this Mac?"
          action="Stop hosting"
          onCancel={() => setConfirm(undefined)}
          onConfirm={() => {
            setConfirm(undefined);
            run(() => bridge.stopHosting().then(setHosting));
          }}
        >
          <p>
            Your devices will not be able to sync until hosting is turned on again. Nothing is
            deleted: every note stays on each device, and the host’s history stays on this Mac.
          </p>
        </Confirm>
      )}
      {confirm?.kind === 'remove' && (
        <Confirm
          title={`Remove “${confirm.name}”?`}
          action="Remove device"
          onCancel={() => setConfirm(undefined)}
          onConfirm={() => {
            const { id } = confirm;
            setConfirm(undefined);
            run(() => bridge.removeDevice(id).then(setHosting));
          }}
        >
          <p>
            It stops syncing at once. The notes already on it stay there. To let it back in, send it
            a new invitation.
          </p>
        </Confirm>
      )}
      {confirm?.kind === 'restore' && (
        <Confirm
          title={`Restore the backup from ${day(confirm.at)}?`}
          action="Restore this backup"
          onCancel={() => setConfirm(undefined)}
          onConfirm={() => {
            const { name } = confirm;
            setConfirm(undefined);
            run(() => bridge.restoreBackup(name).then(setBackups));
          }}
        >
          <p>The host goes back to how its notebooks were at that moment.</p>
          <p className="bg-secondary text-foreground rounded-lg px-4 py-3">
            <b>Nothing newer is thrown away.</b> What the host holds now is backed up first.
            <br />
            <b>Your devices keep their notes.</b> Each one catches up by itself, and what it wrote
            since the backup is sent back up. Notes deleted since then return.
          </p>
        </Confirm>
      )}
    </div>
  );
}
