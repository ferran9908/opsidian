import { useEffect, useMemo, useState } from 'react';
import { AppState, Linking, Modal, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { noteTitle } from '@opsidian/core';
import { connect, open, refresh, store } from './notebook';
import { phonePlatform } from './platform';
import { NavigationContext, parseInvitation, type Navigation, type Route } from './nav';
import { Button, Screen, message, useColors, useStore } from './ui';
import { Folder, Home, Search, Trash } from './screens/browse';
import { Note } from './screens/note';
import { Connect, Downloading, HeldDeletions, Welcome } from './screens/start';
import { Check, History, Sync, Version } from './screens/sync';

/** Handles for driving a development build from the debugger. */
export const dev: Record<string, unknown> = {};
if (__DEV__) {
  Object.assign(dev, { store, open, connect, refresh, platform: phonePlatform });
  (globalThis as { opsidian?: unknown }).opsidian = dev;
}

const label = (route: Route | undefined): string => {
  if (!route) return '‹ Back';
  if (route.name === 'home') return `‹ ${store.name}`;
  if (route.name === 'folder') return `‹ ${route.path.slice(route.path.lastIndexOf('/') + 1)}`;
  if (route.name === 'all') return '‹ All notes';
  if (route.name === 'note') return `‹ ${noteTitle(route.path)}`;
  if (route.name === 'history') return '‹ History';
  if (route.name === 'sync') return '‹ Sync';
  return '‹ Back';
};

function Stack() {
  const [routes, setRoutes] = useState<Route[]>([{ name: 'home' }]);
  const [welcoming, setWelcoming] = useState<'welcome' | 'connect'>('welcome');
  /** Set after connecting, until the first download is in or waved through. */
  const [arriving, setArriving] = useState(false);
  const [snoozed, setSnoozed] = useState(false);
  const [invitation, setInvitation] = useState<{ host: string; code: string }>();
  const { notebook, sync } = useStore();
  const top = routes[routes.length - 1]!;
  const navigation: Navigation = useMemo(
    () => ({
      push: (route) => setRoutes((stack) => [...stack, route]),
      pop: () => setRoutes((stack) => (stack.length > 1 ? stack.slice(0, -1) : stack)),
      replace: (route) => setRoutes((stack) => [...stack.slice(0, -1), route]),
      back: label(routes[routes.length - 2]).slice(0, 22),
    }),
    [routes],
  );
  // Development builds can be driven from the debugger, which is how the app is tested
  // in the simulator. Nothing here exists in a release build.
  useEffect(() => {
    if (__DEV__) Object.assign(dev, { setRoutes, setArriving });
  }, []);
  useEffect(() => {
    if (arriving && sync.state === 'synced') setArriving(false);
  }, [arriving, sync.state]);
  useEffect(() => {
    if (!sync.held) setSnoozed(false);
  }, [sync.held]);
  // iOS suspends the app in the background; catch up the moment it is in front again.
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') store.notebook?.sync.kick();
    });
    return () => listener.remove();
  }, []);

  // `opsidian://connect?host=…&code=…` fills in an invitation; `opsidian://note?path=…` opens a note.
  useEffect(() => {
    const follow = (address: string | null) => {
      try {
        route(address);
      } catch {
        // A link that cannot be read is ignored.
      }
    };
    const route = (address: string | null) => {
      if (!address) return;
      const invited = parseInvitation(address);
      if (invited) {
        setInvitation(invited);
        if (store.notebook) setRoutes((stack) => [...stack, { name: 'connect' }]);
        else setWelcoming('connect');
        return;
      }
      const note = address.match(/^opsidian:\/\/note\/?\?path=([^&]*)/);
      const path = note ? decodeURIComponent(note[1]!) : '';
      if (store.tree.notes.includes(path)) setRoutes((stack) => [...stack, { name: 'note', path }]);
    };
    void Linking.getInitialURL().then(follow, () => {});
    const listener = Linking.addEventListener('url', (event) => follow(event.url));
    return () => listener.remove();
  }, []);

  if (!notebook) {
    return welcoming === 'connect' ? (
      <Connect
        {...(invitation ? { invitation } : {})}
        onBack={() => setWelcoming('welcome')}
        onConnected={() => setArriving(true)}
      />
    ) : (
      <Welcome onConnect={() => setWelcoming('connect')} onStarted={() => {}} />
    );
  }
  if (arriving) return <Downloading onContinue={() => setArriving(false)} />;
  return (
    <NavigationContext.Provider value={navigation}>
      {/* Laid over the screens rather than replacing them, so an open note keeps its text. */}
      <Modal visible={Boolean(sync.held) && !snoozed && top.name !== 'sync'} animationType="slide">
        <SafeAreaProvider>
          <HeldDeletions onLater={() => setSnoozed(true)} />
        </SafeAreaProvider>
      </Modal>
      {/* Keyed by depth, so a renamed note keeps its editor and a new screen starts fresh. */}
      <View key={routes.length} style={{ flex: 1 }}>
        {top.name === 'home' ? (
          <Home />
        ) : top.name === 'folder' ? (
          <Folder path={top.path} />
        ) : top.name === 'all' ? (
          <Folder />
        ) : top.name === 'note' ? (
          <Note path={top.path} {...(top.heading ? { heading: top.heading } : {})} />
        ) : top.name === 'search' ? (
          <Search />
        ) : top.name === 'trash' ? (
          <Trash />
        ) : top.name === 'sync' ? (
          <Sync />
        ) : top.name === 'connect' ? (
          <Connect
            {...(invitation ? { invitation } : {})}
            onBack={navigation.pop}
            onConnected={() => {
              navigation.pop();
              setArriving(true);
            }}
          />
        ) : top.name === 'check' ? (
          <Check />
        ) : top.name === 'history' ? (
          <History path={top.path} />
        ) : (
          <Version path={top.path} version={top.version} />
        )}
      </View>
    </NavigationContext.Provider>
  );
}

export default function App() {
  const colors = useColors();
  const [state, setState] = useState<'opening' | 'ready' | { error: string }>('opening');
  const start = () => {
    setState('opening');
    open().then(
      () => setState('ready'),
      (reason) => setState({ error: message(reason) }),
    );
  };
  useEffect(start, []);
  return (
    <SafeAreaProvider>
      <StatusBar style={colors.background === '#ffffff' ? 'dark' : 'light'} />
      {state === 'ready' ? (
        <Stack />
      ) : (
        <Screen>
          <View style={{ flex: 1, justifyContent: 'center', padding: 28, gap: 14 }}>
            {state === 'opening' ? (
              <Text style={{ fontSize: 17, color: colors.mutedForeground }}>
                Opening your notebook…
              </Text>
            ) : (
              <>
                <Text style={{ fontSize: 24, fontWeight: '700', color: colors.foreground }}>
                  The notebook could not be opened.
                </Text>
                <Text style={{ fontSize: 16, lineHeight: 24, color: colors.mutedForeground }}>
                  {state.error}
                </Text>
                <Button label="Try again" onPress={start} />
              </>
            )}
          </View>
        </Screen>
      )}
    </SafeAreaProvider>
  );
}
