import { useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, Switch, Text, View } from 'react-native';
import * as Network from 'expo-network';
import type { Check as Step } from '@opsidian/sync';
import { noteTitle, type GitHubCopy, type NoteVersion } from '@opsidian/core';
import { disconnect, refresh, store } from '../notebook';
import { rejected, syncLine, useNavigation } from '../nav';
import {
  Button,
  Heading,
  Label,
  Muted,
  Nav,
  Row,
  Screen,
  Sheet,
  message,
  useColors,
  useStore,
  when,
} from '../ui';

function Fact({ label, value }: { label: string; value: string }) {
  const colors = useColors();
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 16,
        minHeight: 50,
        borderTopWidth: 0.5,
        borderTopColor: colors.border,
      }}
    >
      <Text style={{ fontSize: 17, color: colors.mutedForeground }}>{label}</Text>
      <Text
        numberOfLines={1}
        style={{ flex: 1, textAlign: 'right', fontSize: 17, color: colors.foreground }}
      >
        {value}
      </Text>
    </View>
  );
}

/** How this iPhone and the host are getting on, and the way to connect or leave. */
export function Sync() {
  const colors = useColors();
  const navigation = useNavigation();
  const { sync, tree } = useStore();
  const [leaving, setLeaving] = useState(false);
  /** Whether disconnecting also deletes the notebook from this iPhone. */
  const [empty, setEmpty] = useState(true);
  const [left, setLeft] = useState('');
  const line = syncLine(sync, colors);
  const out = rejected(sync);
  // The notebook's copy on GitHub, which its host keeps; any device can ask for a round.
  const [copy, setCopy] = useState<GitHubCopy | null>(null);
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState('');
  useEffect(() => {
    if (!sync.connected || out) return setCopy(null);
    let live = true;
    void store.notebook?.sync.githubCopy().then(
      (next) => live && setCopy(next),
      () => live && setCopy(null),
    );
    return () => {
      live = false;
    };
  }, [sync.connected, out]);
  const syncWithGitHub = () => {
    setCopying(true);
    setCopied('');
    void store
      .notebook!.sync.syncWithGitHub()
      .then(
        (next) => {
          setCopy(next);
          setCopied(
            next.state === 'synced' && !next.held
              ? `${next.repository} is up to date.`
              : next.held
                ? `${next.held} deletions wait to be confirmed on the host.`
                : (next.message ?? 'GitHub could not be synced.'),
          );
        },
        (reason) => setCopied(message(reason)),
      )
      .finally(() => setCopying(false));
  };
  const state = !sync.connected
    ? 'Not syncing'
    : out
      ? 'Not connected'
      : sync.held
        ? 'Waiting for you'
        : sync.state === 'synced'
          ? 'In step'
          : sync.state === 'offline'
            ? 'Offline'
            : sync.state === 'error'
              ? 'Needs attention'
              : 'Syncing…';
  const explain = !sync.connected
    ? 'This notebook lives only on this iPhone. Connect it to a host to keep it in step with your Macs.'
    : out
      ? 'The host no longer accepts this iPhone. Someone removed it from the notebook’s devices, or the host was set up again.'
      : sync.held
        ? `${sync.held} deletions from another device are held until you agree to them.`
        : sync.state === 'synced'
          ? `Everything on this iPhone matches the host.${sync.at ? ` Last checked ${when(sync.at)}.` : ''}`
          : sync.state === 'offline'
            ? `The host is out of reach.${sync.waiting ? ` ${sync.waiting} ${sync.waiting === 1 ? 'change is' : 'changes are'} saved here and waiting.` : ''} ${sync.message ?? ''}`
            : sync.state === 'error'
              ? (sync.message ?? 'Something went wrong.')
              : 'Exchanging changes with the host.';
  return (
    <Screen>
      <Nav back={navigation.back} onBack={navigation.pop} />
      <ScrollView contentContainerStyle={{ flexGrow: 1 }}>
        <View style={{ paddingHorizontal: 24, paddingTop: 14, paddingBottom: 26, gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View
              style={{
                width: 14,
                height: 14,
                borderRadius: 7,
                backgroundColor: out ? colors.destructive : line.color,
              }}
            />
            <Text
              style={{
                fontSize: 34,
                lineHeight: 40,
                fontWeight: '700',
                letterSpacing: -1.1,
                color: colors.foreground,
              }}
            >
              {state}
            </Text>
          </View>
          <Text style={{ fontSize: 16, lineHeight: 24, color: colors.mutedForeground }}>
            {explain.trim()}
          </Text>
          {out ? (
            <Text
              style={{ fontSize: 16, lineHeight: 24, color: colors.mutedForeground, paddingTop: 6 }}
            >
              Your {tree.notes.length} notes are still here. You can keep reading and writing;
              nothing syncs until you connect again.
            </Text>
          ) : null}
          {sync.problems && !out ? (
            <Muted>
              {sync.problems} {sync.problems === 1 ? 'file' : 'files'} could not be synced.{' '}
              {sync.message}
            </Muted>
          ) : null}
        </View>
        {sync.connected ? (
          <View style={{ paddingHorizontal: 24 }}>
            <Fact label="Notebook" value={sync.notebook ?? '—'} />
            <Fact label="Host" value={(sync.host ?? '').replace(/^https?:\/\//, '')} />
            <Fact label="This device" value={sync.device ?? '—'} />
            {copy ? (
              <Fact
                label="GitHub"
                value={`${copy.repository}${copy.at ? ` · ${when(copy.at)}` : ''}`}
              />
            ) : null}
            <View style={{ borderTopWidth: 0.5, borderTopColor: colors.border }} />
            <Muted style={{ fontSize: 15, lineHeight: 23, paddingTop: 22 }}>
              While Opsidian is open, changes travel in about a second. When it is closed, they wait
              and go the next time you open it.
            </Muted>
          </View>
        ) : null}
        <View style={{ flex: 1 }} />
        <View style={{ paddingHorizontal: 20, paddingBottom: 10, paddingTop: 24, gap: 10 }}>
          {!sync.connected || out ? (
            <Button
              label={out ? 'Connect again with a new code' : 'Connect to a host'}
              onPress={() => navigation.push({ name: 'connect' })}
            />
          ) : null}
          {sync.connected && !out && sync.state !== 'synced' ? (
            <Button
              kind="secondary"
              label="See what is in the way"
              onPress={() => navigation.push({ name: 'check' })}
            />
          ) : null}
          {copy ? (
            <>
              <Button
                kind="secondary"
                label={copying ? 'Syncing with GitHub…' : 'Sync with GitHub now'}
                disabled={copying}
                onPress={syncWithGitHub}
              />
              {copied ? (
                <Muted style={{ fontSize: 13, textAlign: 'center' }}>{copied}</Muted>
              ) : null}
            </>
          ) : null}
          {sync.held ? (
            <Button
              kind="dark"
              label={`Move ${sync.held} to trash here`}
              onPress={() => store.notebook?.sync.confirmDeletions()}
            />
          ) : null}
          {sync.connected ? (
            <>
              <Button
                kind="danger"
                label={out ? 'Keep using without sync' : 'Disconnect this iPhone'}
                onPress={() => setLeaving(true)}
              />
              <Muted style={{ fontSize: 13, textAlign: 'center' }}>
                Your notes stay on the host.
              </Muted>
            </>
          ) : null}
          {left ? <Muted style={{ fontSize: 13, textAlign: 'center' }}>{left}</Muted> : null}
        </View>
      </ScrollView>
      <Sheet open={leaving} onClose={() => setLeaving(false)}>
        <Text
          style={{ fontSize: 20, fontWeight: '700', color: colors.foreground, paddingBottom: 6 }}
        >
          Stop syncing this iPhone?
        </Text>
        <Muted style={{ paddingBottom: 16 }}>
          The notebook stays on the host and your other devices. The host removes this iPhone from
          its devices, so to sync again you will need a new invitation code.
        </Muted>
        {out ? (
          <Muted style={{ paddingBottom: 16 }}>Every note stays on this iPhone.</Muted>
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 16 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 17, color: colors.foreground }}>
                Delete the notes from this iPhone
              </Text>
              <Muted style={{ fontSize: 13 }}>
                Only once every note has reached the host. If anything has not, they stay here.
              </Muted>
            </View>
            <Switch value={empty} onValueChange={setEmpty} />
          </View>
        )}
        <Button
          kind="danger"
          label={empty && !out ? 'Disconnect and delete' : 'Disconnect'}
          onPress={() => {
            setLeaving(false);
            setLeft('');
            void disconnect(empty && !out).then(
              ({ emptied }) => {
                if (empty && !out && !emptied)
                  setLeft(
                    'Disconnected. Your notes were kept on this iPhone, because not every change had reached the host.',
                  );
              },
              (reason) => setLeft(message(reason)),
            );
          }}
        />
      </Sheet>
    </Screen>
  );
}

const dayOf = (at: number) =>
  new Date(at).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
const timeOf = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Every version of a note the host has kept. */
export function History({ path }: { path: string }) {
  const colors = useColors();
  const navigation = useNavigation();
  const [versions, setVersions] = useState<NoteVersion[]>();
  const [error, setError] = useState('');
  useEffect(() => {
    void store
      .notebook!.sync.history(path)
      .then(setVersions, (reason) => setError(message(reason)));
  }, [path]);
  let day = '';
  return (
    <Screen>
      <Nav back={navigation.back} onBack={navigation.pop} />
      <Heading
        sub={`${noteTitle(path)}${versions ? ` · ${versions.length} ${versions.length === 1 ? 'version' : 'versions'} on the host` : ''}`}
      >
        History
      </Heading>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 30 }}>
        {error ? <Text style={{ color: colors.destructive }}>{error}</Text> : null}
        {versions && !versions.length ? (
          <Muted style={{ fontSize: 16 }}>
            The host has no versions of this note yet. They appear once it has synced.
          </Muted>
        ) : null}
        {versions?.map((version, position) => {
          const heading = dayOf(version.at) === day ? null : (day = dayOf(version.at));
          const renamed = versions[position + 1] && versions[position + 1]!.path !== version.path;
          return (
            <View key={version.seq}>
              {heading ? (
                <Label style={{ paddingTop: position ? 20 : 6, paddingBottom: 6 }}>
                  {heading.toUpperCase()}
                </Label>
              ) : null}
              <Row
                title={`${timeOf(version.at)} · ${version.device}`}
                bold={position === 0}
                detail={
                  position === 0
                    ? 'Current'
                    : version.hash === null
                      ? 'Deleted'
                      : renamed
                        ? 'Renamed'
                        : undefined
                }
                chevron={position > 0 && version.hash !== null}
                {...(position > 0 && version.hash !== null
                  ? { onPress: () => navigation.push({ name: 'version', path, version }) }
                  : {})}
              />
            </View>
          );
        })}
      </ScrollView>
    </Screen>
  );
}

