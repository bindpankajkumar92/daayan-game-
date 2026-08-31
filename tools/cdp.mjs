/**
 * Evaluate an expression inside the running WebView and print the result.
 *
 * The on-device debugging loop otherwise costs a full sync + gradle + install per question asked.
 * This asks the live page directly, which turns "is the loop alive?" from a rebuild into a second.
 *
 *   adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 *   node tools/cdp.mjs "window.__daayan.player.position.toArray()"
 *   node tools/cdp.mjs --file probe.js
 *
 * `CDP_PORT` overrides the port. Worth knowing about before debugging why the forward will not bind:
 * a headless Chrome left over from an earlier session holds 9222 for as long as it lives, and
 * `adb forward` then fails with `cannot bind to 127.0.0.1:9222` rather than anything about Chrome.
 */

import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
let expression;
if (argv[0] === '--file') expression = readFileSync(argv[1], 'utf8');
else expression = argv.join(' ');
if (!expression) {
  console.error('usage: node tools/cdp.mjs <expression> | --file <path>');
  process.exit(2);
}

const PORT = process.env.CDP_PORT ?? '9222';
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) {
  console.error('no inspectable page — is the app in the foreground?');
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

const res = await send('Runtime.evaluate', {
  expression,
  returnByValue: true,
  awaitPromise: true,
  allowUnsafeEvalBlockedByCSP: true,
});
const r = res.result;
if (r?.exceptionDetails) {
  console.error('THREW:', r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  ws.close();
  process.exit(1);
}
const v = r?.result?.value;
console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
ws.close();
