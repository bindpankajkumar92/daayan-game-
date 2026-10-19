/**
 * Find see-through gaps: cast a fan of rays from the player's eye and report where they escape.
 *
 * Usage: node tools/probe-gap.mjs <x> <feetY> <z> <yaw> [portNeedle]
 *
 * Why: "there is a gap between the stair and the door" is a claim about *line of sight*, and neither a
 * screenshot nor a collider dump answers it directly. A collider list says where solids are; a ray fan
 * says where the eye can see past them. The two disagree exactly at the seams a player notices — an
 * uncovered riser, a floor patch that stops short of a wall, a hole between two slabs — because those
 * are gaps in the *drawn* surface, not in the collision model.
 *
 * Rays are cast on a vertical fan (up/down) and a horizontal fan (left/right), and each is reported
 * with the distance to the first hit. A ray that reaches its maximum length hit nothing at all, which
 * from inside an enclosed room means it escaped through a hole.
 */
const [x, feetY, z, yaw, NEEDLE = '5174'] = process.argv.slice(2);
if (NEEDLE === undefined || yaw === undefined) {
  console.error('usage: node tools/probe-gap.mjs <x> <feetY> <z> <yaw> [portNeedle]');
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
  if (!scene || !scene.traverse) return JSON.stringify({ error: 'no scene' });

  // Raycaster is not reachable from the scene graph, so it has to be found on the page. The game
  // exposes no THREE namespace of its own, so this asks for a global one and reports clearly if the
  // build did not publish it rather than failing with a confusing undefined error later.
  const THREE = window.THREE || (g.engine && g.engine.THREE);
  if (!THREE || !THREE.Raycaster) {
    return JSON.stringify({ error: 'no THREE.Raycaster reachable from the page' });
  }

  const eye = new THREE.Vector3(${Number(x)}, ${Number(feetY)} + p.currentEyeHeight(), ${Number(z)});
  const rc = new THREE.Raycaster();
  rc.far = 40;

  const cast = (dirX, dirY, dirZ) => {
    const d = new THREE.Vector3(dirX, dirY, dirZ).normalize();
    rc.set(eye, d);
    const hits = rc.intersectObjects(scene.children, true);
    // Ignore the player's own hand/held prop and any helper lines.
    for (const h of hits) {
      if (!h.object || !h.object.visible) continue;
      let n = h.object, tag = '';
      while (n) { if (n.name) tag += '/' + n.name; n = n.parent; }
      if (/hand|fist|arm|lantern|torch|helper|line/i.test(tag)) continue;
      return { dist: Number(h.distance.toFixed(3)), what: tag.slice(-46) };
    }
    return null;
  };

  const YAW = ${Number(yaw)};
  const fx = -Math.sin(YAW), fz = -Math.cos(YAW);
  const rx = Math.cos(YAW), rz = -Math.sin(YAW);

  const vertical = [];
  for (let deg = 60; deg >= -60; deg -= 10) {
    const r = (deg * Math.PI) / 180;
    const up = Math.sin(r), fwd = Math.cos(r);
    const hit = cast(fx * fwd, up, fz * fwd);
    vertical.push({ deg, hit: hit ? hit.dist : null, what: hit ? hit.what : 'NOTHING' });
  }
  const horizontal = [];
  for (let deg = -60; deg <= 60; deg += 15) {
    const r = (deg * Math.PI) / 180;
    const s = Math.sin(r), c = Math.cos(r);
    const hit = cast(fx * c + rx * s, 0, fz * c + rz * s);
    horizontal.push({ deg, hit: hit ? hit.dist : null, what: hit ? hit.what : 'NOTHING' });
  }
  return JSON.stringify({ eye: [Number(x), Number(feetY), Number(z)], yaw: YAW, vertical, horizontal });
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
console.log(`eye at (${o.eye.join(', ')})  yaw ${o.yaw}`);
console.log('\nvertical fan (pitch, degrees above horizontal):');
for (const v of o.vertical) {
  const d = v.hit === null ? '  no hit  ' : String(v.hit).padStart(8);
  console.log(`  ${String(v.deg).padStart(4)}deg  ${d}   ${v.what}`);
}
console.log('\nhorizontal fan:');
for (const h of o.horizontal) {
  const d = h.hit === null ? '  no hit  ' : String(h.hit).padStart(8);
  console.log(`  ${String(h.deg).padStart(4)}deg  ${d}   ${h.what}`);
}
ws.close();
