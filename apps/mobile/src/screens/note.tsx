import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Pressable, Text, View } from 'react-native';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';
import { File } from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import {
  encodeDestination,
  headingSection,
  isVaultImage,
  linkResolver,
  noteFolder,
  noteTitle,
  validateContent,
  vaultImageMarkdown,
  type SaveStatus,
} from '@opsidian/core';
import { detectImage } from '@opsidian/notebook';
import { editorHtml } from '../../generated/editor-html';
import { refresh, store } from '../notebook';
import { syncLine, useNavigation } from '../nav';
import { addressOf } from '../platform';
import {
  AboveKeyboard,
  afterSheet,
  Label,
  Muted,
  Nav,
  NavAction,
  Row,
  Screen,
  Sheet,
  message,
  styles,
  useColors,
  useKeyboardShown,
  useStore,
} from '../ui';
import { ItemMenu } from './menus';

const text = (value: unknown, limit = 1000): string => {
  if (typeof value !== 'string' || value.length > limit) throw new Error('Invalid editor request');
  return value;
};
const TYPES: Record<string, string> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  gif: 'gif',
  webp: 'webp',
};

/** One note, in the shared editor. */
export function Note(props: { path: string; heading?: string }) {
  const colors = useColors();
  const navigation = useNavigation();
  const { tree, sync, version, changed } = useStore();
  const web = useRef<WebView>(null);
  const path = useRef<string | null>(props.path);
  const session = useRef('');
  const asks = useRef(new Map<number, (error?: string) => void>());
  const nextAsk = useRef(0);
  const [status, setStatus] = useState<SaveStatus>({ state: 'saved' });
  const [editing, setEditing] = useState(false);
  const [words, setWords] = useState(0);
  const [notice, setNotice] = useState<{ text: string; copy?: string }>();
  const [menu, setMenu] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [source, setSource] = useState(false);
  const [failed, setFailed] = useState('');
  /** Why the note could not be saved when the user tried to leave it. */
  const [unsaved, setUnsaved] = useState('');
  /** Counts up to load the editor page afresh after iOS stops it. */
  const [page, setPage] = useState(0);
  const [hidden, setHidden] = useState(false);
  const keyboard = useKeyboardShown();
  const vault = store.notebook!.vault;

  const send = (value: object) => {
    // Escaped so the text can never end the script it is injected as.
    const json = JSON.stringify(value).replace(
      new RegExp(`[<${String.fromCharCode(0x2028, 0x2029)}]`, 'g'),
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
    web.current?.injectJavaScript(`window.OpsidianHost?.receive(${json});true;`);
  };
  /**
   * Has the editor save what it holds, and fails if it could not. A page that does not
   * answer at all (iOS stopped it) has nothing left to save, so that is not a failure.
   */
  const flush = () =>
    new Promise<void>((resolve, reject) => {
      const ask = ++nextAsk.current;
      const timer = setTimeout(() => done(), 3000);
      function done(error?: string) {
        clearTimeout(timer);
        asks.current.delete(ask);
        if (error) reject(new Error(`This note could not be saved: ${error}`));
        else resolve();
      }
      asks.current.set(ask, done);
      send({ event: 'flush', ask });
    });
  /** Leaves for another screen only once the note is saved; otherwise says why not. */
  const leaving = useRef(false);
  const leave = (go: () => void) => {
    if (leaving.current) return;
    leaving.current = true;
    flush().then(
      () => go(),
      (reason) => {
        leaving.current = false;
        setUnsaved(message(reason));
      },
    );
  };
  const show = async () => {
    const current = path.current;
    if (!current) return;
    try {
      const document = await vault.read(current);
      send({
        event: 'open',
        path: current,
        content: document.content,
        revision: document.revision,
        notes: store.tree.notes,
        mode: source ? 'source' : 'live',
        ...(props.heading ? { heading: props.heading } : {}),
      });
    } catch (reason) {
      setFailed(message(reason));
    }
  };

  // A notice with nothing to open is only news; it leaves by itself.
  useEffect(() => {
    if (!notice || notice.copy) return;
    const timer = setTimeout(() => setNotice(undefined), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    // Lets a development build's debugger reach the editor page.
    if (__DEV__)
      (globalThis as { opsidian?: Record<string, unknown> }).opsidian!.web = (script: string) =>
        web.current?.injectJavaScript(`${script};true;`);
  }, []);
  // Sync or another screen rewrote this note, or the list of notes changed.
  useEffect(() => {
    send({ event: 'notes', notes: tree.notes });
    if (path.current && changed.includes(path.current))
      send({ event: 'changed', path: path.current });
    // Renamed or moved on another device while open: nothing to follow it with, so step back.
    if (path.current && !vault.tree().notes.includes(path.current)) navigation.pop();
  }, [version]);
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => {
      if (state !== 'active') send({ event: 'flush', ask: 0 });
    });
    return () => {
      listener.remove();
      refresh();
    };
  }, []);

  const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    read: (target) => vault.read(text(target)),
    async save(target, content, revision) {
      validateContent(content);
      const result = await vault.save(text(target), content, text(revision, 64));
      // A conflict leaves a second note behind, which the lists should show.
      if ('conflict' in result) refresh();
      return result;
    },
    /** The title, edited in place: the same rename as the note's menu, links and sync included. */
    async rename(from, name) {
      const result = await vault.rename(text(from), text(name, 200));
      // The new path first, so the lists never look for the note where it no longer is.
      if (path.current === from) {
        path.current = result.path;
        navigation.replace({ name: 'note', path: result.path });
      }
      refresh(result.rewritten);
      return result.path;
    },
    async createNote(folder, name) {
      const made = await vault.createNote(text(folder), text(name, 200));
      refresh();
      return made;
    },
    async image(asked) {
      let wanted: string;
      try {
        wanted = decodeURI(text(asked));
      } catch {
        return null;
      }
      if (!isVaultImage(wanted)) return null;
      const name = wanted.slice(wanted.lastIndexOf('/') + 1).toLowerCase();
      const images = store.tree.images;
      const found = images.includes(wanted)
        ? wanted
        : [...images]
            .sort((a, b) => a.split('/').length - b.split('/').length)
            .find((image) => image.slice(image.lastIndexOf('/') + 1).toLowerCase() === name);
      if (!found) return null;
      const type = TYPES[found.slice(found.lastIndexOf('.') + 1).toLowerCase()];
      const base64 = await new File(addressOf(await vault.image(found))).base64();
      return `data:image/${type};base64,${base64}`;
    },
    async embed(from, target, heading) {
      const resolve = linkResolver(store.tree.notes);
      const found = target ? resolve(text(target)) : text(from);
      if (!found) return undefined;
      const { content } = await vault.read(found);
      return typeof heading === 'string' ? headingSection(content, heading) : content;
    },
  };

  async function follow(target: string, heading?: string) {
    const here = path.current ?? '';
    if (!target) return;
    let found = linkResolver(store.tree.notes)(target);
    if (!found) {
      // A link to a note that does not exist yet makes it, beside the note it was in.
      found = await vault.createNote(noteFolder(here), target.slice(target.lastIndexOf('/') + 1));
      refresh();
    }
    if (found !== here)
      navigation.push({ name: 'note', path: found, ...(heading ? { heading } : {}) });
  }

  async function onMessage(event: WebViewMessageEvent) {
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(event.nativeEvent.data) as Record<string, unknown>;
      if (!value || typeof value.session !== 'string' || value.session.length > 100)
        throw new Error();
    } catch {
      return;
    }
    if (typeof value.answer === 'number')
      return asks.current.get(value.answer)?.(
        typeof value.error === 'string' ? value.error : undefined,
      );
    if (typeof value.note === 'string') {
      if (value.note === 'ready') {
        session.current = value.session;
        await show();
      } else if (value.session !== session.current) return;
      else if (value.note === 'status')
        setStatus(
          value.state === 'error'
            ? { state: 'error', message: String(value.message) }
            : { state: value.state === 'saving' ? 'saving' : 'saved' },
        );
      else if (value.note === 'editing') setEditing(value.value === true);
      else if (value.note === 'words') setWords(Number(value.count) || 0);
      else if (value.note === 'notice')
        setNotice({
          text: String(value.text),
          ...(typeof value.copy === 'string' ? { copy: value.copy } : {}),
        });
      else if (value.note === 'attach') setAttaching(true);
      else if (value.note === 'link')
        await follow(
          String(value.target ?? ''),
          typeof value.heading === 'string' ? value.heading : undefined,
        ).catch((reason) => setNotice({ text: message(reason) }));
      return;
    }
    if (typeof value.id !== 'number' || typeof value.method !== 'string') return;
    let result: unknown, failure: string | undefined;
    try {
      const handler = handlers[value.method];
      if (!handler || !Array.isArray(value.args)) throw new Error('Invalid editor request');
      result = await handler(...value.args);
    } catch (reason) {
      failure = message(reason);
    }
    send({ id: value.id, session: value.session, result, error: failure });
  }

  /** Puts a picked file into the notebook and a reference to it into the note. */
  async function add(address: string, name: string) {
    const bytes = await new File(address).bytes();
    const stem = name.replace(/\.[^.]+$/, '');
    if (detectImage(bytes)) {
      const saved = await vault.saveImage(
        bytes,
        /^[^./\\:][^/\\:]*$/.test(stem) ? stem.slice(0, 100) : 'Photo',
      );
      refresh();
      send({ event: 'insert', text: vaultImageMarkdown(saved) });
    } else {
      const saved = await vault.saveFile(bytes, name);
      refresh();
      send({
        event: 'insert',
        text: `\n[${saved.slice(saved.lastIndexOf('/') + 1)}](${encodeDestination(saved)})\n`,
      });
    }
  }
  const attach = (pick: () => Promise<{ uri: string; name: string } | undefined>) => {
    setAttaching(false);
    void new Promise((resolve) => afterSheet(() => resolve(undefined)))
      .then(pick)
      .then((picked) => (picked ? add(picked.uri, picked.name) : undefined))
      .catch((reason) => setNotice({ text: message(reason) }));
  };
  const photo = async (camera: boolean) => {
    if (camera && !(await ImagePicker.requestCameraPermissionsAsync()).granted)
      throw new Error('Allow the camera for Opsidian in Settings to take a photo.');
    const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.85 };
    const result = camera
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);
    const asset = result.canceled ? undefined : result.assets[0];
    return asset
      ? { uri: asset.uri, name: camera ? 'Photo' : (asset.fileName ?? 'Photo') }
      : undefined;
  };
  const file = async () => {
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    const asset = result.canceled ? undefined : result.assets[0];
    return asset ? { uri: asset.uri, name: asset.name } : undefined;
  };

  const title = path.current ? noteTitle(path.current) : '';
  const backlinks = useMemo(() => (path.current ? vault.backlinks(path.current) : []), [version]);
  // Sync keeps both versions when the same lines changed in two places.
  const beside = useMemo(() => {
    const here = path.current;
    if (!here) return undefined;
    const stem = `${here.replace(/\.md$/i, '')} (conflicted copy `;
    return tree.notes.find((note) => note.startsWith(stem));
  }, [tree]);
  const line = syncLine(sync, colors);
  const saved =
    status.state === 'error'
      ? status.message
      : status.state === 'saving'
        ? 'Saving…'
        : `✓ Saved · ${line.text}`;

  return (
    <Screen edges={editing || keyboard ? ['top'] : ['top', 'bottom']}>
      <Nav
        back={navigation.back}
        onBack={() => leave(navigation.pop)}
        right={
          editing ? (
            <NavAction label="Done" bold onPress={() => send({ event: 'blur' })} />
          ) : (
            <NavAction label="•••" onPress={() => setMenu(true)} />
          )
        }
      />
      {failed ? (
        <View style={{ padding: 24, gap: 10 }}>
          <Text style={{ fontSize: 22, fontWeight: '700', color: colors.foreground }}>
            This note could not be opened.
          </Text>
          <Muted style={{ fontSize: 16 }}>{failed}</Muted>
        </View>
      ) : null}
      {unsaved ? (
        <View
          style={{
            marginHorizontal: 20,
            marginTop: 6,
            padding: 14,
            borderRadius: 12,
            backgroundColor: colors.secondary,
            gap: 8,
          }}
        >
          <Text style={{ fontSize: 14, lineHeight: 20, color: colors.destructive }}>{unsaved}</Text>
          <View style={{ flexDirection: 'row', gap: 20 }}>
            <Pressable hitSlop={8} onPress={() => setUnsaved('')}>
              <Text style={{ fontSize: 15, fontWeight: '600', color: colors.ring }}>
                Keep editing
              </Text>
            </Pressable>
            <Pressable hitSlop={8} onPress={navigation.pop}>
              <Text style={{ fontSize: 15, color: colors.mutedForeground }}>
                Leave without saving
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {notice ? (
        <View
          style={{
            marginHorizontal: 20,
            marginTop: 6,
            padding: 14,
            borderRadius: 12,
            backgroundColor: colors.accent,
            gap: 8,
          }}
        >
          <Text style={{ fontSize: 14, lineHeight: 20, color: colors.foreground }}>
            {notice.text}
          </Text>
          <View style={{ flexDirection: 'row', gap: 20 }}>
            {notice.copy ? (
              <Pressable
                hitSlop={8}
                onPress={() => {
                  const copy = notice.copy!;
                  setNotice(undefined);
                  leave(() => navigation.push({ name: 'note', path: copy }));
                }}
              >
                <Text style={{ fontSize: 15, fontWeight: '600', color: colors.ring }}>Open it</Text>
              </Pressable>
            ) : null}
            <Pressable hitSlop={8} onPress={() => setNotice(undefined)}>
              <Text style={{ fontSize: 15, color: colors.mutedForeground }}>Dismiss</Text>
            </Pressable>
          </View>
        </View>
      ) : beside && !hidden ? (
        <View
          style={{
            marginHorizontal: 20,
            marginTop: 6,
            padding: 14,
            borderRadius: 12,
            backgroundColor: colors.secondary,
            gap: 6,
          }}
        >
          <Text style={{ fontSize: 15, fontWeight: '600', color: colors.foreground }}>
            Two versions of this note were kept
          </Text>
          <Muted style={{ lineHeight: 20 }}>
            The same lines changed on two devices while one was offline. The other version is saved
            beside this one.
          </Muted>
          <View style={{ flexDirection: 'row', gap: 20, paddingTop: 4 }}>
            <Pressable
              hitSlop={8}
              onPress={() => leave(() => navigation.push({ name: 'note', path: beside }))}
            >
              <Text style={{ fontSize: 15, fontWeight: '600', color: colors.ring }}>
                Open the other version
              </Text>
            </Pressable>
            <Pressable hitSlop={8} onPress={() => setHidden(true)}>
              <Text style={{ fontSize: 15, color: colors.mutedForeground }}>Dismiss</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      <AboveKeyboard>
        <WebView
          // A new key loads the page afresh: iOS cannot reload one made from a string.
          key={page}
          ref={web}
          source={{ html: editorHtml, baseUrl: 'https://opsidian.local/' }}
          style={[styles.fill, { backgroundColor: colors.background }]}
          originWhitelist={['https://opsidian.local']}
          onMessage={(event) => void onMessage(event)}
          javaScriptEnabled
          domStorageEnabled={false}
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          setSupportMultipleWindows={false}
          keyboardDisplayRequiresUserAction={false}
          hideKeyboardAccessoryView
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
          scrollEnabled={false}
          onShouldStartLoadWithRequest={(request) =>
            request.url === 'about:blank' || request.url === 'https://opsidian.local/'
          }
          // iOS stops a page that uses too much memory; loading it again restores the saved note.
          onContentProcessDidTerminate={() => {
            setEditing(false);
            setPage((count) => count + 1);
          }}
          onError={(event) => setFailed(event.nativeEvent.description)}
        />
      </AboveKeyboard>
      {!editing && !keyboard ? (
        <View>
          {backlinks.length ? (
            <View
              style={{
                paddingHorizontal: 24,
                paddingVertical: 14,
                gap: 8,
                borderTopWidth: 0.5,
                borderTopColor: colors.border,
              }}
            >
              <Label>{`LINKED FROM ${backlinks.length} ${backlinks.length === 1 ? 'NOTE' : 'NOTES'}`}</Label>
              {backlinks.slice(0, 3).map((link) => (
                <Pressable
                  key={link.path}
                  hitSlop={4}
                  onPress={() => leave(() => navigation.push({ name: 'note', path: link.path }))}
                >
                  <Text numberOfLines={1} style={{ fontSize: 16, color: colors.link }}>
                    ↗ {noteTitle(link.path)}
                  </Text>
                </Pressable>
              ))}
              {backlinks.length > 3 ? <Muted>and {backlinks.length - 3} more</Muted> : null}
            </View>
          ) : null}
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              gap: 12,
              paddingHorizontal: 24,
              paddingVertical: 10,
              borderTopWidth: 0.5,
              borderTopColor: colors.border,
            }}
          >
            <Text
              numberOfLines={1}
              style={{
                flex: 1,
                fontSize: 13,
                color: status.state === 'error' ? colors.destructive : colors.mutedForeground,
              }}
            >
              {saved}
            </Text>
            <Text style={{ fontSize: 13, color: colors.mutedForeground }}>
              {words} {words === 1 ? 'word' : 'words'}
            </Text>
          </View>
        </View>
      ) : null}
      <ItemMenu
        path={menu && path.current ? path.current : undefined}
        onClose={() => setMenu(false)}
        before={flush}
        onMoved={(next) => {
          path.current = next;
          send({ event: 'moved', path: next });
          if (next) navigation.replace({ name: 'note', path: next });
          else navigation.pop();
        }}
      >
        <Row
          title={source ? 'Show as Live Preview' : 'Show Markdown source'}
          onPress={() => {
            setMenu(false);
            setSource(!source);
            send({ event: 'mode', mode: source ? 'live' : 'source' });
          }}
        />
        <Row
          title="Add a photo or file"
          onPress={() => {
            setMenu(false);
            afterSheet(() => setAttaching(true));
          }}
        />
      </ItemMenu>
      <Sheet open={attaching} onClose={() => setAttaching(false)}>
        <Text
          style={{ fontSize: 22, fontWeight: '700', color: colors.foreground, paddingBottom: 8 }}
        >
          Add to this note
        </Text>
        <Row title="Photo library" onPress={() => attach(() => photo(false))} />
        <Row title="Take a photo" onPress={() => attach(() => photo(true))} />
        <Row title="Choose a file" last onPress={() => attach(file)} />
        <Muted style={{ fontSize: 13, lineHeight: 19, paddingTop: 10 }}>
          Stored in the notebook’s attachments folder and sent to your other devices. Up to 25 MB
          for pictures.
        </Muted>
      </Sheet>
      <Text style={{ height: 0 }} accessibilityLabel={`Note ${title}`} />
    </Screen>
  );
}
