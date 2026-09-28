export const themes = {
  light: {
    canvas: '#FFFFFF',
    sidebar: '#F3F5F6',
    surface: '#FFFFFF',
    text: '#202C35',
    muted: '#60717E',
    accent: '#254D70',
    onAccent: '#FFFFFF',
    border: '#DCE2E6',
    selection: '#E1E8EE',
    linkBackground: '#EDF2F6',
  },
  dark: {
    canvas: '#171D22',
    sidebar: '#12181D',
    surface: '#202A32',
    text: '#E7EDF1',
    muted: '#A2B0BC',
    accent: '#A9C9E3',
    onAccent: '#15232E',
    border: '#35414B',
    selection: '#293D4E',
    linkBackground: '#263B4B',
  },
} as const;

export type ThemeName = keyof typeof themes;
export type ThemePreference = ThemeName | 'system';
export type ThemeToken = keyof (typeof themes)['light'];
