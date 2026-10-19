/**
 * Read the book, close it, and capture the hand-off toast in the same CDP evaluation.
 *
 * Usage: node tools/probe-bookkey.mjs [portNeedle]
 *
 * The key hand-off toast lives 3.4 s, so probing it in a *separate* tool invocation races the
 * clock and reads as "no toast" even when it fired. This does read -> close -> sample atomically.
 *
 * What it proves, in order: the interaction picks `hidden.book`, the note opens, closing fires the
 * clue's own first-read beat, and the book's wrapper adds the key on top of it.
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
  const g = window.__daayan;
  const P = g.player;
  const wait = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const hud = () => (document.body.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
  const keyGroup = () => {
    let found = null;
    g.engine.scene.traverse((o) => {
      if (o.name === 'hidden-key') found = { visible: o.visible, children: o.children.length };
    });
    return found;
  };

  const before = keyGroup();

  // Pose at the wardrobe and read the book.
  P.warpTo(new (P.position.constructor)(17.0, 1.7, -5.1), 3.14);
  P.addLookDelta(0, -(-0.75 - P.facing.x));
  await wait();
  const won = g.interactables().current;
  const btn = document.getElementById('tc-btn-interact');
  const r = btn.getBoundingClientRect();
  const opt = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 1, pointerType: 'touch', isPrimary: true };
  btn.dispatchEvent(new PointerEvent('pointerdown', opt));
  btn.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true }));
  btn.dispatchEvent(new PointerEvent('pointerup', opt));
  btn.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true }));
  btn.dispatchEvent(new MouseEvent('click', opt));
  await wait();
  const layer = document.getElementById('overlay-layer');
  const noteOpen = !!layer && getComputedStyle(layer).display !== 'none';
  const toastWhileOpen = hud().filter((s) => /oilcloth|He wrote it/.test(s));

  // Close it, then sample the HUD on the very next frames — the key toast is short-lived.
  const closeBtn = layer ? layer.querySelector('button') : null;
  if (closeBtn) {
    const cr = closeBtn.getBoundingClientRect();
    closeBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true,
      pointerId: 2, pointerType: 'touch', isPrimary: true,
      clientX: cr.left + cr.width / 2, clientY: cr.top + cr.height / 2 }));
  }
  await wait();
  await wait();

  return JSON.stringify({
    won,
    noteOpen,
    toastWhileOpen,
    noteClosedAfter: (() => { const l = document.getElementById('overlay-layer'); return !l || getComputedStyle(l).display === 'none'; })(),
    toastsAfterClose: hud().filter((s) => /oilcloth|He wrote it|Brass Key/i.test(s)),
    keyGroupBefore: before,
    keyGroupAfter: keyGroup(),
  });
})()`;

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
if (r.result?.exceptionDetails) {
  console.error('eval failed:', r.result.exceptionDetails.text, r.result.exceptionDetails.exception?.description ?? '');
  process.exit(1);
}
console.log(r.result.result.value);
ws.close();
