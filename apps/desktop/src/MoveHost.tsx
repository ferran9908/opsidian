import { useEffect, useState, type ReactNode } from 'react';
import type { Handoff, HostingInfo, TakeOverProgress } from '@opsidian/core';
import { bridge, message } from './bridge';
import { Button } from '@/components/ui/button';
import { Line } from './Settings';

/**
 * Moving the host between machines: from this Mac to a server or another Mac, or from
 * wherever it is to this Mac. Devices follow by themselves, so nothing is set up again.
 */

const bare = (address: string) => address.replace(/^https?:\/\//, '');
const when = (at: number) =>
  new Date(at).toLocaleString([], {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

function Panel(props: { label: string; children: ReactNode; onClose(): void }) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}
    >
      <div
        role="dialog"
        aria-label={props.label}
        className="bg-popover text-popover-foreground w-[min(640px,92vw)] space-y-4 rounded-2xl p-9 shadow-2xl"
      >
        <h2 className="text-2xl font-bold tracking-tight">{props.label}</h2>
        {props.children}
      </div>
    </div>
  );
}
const Note = ({ children }: { children: ReactNode }) => (
  <p className="text-muted-foreground text-sm leading-[22px]">{children}</p>
);
const Problem = ({ text }: { text: string }) =>
  text ? (
    <p role="alert" className="text-destructive text-sm leading-5">
      {text}
    </p>
  ) : null;

