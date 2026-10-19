/**
 * Report the height profile of a stair MODEL, sampled from its actual vertices, beside the walkable
 * tread heights the player walks on.
 *
 * Usage: node tools/probe-stairmodel.mjs <x0> <x1> <z> <feetY> [steps] [portNeedle]
 *
 * Why: a stair in this house is two independently-authored things that must agree — `groundYAt()`
 * (analytic rectangles the controller snaps to) and an imported `.glb` scaled into the well. If the
 * model's high end is at the opposite end to the treads' high end, the player walks *down* a surface
 * drawn going *up*. Neither half is broken alone, the walk probe passes (it only tests the rects), and
 * the only symptom is what the player sees — reported as "the stair is the wrong way round".
 *
 * So this measures both sides of that contract at once:
 *   walkY — `groundYAt(x, z)`, the surface the feet follow
 *   topY  — the highest world-space vertex of the stair model within a small x window at that z
 *
 * Then it states which way each one rises, which is the thing that has to match.
 */
const [x0, x1, z, feetY, steps = '9', NEEDLE = '5174'] = process.argv.slice(2);
if (NEEDLE === undefined || feetY === undefined) {
  console.error('usage: node tools/probe-stairmodel.mjs <x0> <x1> <z> <feetY> [steps] [portNeedle]');
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
  const g = window.__daayan, p = g.player;
  const scene = (g.engine && g.engine.scene) || g.scene;
  if (!scene || !scene.traverse) return JSON.stringify({ error: 'no scene found' });
  const V = p.position.constructor;
  const X0 = ${Number(x0)}, X1 = ${Number(x1)}, Z = ${Number(z)}, N = ${Number(steps)};

  // Collect the stair model's meshes. Match on the object's ancestry name so a clone and the original
  // are both caught regardless of which id the loader gave them.
  const meshes = [];
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    let n = o, tag = '';
    while (n) { if (n.name) tag += '/' + n.name; n = n.parent; }
    if (/stair/i.test(tag)) meshes.push({ o, tag });
  });

  // Bucket every transformed vertex by x, keeping the highest y seen in each bucket at this z.
  const NB = N;
  const top = new Array(NB).fill(-Infinity);
  const count = new Array(NB).fill(0);
  const v = new V();
  let totalVerts = 0;
  for (const { o } of meshes) {
    const pos = o.geometry.attributes && o.geometry.attributes.position;
    if (!pos) continue;
    o.updateWorldMatrix(true, false);
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(o.matrixWorld);
      // Only vertices near the probe line, so the profile is of this flight and not the whole file.
      if (Math.abs(v.z - Z) > 0.35) continue;
      if (v.x < X0 - 0.05 || v.x > X1 + 0.05) continue;
      const b = Math.min(NB - 1, Math.max(0, Math.round(((v.x - X0) / (X1 - X0)) * (NB - 1))));
      if (v.y > top[b]) top[b] = v.y;
      count[b]++;
      totalVerts++;
    }
  }

  const rows = [];
  for (let i = 0; i < NB; i++) {
    const x = X0 + ((X1 - X0) * i) / (NB - 1);
    rows.push({
      x: Number(x.toFixed(2)),
      walkY: Number(p.groundYAt(x, Z).toFixed(3)),
      topY: count[i] ? Number(top[i].toFixed(3)) : null,
    });
  }
  // Which way does each rise? Compare the first third against the last third.
  const third = Math.max(1, Math.floor(NB / 3));
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
  const walkFirst = avg(rows.slice(0, third).map((r) => r.walkY));
  const walkLast = avg(rows.slice(-third).map((r) => r.walkY));
  const modelRows = rows.filter((r) => r.topY !== null);
  const mFirst = avg(modelRows.slice(0, Math.max(1, Math.floor(modelRows.length / 3))).map((r) => r.topY));
  const mLast = avg(modelRows.slice(-Math.max(1, Math.floor(modelRows.length / 3))).map((r) => r.topY));
  return JSON.stringify({
    meshCount: meshes.length, vertsNearLine: totalVerts,
    names: meshes.slice(0, 6).map((m) => m.tag.slice(-60)),
    rows,
    walkRisesToward: walkFirst > walkLast ? 'x0' : 'x1',
    modelRisesToward: modelRows.length < 2 ? 'unknown' : (mFirst > mLast ? 'x0' : 'x1'),
  });
})()`;

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
if (r.result?.exceptionDetails) {
  console.error('eval failed:', r.result.exceptionDetails.text, r.result.exceptionDetails.exception?.description ?? '');
  process.exit(1);
}
const o = JSON.parse(r.result.result.value);
if (o.error) {
  console.error(o.error);
  process.exit(1);
}
console.log(`stair meshes: ${o.meshCount}   vertices near the probe line: ${o.vertsNearLine}`);
if (o.names) for (const n of o.names) console.log('   ', n);
console.log('\n   x     walkY (treads)   topY (model)');
for (const row of o.rows) {
  const t = row.topY === null ? '   -  ' : String(row.topY).padStart(6);
  console.log(`  ${String(row.x).padStart(5)}   ${String(row.walkY).padStart(8)}   ${t}`);
}
console.log(`\nwalkable treads rise toward : ${o.walkRisesToward}`);
console.log(`the model rises toward      : ${o.modelRisesToward}`);
console.log(o.walkRisesToward === o.modelRisesToward
  ? 'IN SYNC — the model climbs the same way the player walks.'
  : 'MISMATCH — the model is flipped against its own treads.');
ws.close();
