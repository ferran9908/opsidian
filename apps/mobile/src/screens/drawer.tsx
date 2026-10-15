import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import {
  Animated,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { noteFolder, noteTitle } from '@opsidian/core';
import { refresh, store } from '../notebook';
import { syncLine, useNavigation } from '../nav';
import { prefs } from '../prefs';
import { Chevron, CollapseIcon, GearIcon, NewFolderIcon, NewNoteIcon, SortIcon } from '../icons';
import { NameDialog, Row, afterSheet, useColors, useStore } from '../ui';
import { ItemMenu } from './menus';
import type { Guard } from './note';

/** Folders left open, kept while the app runs so the drawer opens as it was left. */
const opened = new Set<string>();
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/**
 * The files, sliding in from the left as in Obsidian: the notebook's name and sync at the top,
 * the same four buttons as on the Mac, and the tree. Holding a row offers what can be done to it.
 */
export function Drawer(props: {
  open: boolean;
  current: string | undefined;
  guard: MutableRefObject<Guard>;
  onClose: () => void;
  onNewNote: (folder: string) => void;
}) {
  const colors = useColors();
  const navigation = useNavigation();
  const { tree, sync } = useStore();
  const { width } = useWindowDimensions();
  const size = Math.min(340, width - 56);
  const [shown, setShown] = useState(props.open);
  const [, redraw] = useState(0);
  const [held, setHeld] = useState<string>();
  const [naming, setNaming] = useState<string>();
  const [notebookMenu, setNotebookMenu] = useState(false);
  const [sort, setSort] = useState(prefs.get().sort);
  const slide = useRef(new Animated.Value(-size)).current;
  useEffect(() => {
    // Lets a development build's debugger hold a row, as a long press does.
    if (__DEV__) (globalThis as { opsidian?: Record<string, unknown> }).opsidian!.hold = setHeld;
  }, []);

  useEffect(() => {
    if (props.open) {
      // The open note's folders, so it can be seen.
      const folder = props.current ? noteFolder(props.current) : '';
      const parts = folder ? folder.split('/') : [];
      parts.forEach((_part, depth) => opened.add(parts.slice(0, depth + 1).join('/')));
      setNotebookMenu(false);
      setShown(true);
      Animated.timing(slide, { toValue: 0, duration: 220, useNativeDriver: true }).start();
    } else if (shown)
      Animated.timing(slide, { toValue: -size, duration: 180, useNativeDriver: true }).start(() =>
        setShown(false),
      );
  }, [props.open]);
  // A swipe back to the left closes it.
  const swipe = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, move) => move.dx < -14 && Math.abs(move.dy) < 24,
        onPanResponderRelease: (_event, move) => {
          if (move.dx < -50) props.onClose();
        },
      }),
    [props.onClose],
  );

  const order = (a: string, b: string) =>
    (sort === 'name-desc' ? -1 : 1) * a.localeCompare(b, undefined, { numeric: true });
  const count = (folder: string) =>
    tree.notes.filter((note) => note.startsWith(`${folder}/`)).length;
  /** Leaves the note for another screen, once it is saved. */
  const go = (where: () => void) => {
    props.onClose();
    props.guard.current.leave(where);
  };
  /** Whether a change to `path` touches the open note. */
  const holds = (path: string) =>
    props.current !== undefined && (props.current === path || props.current.startsWith(`${path}/`));

  const rows = (folder: string, depth: number): React.ReactNode[] => {
    const folders = tree.folders
      .filter((each) => noteFolder(each) === folder)
      // The folder that only holds pictures and files is not somewhere to read.
      .filter((each) => each !== 'attachments' || count(each) > 0)
      .sort((a, b) => order(nameOf(a), nameOf(b)));
    const notes = tree.notes
      .filter((each) => noteFolder(each) === folder)
      .sort((a, b) => order(noteTitle(a), noteTitle(b)));
    const indent = 12 + depth * 18;
    return [
      ...folders.flatMap((path) => {
        const isOpen = opened.has(path);
        return [
          <Pressable
            key={path}
            accessibilityRole="button"
            accessibilityLabel={`Folder ${nameOf(path)}`}
            accessibilityState={{ expanded: isOpen }}
            onPress={() => {
              if (!opened.delete(path)) opened.add(path);
              redraw((n) => n + 1);
            }}
            onLongPress={() => setHeld(path)}
            style={({ pressed }) => ({
              height: 42,
              flexDirection: 'row',
              alignItems: 'center',
              paddingLeft: indent,
              borderRadius: 8,
              backgroundColor: pressed ? colors.sidebarAccent : 'transparent',
            })}
          >
            <Chevron color={colors.faint} size={18} to={isOpen ? 'down' : 'right'} />
            <Text
              numberOfLines={1}
              style={{ flex: 1, fontSize: 16, color: colors.sidebarForeground }}
            >
              {nameOf(path)}
            </Text>
          </Pressable>,
          ...(isOpen ? rows(path, depth + 1) : []),
        ];
      }),
      ...notes.map((path) => (
        <Pressable
          key={path}
          accessibilityRole="button"
          accessibilityLabel={`Note ${noteTitle(path)}`}
          accessibilityState={{ selected: path === props.current }}
          onPress={() =>
            path === props.current ? props.onClose() : go(() => navigation.openNote(path))
          }
          onLongPress={() => setHeld(path)}
          style={({ pressed }) => ({
            height: 42,
            justifyContent: 'center',
            paddingLeft: indent + 18,
            paddingRight: 10,
            borderRadius: 8,
            backgroundColor:
              path === props.current || pressed ? colors.sidebarAccent : 'transparent',
          })}
        >
          <Text
            numberOfLines={1}
            style={{
              fontSize: 16,
              color: path === props.current ? colors.foreground : colors.sidebarForeground,
              fontWeight: path === props.current ? '500' : '400',
            }}
          >
            {noteTitle(path)}
          </Text>
        </Pressable>
      )),
    ];
  };

  const line = syncLine(sync, colors);
  const tool = (label: string, onPress: () => void, icon: React.ReactNode) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 44,
        height: 40,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.5 : 1,
      })}
    >
      {icon}
    </Pressable>
  );
  const ink = colors.mutedForeground;
  const tree_ = rows('', 0);

  return (
    <Modal visible={shown} transparent animationType="none" onRequestClose={props.onClose}>
      <SafeAreaProvider>
        <View style={{ flex: 1, flexDirection: 'row' }} {...swipe.panHandlers}>
          <Animated.View
            style={{
              width: size,
              backgroundColor: colors.sidebar,
              transform: [{ translateX: slide }],
              shadowColor: '#000',
              shadowOpacity: 0.15,
              shadowRadius: 16,
              shadowOffset: { width: 4, height: 0 },
            }}
          >
            <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1 }}>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingLeft: 20,
                  paddingRight: 8,
                  paddingTop: 8,
                }}
              >
                <View style={{ flex: 1, gap: 3 }}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Notebook"
                    onPress={() => setNotebookMenu(!notebookMenu)}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
                  >
                    <Text
                      numberOfLines={1}
                      style={{
                        flexShrink: 1,
                        fontSize: 22,
                        lineHeight: 28,
                        fontWeight: '700',
                        letterSpacing: -0.3,
                        color: colors.foreground,
                      }}
                    >
                      {store.name}
                    </Text>
                    <Chevron color={colors.faint} size={18} to={notebookMenu ? 'up' : 'down'} />
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Sync"
                    hitSlop={6}
                    onPress={() => go(() => navigation.push({ name: 'sync' }))}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}
                  >
                    <View
                      style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: line.color }}
                    />
                    <Text style={{ fontSize: 14, color: colors.mutedForeground }}>{line.text}</Text>
                  </Pressable>
                </View>
                {tool(
                  'Settings',
                  () => go(() => navigation.push({ name: 'settings' })),
                  <GearIcon color={ink} />,
                )}
              </View>
              {notebookMenu ? (
                <View style={{ marginHorizontal: 12, marginTop: 10 }}>
                  <Row
                    title="Trash"
                    chevron
                    last
                    onPress={() => go(() => navigation.push({ name: 'trash' }))}
                  />
                </View>
              ) : null}
              <View
                style={{
                  flexDirection: 'row',
                  gap: 4,
                  paddingHorizontal: 12,
                  paddingTop: 10,
                  paddingBottom: 8,
                  borderBottomWidth: 0.5,
                  borderBottomColor: colors.sidebarBorder,
                }}
              >
                {tool('New note', () => props.onNewNote(''), <NewNoteIcon color={ink} />)}
                {tool('New folder', () => setNaming(''), <NewFolderIcon color={ink} />)}
                {tool(
                  sort === 'name' ? 'Sort: A to Z' : 'Sort: Z to A',
                  () => {
                    const next = sort === 'name' ? 'name-desc' : 'name';
                    setSort(next);
                    prefs.set({ sort: next });
                  },
                  <SortIcon color={ink} />,
                )}
                {tool(
                  'Collapse all',
                  () => {
                    opened.clear();
                    redraw((n) => n + 1);
                  },
                  <CollapseIcon color={ink} />,
                )}
                <Text
                  style={{
                    alignSelf: 'center',
                    marginLeft: 'auto',
                    fontSize: 12,
                    color: colors.faint,
                  }}
                >
                  {sort === 'name' ? 'A–Z' : 'Z–A'}
                </Text>
              </View>
              <ScrollView contentContainerStyle={{ padding: 8, paddingBottom: 30 }}>
                {tree_.length ? (
                  tree_
                ) : (
                  <Text style={{ padding: 12, fontSize: 15, color: colors.mutedForeground }}>
                    Nothing here yet.
                  </Text>
                )}
              </ScrollView>
            </SafeAreaView>
          </Animated.View>
          <Pressable
            accessibilityLabel="Close files"
            onPress={props.onClose}
            style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.25)' }}
          />
        </View>
        <ItemMenu
          path={held}
          onClose={() => setHeld(undefined)}
          before={async () => {
            if (held !== undefined && holds(held)) await props.guard.current.flush();
          }}
          onMoved={(next) => {
            const from = held;
            if (from === undefined || !props.current || !holds(from)) return;
            if (next === null) navigation.dropNote();
            else navigation.replaceNote(next + props.current.slice(from.length));
          }}
          onHistory={props.onClose}
        >
          {held !== undefined && !/\.md$/i.test(held) ? (
            <>
              <Row
                title="New note here"
                onPress={() => {
                  const folder = held;
                  setHeld(undefined);
                  opened.add(folder);
                  afterSheet(() => props.onNewNote(folder));
                }}
              />
              <Row
                title="New folder inside"
                onPress={() => {
                  const folder = held;
                  setHeld(undefined);
                  afterSheet(() => setNaming(folder));
                }}
              />
            </>
          ) : null}
        </ItemMenu>
        <NameDialog
          open={naming !== undefined}
          title="New folder"
          action="Create"
          onCancel={() => setNaming(undefined)}
          onSubmit={async (name) => {
            const parent = naming ?? '';
            await store.notebook!.vault.createFolder(parent, name);
            if (parent) opened.add(parent);
            refresh();
            setNaming(undefined);
          }}
        />
      </SafeAreaProvider>
    </Modal>
  );
}
