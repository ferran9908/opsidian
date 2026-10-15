import { File, Paths } from 'expo-file-system';
import { Appearance } from 'react-native';

/** Choices made on this iPhone. They stay here: they are not part of the notebook. */
export interface Prefs {
  /** The note that was open, to open again next time. */
  last?: string;
  mode: 'live' | 'source' | 'reading';
  sort: 'name' | 'name-desc';
  theme: 'system' | 'light' | 'dark';
}
const DEFAULTS: Prefs = { mode: 'live', sort: 'name', theme: 'system' };
// Beside the notebook's folder, not in it, so sync never sees it.
const file = new File(Paths.document, 'opsidian-settings.json');

function load(): Prefs {
  try {
    if (!file.exists) return { ...DEFAULTS };
    const saved = JSON.parse(file.textSync()) as Partial<Prefs>;
    return {
      ...(typeof saved.last === 'string' ? { last: saved.last } : {}),
      mode: saved.mode === 'source' || saved.mode === 'reading' ? saved.mode : 'live',
      sort: saved.sort === 'name-desc' ? 'name-desc' : 'name',
      theme: saved.theme === 'light' || saved.theme === 'dark' ? saved.theme : 'system',
    };
  } catch {
    return { ...DEFAULTS };
  }
}

let current = load();
const listeners = new Set<() => void>();
applyTheme(current.theme);

function applyTheme(theme: Prefs['theme']) {
  Appearance.setColorScheme(theme === 'system' ? 'unspecified' : theme);
}

export const prefs = {
  get: () => current,
  set(change: Partial<Prefs>) {
    current = { ...current, ...change };
    if (change.theme) applyTheme(change.theme);
    try {
      file.write(JSON.stringify(current));
    } catch {
      // Not remembering a choice is no reason to stop the app.
    }
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
};