/** On the hosting Mac: what the other machine needs, and how the move is going. */
export function MoveDialog(props: { onClose(): void }) {
  const [handoff, setHandoff] = useState<Handoff>();
  const [hosting, setHosting] = useState<HostingInfo>();
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const make = () =>
    void bridge.moveHosting().then(setHandoff, (reason) => setError(message(reason)));
  useEffect(make, []);
  useEffect(() => {
    // The other machine does the work; this one only watches it happen.
    const stop = bridge.onHosting(setHosting);
    const timer = setInterval(() => void bridge.hosting().then(setHosting), 1500);
    return () => {
      stop();
      clearInterval(timer);
    };
  }, []);

  if (hosting?.moved)
    return (
      <Panel label="Hosting has moved" onClose={props.onClose}>
        <Note>
          Every notebook, its history and its devices are now hosted at{' '}
          <code className="text-foreground">{bare(hosting.moved.to)}</code>. Each device follows the
          next time it syncs, this Mac included. Nothing needs to be set up again on any of them.
        </Note>
        <Note>
          This Mac keeps telling devices where the host went, so leave it on until they all have
          followed. Settings shows which have.
        </Note>
        <div className="flex justify-end pt-1">
          <Button onClick={props.onClose}>Done</Button>
        </div>
      </Panel>
    );
  return (
    <Panel label="Move hosting to another machine" onClose={props.onClose}>
      <Note>
        The other machine copies every notebook, its history and its devices from this Mac. Devices
        keep syncing while it copies, pause for a few seconds at the end, then follow by themselves.
      </Note>
      <Problem text={error} />
      {hosting?.moving ? (
        <p className="bg-secondary rounded-lg px-4 py-3 text-sm" role="status">
          The other machine is copying the host now…
        </p>
      ) : (
        <>
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">On a server, or a Mac without the app</h3>
            <div className="bg-secondary flex items-center justify-between gap-3 rounded-lg px-4 py-3">
              <code id="move-command" className="text-[13px] break-all select-all">
                {handoff?.command ?? '…'}
              </code>
              <Button
                variant="secondary"
                size="sm"
                disabled={!handoff}
                onClick={() => {
                  void navigator.clipboard.writeText(handoff!.command);
                  setCopied(true);
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </section>
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">On another Mac with Opsidian</h3>
            <Note>Open Settings → Sync, choose Take over hosting, and type:</Note>
            <div>
              <Line>
                <span className="text-muted-foreground">Address</span>
                <code className="text-[13px] select-all">{handoff?.address}</code>
              </Line>
              <Line>
                <span className="text-muted-foreground">Code</span>
                <code id="move-code" className="text-[15px] font-bold tracking-[0.08em] select-all">
                  {handoff?.code}
                </code>
              </Line>
            </div>
          </section>
          {handoff && (
            <p className="text-muted-foreground text-[13px]">
              Works once, until {when(handoff.expires)}.
            </p>
          )}
        </>
      )}
      <div className="flex justify-end gap-2.5 pt-1">
        <Button variant="secondary" onClick={make} disabled={hosting?.moving}>
          New code
        </Button>
        <Button onClick={props.onClose}>Close</Button>
      </div>
    </Panel>
  );
}

const PHASES: Record<TakeOverProgress['phase'], string> = {
  connecting: 'Asking the host to hand over…',
  copying: 'Copying notes and history',
  pausing: 'Pausing changes for a moment to copy the last of them',
  finishing: 'Starting the host here and pointing devices to it…',
};

/** On a Mac that will host from now on: takes the host over from wherever it is. */
export function TakeOverDialog(props: {
  /** Where this Mac syncs with now, which is usually the host to take over. */
  address?: string | undefined;
  onClose(): void;
  onDone(info: HostingInfo): void;
}) {
  const [address, setAddress] = useState(props.address ? bare(props.address) : '');
  const [code, setCode] = useState('');
  const [progress, setProgress] = useState<TakeOverProgress>();
  const [error, setError] = useState('');
  const [done, setDone] = useState<HostingInfo>();
  useEffect(() => bridge.onTakeOver(setProgress), []);
  const working = Boolean(progress) && !done && !error;
  const start = () => {
    setError('');
    setProgress({ phase: 'connecting', done: 0, total: 0 });
    void bridge.takeOverHosting(address, code).then(
      (info) => {
        setDone(info);
        props.onDone(info);
      },
      (reason) => {
        setProgress(undefined);
        setError(message(reason));
      },
    );
  };

  if (done)
    return (
      <Panel label="This Mac is the host now" onClose={props.onClose}>
        <Note>
          It hosts {done.notebooks.map((each) => `“${each.name}”`).join(', ') || 'every notebook'}{' '}
          with all of its history. Every device follows by itself the next time it syncs; nothing
          needs to be set up again on any of them.
        </Note>
        <Note>
          The old host now only tells devices to come here. Once they all have, it can be stopped
          there. If it kept notebooks on GitHub, sign in to GitHub here to carry on.
        </Note>
        <div className="flex justify-end pt-1">
          <Button onClick={props.onClose}>Done</Button>
        </div>
      </Panel>
    );
  const percent =
    progress && progress.total > 0 ? Math.floor((progress.done / progress.total) * 100) : undefined;
  return (
    <Panel label="Take over hosting" onClose={() => !working && props.onClose()}>
      <Note>
        Makes this Mac the host, with every notebook, its history and its devices. They follow by
        themselves. Get a code on the current host: in Opsidian there, Settings → Sync → Move
        hosting; on a server, run <code className="text-foreground">opsidian host move</code>.
      </Note>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!working) start();
        }}
      >
        <label className="block space-y-1.5 text-sm">
          <span className="text-muted-foreground">Current host’s address</span>
          <input
            id="take-over-address"
            className="border-border bg-secondary h-9 w-full rounded-md border px-3 outline-none"
            placeholder="100.101.1.2:4810"
            value={address}
            disabled={working}
            onChange={(event) => setAddress(event.target.value)}
          />
        </label>
        <label className="block space-y-1.5 text-sm">
          <span className="text-muted-foreground">Code</span>
          <input
            id="take-over-code"
            className="border-border bg-secondary h-9 w-full rounded-md border px-3 font-bold tracking-[0.08em] outline-none"
            placeholder="ABCD-EFGH-JKLM"
            value={code}
            disabled={working}
            onChange={(event) => setCode(event.target.value)}
          />
        </label>
        <Problem text={error} />
        {progress && (
          <div className="space-y-1.5" role="status">
            <p className="text-sm">
              {PHASES[progress.phase]}
              {percent !== undefined && ` · ${percent}%`}
            </p>
            <div className="bg-secondary h-1.5 overflow-hidden rounded-full">
              <div
                className="bg-primary h-full transition-[width]"
                style={{ width: `${percent ?? (progress.phase === 'finishing' ? 100 : 5)}%` }}
              />
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2.5 pt-1">
          <Button type="button" variant="secondary" disabled={working} onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={working || !address.trim() || !code.trim()}>
            {working ? 'Taking over…' : 'Take over'}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

/** On a device whose host moved while it could not be told: points it at the new address. */
export function FollowDialog(props: { onClose(): void }) {
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Panel label="Change the host’s address" onClose={props.onClose}>
      <Note>
        For when the host moved to another machine and this Mac missed being told. It is checked
        first: only the same host, with this notebook and this Mac on it, is accepted. Your notes
        carry on syncing where they left off.
      </Note>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          void bridge
            .followHost(address)
            .then(props.onClose, (reason) => setError(message(reason)))
            .finally(() => setBusy(false));
        }}
      >
        <input
          id="follow-address"
          aria-label="New address"
          className="border-border bg-secondary h-9 w-full rounded-md border px-3 outline-none"
          placeholder="100.64.0.9:4810"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
        <Problem text={error} />
        <div className="flex justify-end gap-2.5 pt-1">
          <Button type="button" variant="secondary" onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !address.trim()}>
            {busy ? 'Checking…' : 'Change address'}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

/** Settings → Sync on a Mac whose host moved away: who has followed, and when to stop. */
export function MovedSettings(props: {
  moved: NonNullable<HostingInfo['moved']>;
  busy: boolean;
  onStop(): void;
}) {
  const { moved } = props;
  const waiting = moved.devices.filter((each) => !each.told);
  return (
    <>
      <div className="flex items-start justify-between gap-6 pb-1">
        <div className="space-y-1.5">
          <h2 className="text-xl leading-7 font-bold">Hosting moved</h2>
          <p className="text-muted-foreground flex items-center gap-2 text-[13px] leading-5">
            <span className="bg-faint size-2 shrink-0 rounded-full" />
            On {when(moved.at)} this Mac handed its host to {bare(moved.to)}. It only points devices
            there now.
          </p>
        </div>
      </div>
      <section>
        <h3 className="text-muted-foreground pb-2 text-xs font-semibold tracking-[0.08em] uppercase">
          Devices
        </h3>
        {moved.devices.map((each) => (
          <Line key={each.id}>
            <span>
              <span className="font-semibold">{each.name}</span>
              <span className="text-muted-foreground"> · {each.notebook}</span>
            </span>
            <span className={each.told ? 'text-success' : 'text-muted-foreground'}>
              {each.told
                ? 'Followed'
                : `Not yet${each.seen ? ` · last seen ${when(each.seen)}` : ''}`}
            </span>
          </Line>
        ))}
      </section>
      <div className="border-border flex items-center justify-between gap-6 border-t py-4">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium">Stop pointing devices</p>
          <div className="text-muted-foreground text-[13px] leading-5">
            {waiting.length
              ? `${waiting.length} not followed yet. Each one does the next time it syncs while this Mac is on; after that, change its host’s address in its Sync settings.`
              : 'Every device has followed, so this Mac has nothing left to do.'}
          </div>
        </div>
        <Button variant="secondary" disabled={props.busy} onClick={props.onStop}>
          Stop
        </Button>
      </div>
    </>
  );
}
