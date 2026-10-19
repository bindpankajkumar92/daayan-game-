/**
 * Print an object's own local (pre-placement) box and the scale the fit applied.
 *
 * Usage: node tools/probe-fit.mjs <objectName> [port]
 *
 * `fitToBox` scales in *source* axes, so to choose `fit` numbers you need the file's own proportions
 * as rendered — not the normalised ratios a file-level bounds tool reports. Some assets carry rotated
 * wrapper matrices and a 14-primitive grouping, and their nominal ratios do not survive to the
 * rendered box. This reads the live object so the two agree by construction.
 */
const want = process.argv[2] ?? 'hidden-wardrobe.glb';
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
  const r3 = (v) => Math.round(v * 1000) / 1000;
  let g = null;
  window.__daayan.engine.scene.traverse((o) => { if (o.name === ${JSON.stringify(want)}) g = o; });
  if (!g) return JSON.stringify({ error: 'not found' });
  // Local box, before this object's own rotation/scale are baked in by a world matrix.
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  g.updateWorldMatrix(false, false);
  g.traverse((c) => {
    if (!c.geometry) return;
    const geo = c.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    for (const cx of [bb.min.x, bb.max.x])
      for (const cy of [bb.min.y, bb.max.y])
        for (const cz of [bb.min.z, bb.max.z]) {
          const p = new (c.position.constructor)(cx, cy, cz);
          c.localToWorld(p);
          min = [Math.min(min[0], p.x), Math.min(min[1], p.y), Math.min(min[2], p.z)];
          max = [Math.max(max[0], p.x), Math.max(max[1], p.y), Math.max(max[2], p.z)];
        }
  });
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  return JSON.stringify({
    name: g.name,
    rotation: [g.rotation.x, g.rotation.y, g.rotation.z].map(r3),
    scale: [g.scale.x, g.scale.y, g.scale.z].map(r3),
    worldSize: size.map(r3)
  });
})()`;

const out = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
if (out.result?.exceptionDetails) {
  console.error('eval failed:', out.result.exceptionDetails.text, out.result.exceptionDetails.exception?.description ?? '');
  process.exit(1);
}
const d = JSON.parse(out.result.result.value);
if (d.error) {
  console.error(d.error, '—', want);
  process.exit(1);
}
console.log(JSON.stringify(d, null, 2));
ws.close();
