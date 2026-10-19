/**
 * Walk the hidden stairwell and report `groundYAt` / collider / step feasibility at each point.
 *
 * Usage: node tools/probe-stair.mjs [portNeedle]
 *
 * Why: "I am stuck" is ambiguous between three different faults — no floor under the feet (falling
 * forever), floor at the wrong height (standing on a lid), or a collider overlapping the only way
 * out (wall you cannot pass). This separates them by sampling the whole well rather than the one
 * point the player happens to be standing on, because the interesting failures are at the seams.
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
  const p = g.player;
  const rows = [];
  // The stairwell column is x 16.21..18.61, z -1.08..0.16. Sample the centre line plus both edges,
  // and both sides of the door threshold, because the seam at x=18.61 is where an entry-room floor
  // above a descending tread shows up as a "lid" the player stands on.
  const zs = [-1.0, -0.46, 0.1];
  const xs = [18.61, 18.9, 18.3, 18.0, 17.7, 17.4, 17.1, 16.8, 16.5, 16.21, 16.0, 15.8];
  for (const z of zs) {
    const line = [];
    for (const x of xs) {
      const y = p.groundYAt(x, z);
      line.push(Number(y.toFixed(3)));
    }
    rows.push({ z: Number(z.toFixed(2)), y: line });
  }
  // Colliders overlapping the stairwell column — a wall here blocks the only route.
  const inWell = (p.aabbs || []).filter((a) =>
    a.maxX > 16.2 && a.minX < 18.62 && a.maxZ > -1.09 && a.minZ < 0.17);
  return JSON.stringify({
    xs,
    rows,
    collidersInWell: inWell.length,
    colliderBoxes: inWell.map((a) => ({
      x: [Number(a.minX.toFixed(3)), Number(a.maxX.toFixed(3))],
      y: [Number(a.minY.toFixed(3)), Number(a.maxY.toFixed(3))],
      z: [Number(a.minZ.toFixed(3)), Number(a.maxZ.toFixed(3))],
    })),
    stepUpHeight: p.opts ? p.opts.stepUpHeight : 'n/a',
  });
})()`;

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
if (r.result?.exceptionDetails) {
  console.error('eval failed:', r.result.exceptionDetails.text, r.result.exceptionDetails.exception?.description ?? '');
  process.exit(1);
}
const v = r.result.result.value;
const o = JSON.parse(v);
console.log('xs      :', o.xs.join('   '));
for (const row of o.rows) console.log(`z ${String(row.z).padStart(5)} :`, row.y.map((n) => n.toFixed(3)).join(' '));
console.log('\nstepUpHeight:', o.stepUpHeight);
console.log('colliders overlapping the well:', o.collidersInWell);
for (const b of o.colliderBoxes) console.log('  x', b.x, ' y', b.y, ' z', b.z);
ws.close();
