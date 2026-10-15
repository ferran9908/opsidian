import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { syncLine, useNavigation } from '../nav';
import { prefs, type Prefs } from '../prefs';
import { Chevron } from '../icons';
import { Nav, NavAction, Sheet, Row, useColors, useStore } from '../ui';

const THEMES: [Prefs['theme'], string][] = [
  ['system', 'Automatic'],
  ['light', 'Light'],
  ['dark', 'Dark'],
];
const MODES: [Prefs['mode'], string][] = [
  ['live', 'Editing'],
  ['source', 'Source mode'],
  ['reading', 'Reading view'],
];

function Group(props: { title: string; children: ReactNode }) {
  const colors = useColors();
  return (
    <View style={{ paddingHorizontal: 16, paddingBottom: 24 }}>
      <Text
        style={{
          fontSize: 13,
          color: colors.mutedForeground,
          paddingHorizontal: 16,
          paddingBottom: 7,
        }}
      >
        {props.title.toUpperCase()}
      </Text>
      <View style={{ backgroundColor: colors.card, borderRadius: 12, overflow: 'hidden' }}>
        {props.children}
      </View>
    </View>
  );
}
function Item(props: {
  title: string;
  detail?: string;
  dot?: string;
  last?: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      style={({ pressed }) => ({
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 16,
        borderBottomWidth: props.last ? 0 : 0.5,
        borderBottomColor: colors.border,
        backgroundColor: pressed ? colors.accent : 'transparent',
      })}
    >
      {props.dot ? (
        <View style={{ width: 9, height: 9, borderRadius: 4.5, backgroundColor: props.dot }} />
      ) : null}
      <Text style={{ flex: 1, fontSize: 17, color: colors.foreground }}>{props.title}</Text>
      {props.detail ? (
        <Text
          numberOfLines={1}
          style={{ maxWidth: '50%', fontSize: 16, color: colors.mutedForeground }}
        >
          {props.detail}
        </Text>
      ) : null}
      <Chevron color={colors.faint} size={16} to="right" />
    </Pressable>
  );
}

/** Settings, as a plain iPhone list: sync, how the app looks, and the trash. */
export function Settings() {
  const colors = useColors();
  const navigation = useNavigation();
  const { sync } = useStore();
  const chosen = useSyncExternalStore(prefs.subscribe, prefs.get);
  const [picking, setPicking] = useState<'theme' | 'mode'>();
  const line = syncLine(sync, colors);
  const host = sync.host?.replace(/^https?:\/\//, '').replace(/:\d+$/, '');
  const options = picking === 'theme' ? THEMES : MODES;
  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.secondary }}>
      <View style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
          <View style={{ backgroundColor: colors.secondary }}>
            <Nav right={<NavAction label="Done" bold onPress={navigation.pop} />} />
            <Text
              style={{
                paddingHorizontal: 20,
                paddingBottom: 18,
                fontSize: 34,
                lineHeight: 41,
                fontWeight: '700',
                letterSpacing: -0.6,
                color: colors.foreground,
              }}
            >
              Settings
            </Text>
          </View>
          <Group title="Sync">
            <Item
              title={sync.connected ? line.text : 'Sync is off'}
              dot={line.color}
              {...(sync.connected && host ? { detail: host } : {})}
              onPress={() => navigation.push({ name: 'sync' })}
            />
            <Item
              title="Connection check"
              last
              onPress={() => navigation.push({ name: 'check' })}
            />
          </Group>
          <Group title="Options">
            <Item
              title="Appearance"
              detail={THEMES.find(([value]) => value === chosen.theme)![1]}
              onPress={() => setPicking('theme')}
            />
            <Item
              title="Open notes in"
              detail={MODES.find(([value]) => value === chosen.mode)![1]}
              last
              onPress={() => setPicking('mode')}
            />
          </Group>
          <Group title="Notebook">
            <Item title="Trash" last onPress={() => navigation.push({ name: 'trash' })} />
          </Group>
          <Text
            style={{
              textAlign: 'center',
              fontSize: 13,
              lineHeight: 19,
              color: colors.mutedForeground,
            }}
          >
            Opsidian
            {'\n'}Updates arrive on their own.
          </Text>
        </ScrollView>
      </View>
      <Sheet open={picking !== undefined} onClose={() => setPicking(undefined)}>
        <Text
          style={{ fontSize: 20, fontWeight: '700', color: colors.foreground, paddingBottom: 6 }}
        >
          {picking === 'theme' ? 'Appearance' : 'Open notes in'}
        </Text>
        {options.map(([value, label], at) => (
          <Row
            key={value}
            title={label}
            {...((picking === 'theme' ? chosen.theme : chosen.mode) === value
              ? { detail: '✓' }
              : {})}
            last={at === options.length - 1}
            onPress={() => {
              prefs.set(
                picking === 'theme'
                  ? { theme: value as Prefs['theme'] }
                  : { mode: value as Prefs['mode'] },
              );
              setPicking(undefined);
            }}
          />
        ))}
      </Sheet>
    </SafeAreaView>
  );
}
