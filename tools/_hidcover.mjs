/**
 * Scratch probe for the hidden-room stairwell enclosure: what is actually there right now.
 *
 * Usage:
 *   node tools/_hidcover.mjs [portNeedle] [x0] [z0] [x1] [z1] [poseX poseFeetY poseZ yaw pitch]
 *
 * Prints:
 *   1. the camera's own world position and forward vector, so a pose's yaw sign is a fact and not a
 *      guess (`lookshot.mjs` takes the same numbers);
 *   2. every collider box (p.aabbs) overlapping the region, with full extents — this is where a wall's
 *      real thickness comes from, including the boxes sliced out of an imported model's own geometry;
 *   3. a groundYAt grid over the region. `groundYAt` answers "what is under me", so the pose matters:
 *      sampled from the ground floor the upper storey is above the eye and invisible to it.
 *
 * Deliberately uses no `three`: the page publishes no `THREE` namespace, and everything below is plain
 * numbers on the controller. See probe-region.mjs for the same idea at a coarser grain.
 */
const [NEEDLE = '5174', X0 = '17.4', Z0 = '-2.2', X1 = '19.6', Z1 = '1.0', ...POSE] = process.argv.slice(2);
const PORT = process.env.CDP_PORT ?? '9222';
const STEP = 0.3;

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

const pose = POSE.length >= 3 ? POSE.map(Number) : null;
const poseJs = pose
  ? `const p0 = p; p0.position.set(${pose[0]}, ${pose[1]}, ${pose[2]}); p0.onGround = true;
     p0.look(${pose[3] ?? 0}, ${pose[4] ?? 0}); if (typeof p0.syncCamera === 'function') p0.syncCamera();`
  : '';

const expr = `(() => {
  const p = window.__daayan.player;
  ${poseJs}
  const [X0, Z0, X1, Z1] = [${Number(X0)}, ${Number(Z0)}, ${Number(X1)}, ${Number(Z1)}];
  const loX = Math.min(X0, X1), hiX = Math.max(X0, X1);
  const loZ = Math.min(Z0, Z1), hiZ = Math.max(Z0, Z1);
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const cam = window.__daayan.engine.camera;
  cam.updateWorldMatrix(true, false);
  const e = cam.matrixWorld.elements;
  const boxes = (p.aabbs || [])
    .filter((a) => a.maxX > loX && a.minX < hiX && a.maxZ > loZ && a.minZ < hiZ && a.maxY > 0 && a.minY < 9)
    .map((a) => ({
      x: [r3(a.minX), r3(a.maxX)], y: [r3(a.minY), r3(a.maxY)], z: [r3(a.minZ), r3(a.maxZ)],
      w: r3(a.maxX - a.minX), d: r3(a.maxZ - a.minZ), h: r3(a.maxY - a.minY),
    }))
    .sort((q, s) => q.z[0] - s.z[0] || q.x[0] - s.x[0]);
  const grid = [];
  for (let x = loX; x <= hiX + 1e-6; x += ${STEP}) {
    const row = [];
    for (let z = loZ; z <= hiZ + 1e-6; z += ${STEP}) row.push(Number(p.groundYAt(x, z).toFixed(2)));
    grid.push({ x: r3(x), y: row });
  }
  return JSON.stringify({
    radius: p.getRadius ? r3(p.getRadius()) : null,
    eye: p.currentEyeHeight ? r3(p.currentEyeHeight()) : null,
    cam: [r3(cam.position.x), r3(cam.position.y), r3(cam.position.z)],
    fwd: [r3(-e[8]), r3(-e[9]), r3(-e[10])],
    feet: [r3(p.position.x), r3(p.position.y), r3(p.position.z)],
    count: (p.aabbs || []).length,
    boxes, grid,
    zs: grid.length ? grid[0].y.map((_, i) => r3(loZ + i * ${STEP})) : [],
  });
})()`;

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
if (r.result?.exceptionDetails) {
  console.error('eval failed:', r.result.exceptionDetails.text, r.result.exceptionDetails.exception?.description ?? '');
  process.exit(1);
}
const o = JSON.parse(r.result.result.value);
console.log(`player radius ${o.radius}  eye ${o.eye}  colliders ${o.count}`);
console.log(`feet (${o.feet.join(', ')})   cam (${o.cam.join(', ')})   forward (${o.fwd.join(', ')})`);
console.log(`\ncolliders overlapping x ${Math.min(+X0, +X1)}..${Math.max(+X0, +X1)}, z ${Math.min(+Z0, +Z1)}..${Math.max(+Z0, +Z1)}:`);
for (const b of o.boxes) {
  console.log(
    `  x ${String(b.x[0]).padStart(7)}..${String(b.x[1]).padStart(7)} (w ${String(b.w).padStart(6)})  ` +
      `y ${String(b.y[0]).padStart(6)}..${String(b.y[1]).padStart(6)}  ` +
      `z ${String(b.z[0]).padStart(7)}..${String(b.z[1]).padStart(7)} (d ${String(b.d).padStart(6)})`,
  );
}
console.log(`\ngroundYAt grid (rows x, columns z):`);
console.log(`        ${o.zs.map((z) => String(z).padStart(6)).join(' ')}`);
for (const row of o.grid) console.log(`  ${String(row.x).padStart(6)} ${row.y.map((y) => String(y).padStart(6)).join(' ')}`);
ws.close();

