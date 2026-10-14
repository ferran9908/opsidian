import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { noteFolder, noteTitle, type SearchResult, type TrashEntry } from '@opsidian/core';
import { refresh, store } from '../notebook';
import { deleteForGood } from '../platform';
import { syncLine, useNavigation } from '../nav';
import {
  AboveKeyboard,
  afterSheet,
  Button,
  Heading,
  Label,
  Muted,
  NameDialog,
  Nav,
  NavAction,
  Row,
  Screen,
  Sheet,
  message,
  useColors,
  useStore,
  when,
} from '../ui';
import { ItemMenu, folderName } from './menus';

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
      onPress={() => navigation.push({ name: 'note', path: props.path })}
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

function NewNote({ folder }: { folder: string }) {
  const colors = useColors();
  const navigation = useNavigation();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="New note"
      onPress={() =>
        void store.notebook!.vault.createNote(folder).then((path) => {
          refresh();
          navigation.push({ name: 'note', path });
        })
      }
      style={{
        position: 'absolute',
        right: 20,
        bottom: 12,
        height: 52,
        paddingHorizontal: 22,
        borderRadius: 26,
        backgroundColor: colors.ring,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        shadowColor: '#000',
        shadowOpacity: 0.18,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 4 },
      }}
    >
      <Text style={{ color: '#fff', fontSize: 22, lineHeight: 24 }}>+</Text>
      <Text style={{ color: '#fff', fontSize: 17, fontWeight: '600' }}>New note</Text>
    </Pressable>
  );
}