/** One earlier version, read only, with the way to bring it back. */
export function Version({ path, version }: { path: string; version: NoteVersion }) {
  const colors = useColors();
  const navigation = useNavigation();
  const [content, setContent] = useState<string>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (version.hash)
      void store
        .notebook!.sync.versionText(version.hash)
        .then(setContent, (reason) => setError(message(reason)));
  }, [version]);
  const restore = async () => {
    if (content === undefined || busy) return;
    setBusy(true);
    try {
      const vault = store.notebook!.vault;
      const current = await vault.read(path);
      await vault.save(path, content, current.revision);
      refresh([path]);
      navigation.pop();
      navigation.pop();
    } catch (reason) {
      setError(message(reason));
      setBusy(false);
    }
  };
  return (
    <Screen>
      <Nav
        back="‹ History"
        onBack={navigation.pop}
        title={`${timeOf(version.at)} · ${version.device}`}
      />
      <ScrollView contentContainerStyle={{ padding: 24, gap: 16 }}>
        <Label>AN EARLIER VERSION · READ ONLY</Label>
        <Text
          style={{
            fontSize: 30,
            lineHeight: 36,
            fontWeight: '700',
            letterSpacing: -0.9,
            color: colors.foreground,
          }}
        >
          {noteTitle(version.path)}
        </Text>
        {error ? <Text style={{ color: colors.destructive }}>{error}</Text> : null}
        <Text selectable style={{ fontSize: 17, lineHeight: 27, color: colors.foreground }}>
          {content ?? (error ? '' : 'Fetching this version from the host…')}
        </Text>
      </ScrollView>
      <View
        style={{
          paddingHorizontal: 20,
          paddingTop: 16,
          paddingBottom: 10,
          gap: 10,
          borderTopWidth: 0.5,
          borderTopColor: colors.border,
        }}
      >
        <Button
          label={busy ? 'Restoring…' : 'Restore this version'}
          disabled={content === undefined || busy}
          onPress={() => void restore()}
        />
        <Muted style={{ fontSize: 13, lineHeight: 19, textAlign: 'center' }}>
          Today’s text is not lost. Restoring adds a new version on top, on every device.
        </Muted>
      </View>
    </Screen>
  );
}

