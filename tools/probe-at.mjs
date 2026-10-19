/**
 * List every mesh whose world bounding box contains a point, with its name and material colour.
 *
 * Usage: node tools/probe-at.mjs <x> <y> <z> [portNeedle]
 *
 * Why: a bare grey patch on a wooden floor is a surface whose material does not match its neighbours,
 * and a screenshot cannot say which mesh it is. Asking the scene "what is at this point" names the
 * object outright — including the ones drawn by a code path nobody would think to suspect.
 *
 * Reports the material's name, its base colour and whether it carries a map, since "grey" is usually
 * a colour multiplier over the same wood texture rather than a different texture entirely.
 */
const [x, y, z, NEEDLE = '5174'] = process.argv.slice(2);
if (z === undefined) {
  console.error('usage: node tools/probe-at.mjs <x> <y> <z> [portNeedle]');
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
  const g = window.__daayan;
  const scene = (g.engine && g.engine.scene) || g.scene;
  if (!scene || !scene.traverse) return JSON.stringify({ error: 'no scene' });
  const P = [${Number(x)}, ${Number(y)}, ${Number(z)}];
  const hits = [];
  const v = new (g.player.position.constructor)();

  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.visible) return;
    const pos = o.geometry.attributes && o.geometry.attributes.position;
    if (!pos) return;
    o.updateWorldMatrix(true, false);
    // World-space AABB straight off the vertices, so nothing has to be constructed per frame.
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const step = pos.count > 4000 ? 4 : 1;
    for (let i = 0; i < pos.count; i += step) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(o.matrixWorld);
      if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
      if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
      if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
    }
    if (P[0] < minX || P[0] > maxX || P[1] < minY || P[1] > maxY || P[2] < minZ || P[2] > maxZ) return;

    let n = o, tag = '';
    while (n) { if (n.name) tag = n.name + '/' + tag; n = n.parent; }
    const m = o.material;
    const col = m && m.color ? '#' + m.color.getHexString() : 'n/a';
    hits.push({
      tag: tag.slice(-72),
      mat: m ? m.name || m.type : 'none',
      color: col,
      hasMap: !!(m && m.map),
      y: [Number(minY.toFixed(3)), Number(maxY.toFixed(3))],
      x: [Number(minX.toFixed(2)), Number(maxX.toFixed(2))],
      z: [Number(minZ.toFixed(2)), Number(maxZ.toFixed(2))],
    });
  });
  return JSON.stringify({ point: P, count: hits.length, hits: hits.slice(0, 14) });
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
console.log(`meshes containing (${o.point.join(', ')}): ${o.count}`);
for (const h of o.hits) {
  console.log(`\n  ${h.tag}`);
  console.log(`     mat ${h.mat}  color ${h.color}  map ${h.hasMap ? 'yes' : 'no'}`);
  console.log(`     x ${h.x}  y ${h.y}  z ${h.z}`);
}
ws.close();
