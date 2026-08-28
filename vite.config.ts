import { defineConfig } from 'vite';
import path from 'node:path';

// Vite config — single source of truth for both web dev and the Capacitor build.
// WebView remote debugging over USB: chrome://inspect after `adb shell am start ...`
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    host: true, // expose to LAN so the device can hit the dev server
    port: 5173,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0, // keep assets as separate files for cleaner APK bundling
    sourcemap: false, // off in production; turn on for dev builds
    chunkSizeWarningLimit: 1000,
  },
  optimizeDeps: {
    include: ['three'],
  },
});
