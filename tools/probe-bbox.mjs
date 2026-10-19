/**
 * Print the world-space bounding box of every object matching a regex.
 *
 * Usage: node tools/probe-bbox.mjs <regex> [port]
 *
 * The placement numbers in ModelProps are origins, and an origin says nothing about where the art
 * ends up once `pitch`/`yaw` have been applied and the box has been centred — a figure laid down by
 * a -pi/2 pitch swings its origin half its length off the floor. This reports the box, which is what
 * has to sit on the boards.
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

// Box3.setFromObject needs the module; the page already has three loaded, so reach it through a
// live mesh's own constructor chain rather than importing.
const expr = `(() => {
  const pat = new RegExp(${JSON.stringify(pattern)}, 'i');
  const scene = window.__daayan.engine.scene;
  const out = [];
  const r3 = (v) => Math.round(v * 1000) / 1000;
  scene.traverse((o) => {
    if (!o.name || !pat.test(o.name) || !o.isObject3D) return;
    // Only report leaves of the match: a Group and its child both matching doubles every line.
    let hasMatchingChild = false;
    o.traverse((c) => { if (c !== o && c.name && pat.test(c.name)) hasMatchingChild = true; });
    if (hasMatchingChild) return;
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    let found = false;
    o.updateWorldMatrix(true, true);
    o.traverse((c) => {
      if (!c.geometry) return;
      found = true;
      const g = c.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox;
      const corners = [];
      for (const cx of [bb.min.x, bb.max.x]) {
        for (const cy of [bb.min.y, bb.max.y]) {
          for (const cz of [bb.min.z, bb.max.z]) {
            const p = new (c.position.constructor)(cx, cy, cz);
            c.localToWorld(p);
            corners.push(p);
          }
        }
      }
      for (const p of corners) {
        min = [Math.min(min[0], p.x), Math.min(min[1], p.y), Math.min(min[2], p.z)];
        max = [Math.max(max[0], p.x), Math.max(max[1], p.y), Math.max(max[2], p.z)];
      }
    });
    if (!found) return;
    out.push({ name: o.name, type: o.type, min: min.map(r3), max: max.map(r3),
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]].map(r3) });
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
  process.exit(0);
}
for (const r of rows) {
  console.log(`${r.name}  [${r.type}]`);
  console.log(`   y ${String(r.min[1]).padStart(7)} .. ${String(r.max[1]).padStart(7)}   (height ${r.size[1]})`);
  console.log(`   x ${String(r.min[0]).padStart(7)} .. ${String(r.max[0]).padStart(7)}   (width  ${r.size[0]})`);
  console.log(`   z ${String(r.min[2]).padStart(7)} .. ${String(r.max[2]).padStart(7)}   (depth  ${r.size[2]})`);
}
ws.close();
