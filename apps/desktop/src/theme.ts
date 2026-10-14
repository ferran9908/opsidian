import { useEffect, useState } from 'react';
import type { ThemePreference } from '@opsidian/theme';

const NEXT: Record<ThemePreference, ThemePreference> = {
  dark: 'light',
  light: 'system',
  system: 'dark',
};

/** Light, dark or follow-the-system appearance, applied as the `dark` class on <html>. */
export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(
    () => (localStorage.getItem('opsidian-theme') as ThemePreference) || 'dark',
  );
  const [systemDark, setSystemDark] = useState(matchMedia('(prefers-color-scheme: dark)').matches);
  const dark = preference === 'dark' || (preference === 'system' && systemDark);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const change = () => setSystemDark(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('opsidian-theme', preference);
  }, [preference, dark]);
  return { preference, dark, set: setPreference, cycle: () => setPreference(NEXT[preference]) };
}
