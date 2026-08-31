/**
 * Clear the WebView's HTTP cache and hard-reload the page, then report which bundle came back.
 *
 * This exists because of a trap that cost most of a session. Reinstalling the APK replaces
 * `assets/public/index.html` and the hashed bundle beside it, but it does **not** touch the
 * WebView's disk cache, which lives in app *data* and survives a reinstall. Capacitor serves the
 * app over `https://localhost` through WebViewAssetLoader, so those files are ordinary cacheable
 * HTTP responses: the WebView happily keeps serving the previous `index.html`, which names the
 * previous bundle hash, which is also still in the cache. The result is an app that reports the new
 * `versionName` and a fresh `lastUpdateTime` while executing code from two builds ago.
 *
 * It is a nastier failure than a stale APK because every check you would reach for says the install
 * worked. The only honest test is the one at the bottom of this file: ask the live page which script
 * it actually loaded and compare that against the hash in the APK's index.html.
 *
 *   node tools/cdp-reload.mjs                 # clear cache, reload, print the live bundle name
 *   node tools/cdp-reload.mjs --expect index-DJVcSRo-.js   # ...and exit 1 unless it matches
 *
 * `CDP_PORT` overrides the port, matching cdp.mjs.
 */

const PORT = process.env.CDP_PORT ?? '9222';
const argv = process.argv.slice(2);
const expect = argv.includes('--expect') ? argv[argv.indexOf('--expect') + 1] : null;

const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) {
  console.error('no inspectable page — is the app in the foreground and unlocked?');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params) =>
  new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

// Both, not either: clearBrowserCache drops the stored responses, and ignoreCache on the reload
// stops the navigation itself from being served out of the memory cache that survives it.
await send('Network.enable');
await send('Network.clearBrowserCache');
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });

const evaluate = (expression) =>
  send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, allowUnsafeEvalBlockedByCSP: true });

/**
 * Poll for the bundle name rather than waiting on Page.loadEventFired. The reload tears down the
 * execution context, so an evaluate issued too early comes back with no result at all instead of an
 * error, and the scene then needs several more seconds to upload its textures regardless.
 */
let bundle = null;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 750));
  const res = await evaluate(
    "JSON.stringify({b:[...document.scripts].map(s=>s.src.split('/').pop()).filter(n=>n.startsWith('index-'))[0]??null," +
      't:window.__daayan?window.__daayan.engine.renderer.info.memory.textures:0})',
  );
  const v = res?.result?.result?.value;
  if (typeof v !== 'string') continue;
  const got = JSON.parse(v);
  if (got.b) {
    bundle = got.b;
    if (got.t >= 10) {
      console.log(`${bundle}   textures=${got.t}`);
      break;
    }
  }
}

ws.close();
if (!bundle) {
  console.error('page never came back with a bundle name');
  process.exit(1);
}
if (expect && bundle !== expect) {
  console.error(`STALE: live page is running ${bundle}, expected ${expect}`);
  process.exit(1);
}
