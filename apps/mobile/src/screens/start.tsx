import { useEffect, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { connect, open, store } from '../notebook';
import {
  AboveKeyboard,
  Button,
  Muted,
  Nav,
  Screen,
  message,
  styles,
  useColors,
  useStore,
} from '../ui';

/** First launch: nothing on this iPhone yet. */
export function Welcome(props: { onConnect: () => void; onStarted: () => void }) {
  const colors = useColors();
  const [error, setError] = useState('');
  return (
    <Screen>
      <View
        style={{
          flex: 1,
          justifyContent: 'flex-end',
          paddingHorizontal: 28,
          paddingBottom: 40,
          gap: 14,
        }}
      >
        <View
          style={{
            width: 44,
            height: 54,
            borderRadius: 9,
            borderWidth: 3,
            borderLeftWidth: 9,
            borderColor: colors.ring,
          }}
        />
        <Text
          style={{
            fontSize: 38,
            lineHeight: 42,
            fontWeight: '700',
            letterSpacing: -1.3,
            color: colors.foreground,
            paddingTop: 18,
          }}
        >
          Your notebook,{'\n'}in your pocket.
        </Text>
        <Text style={{ fontSize: 17, lineHeight: 25, color: colors.mutedForeground }}>
          Plain Markdown notes that live on this iPhone and stay in step with your Macs.
        </Text>
      </View>
      <View style={{ paddingHorizontal: 20, paddingBottom: 30, gap: 10 }}>
        {error ? <Text style={{ color: colors.destructive, fontSize: 14 }}>{error}</Text> : null}
        <Button label="Connect to a notebook" onPress={props.onConnect} />
        <Button
          kind="secondary"
          label="Start one on this iPhone"
          onPress={() =>
            void open(true).then(props.onStarted, (reason) => setError(message(reason)))
          }
        />
        <Muted style={{ fontSize: 13, lineHeight: 19, textAlign: 'center', paddingTop: 10 }}>
          You can connect later. Notes you write now come along.
        </Muted>
      </View>
    </Screen>
  );
}

/** Host address and invitation code. Also used to connect again later. */
export function Connect(props: {
  /** Filled in from an invitation link. The user still has to press Connect. */
  invitation?: { host: string; code: string };
  onBack: () => void;
  onConnected: () => void;
}) {
  const colors = useColors();
  const [host, setHost] = useState(props.invitation?.host ?? '');
  const [code, setCode] = useState(props.invitation?.code ?? '');
  useEffect(() => {
    if (!props.invitation) return;
    setHost(props.invitation.host);
    setCode(props.invitation.code);
  }, [props.invitation]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!host.trim() || !code.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await connect(host, code);
      props.onConnected();
    } catch (reason) {
      const text = message(reason);
      setError(
        /could not be reached/i.test(text)
          ? 'This iPhone could not reach the host. Check the address, and that Tailscale is on. The host must be running.'
          : text,
      );
    } finally {
      setBusy(false);
    }
  };
  const field = { borderColor: colors.input, color: colors.foreground };
  return (
    <Screen>
      <AboveKeyboard>
        <Nav back="‹ Back" onBack={props.onBack} />
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 24, gap: 18 }}
        >
          <View style={{ gap: 10, paddingBottom: 10 }}>
            <Text
              style={{
                fontSize: 30,
                lineHeight: 36,
                fontWeight: '700',
                letterSpacing: -0.9,
                color: colors.foreground,
              }}
            >
              Connect to a notebook
            </Text>
            <Text style={{ fontSize: 16, lineHeight: 24, color: colors.mutedForeground }}>
              On the Mac that hosts it, run{' '}
              <Text style={{ fontFamily: 'Menlo', fontSize: 14, color: colors.foreground }}>
                pnpm host invite
              </Text>{' '}
              and type what it prints.
            </Text>
          </View>
          {error ? (
            <View
              style={{
                flexDirection: 'row',
                gap: 12,
                padding: 14,
                borderRadius: 10,
                backgroundColor: colors.secondary,
              }}
            >
              <View style={{ width: 4, borderRadius: 2, backgroundColor: colors.destructive }} />
              <Text style={{ flex: 1, fontSize: 14, lineHeight: 20, color: colors.foreground }}>
                {error}
              </Text>
            </View>
          ) : null}
          <View style={{ gap: 8 }}>
            <Text style={{ fontSize: 14, fontWeight: '600', color: colors.foreground }}>
              Host address
            </Text>
            <TextInput
              accessibilityLabel="Host address"
              value={host}
              onChangeText={setHost}
              placeholder="100.84.12.7:4810"
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={[styles.input, field]}
            />
          </View>
          <View style={{ gap: 8 }}>
            <Text style={{ fontSize: 14, fontWeight: '600', color: colors.foreground }}>
              Invitation code
            </Text>
            <TextInput
              accessibilityLabel="Invitation code"
              value={code}
              onChangeText={setCode}
              placeholder="K7QM-2XPD-9RTA"
              placeholderTextColor={colors.faint}
              autoCapitalize="characters"
              autoCorrect={false}
              onSubmitEditing={() => void submit()}
              style={[styles.input, field, { fontFamily: 'Menlo', letterSpacing: 1.2 }]}
            />
            <Muted style={{ fontSize: 13 }}>Works once, for 15 minutes.</Muted>
          </View>
          <Button
            label={busy ? 'Connecting…' : error ? 'Try again' : 'Connect'}
            disabled={busy || !host.trim() || !code.trim()}
            onPress={() => void submit()}
          />
          <Muted style={{ fontSize: 13, lineHeight: 19 }}>
            This iPhone reaches the host over Tailscale or your home Wi-Fi. Turn Tailscale on first
            if the host is not at home.
          </Muted>
        </ScrollView>
      </AboveKeyboard>
    </Screen>
  );
}

