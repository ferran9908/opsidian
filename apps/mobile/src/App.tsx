import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Linking, Modal, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { connect, open, refresh, store } from './notebook';
import { prefs } from './prefs';
import { phonePlatform } from './platform';
import { NavigationContext, parseInvitation, type Navigation, type Route } from './nav';
import { Button, Screen, message, useColors, useStore } from './ui';
import { Search, Trash } from './screens/browse';
import { Notes } from './screens/note';
import { Settings } from './screens/settings';
import { Connect, Downloading, HeldDeletions, Welcome } from './screens/start';
import { Check, History, Sync, Version } from './screens/sync';

/** Handles for driving a development build from the debugger. */
export const dev: Record<string, unknown> = {};
if (__DEV__) {
  Object.assign(dev, { store, open, connect, refresh, prefs, platform: phonePlatform });
  (globalThis as { opsidian?: unknown }).opsidian = dev;
}

const label = (route: Route | undefined): string => {
  if (!route) return '‹ Back';
  if (route.name === 'notes') return '‹ Notes';
  if (route.name === 'settings') return '‹ Settings';
  if (route.name === 'history') return '‹ History';
  if (route.name === 'sync') return '‹ Sync';
  return '‹ Back';
};

/** The notes opened, in order, and which of them is showing; back and forward walk it. */
interface Trail {
  paths: string[];
  at: number;
  /** Counts openings, so a new note gets a fresh editor but a renamed one keeps its own. */
  visit: number;
  heading?: string;
}
const EMPTY: Trail = { paths: [], at: -1, visit: 0 };

/** The note to start on: the one open last time, or else the one changed most recently. */
function firstNote(): string | undefined {
  const notes = store.tree.notes;
  const last = prefs.get().last;
  if (last && notes.includes(last)) return last;
  const times = store.notebook?.vault.modified() ?? new Map<string, number>();
  return [...notes].sort((a, b) => (times.get(b) ?? 0) - (times.get(a) ?? 0))[0];
}

function Stack() {
  const [routes, setRoutes] = useState<Route[]>([{ name: 'notes' }]);
  const [trail, setTrail] = useState<Trail>(EMPTY);
  /** Whether a note has been chosen to start on; after that an empty trail stays empty. */
  const started = useRef(false);
  const [welcoming, setWelcoming] = useState<'welcome' | 'connect'>('welcome');
  /** Set after connecting, until the first download is in or waved through. */
  const [arriving, setArriving] = useState(false);
  const [snoozed, setSnoozed] = useState(false);
  const [invitation, setInvitation] = useState<{ host: string; code: string }>();
  const { notebook, sync, tree } = useStore();
  const top = routes[routes.length - 1]!;
  const exists = (path: string) => store.tree.notes.includes(path);
  const navigation: Navigation = useMemo(
    () => ({
      push: (route) => setRoutes((stack) => [...stack, route]),
      pop: () => setRoutes((stack) => (stack.length > 1 ? stack.slice(0, -1) : stack)),
      replace: (route) => setRoutes((stack) => [...stack.slice(0, -1), route]),
      back: label(routes[routes.length - 2]).slice(0, 22),
      openNote: (path, heading) => {
        started.current = true;
        setTrail((before) => {
          const paths = [...before.paths.slice(0, before.at + 1), path];
          return {
            paths,
            at: paths.length - 1,
            visit: before.visit + 1,
            ...(heading ? { heading } : {}),
          };
        });
        setRoutes([{ name: 'notes' }]);
      },
      replaceNote: (path) =>
        setTrail((before) => {
          const old = before.paths[before.at];
          if (old === undefined || old === path) return before;
          return { ...before, paths: before.paths.map((each) => (each === old ? path : each)) };
        }),
      dropNote: () =>
        setTrail((before) => {
          const old = before.paths[before.at];
          const kept = before.paths
            .map((path, at) => ({ path, at }))
            .filter(({ path }) => path !== old && exists(path));
          // The note before it, where back would have gone; failing that, the one after.
          const earlier = kept.filter(({ at }) => at < before.at).length;
          return {
            paths: kept.map(({ path }) => path),
            at: kept.length ? Math.max(0, earlier - 1) : -1,
            visit: before.visit + 1,
          };
        }),
      step: (by) =>
        setTrail((before) => {
          let at = before.at + by;
          // Notes removed since are stepped over.
          while (at >= 0 && at < before.paths.length && !exists(before.paths[at]!)) at += by;
          if (at < 0 || at >= before.paths.length) return before;
          return { paths: before.paths, at, visit: before.visit + 1 };
        }),
      canStep: (by) => {
        for (let at = trail.at + by; at >= 0 && at < trail.paths.length; at += by)
          if (exists(trail.paths[at]!)) return true;
        return false;
      },
    }),
    [routes, trail],
  );
  const current = trail.paths[trail.at];
  useEffect(() => {
    if (__DEV__) dev.navigation = navigation;
  });
  // Next time, the app opens on the note that was open.
  useEffect(() => {
    if (current) prefs.set({ last: current });
  }, [current]);
  // The notebook was deleted from this iPhone on disconnecting: start again from nothing.
  useEffect(() => {
    if (notebook) return;
    started.current = false;
    setTrail(EMPTY);
    setRoutes([{ name: 'notes' }]);
    setWelcoming('welcome');
  }, [notebook]);
  // Start on a note as soon as there is one: at once, or when the first download brings some.
  useEffect(() => {
    if (started.current || !notebook) return;
    const first = firstNote();
    if (!first) return;
    started.current = true;
    setTrail({ paths: [first], at: 0, visit: 1 });
  }, [notebook, tree]);
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
      if (store.tree.notes.includes(path)) navigation.openNote(path);
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
        {top.name === 'notes' ? (
          <Notes
            path={current}
            visit={trail.visit}
            {...(trail.heading ? { heading: trail.heading } : {})}
          />
        ) : top.name === 'settings' ? (
          <Settings />
        ) : top.name === 'search' ? (
          <Search query={top.query} />
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
