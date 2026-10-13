import type { ExpoConfig } from 'expo/config';

// Signing is per developer: set these in apps/mobile/.env.local (see .env.example).
const appleTeamId = process.env.APPLE_TEAM_ID;
const bundleIdentifier = process.env.IOS_BUNDLE_IDENTIFIER || 'sh.ferran.opsidian';

const config: ExpoConfig = {
  name: 'Opsidian',
  slug: 'opsidian',
  version: '0.1.0',
  scheme: 'opsidian',
  orientation: 'default',
  userInterfaceStyle: 'automatic',
  ios: {
    supportsTablet: true,
    bundleIdentifier,
    ...(appleTeamId ? { appleTeamId } : {}),
  },
  plugins: ['expo-sqlite', 'expo-document-picker'],
};

export default config;
