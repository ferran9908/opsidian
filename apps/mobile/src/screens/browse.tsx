import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { noteFolder, noteTitle, type SearchResult, type TrashEntry } from '@opsidian/core';
import { refresh, store } from '../notebook';
import { deleteForGood } from '../platform';
import { useNavigation } from '../nav';
import {
  AboveKeyboard,
  Button,
  Heading,
  Label,
  Muted,
  Nav,
  NavAction,
  Screen,
  Sheet,
  message,
  useColors,
  useStore,
  when,
} from '../ui';
import { folderName } from './menus';

/** The first line of a note worth showing under its name. */
function preview(path: string): string {
  const text = store.notebook?.vault.text(path) ?? '';
  for (const line of text.split('\n', 40)) {
    const plain = line
      .replace(/^\s*(#{1,6}|[-*+]|\d+\.|>)\s+/, '')
      .replace(/^\[[ xX]\]\s+/, '')
      .replace(/!?\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
      .replace(/[*_`~]/g, '')
      .trim();
    if (plain && !/^-{3,}$/.test(plain)) return plain;
  }
  return 'No text yet';
}

function NoteRow(props: {
  path: string;
  at?: number | undefined;
  context?: string;
  excerpt?: string;
  last?: boolean;
  onLongPress?: () => void;
}) {
  const colors = useColors();
  const navigation = useNavigation();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => navigation.openNote(props.path)}
      onLongPress={props.onLongPress}
      style={({ pressed }) => ({
        paddingVertical: 11,
        gap: 3,
        borderBottomWidth: props.last ? 0 : 0.5,
        borderBottomColor: colors.border,
        backgroundColor: pressed ? colors.accent : 'transparent',
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 12 }}>
        <Text
          numberOfLines={1}
          style={{ flex: 1, fontSize: 17, fontWeight: '600', color: colors.foreground }}
        >
          {noteTitle(props.path)}
        </Text>
        {props.at ? (
          <Text style={{ fontSize: 13, color: colors.mutedForeground }}>{when(props.at)}</Text>
        ) : null}
      </View>
      {props.context ? (
        <Text style={{ fontSize: 13, color: colors.link }}>{props.context}</Text>
      ) : null}
      <Text
        numberOfLines={2}
        style={{ fontSize: 15, lineHeight: 21, color: colors.mutedForeground }}
      >
        {props.excerpt ?? preview(props.path)}
      </Text>
    </Pressable>
  );
}

/** Looks through note names and everything written inside them, or by `#tag`. */
export function Search(props: { query?: string | undefined }) {
  const colors = useColors();
  const navigation = useNavigation();
  const { version } = useStore();
  const [query, setQuery] = useState(props.query ?? '');
  const asked = query.trim();
  const results: SearchResult[] = useMemo(
    () => (asked ? (store.notebook?.vault.search(asked) ?? []).slice(0, 100) : []),
    [asked, version],
  );
  return (
    <Screen>
      <AboveKeyboard>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            paddingHorizontal: 20,
            paddingTop: 6,
            paddingBottom: 14,
          }}
        >
          <TextInput
            autoFocus
            accessibilityLabel="Find a note"
            value={query}
            onChangeText={setQuery}
            placeholder="Find a note"
            placeholderTextColor={colors.mutedForeground}
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            returnKeyType="search"
            style={{
              flex: 1,
              height: 44,
              borderRadius: 10,
              backgroundColor: colors.secondary,
              paddingHorizontal: 14,
              fontSize: 17,
              color: colors.foreground,
            }}
          />
          <NavAction label="Cancel" onPress={navigation.pop} />
        </View>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 30 }}
        >
          {results.length ? (
            <>
              <Label style={{ paddingVertical: 6 }}>
                {`${results.length} ${results.length === 1 ? 'NOTE' : 'NOTES'}`}
              </Label>
              {results.map((result, position) => (
                <NoteRow
                  key={result.path}
                  path={result.path}
                  context={noteFolder(result.path) || store.name}
                  excerpt={result.excerpt ?? 'Title match'}
                  last={position === results.length - 1}
                />
              ))}
            </>
          ) : asked.startsWith('#') ? (
            <View style={{ paddingTop: 40, gap: 10 }}>
              <Text
                style={{
                  fontSize: 24,
                  lineHeight: 30,
                  fontWeight: '700',
                  color: colors.foreground,
                }}
              >
                No note carries {asked}.
              </Text>
            </View>
          ) : asked ? (
            <View style={{ paddingTop: 40, gap: 10 }}>
              <Text
                style={{
                  fontSize: 24,
                  lineHeight: 30,
                  fontWeight: '700',
                  color: colors.foreground,
                }}
              >
                Nothing mentions “{asked}” yet.
              </Text>
              <Muted style={{ fontSize: 16, lineHeight: 24 }}>
                Search looks at note names and everything written inside them.
              </Muted>
              <Pressable
                onPress={() =>
                  void store.notebook!.vault.createNote('', asked).then(
                    (path) => {
                      refresh();
                      navigation.openNote(path);
                    },
                    () => {},
                  )
                }
                style={{
                  alignSelf: 'flex-start',
                  marginTop: 14,
                  height: 46,
                  paddingHorizontal: 18,
                  borderRadius: 10,
                  backgroundColor: colors.accent,
                  justifyContent: 'center',
                }}
              >
                <Text style={{ fontSize: 16, fontWeight: '600', color: colors.ring }}>
                  Create “{asked}”
                </Text>
              </Pressable>
            </View>
          ) : null}
        </ScrollView>
      </AboveKeyboard>
    </Screen>
  );
}

/** What was removed, here or on another device, and the way to get it back. */
export function Trash() {
  const colors = useColors();
  const navigation = useNavigation();
  const { version } = useStore();
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const load = () =>
    void store.notebook?.vault.trashed().then(setEntries, (reason) => setError(message(reason)));
  useEffect(load, [version]);
  return (
    <Screen>
      <Nav back={navigation.back} onBack={navigation.pop} />
      <Heading sub="Nothing is deleted for good. Notes removed on another device land here too.">
        Trash
      </Heading>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20 }}>
        {error ? (
          <Text style={{ color: colors.destructive, paddingBottom: 10 }}>{error}</Text>
        ) : null}
        {entries.map((entry) => (
          <View
            key={entry.name}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              paddingVertical: 12,
              borderBottomWidth: 0.5,
              borderBottomColor: colors.border,
            }}
          >
            <View style={{ flex: 1, gap: 3 }}>
              <Text
                numberOfLines={1}
                style={{ fontSize: 17, fontWeight: '600', color: colors.foreground }}
              >
                {entry.folder ? entry.name : entry.name.replace(/\.md$/i, '')}
              </Text>
              <Muted>
                {[
                  entry.folder ? 'Folder' : '',
                  `from ${folderName(noteFolder(entry.from ?? ''))}`,
                  when(entry.at),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Muted>
            </View>
            <Pressable
              hitSlop={10}
              onPress={() =>
                void store.notebook!.vault.restore(entry.name).then(
                  () => {
                    refresh();
                    load();
                  },
                  (reason) => setError(message(reason)),
                )
              }
            >
              <Text style={{ fontSize: 16, color: colors.ring }}>Put back</Text>
            </Pressable>
          </View>
        ))}
        {!entries.length ? (
          <Muted style={{ fontSize: 16, paddingTop: 20 }}>The trash is empty.</Muted>
        ) : null}
      </ScrollView>
      {entries.length ? (
        <View style={{ paddingHorizontal: 20, paddingBottom: 10, gap: 10 }}>
          <Button
            kind="danger"
            label="Empty trash on this iPhone"
            onPress={() => setConfirming(true)}
          />
          <Muted style={{ fontSize: 13, textAlign: 'center' }}>
            {store.sync.connected
              ? 'The host still keeps every version in history.'
              : 'This cannot be undone.'}
          </Muted>
        </View>
      ) : null}
      <Sheet open={confirming} onClose={() => setConfirming(false)}>
        <Text
          style={{ fontSize: 20, fontWeight: '700', color: colors.foreground, paddingBottom: 6 }}
        >
          Remove {entries.length} {entries.length === 1 ? 'item' : 'items'} from this iPhone?
        </Text>
        <Muted style={{ paddingBottom: 16 }}>They can no longer be put back from here.</Muted>
        <Button
          kind="danger"
          label="Empty trash"
          onPress={() => {
            setConfirming(false);
            void store
              .notebook!.vault.emptyTrash(async (file) => deleteForGood(file))
              .then(load, (reason) => setError(message(reason)));
          }}
        />
      </Sheet>
    </Screen>
  );
}
