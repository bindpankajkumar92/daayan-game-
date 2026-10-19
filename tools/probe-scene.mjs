/**
 * List scene objects whose name matches a pattern, with their world positions.
 *
 * Usage: node tools/probe-scene.mjs <regex> [port]
 *
 * Why a file and not `act.mjs --evaluate`: that tool rejoins argv with single spaces, so any
 * expression containing a quoted string with spaces is mangled into a syntax error.
 */
const pattern = process.argv[2] ?? 'hidden';
const NEEDLE = process.argv[3] ?? '5174';
const PORT = process.env.CDP_PORT ?? '9222';

const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list
  .filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  .find((t) => t.url.includes(NEEDLE));
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
  const pat = new RegExp(${JSON.stringify(pattern)}, 'i');
  const scene = window.__daayan.engine.scene;
  const out = [];
  scene.traverse((o) => {
    if (!o.name || !pat.test(o.name)) return;
    const p = new (o.position.constructor)();
    o.getWorldPosition(p);
    out.push({
      name: o.name,
      type: o.type,
      visible: o.visible,
      pos: [p.x, p.y, p.z].map((v) => Math.round(v * 1000) / 1000)
    });
  });
  return JSON.stringify(out);
})()`;

const out = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
if (out.result?.exceptionDetails) {
  console.error('eval failed:', out.result.exceptionDetails.text, out.result.exceptionDetails.exception?.description ?? '');
  process.exit(1);
}
const rows = JSON.parse(out.result.result.value);
if (!rows.length) {
  console.log(`no object matching /${pattern}/i`);
} else {
  for (const r of rows) {
    console.log(`${r.type.padEnd(12)} ${r.name}`);
    console.log(`             world ${JSON.stringify(r.pos)}  visible=${r.visible}`);
  }
}
console.log(`(${rows.length} match${rows.length === 1 ? '' : 'es'})`);
ws.close();
