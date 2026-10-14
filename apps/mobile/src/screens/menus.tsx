import { useMemo, useState } from 'react';
import { ScrollView, Share, Text, View } from 'react-native';
import { noteFolder, noteTitle } from '@opsidian/core';
import { refresh, store } from '../notebook';
import { useNavigation } from '../nav';
import {
  Muted,
  afterSheet,
  NameDialog,
  Page,
  Nav,
  NavAction,
  Row,
  Screen,
  Sheet,
  message,
  useColors,
  useStore,
} from '../ui';

const isNote = (path: string) => /\.md$/i.test(path);
const nameOf = (path: string) =>
  isNote(path) ? noteTitle(path) : path.slice(path.lastIndexOf('/') + 1);
export const folderName = (path: string) =>
  path ? path.slice(path.lastIndexOf('/') + 1) : store.name;

/** Chooses the folder a note or folder moves into. */
export function FolderPicker(props: {
  open: boolean;
  path: string;
  onCancel: () => void;
  onMoved: (path: string) => void;
}) {
  const colors = useColors();
  const { tree } = useStore();
  const current = noteFolder(props.path);
  const [chosen, setChosen] = useState<string | undefined>();
  const [naming, setNaming] = useState(false);
  const [error, setError] = useState('');
  const target = chosen ?? current;
  // A folder cannot go inside itself.
  const folders = useMemo(
    () =>
      isNote(props.path)
        ? tree.folders
        : tree.folders.filter(
            (folder) => folder !== props.path && !folder.startsWith(`${props.path}/`),
          ),
    [tree, props.path],
  );
  const move = async () => {
    try {
      const result = await store.notebook!.vault.move(props.path, target);
      refresh(result.rewritten);
      setChosen(undefined);
      props.onMoved(result.path);
    } catch (reason) {
      setError(message(reason));
    }
  };
  return (
    <Page open={props.open} onClose={props.onCancel}>
      <Screen>
        <Nav
          back="Cancel"
          onBack={() => {
            setChosen(undefined);
            props.onCancel();
          }}
          title={isNote(props.path) ? 'Move note' : 'Move folder'}
          right={
            <NavAction
              label="Move"
              bold
              disabled={target === current}
              onPress={() => void move()}
            />
          }
        />
        <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 14 }}>
          <Muted style={{ paddingBottom: 10 }}>
            “{nameOf(props.path)}” is in {folderName(current)}.
          </Muted>
          {error ? (
            <Text style={{ color: colors.destructive, paddingBottom: 10 }}>{error}</Text>
          ) : null}
          <Row
            title={store.name}
            bold={target === ''}
            selected={target === ''}
            detail={current === '' ? 'Here now' : target === '' ? '✓' : undefined}
            onPress={() => setChosen('')}
          />
          {folders.map((folder) => (
            <Row
              key={folder}
              title={folderName(folder)}
              indent={folder.split('/').length}
              bold={target === folder}
              selected={target === folder}
              detail={current === folder ? 'Here now' : target === folder ? '✓' : undefined}
              onPress={() => setChosen(folder)}
            />
          ))}
          <Row title="+ New folder" color={colors.ring} last onPress={() => setNaming(true)} />
        </ScrollView>
        <NameDialog
          open={naming}
          title="New folder"
          action="Create"
          note={`Inside ${folderName(target)}.`}
          onCancel={() => setNaming(false)}
          onSubmit={async (name) => {
            const made = await store.notebook!.vault.createFolder(target, name);
            refresh();
            setChosen(made);
            setNaming(false);
          }}
        />
      </Screen>
    </Page>
  );
}

/** Everything that can be done to one note or folder. */
export function ItemMenu(props: {
  /** The note or folder; undefined keeps the menu closed. */
  path: string | undefined;
  onClose: () => void;
  /** Runs first, so an open editor can save what it holds. */
  before?: () => Promise<void>;
  /** Where the item went: its new path, or null once trashed. */
  onMoved?: (path: string | null) => void;
  /** Extra rows shown above the destructive one. */
  children?: React.ReactNode;
}) {
  const colors = useColors();
  const navigation = useNavigation();
  const { sync } = useStore();
  const [act, setAct] = useState<{ kind: 'rename' | 'move'; path: string } | undefined>();
  const [error, setError] = useState('');
  const path = props.path;
  const note = path !== undefined && isNote(path);
  const vault = store.notebook?.vault;
  /** Has an open editor save first. If it cannot, nothing is done and the menu says why. */
  const ready = async () => {
    setError('');
    try {
      await props.before?.();
      return true;
    } catch (reason) {
      setError(message(reason));
      return false;
    }
  };
  const start = (kind: 'rename' | 'move') => {
    if (path === undefined) return;
    void ready().then((saved) => {
      if (!saved) return;
      props.onClose();
      afterSheet(() => setAct({ kind, path }));
    });
  };
  const links = act && isNote(act.path) ? (vault?.backlinks(act.path).length ?? 0) : 0;
  return (
    <>
      <Sheet open={path !== undefined && !act} onClose={props.onClose}>
        {path !== undefined ? (
          <View>
            <Muted style={{ fontSize: 13, paddingBottom: 6 }}>
              {nameOf(path)} · {folderName(noteFolder(path))}
            </Muted>
            {error ? (
              <Text style={{ color: colors.destructive, paddingBottom: 6 }}>{error}</Text>
            ) : null}
            <Row title="Rename" onPress={() => start('rename')} />
            <Row title="Move to a folder" onPress={() => start('move')} />
            {note && sync.connected ? (
              <Row
                title="Version history"
                chevron
                onPress={() => {
                  props.onClose();
                  navigation.push({ name: 'history', path });
                }}
              />
            ) : null}
            {note ? (
              <Row
                title="Share as Markdown"
                onPress={() =>
                  void ready().then((saved) => {
                    if (!saved) return;
                    props.onClose();
                    afterSheet(
                      () =>
                        void vault!
                          .read(path)
                          .then((document) =>
                            Share.share({ title: nameOf(path), message: document.content }),
                          )
                          .catch(() => {}),
                    );
                  })
                }
              />
            ) : null}
            {props.children}
            <Row
              title="Move to trash"
              color={colors.destructive}
              last
              onPress={() =>
                void ready().then((saved) => {
                  if (!saved) return;
                  vault!.trash(path).then(
                    () => {
                      refresh();
                      props.onClose();
                      props.onMoved?.(null);
                    },
                    (reason) => setError(message(reason)),
                  );
                })
              }
            />
          </View>
        ) : null}
      </Sheet>
      <NameDialog
        open={act?.kind === 'rename'}
        title="Rename"
        action="Save"
        initial={act ? nameOf(act.path) : ''}
        {...(links
          ? {
              note: `${links} ${links === 1 ? 'note links' : 'notes link'} to this one. Their links are rewritten to the new name, here and on your other devices.`,
            }
          : {})}
        onCancel={() => setAct(undefined)}
        onSubmit={async (name) => {
          const result = await vault!.rename(act!.path, name);
          refresh(result.rewritten);
          setAct(undefined);
          props.onMoved?.(result.path);
        }}
      />
      <FolderPicker
        open={act?.kind === 'move'}
        path={act?.path ?? ''}
        onCancel={() => setAct(undefined)}
        onMoved={(next) => {
          setAct(undefined);
          props.onMoved?.(next);
        }}
      />
    </>
  );
}
