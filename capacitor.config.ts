import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor config — Daayan's House.
 * - Landscape-only (locked via @capacitor/screen-orientation in main.ts)
 * - Fullscreen immersive (StatusBar plugin)
 * - Splash screen from plugin default
 * - WebView remote debugging over USB is enabled by default in debug builds
 *   via chrome://inspect (no extra config needed for that).
 */
const config: CapacitorConfig = {
  appId: 'com.daayanshouse.app',
  appName: "Daayan's House",
  webDir: 'dist',
  bundledWebRuntime: false,
  android: {
    allowMixedContent: false,
    backgroundColor: '#000000',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      backgroundColor: '#000000',
      showSpinner: false,
      androidSplashResourceName: 'splash',
    },
  },
};

export default config;
