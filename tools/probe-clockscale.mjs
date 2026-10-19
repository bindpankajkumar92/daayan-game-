/**
 * Measure how much GAME time passes per second of wall time, and prove __daayan.clock() advances.
 *
 * Usage: node tools/probe-clockscale.mjs [portNeedle]
 *
 * Why: this is the number that made a working door look broken. `engine.clock` steps by the fixed
 * timestep, but `GameLoop` clamps each frame to maxFrameDt (0.1 s) and rAF drops to ~1 Hz in a tab
 * Chrome is not compositing — so game time runs far behind wall time. Knowing the ratio turns a
 * "wait 3 seconds" into "wait for 1.6 seconds of game time", which is what a tween actually reads.
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
  if (typeof g.clock !== 'function') return JSON.stringify({ error: 'no __daayan.clock — reload the page' });
  const a = g.clock();
  const t0 = performance.now();
  await new Promise((r) => setTimeout(r, 2000));
  const b = g.clock();
  const wall = (performance.now() - t0) / 1000;
  return JSON.stringify({ gameStart: Number(a.toFixed(3)), gameEnd: Number(b.toFixed(3)),
    gameSeconds: Number((b - a).toFixed(3)), wallSeconds: Number(wall.toFixed(3)),
    ratio: Number(((b - a) / wall).toFixed(3)) });
})()`;

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
if (r.result?.exceptionDetails) {
  console.error('eval failed:', r.result.exceptionDetails.text, r.result.exceptionDetails.exception?.description ?? '');
  process.exit(1);
}
const o = JSON.parse(r.result.result.value);
console.log(o);
if (typeof o.ratio === 'number') {
  console.log(
    o.ratio < 0.5
      ? `Game time runs ${(1 / o.ratio).toFixed(1)}x SLOWER than wall time — every wall-clock settle wait is too short.`
      : 'Game time tracks wall time closely.',
  );
}
ws.close();
