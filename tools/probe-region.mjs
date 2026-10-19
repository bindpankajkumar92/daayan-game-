/**
 * List every collider in a box-shaped region, so a camera pose can be chosen from facts.
 *
 * Usage: node tools/probe-region.mjs <x1> <z1> <x2> <z2> [portNeedle]
 *
 * Why: `shot-room.mjs` refuses a pose inside geometry, and when it refuses the question is "which
 * box, and where can I stand instead". Guessing a nearby coordinate and re-running is slow and
 * tends to land in the next box. This prints the boxes with their full extents so the clear lane is
 * obvious.
 */
const [x1, z1, x2, z2, NEEDLE = '5174'] = process.argv.slice(2);
if (z2 === undefined) {
  console.error('usage: node tools/probe-region.mjs <x1> <z1> <x2> <z2> [portNeedle]');
  process.exit(2);
}
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
  const p = window.__daayan.player;
  const [X1, Z1, X2, Z2] = [${Number(x1)}, ${Number(z1)}, ${Number(x2)}, ${Number(z2)}];
  const loX = Math.min(X1, X2), hiX = Math.max(X1, X2);
  const loZ = Math.min(Z1, Z2), hiZ = Math.max(Z1, Z2);
  const boxes = (p.aabbs || []).filter((a) => a.maxX > loX && a.minX < hiX && a.maxZ > loZ && a.minZ < hiZ)
    .map((a) => ({ x: [Number(a.minX.toFixed(3)), Number(a.maxX.toFixed(3))],
                   y: [Number(a.minY.toFixed(3)), Number(a.maxY.toFixed(3))],
                   z: [Number(a.minZ.toFixed(3)), Number(a.maxZ.toFixed(3))] }));
  // Where is the floor, sampled on a grid, so a clear standing spot is visible directly.
  const grid = [];
  for (let x = loX; x <= hiX + 1e-6; x += (hiX - loX) / 8) {
    const row = [];
    for (let z = loZ; z <= hiZ + 1e-6; z += (hiZ - loZ) / 8) row.push(Number(p.groundYAt(x, z).toFixed(2)));
    grid.push({ x: Number(x.toFixed(2)), y: row });
  }
  return JSON.stringify({ boxes, grid, radius: p.getRadius ? p.getRadius() : 0.3,
    stepUp: p.opts ? p.opts.stepUpHeight : null });
})()`;

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
if (r.result?.exceptionDetails) {
  console.error('eval failed:', r.result.exceptionDetails.text, r.result.exceptionDetails.exception?.description ?? '');
  process.exit(1);
}
const o = JSON.parse(r.result.result.value);
console.log(`region x ${x1}..${x2}  z ${z1}..${z2}   player radius ${o.radius}  stepUp ${o.stepUp}`);
console.log(`\n${o.boxes.length} colliders overlapping:`);
for (const b of o.boxes) console.log('  x', b.x, ' y', b.y, ' z', b.z);
console.log('\ngroundYAt grid (rows = x, cols = z from ' + z1 + ' to ' + z2 + '):');
for (const row of o.grid) console.log('  x', String(row.x).padStart(6), ':', row.y.map((n) => String(n).padStart(6)).join(''));
ws.close();