/** The notebook's front page: what was touched lately, then the folders. */
export function Home() {
  const colors = useColors();
  const navigation = useNavigation();
  const { tree, sync, name, version } = useStore();
  const [menu, setMenu] = useState(false);
  const [naming, setNaming] = useState(false);
  const [held, setHeld] = useState<string>();
  const times = useMemo(
    () => store.notebook?.vault.modified() ?? new Map<string, number>(),
    [version],
  );
  const recent = useMemo(
    () => [...tree.notes].sort((a, b) => (times.get(b) ?? 0) - (times.get(a) ?? 0)).slice(0, 3),
    [tree, times],
  );
  const count = (folder: string) =>
    tree.notes.filter((note) => note.startsWith(`${folder}/`)).length;
  // The folder that only holds pictures and files is not somewhere to go and read.
  const top = tree.folders.filter(
    (folder) => !folder.includes('/') && (folder !== 'attachments' || count(folder) > 0),
  );
  const line = syncLine(sync, colors);
  return (
    <Screen edges={['top']}>
      <ScrollView contentContainerStyle={{ paddingBottom: 96 }}>
        <View style={{ paddingHorizontal: 20, paddingTop: 10, paddingBottom: 16, gap: 6 }}>
          <View
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <Text
              numberOfLines={1}
              style={{
                flex: 1,
                fontSize: 34,
                lineHeight: 40,
                fontWeight: '700',
                letterSpacing: -1.1,
                color: colors.foreground,
              }}
            >
              {name}
            </Text>
            <Pressable
              hitSlop={12}
              accessibilityLabel="Notebook menu"
              onPress={() => setMenu(true)}
            >
              <Text style={{ fontSize: 26, color: colors.mutedForeground, letterSpacing: 1 }}>
                •••
              </Text>
            </Pressable>
          </View>
          <Pressable
            accessibilityLabel="Sync"
            onPress={() => navigation.push({ name: 'sync' })}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
          >
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: line.color }} />
            <Text style={{ fontSize: 14, color: colors.mutedForeground }}>{line.text}</Text>
          </Pressable>
        </View>
        {sync.connected && sync.state === 'offline' ? (
          <View
            style={{
              marginHorizontal: 20,
              marginBottom: 16,
              padding: 14,
              borderRadius: 12,
              backgroundColor: colors.secondary,
              gap: 4,
            }}
          >
            <Text style={{ fontSize: 15, fontWeight: '600', color: colors.foreground }}>
              Keep writing. Nothing is lost.
            </Text>
            <Muted style={{ lineHeight: 20 }}>
              The host is out of reach. What you change is saved on this iPhone and goes up when it
              is back.
            </Muted>
            <Pressable onPress={() => store.notebook?.sync.kick()} hitSlop={8}>
              <Text style={{ fontSize: 15, fontWeight: '600', color: colors.ring, paddingTop: 6 }}>
                Try now
              </Text>
            </Pressable>
          </View>
        ) : null}
        <Pressable
          accessibilityLabel="Find a note"
          onPress={() => navigation.push({ name: 'search' })}
          style={{
            marginHorizontal: 20,
            marginBottom: 18,
            height: 44,
            borderRadius: 10,
            backgroundColor: colors.secondary,
            justifyContent: 'center',
            paddingHorizontal: 14,
          }}
        >
          <Text style={{ fontSize: 17, color: colors.mutedForeground }}>Find a note</Text>
        </Pressable>
        <View style={{ paddingHorizontal: 20 }}>
          {recent.length ? (
            <>
              <Label style={{ paddingBottom: 6 }}>RECENT</Label>
              {recent.map((path, position) => (
                <NoteRow
                  key={path}
                  path={path}
                  at={times.get(path)}
                  {...(noteFolder(path) ? { context: noteFolder(path) } : {})}
                  last={position === recent.length - 1}
                  onLongPress={() => setHeld(path)}
                />
              ))}
            </>
          ) : (
            <View style={{ paddingVertical: 30, gap: 8 }}>
              <Text style={{ fontSize: 22, fontWeight: '700', color: colors.foreground }}>
                Nothing here yet.
              </Text>
              <Muted style={{ fontSize: 16, lineHeight: 24 }}>
                Tap New note to write the first one.
              </Muted>
            </View>
          )}
          <Label style={{ paddingTop: 22, paddingBottom: 6 }}>FOLDERS</Label>
          {top.map((folder) => (
            <Row
              key={folder}
              title={folder}
              detail={String(count(folder))}
              chevron
              onPress={() => navigation.push({ name: 'folder', path: folder })}
              onLongPress={() => setHeld(folder)}
            />
          ))}
          <Row
            title="All notes"
            detail={String(tree.notes.length)}
            chevron
            last
            onPress={() => navigation.push({ name: 'all' })}
          />
        </View>
      </ScrollView>
      <NewNote folder="" />
      <Sheet open={menu} onClose={() => setMenu(false)}>
        <Row
          title="New folder"
          onPress={() => {
            setMenu(false);
            afterSheet(() => setNaming(true));
          }}
        />
        <Row
          title="Sync"
          detail={line.text}
          chevron
          onPress={() => {
            setMenu(false);
            navigation.push({ name: 'sync' });
          }}
        />
        <Row
          title="Trash"
          chevron
          last
          onPress={() => {
            setMenu(false);
            navigation.push({ name: 'trash' });
          }}
        />
      </Sheet>
      <NameDialog
        open={naming}
        title="New folder"
        action="Create"
        onCancel={() => setNaming(false)}
        onSubmit={async (folder) => {
          await store.notebook!.vault.createFolder('', folder);
          refresh();
          setNaming(false);
        }}
      />
      <ItemMenu path={held} onClose={() => setHeld(undefined)} />
    </Screen>
  );
}