/** Why this iPhone and its host are not talking, one step at a time. */
export function Check() {
  const colors = useColors();
  const navigation = useNavigation();
  const { sync } = useStore();
  const [steps, setSteps] = useState<Step[]>();
  const run = () => {
    setSteps(undefined);
    store.notebook?.sync.kick();
    void store.notebook?.sync
      .check(
        'this iPhone',
        async () => (await Network.getNetworkStateAsync()).isConnected !== false,
      )
      .then(setSteps, (reason) =>
        setSteps([
          {
            id: 'online',
            state: 'failed',
            title: 'The check itself could not run',
            detail: message(reason),
          },
        ]),
      );
  };
  useEffect(run, []);
  const failed = steps?.find((step) => step.state === 'failed');
  return (
    <Screen>
      <Nav back={navigation.back} onBack={navigation.pop} />
      <View style={{ paddingHorizontal: 24, paddingTop: 14, paddingBottom: 22, gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View
            style={{
              width: 14,
              height: 14,
              borderRadius: 7,
              backgroundColor: !steps ? colors.faint : failed ? colors.destructive : colors.success,
            }}
          />
          <Text
            style={{
              flex: 1,
              fontSize: 30,
              lineHeight: 36,
              fontWeight: '700',
              letterSpacing: -0.9,
              color: colors.foreground,
            }}
          >
            {!steps ? 'Checking…' : failed ? 'Cannot sync right now' : 'Everything is connected'}
          </Text>
        </View>
        <Text style={{ fontSize: 16, lineHeight: 24, color: colors.mutedForeground }}>
          {failed
            ? `${sync.waiting ? `${sync.waiting} ${sync.waiting === 1 ? 'change is' : 'changes are'} saved on this iPhone and waiting. ` : 'What you write is saved on this iPhone. '}Here is what is in the way.`
            : steps
              ? 'This iPhone reaches its host, and the host accepts it.'
              : 'Trying each step in turn.'}
        </Text>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 24 }}>
        {steps?.map((step) => (
          <View
            key={step.id}
            style={{
              flexDirection: 'row',
              gap: 14,
              paddingVertical: 14,
              borderTopWidth: 0.5,
              borderTopColor: colors.border,
            }}
          >
            <Text
              style={{
                width: 20,
                fontSize: 16,
                fontWeight: '700',
                color:
                  step.state === 'ok'
                    ? colors.success
                    : step.state === 'failed'
                      ? colors.destructive
                      : colors.faint,
              }}
            >
              {step.state === 'ok' ? '✓' : step.state === 'failed' ? '✕' : '–'}
            </Text>
            <View style={{ flex: 1, gap: 5 }}>
              <Text
                style={{
                  fontSize: 16,
                  fontWeight: step.state === 'failed' ? '600' : '400',
                  color: step.state === 'skipped' ? colors.faint : colors.foreground,
                }}
              >
                {step.title}
              </Text>
              {step.detail ? <Muted style={{ lineHeight: 20 }}>{step.detail}</Muted> : null}
              {step.tailscale ? (
                <Pressable
                  hitSlop={8}
                  onPress={() => void Linking.openURL('tailscale://').catch(() => {})}
                >
                  <Text
                    style={{ fontSize: 15, fontWeight: '600', color: colors.ring, paddingTop: 4 }}
                  >
                    Open Tailscale
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        ))}
      </ScrollView>
      <View style={{ paddingHorizontal: 20, paddingBottom: 10, gap: 10 }}>
        <Button label="Check again" onPress={run} />
        <Muted style={{ fontSize: 13, textAlign: 'center' }}>
          Opsidian keeps trying by itself. You can keep writing.
        </Muted>
      </View>
    </Screen>
  );
}
