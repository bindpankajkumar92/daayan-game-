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
    port: 5174,
    // Fail loudly instead of silently moving to the next free port.
    //
    // Without this, a dead server left over from an earlier session makes Vite start on 5175, 5176, ...
    // and the URL in the console stops being the URL anything is watching. The failure that costs real
    // time is subtler than a wrong port, though: a browser tab already open on the *old* port keeps its
    // HMR client alive, that client reconnects to the origin it was loaded from, and the tab ends up
    // either showing a stale build or navigating itself to a dead server and rendering ERR_CONNECTION_REFUSED.
    // Both look exactly like a bug in the game — a screenshot shows last week's geometry and the obvious
    // conclusion is that the fix did not work. It took an hour of that to find this, so: strictPort.
    //
    // A hard failure here is what you want. It means "kill whatever is on 5174", which is one command,
    // rather than "work out which of six ports is the live one", which is not.
    strictPort: true,
    // `host: true` binds both `0.0.0.0` and `[::]`, and Vite's HMR client then advertises the page's
    // own host to itself. On this machine `localhost` is the problem: Chrome resolves it to `::1`
    // first, IPv6 to the dev server is refused, and the client gives up with ERR_CONNECTION_REFUSED
    // instead of falling back to IPv4. The page then reloads itself onto a dead origin mid-session and
    // looks like a crash in the game.
    //
    // Pinning the HMR host to 127.0.0.1 keeps every reconnect on IPv4, where the server is reachable.
    // `host: true` stays for LAN/device testing — this only changes the address the *client* dials.
    hmr: { host: '127.0.0.1' },
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
