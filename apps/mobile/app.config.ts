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
  // Drawn from design/logo by `pnpm icons`.
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  ios: {
    supportsTablet: true,
    bundleIdentifier,
    ...(appleTeamId ? { appleTeamId } : {}),
    infoPlist: {
      // The host is reached over Tailscale or the home network, which carry plain http.
      // NSAllowsLocalNetworking must not be added: iOS then ignores NSAllowsArbitraryLoads,
      // and Tailscale's 100.x addresses do not count as local, so they are refused.
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
      NSLocalNetworkUsageDescription:
        'Opsidian connects to the host that keeps your notebook in step, on your own network.',
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  plugins: [
    'expo-document-picker',
    'expo-secure-store',
    [
      'expo-camera',
      {
        cameraPermission:
          'Opsidian uses the camera to scan an invitation and to add photos to notes.',
        microphonePermission: false,
        recordAudioAndroid: false,
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission: 'Opsidian adds the photos you choose to your notes.',
        cameraPermission:
          'Opsidian uses the camera to scan an invitation and to add photos to notes.',
        microphonePermission: false,
      },
    ],
  ],
};

export default config;
