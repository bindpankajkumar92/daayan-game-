/**
 * List every line-ish object in the scene, and any mesh whose geometry has degenerate triangles.
 *
 * Usage: node tools/probe-wireframe.mjs [portNeedle]
 *
 * Why: a bright triangle *outline* on a wall is not a hole — the inside is wall-coloured and only the
 * edges are white. That means something is drawing lines, or a mesh has a triangle whose vertices are
 * so close together (or so far apart) that it rasterises as a sliver. Both are found here by looking
 * at the scene rather than at a screenshot, which cannot say what drew it.
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
  const scene = (g.engine && g.engine.scene) || g.scene;
  if (!scene || !scene.traverse) return JSON.stringify({ error: 'no scene' });

  const lines = [];
  const helpers = [];
  let meshCount = 0;
  let wireframeMeshes = [];
  let degenerate = [];

  scene.traverse((o) => {
    if (!o.visible) return;
    let tag = '';
    let n = o;
    while (n) { if (n.name) tag = n.name + '/' + tag; n = n.parent; }

    if (o.isLine || o.isLineSegments || o.isLineLoop) {
      lines.push({ tag: tag.slice(-70), type: o.type });
      return;
    }
    if (o.type && /Helper/i.test(o.type)) {
      helpers.push({ tag: tag.slice(-70), type: o.type });
      return;
    }
    if (!o.isMesh || !o.geometry) return;
    meshCount++;

    const m = o.material;
    if (m && (m.wireframe === true)) wireframeMeshes.push({ tag: tag.slice(-70) });

    // Degenerate triangles: any triangle with near-zero area but non-zero extent, which rasterises as
    // a bright sliver. Counted per mesh so a suspect can be named rather than guessed at.
    const pos = o.geometry.attributes && o.geometry.attributes.position;
    if (!pos || pos.count < 3) return;
    let bad = 0;
    const step = pos.count > 20000 ? 3 : 1;   // sample big meshes rather than stall the frame
    for (let i = 0; i + 2 < pos.count; i += 3 * step) {
      const ax = pos.getX(i), ay = pos.getY(i), az = pos.getZ(i);
      const bx = pos.getX(i + 1), by = pos.getY(i + 1), bz = pos.getZ(i + 1);
      const cx = pos.getX(i + 2), cy = pos.getY(i + 2), cz = pos.getZ(i + 2);
      // Cross product magnitude is twice the area.
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const area2 = Math.hypot(nx, ny, nz);
      const span = Math.max(Math.abs(ux), Math.abs(uy), Math.abs(uz), Math.abs(vx), Math.abs(vy), Math.abs(vz));
      if (area2 < 1e-7 && span > 1e-4) bad++;
    }
    if (bad > 0) degenerate.push({ tag: tag.slice(-70), bad });
  });

  return JSON.stringify({
    meshCount,
    lineObjects: lines.slice(0, 12),
    lineCount: lines.length,
    helperObjects: helpers.slice(0, 12),
    helperCount: helpers.length,
    wireframeMeshes: wireframeMeshes.slice(0, 12),
    wireframeCount: wireframeMeshes.length,
    degenerateMeshes: degenerate.sort((a, b) => b.bad - a.bad).slice(0, 10),
    degenerateCount: degenerate.length,
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
console.log(`visible meshes: ${o.meshCount}`);
console.log(`line objects: ${o.lineCount}   helpers: ${o.helperCount}   wireframe materials: ${o.wireframeCount}`);
for (const l of o.lineObjects) console.log('   line  ', l.type, l.tag);
for (const h of o.helperObjects) console.log('   helper', h.type, h.tag);
for (const w of o.wireframeMeshes) console.log('   wire  ', w.tag);
console.log(`\nmeshes with degenerate triangles: ${o.degenerateCount}`);
for (const d of o.degenerateMeshes) console.log(`   ${String(d.bad).padStart(5)} bad  ${d.tag}`);
ws.close();
