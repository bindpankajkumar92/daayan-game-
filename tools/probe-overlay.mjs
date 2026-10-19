/**
 * Read back whatever the overlay layer is currently showing.
 *
 * Usage: node tools/probe-overlay.mjs [portNeedle] [chars]
 *
 * `document.body.innerText` is useless for this: the note lives inside a
 * `max-height: 82vh; overflow: auto` panel and the HUD's debug line sits after it in
 * the DOM, so a `slice(-N)` over the body text returns the debug counters and looks
 * like the overlay never opened. Read `#overlay-layer` directly.
 */
const [NEEDLE = '5174', CHARS = '900'] = process.argv.slice(2);
const PORT = process.env.CDP_PORT ?? '9222';
const MAX = Number(CHARS);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl).find((t) => t.url.includes(NEEDLE));
if (!page) {
  console.error(`no page matching ${NEEDLE}`);
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  const f = pend.get(m.id);
  if (f) {
    pend.delete(m.id);
    f(m);
  }
});
const send = (method, params = {}) =>
  new Promise((res) => {
    const n = ++id;
    pend.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params }));
  });

const expr = `(() => {
  const el = document.getElementById('overlay-layer');
  if (!el) return JSON.stringify({ ok: false, reason: 'no #overlay-layer in DOM' });
  const cs = getComputedStyle(el);
  const open = cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0;
  const text = (el.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean).join(' / ');
  // The clue's firstToast is meant to fire on *close*, not on open — a toast shown behind the
  // open note is a toast nobody reads. This flag is how that is checked from outside.
  const onFirstRead = /He wrote it for you/.test(document.body.innerText || '');
  return JSON.stringify({ ok: true, open, display: cs.display, opacity: cs.opacity,
    children: el.children.length, chars: text.length, toastWhileOpen: onFirstRead,
    text: text.slice(0, ${MAX}) });
})()`;

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
if (r.result?.exceptionDetails) {
  console.error('eval failed:', r.result.exceptionDetails.text);
  process.exit(1);
}
console.log(r.result.result.value);
ws.close();
