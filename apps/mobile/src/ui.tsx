import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { themes } from '@opsidian/theme';
import { store } from './notebook';

export type Colors = (typeof themes)[keyof typeof themes];
export function useColors(): Colors {
  return themes[useColorScheme() === 'dark' ? 'dark' : 'light'];
}
/** Re-renders whenever the notebook or its sync status changes. */
export function useStore() {
  useSyncExternalStore(store.subscribe, () => store.stamp);
  return store;
}
export const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

/** "9:12" today, then "Yesterday", a weekday, and finally "3 Oct". */
export function when(at: number, now = Date.now()): string {
  const date = new Date(at);
  const day = (value: number) => new Date(value).setHours(0, 0, 0, 0);
  const days = Math.round((day(now) - day(at)) / 86400000);
  if (days <= 0) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString([], { weekday: 'short' });
  return date.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export function Screen({ children, edges }: { children: ReactNode; edges?: ('top' | 'bottom')[] }) {
  const colors = useColors();
  return (
    <SafeAreaView
      edges={edges ?? ['top', 'bottom']}
      style={[styles.fill, { backgroundColor: colors.background }]}
    >
      {children}
    </SafeAreaView>
  );
}

export function Nav(props: {
  back?: string;
  onBack?: () => void;
  title?: string;
  right?: ReactNode;
}) {
  const colors = useColors();
  return (
    <View style={styles.nav}>
      <View style={styles.navSide}>
        {props.onBack ? (
          <Pressable hitSlop={12} onPress={props.onBack} accessibilityRole="button">
            <Text style={{ color: colors.ring, fontSize: 17 }} numberOfLines={1}>
              {props.back ?? '‹ Back'}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {props.title ? (
        <Text style={[styles.navTitle, { color: colors.foreground }]} numberOfLines={1}>
          {props.title}
        </Text>
      ) : null}
      <View style={[styles.navSide, { alignItems: 'flex-end' }]}>{props.right}</View>
    </View>
  );
}
export function NavAction(props: {
  label: string;
  onPress: () => void;
  bold?: boolean;
  disabled?: boolean;
}) {
  const colors = useColors();
  return (
    <Pressable
      hitSlop={12}
      onPress={props.onPress}
      disabled={props.disabled}
      accessibilityRole="button"
    >
      <Text
        style={{
          color: props.disabled ? colors.faint : colors.ring,
          fontSize: 17,
          fontWeight: props.bold ? '600' : '400',
        }}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

export function Heading({ children, sub }: { children: string; sub?: string }) {
  const colors = useColors();
  return (
    <View style={{ paddingHorizontal: 20, paddingTop: 10, paddingBottom: 14, gap: 4 }}>
      <Text style={[styles.large, { color: colors.foreground }]}>{children}</Text>
      {sub ? (
        <Text style={{ fontSize: 14, lineHeight: 21, color: colors.mutedForeground }}>{sub}</Text>
      ) : null}
    </View>
  );
}
export function Label({ children, style }: { children: string; style?: StyleProp<TextStyle> }) {
  const colors = useColors();
  return <Text style={[styles.label, { color: colors.mutedForeground }, style]}>{children}</Text>;
}
export function Muted({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  const colors = useColors();
  return (
    <Text style={[{ fontSize: 14, lineHeight: 21, color: colors.mutedForeground }, style]}>
      {children}
    </Text>
  );
}

export function Button(props: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger' | 'dark';
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const colors = useColors();
  const kind = props.kind ?? 'primary';
  const background =
    kind === 'primary' ? colors.ring : kind === 'dark' ? colors.foreground : colors.secondary;
  const color =
    kind === 'primary'
      ? '#ffffff'
      : kind === 'dark'
        ? colors.background
        : kind === 'danger'
          ? colors.destructive
          : colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: background, opacity: props.disabled ? 0.5 : pressed ? 0.8 : 1 },
        props.style,
      ]}
    >
      <Text style={{ color, fontSize: 17, fontWeight: kind === 'secondary' ? '500' : '600' }}>
        {props.label}
      </Text>
    </Pressable>
  );
}

/** A plain list row with an optional detail on the right. */
export function Row(props: {
  title: string;
  detail?: string | undefined;
  color?: string;
  bold?: boolean;
  chevron?: boolean;
  indent?: number;
  selected?: boolean;
  last?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      style={({ pressed }) => [
        styles.row,
        {
          borderBottomColor: props.last ? 'transparent' : colors.border,
          paddingLeft: (props.indent ?? 0) * 22,
          backgroundColor: props.selected || pressed ? colors.accent : 'transparent',
        },
      ]}
    >
      <Text
        numberOfLines={1}
        style={{
          flex: 1,
          fontSize: 17,
          color: props.color ?? colors.foreground,
          fontWeight: props.bold ? '600' : '400',
        }}
      >
        {props.title}
      </Text>
      {props.detail ? (
        <Text style={{ fontSize: 15, color: colors.mutedForeground }}>{props.detail}</Text>
      ) : null}
      {props.chevron ? <Text style={{ fontSize: 20, color: colors.faint }}>›</Text> : null}
    </Pressable>
  );
}

/** Rises from the bottom over whatever is on screen; a tap outside closes it. */
export function Sheet(props: { open: boolean; onClose: () => void; children: ReactNode }) {
  const colors = useColors();
  return (
    <Modal visible={props.open} transparent animationType="slide" onRequestClose={props.onClose}>
      <Pressable style={styles.scrim} onPress={props.onClose} accessibilityLabel="Close" />
      <View style={[styles.sheet, { backgroundColor: colors.popover }]}>
        <View style={[styles.grabber, { backgroundColor: colors.border }]} />
        {props.children}
      </View>
    </Modal>
  );
}

/** A whole screen that slides up over the current one, as a card. */
export function Page(props: { open: boolean; onClose: () => void; children: ReactNode }) {
  return (
    <Modal
      visible={props.open}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      {/* A modal is its own window, so it measures its own safe area. */}
      <SafeAreaProvider>{props.children}</SafeAreaProvider>
    </Modal>
  );
}

/** Runs once a closing sheet is out of the way; iOS cannot show two at the same moment. */
export const afterSheet = (task: () => void) => setTimeout(task, 400);

/** Asks for one name: a new folder, or a new name for a note. */
export function NameDialog(props: {
  open: boolean;
  title: string;
  initial?: string;
  action: string;
  note?: string;
  onCancel: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const colors = useColors();
  const [value, setValue] = useState(props.initial ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (props.open) {
      setValue(props.initial ?? '');
      setError('');
    }
  }, [props.open, props.initial]);
  const submit = async () => {
    const name = value.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      await props.onSubmit(name);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page open={props.open} onClose={props.onCancel}>
      <Screen>
        <Nav
          back="Cancel"
          onBack={props.onCancel}
          title={props.title}
          right={
            <NavAction
              label={props.action}
              bold
              onPress={() => void submit()}
              disabled={!value.trim() || busy}
            />
          }
        />
        <View style={{ padding: 24, gap: 12 }}>
          <TextInput
            autoFocus
            value={value}
            onChangeText={setValue}
            onSubmitEditing={() => void submit()}
            returnKeyType="done"
            autoCapitalize="sentences"
            style={[
              styles.input,
              { borderColor: colors.ring, color: colors.foreground, borderWidth: 2 },
            ]}
          />
          {error ? <Text style={{ color: colors.destructive, fontSize: 14 }}>{error}</Text> : null}
          {props.note ? <Muted>{props.note}</Muted> : null}
        </View>
      </Screen>
    </Page>
  );
}

/** Keeps content above the keyboard. */
export function AboveKeyboard({ children }: { children: ReactNode }) {
  return (
    <KeyboardAvoidingView style={styles.fill} behavior="padding">
      {children}
    </KeyboardAvoidingView>
  );
}
export function useKeyboardShown(): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', () => setShown(true));
    const hide = Keyboard.addListener('keyboardWillHide', () => setShown(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return shown;
}

export const styles = StyleSheet.create({
  fill: { flex: 1 },
  nav: { height: 44, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, gap: 8 },
  navSide: { flex: 1 },
  navTitle: { fontSize: 17, fontWeight: '600', maxWidth: '55%' },
  large: { fontSize: 34, lineHeight: 40, fontWeight: '700', letterSpacing: -1.1 },
  label: { fontSize: 12, fontWeight: '600', letterSpacing: 1 },
  button: {
    height: 54,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  row: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  input: { height: 52, borderRadius: 10, borderWidth: 1, paddingHorizontal: 16, fontSize: 17 },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)' },
  sheet: {
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 34,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    marginTop: -18,
  },
  grabber: { alignSelf: 'center', width: 36, height: 5, borderRadius: 3, marginBottom: 14 },
});
