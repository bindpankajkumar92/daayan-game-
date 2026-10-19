/**
 * Scratch probe: at one point, which collider is it — and does the controller agree?
 *
 * `_hidwalk.mjs` says a walk is refused; this says by *what*, with full extents, and cross-checks by
 * re-running the controller's own two predicates against every box. Neither filter, no region: a box
 * that stops a walk from 0.5 m away is exactly the case a region query hides, and that case came up.
 *
 * Usage: node tools/_hidhit.mjs <needle> <x> <y> <z> [radius]
 */
const [NEEDLE = '5174', X = '15.0', Y = '4.1', Z = '0.5', R = ''] = process.argv.slice(2);
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
  const r = ${R === '' ? 'p.getRadius()' : Number(R)};
  const keep = [p.position.x, p.position.y, p.position.z];
  p.position.set(${Number(X)}, ${Number(Y)}, ${Number(Z)});
  const at = p.collidesAabbAt(p.position, r);
  const band = p.collidesAabb(p.position, r);
  const minY = p.position.y - (p.currentEyeHeight ? p.currentEyeHeight() : 1.7);
  const maxY = p.position.y;
  const hits = [];
  for (const a of p.aabbs || []) {
    const overlap =
      p.position.x + r > a.minX && p.position.x - r < a.maxX &&
      p.position.z + r > a.minZ && p.position.z - r < a.maxZ;
    if (!overlap) continue;
    const sphereY = p.position.y + r > a.minY && p.position.y - r < a.maxY;
    const skippedUnder = a.maxY <= minY + 0.05;
    const skippedOver = a.minY >= maxY + 0.05;
    const bandY = !skippedUnder && !skippedOver && maxY > a.minY && minY < a.maxY;
    hits.push({
      x: [a.minX, a.maxX], y: [a.minY, a.maxY], z: [a.minZ, a.maxZ],
      sphereY, bandY, skippedUnder, skippedOver,
    });
  }
  p.position.set(keep[0], keep[1], keep[2]);
  return JSON.stringify({ point: [${Number(X)}, ${Number(Y)}, ${Number(Z)}], r, eye: p.currentEyeHeight(), at, band, band0: minY, band1: maxY, hits });
})()`;

const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
if (res.result?.exceptionDetails) {
  console.error('eval failed:', res.result.exceptionDetails.text, res.result.exceptionDetails.exception?.description ?? '');
  process.exit(1);
}
const o = JSON.parse(res.result.result.value);
const f3 = (n) => (Math.round(n * 1000) / 1000).toFixed(3);
console.log(`point (${o.point.join(', ')})  r ${o.r}  eye ${o.eye}  band ${f3(o.band0)}..${f3(o.band1)}`);
console.log(`collidesAabbAt = ${o.at}    collidesAabb = ${o.band}`);
for (const h of o.hits) {
  console.log(
    `  x ${f3(h.x[0])}..${f3(h.x[1])}  y ${f3(h.y[0])}..${f3(h.y[1])}  z ${f3(h.z[0])}..${f3(h.z[1])}` +
      `  sphereY ${h.sphereY} bandY ${h.bandY}${h.skippedUnder ? ' [underfoot]' : ''}${h.skippedOver ? ' [overhead]' : ''}`,
  );
}
if (!o.hits.length) console.log('  (no box overlaps this point — neither test should have fired)');
ws.close();