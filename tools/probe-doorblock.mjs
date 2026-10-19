/**
 * Report every collider overlapping the doorway column, right now, with which one would stop a step.
 *
 * Usage: node tools/probe-doorblock.mjs [portNeedle]
 *
 * Why: the walk probe says "stuck" and names a point, not a cause. The door blocker, the door leaf
 * and the wall run are all boxes in the same column, and only one of them is *supposed* to be
 * passable at any given moment. Listing them with their y-extents says which one is in the way —
 * and an FPController box that ends below the feet is ignored, so the y range is the whole story.
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
  const g = window.__daayan, p = g.player;
  const eye = p.currentEyeHeight();
  const feet = p.position.y - eye;
  // The doorway column: x 18.47..18.75 (blocker), z -1.08..0.16.
  const near = (a) => a.maxX > 18.3 && a.minX < 18.9 && a.maxZ > -1.2 && a.minZ < 0.3;
  const boxes = (p.aabbs || []).filter(near).map((a) => ({
    x: [Number(a.minX.toFixed(3)), Number(a.maxX.toFixed(3))],
    y: [Number(a.minY.toFixed(3)), Number(a.maxY.toFixed(3))],
    z: [Number(a.minZ.toFixed(3)), Number(a.maxZ.toFixed(3))],
    // The controller ignores a box whose top is under the feet, so this is the passable test.
    blocksPlayer: a.maxY > feet + 0.02 && a.minY < feet + 1.8,
  }));
  // Is there a doorway leaf mesh still sitting in the opening?
  const leaves = [];
  g.scene && g.scene.traverse && g.scene.traverse((o) => {
    if (o.name && /hidden|door|leaf/i.test(o.name)) {
      const wp = new (p.position.constructor)();
      o.getWorldPosition(wp);
      leaves.push({ name: o.name, at: [Number(wp.x.toFixed(2)), Number(wp.y.toFixed(2)), Number(wp.z.toFixed(2))] });
    }
  });
  return JSON.stringify({ playerFeet: Number(feet.toFixed(3)), playerX: Number(p.position.x.toFixed(3)),
    boxesInDoorway: boxes, namedMeshes: leaves.slice(0, 12),
    reachCount: g.interactables().count });
})()`;

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
if (r.result?.exceptionDetails) {
  console.error('eval failed:', r.result.exceptionDetails.text, r.result.exceptionDetails.exception?.description ?? '');
  process.exit(1);
}
const o = JSON.parse(r.result.result.value);
console.log('player feet y:', o.playerFeet, ' x:', o.playerX, ' interactables:', o.reachCount);
console.log('\nboxes in the doorway column:');
for (const b of o.boxesInDoorway) console.log('  x', b.x, ' y', b.y, ' z', b.z, b.blocksPlayer ? '<-- BLOCKS' : '(below the feet — ignored)');
console.log('\nnamed meshes that look like a door:');
for (const m of o.namedMeshes) console.log('  ', m.name, m.at);
ws.close();
