/**
 * Report the walkable floor extent and the wall colliders of a named room, straight from the scene.
 *
 * Usage: node tools/probe-roombox.mjs [portNeedle]
 *
 * Why: after moving a room constant it is not enough to know the build compiled — a running dev
 * server may still be serving the previous bundle (HMR can miss a change to a module that is only
 * read once at scene construction). This prints the floor rectangles and the colliders that enclose
 * the hidden room as the live scene actually has them, so "did my edit reach the browser" is a
 * measurement rather than an assumption.
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
  const p = window.__daayan.player;
  // Walk the west edge of the hidden room floor to find where the floor actually begins.
  const at = [];
  for (let x = 15.5; x <= 16.0; x += 0.05) {
    const y = p.groundYAt(x, -0.5);
    at.push([Number(x.toFixed(2)), Number(y.toFixed(3))]);
  }
  // And the north edge.
  const zAt = [];
  for (let z = 0.3; z <= 0.8; z += 0.05) {
    const y = p.groundYAt(17.0, z);
    zAt.push([Number(z.toFixed(2)), Number(y.toFixed(3))]);
  }
  // Colliders that enclose the room (its own four walls): all at y 0.2..2.4.
  const walls = (p.aabbs || []).filter((a) =>
    Math.abs(a.minY - 0.2) < 0.001 && a.maxY < 3.0 && a.minX < 22 && a.maxX > 15 &&
    a.minZ < 0.9 && a.maxZ > -6.5);
  return JSON.stringify({
    westEdgeFloor: at,
    northEdgeFloor: zAt,
    roomWalls: walls.map((a) => ({ x: [Number(a.minX.toFixed(2)), Number(a.maxX.toFixed(2))],
      y: [Number(a.minY.toFixed(2)), Number(a.maxY.toFixed(2))],
      z: [Number(a.minZ.toFixed(2)), Number(a.maxZ.toFixed(2))] })),
  });
})()`;

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
if (r.result?.exceptionDetails) {
  console.error('eval failed:', r.result.exceptionDetails.text, r.result.exceptionDetails.exception?.description ?? '');
  process.exit(1);
}
const o = JSON.parse(r.result.result.value);
console.log('floor height walking east from x 15.5 at z -0.5:');
for (const [x, y] of o.westEdgeFloor) console.log(`  x ${x}  ->  ${y}`);
console.log('\nfloor height walking north from z 0.3 at x 17.0:');
for (const [z, y] of o.northEdgeFloor) console.log(`  z ${z}  ->  ${y}`);
console.log('\nroom wall colliders (y 0.2 lower bound):');
for (const w of o.roomWalls) console.log('  x', w.x, ' y', w.y, ' z', w.z);
ws.close();