/** One folder, or with no `path` every note in the notebook. */
export function Folder({ path }: { path?: string }) {
  const colors = useColors();
  const navigation = useNavigation();
  const { tree, version } = useStore();
  const [byName, setByName] = useState(false);
  const [held, setHeld] = useState<string>();
  const [menu, setMenu] = useState(false);
  const [naming, setNaming] = useState(false);
  const times = useMemo(
    () => store.notebook?.vault.modified() ?? new Map<string, number>(),
    [version],
  );
  const folders =
    path === undefined ? [] : tree.folders.filter((folder) => noteFolder(folder) === path);
  const notes = useMemo(() => {
    const inside =
      path === undefined ? [...tree.notes] : tree.notes.filter((note) => noteFolder(note) === path);
    return byName
      ? inside.sort((a, b) => noteTitle(a).localeCompare(noteTitle(b)))
      : inside.sort((a, b) => (times.get(b) ?? 0) - (times.get(a) ?? 0));
  }, [tree, times, path, byName]);
  // The folder was renamed, moved or trashed from somewhere else.
  const gone = path !== undefined && !tree.folders.includes(path);
  /** Set when this screen moved the folder itself and is already navigating. */
  const moving = useRef(false);
  useEffect(() => {
    if (gone && !moving.current) navigation.pop();
  }, [gone]);
  useEffect(() => {
    moving.current = false;
  }, [path]);
  const total = (folder: string) =>
    tree.notes.filter((note) => note.startsWith(`${folder}/`)).length;
  const summary = [
    `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`,
    ...(folders.length ? [`${folders.length} ${folders.length === 1 ? 'folder' : 'folders'}`] : []),
  ].join(' · ');
  return (
    <Screen edges={['top']}>
      <Nav
        back={navigation.back}
        onBack={navigation.pop}
        right={
          <View style={{ flexDirection: 'row', gap: 20 }}>
            <NavAction label={byName ? 'A–Z' : 'Recent'} onPress={() => setByName(!byName)} />
            {path !== undefined ? <NavAction label="•••" onPress={() => setMenu(true)} /> : null}
          </View>
        }
      />
      <ScrollView contentContainerStyle={{ paddingBottom: 96 }}>
        <Heading sub={summary}>{path === undefined ? 'All notes' : folderName(path)}</Heading>
        <View style={{ paddingHorizontal: 20 }}>
          {folders.map((folder) => (
            <Row
              key={folder}
              title={folderName(folder)}
              color={colors.ring}
              detail={String(total(folder))}
              chevron
              onPress={() => navigation.push({ name: 'folder', path: folder })}
              onLongPress={() => setHeld(folder)}
            />
          ))}
          {notes.map((note, position) => (
            <NoteRow
              key={note}
              path={note}
              at={times.get(note)}
              {...(path === undefined && noteFolder(note) ? { context: noteFolder(note) } : {})}
              last={position === notes.length - 1}
              onLongPress={() => setHeld(note)}
            />
          ))}
          {!notes.length && !folders.length ? (
            <Muted style={{ fontSize: 16, paddingTop: 20 }}>This folder is empty.</Muted>
          ) : null}
        </View>
      </ScrollView>
      <NewNote folder={path ?? ''} />
      <ItemMenu path={held} onClose={() => setHeld(undefined)} />
      <ItemMenu
        path={menu ? path : undefined}
        onClose={() => setMenu(false)}
        before={async () => {
          moving.current = true;
        }}
        onMoved={(next) =>
          next ? navigation.replace({ name: 'folder', path: next }) : navigation.pop()
        }
      >
        <Row
          title="New folder inside"
          onPress={() => {
            setMenu(false);
            afterSheet(() => setNaming(true));
          }}
        />
      </ItemMenu>
      <NameDialog
        open={naming}
        title="New folder"
        action="Create"
        onCancel={() => setNaming(false)}
        onSubmit={async (name) => {
          await store.notebook!.vault.createFolder(path ?? '', name);
          refresh();
          setNaming(false);
        }}
      />
    </Screen>
  );
}

/** Looks through note names and everything written inside them. */
export function Search() {
  const colors = useColors();
  const navigation = useNavigation();
  const { version } = useStore();
  const [query, setQuery] = useState('');
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
                      navigation.replace({ name: 'note', path });
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