/** Shown after connecting until the first download finishes or the user moves on. */
export function Downloading(props: { onContinue: () => void }) {
  const colors = useColors();
  const { tree, sync, name } = useStore();
  const failed = sync.state === 'offline' || sync.state === 'error';
  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 28, gap: 14 }}>
        <Text style={{ fontSize: 13, fontWeight: '600', letterSpacing: 1, color: colors.ring }}>
          CONNECTED
        </Text>
        <Text
          style={{
            fontSize: 34,
            lineHeight: 40,
            fontWeight: '700',
            letterSpacing: -1.1,
            color: colors.foreground,
          }}
        >
          Bringing “{name}” to this iPhone
        </Text>
        <Text style={{ fontSize: 15, color: colors.mutedForeground }}>
          {tree.notes.length} {tree.notes.length === 1 ? 'note' : 'notes'} so far
        </Text>
        <Muted style={{ fontSize: 15, lineHeight: 22, paddingTop: 14 }}>
          {failed
            ? (sync.message ??
              'The host went out of reach. The download continues when it is back.')
            : 'Keep Opsidian open. You can start reading as soon as the notes arrive; pictures follow.'}
        </Muted>
      </View>
      <View style={{ paddingHorizontal: 20, paddingBottom: 30 }}>
        <Button kind="secondary" label="Start reading" onPress={props.onContinue} />
      </View>
    </Screen>
  );
}

/** Sync holds back a large batch of deletions until someone agrees to it. */
export function HeldDeletions(props: { onLater: () => void }) {
  const colors = useColors();
  const { sync } = useStore();
  const count = sync.held ?? 0;
  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 28, gap: 14 }}>
        <Text style={{ fontSize: 13, fontWeight: '600', letterSpacing: 1, color: '#b56a00' }}>
          SYNC IS WAITING FOR YOU
        </Text>
        <Text
          style={{
            fontSize: 32,
            lineHeight: 38,
            fontWeight: '700',
            letterSpacing: -1,
            color: colors.foreground,
          }}
        >
          {count} {count === 1 ? 'file was' : 'files were'} removed on another device.
        </Text>
        <Text style={{ fontSize: 17, lineHeight: 26, color: colors.mutedForeground }}>
          That is a large part of this notebook, so nothing has been removed here yet. If it was a
          mistake, fix it on the other device first.
        </Text>
      </View>
      <View style={{ paddingHorizontal: 20, paddingBottom: 30, gap: 10 }}>
        <Button
          kind="dark"
          label={`Move ${count} to trash here`}
          onPress={() => store.notebook?.sync.confirmDeletions()}
        />
        <Button kind="secondary" label="Not now" onPress={props.onLater} />
        <Muted style={{ fontSize: 13, lineHeight: 19, textAlign: 'center', paddingTop: 6 }}>
          They go to the trash on this iPhone, where you can put them back.
        </Muted>
      </View>
    </Screen>
  );
}
