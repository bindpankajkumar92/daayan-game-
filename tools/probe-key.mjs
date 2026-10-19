/**
 * Report the state of the hidden room's key: is its group in the scene, is it visible, does the
 * player hold the clock key, and is the book's clue flagged as seen.
 *
 * Usage: node tools/probe-key.mjs [portNeedle]
 *
 * Why a dedicated probe: the book's key hand-off is a *wrapper* around the clue handler, so the
 * three ways it can fail look identical from the outside — the group never got built, the wrapper
 * never replaced `onUse`, or the wrapper ran but `collectKey` refused. This separates them.
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

const expr = `(() => {
  const g = window.__daayan;
  const scene = g.engine.scene;
  const found = [];
  scene.traverse((o) => {
    if (o.name === 'hidden-key') {
      found.push({ name: o.name, visible: o.visible, children: o.children.length,
        pos: o.position.toArray().map((n) => Number(n.toFixed(3))) });
    }
  });
  // The interactable list the scene actually registered, via the dev handle.
  const probe = g.interactables();
  const bookListed = probe.ids.includes('hidden.book');
  // The two toasts, read from the HUD rather than the body, which is easier to filter.
  const body = (document.body.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
  return JSON.stringify({
    groupsInScene: found,
    groupCount: found.length,
    bookListed,
    interCount: probe.count,
    clueToast: body.some((s) => /He wrote it for you/.test(s)),
    keyToast: body.filter((s) => /oilcloth|Brass Key/i.test(s)),
    // State, so a refusal inside collectKey is visible as "seen but not held".
    bookSeen: typeof g.state.hasSeen === 'function' ? g.state.hasSeen('hidden.book') : 'no hasSeen',
    holdsClockKey: typeof g.state.hasKey === 'function' ? g.state.hasKey('key-clock') : 'no hasKey',
  });
})()`;

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
if (r.result?.exceptionDetails) {
  console.error('eval failed:', r.result.exceptionDetails.text, r.result.exceptionDetails.exception?.description ?? '');
  process.exit(1);
}
console.log(r.result.result.value);
ws.close();
