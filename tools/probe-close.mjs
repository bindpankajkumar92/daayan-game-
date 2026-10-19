/**
 * Close whatever the overlay is showing, then report the after-effects.
 *
 * Usage: node tools/probe-close.mjs [portNeedle]
 *
 * Verifies the close path of a CLUES note: the overlay must shut, and the first-read
 * beat (toast + tension raise) must fire on *close* rather than on open — the note
 * would otherwise be talked over by its own toast.
 */
const [NEEDLE = '5174'] = process.argv.slice(2);
const PORT = process.env.CDP_PORT ?? '9222';

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

const expr = `(async () => {
  const grab = () => {
    const t = (document.body.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
    return t.filter((s) => /He wrote it|tension|TERRIFY/i.test(s)).join(' / ');
  };
  const beforeText = grab();
  // #overlay-layer is a permanent node whose display toggles, NOT one that is removed on close.
  const el = document.getElementById('overlay-layer');
  const wasOpen = !!el && getComputedStyle(el).display !== 'none';
  // The close button listens for *pointerdown*, and so does every overlayButton. A synthetic
  // .click() is never delivered to a pointerdown listener and looks exactly like a dead button.
  const btn = el ? el.querySelector('button') : null;
  let closedVia = 'none';
  if (btn) {
    closedVia = 'close-button';
    const r = btn.getBoundingClientRect();
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true,
      pointerId: 1, pointerType: 'touch', isPrimary: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const after = document.getElementById('overlay-layer');
  const nowDisplay = after ? getComputedStyle(after).display : 'gone';
  return JSON.stringify({
    closedVia,
    wasOpen,
    nowDisplay,
    closed: nowDisplay === 'none',
    beforeText,
    afterText: grab(),
  });
})()`;

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
if (r.result?.exceptionDetails) {
  console.error('eval failed:', r.result.exceptionDetails.text, r.result.exceptionDetails.exception?.description ?? '');
  process.exit(1);
}
console.log(r.result.result.value);
ws.close();
