/**
 * Scratch probe: where can the player stand and then not move at all?
 *
 * This is the "daldal" class of bug, and this file exists because the enclosure added new colliders
 * inside a room the player walks: a kerb whose box a legal standing pose already intersects leaves that
 * pose with every horizontal move refused, no face to slide along and no approach to have stopped them.
 * It cannot be found from a screenshot — the player looks fine and simply never moves again — and it was
 * found this way before, by a sweep that reported sixteen trapped poses hugging a wall.
 *
 * Nothing here is reimplemented: the two predicates are the controller's own, `groundYAt` is the floor
 * query the walker uses, and a pose counts as trapped only when it is intersecting *and* none of its
 * eight neighbours is free. Intersecting-but-escapable is a pose pressed against a wall, which is
 * normal, so the report separates the two rather than alarming on both.
 *
 * Usage: node tools/_hidstuck.mjs [portNeedle]
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
  const r = p.getRadius ? p.getRadius() : 0.35;
  const EYE = p.currentEyeHeight ? p.currentEyeHeight() : 1.7;
  const keep = p.position.clone();
  const near = (x, y, z) => {
    p.position.set(x, y, z);
    return p.collidesAabb(p.position, r) || p.collidesAabbAt(p.position, r);
  };
  const DIRS = [[1, 0], [0.7, 0.7], [0, 1], [-0.7, 0.7], [-1, 0], [-0.7, -0.7], [0, -1], [0.7, -0.7]];

  /**
   * name, x0, z0, x1, z1, step, lowest feet, highest feet.
   *
   * Feet are read off \`groundYAt\`, so a pose in mid-air is skipped instead of tested: the question is
   * only about poses someone can stand in, and the two bounds are what select the storey.
   */
  const REGIONS = [
    ['entry room + the strip behind it', 14.55, -1.95, 19.45, 3.65, 0.1, 2.34, 2.46],
    ['the hidden stair', 16.2, -1.1, 18.65, 0.2, 0.1, 0.14, 2.46],
    ['the hidden room', 15.75, -6.05, 21.45, 0.45, 0.1, 0.14, 0.26],
    ['rear wing: store, child, shrine', 14.55, -6.35, 21.45, -1.99, 0.1, 2.34, 2.46],
    // The four corridors the kerbs are meant to keep a walker out of *while still being walked past*:
    // the open floor either side of each kerb, off which the kerb has to be reachable-but-refusing.
    ['inside the flat, north of the north kerb', 15.8, 0.45, 18.5, 3.6, 0.1, 2.34, 2.46],
    ['inside the flat, by the west kerb', 15.8, -0.7, 18.5, 0.1, 0.1, 2.34, 2.46],
    ['the strip behind the flat, over the hole', 15.75, -1.9, 18.5, -1.05, 0.1, 2.34, 2.46],
    ['the store, north of the south kerb', 15.2, -3.6, 18.5, -2.1, 0.1, 2.34, 2.46],
  ];

  const stuck = [], pressed = [];
  let poses = 0;
  for (const [name, x0, z0, x1, z1, step, minF, maxF] of REGIONS) {
    // Seed the pose on the storey being swept before asking \`groundYAt\` anything: the query reads the
    // eye off the *current* position, so a sweep run while the player happens to be standing on the
    // other storey answers with the wrong floor for every point in it.
    p.position.set(x0, maxF + EYE, z0);
    for (let x = x0; x <= x1 + 1e-9; x += step) {
      for (let z = z0; z <= z1 + 1e-9; z += step) {
        const g = p.groundYAt(x, z);
        if (!isFinite(g) || g < minF || g > maxF) continue;
        const y = g + EYE;
        poses++;
        const inter = near(x, y, z);
        let escape = null;
        for (const [dx, dz] of DIRS) {
          // Half a metre, not one step: a pose 5 cm inside a wall is one the player cannot walk out of
          // frame by frame, but it is also one they could not have walked *into*, and asking whether a
          // half-metre move can get out separates that from a genuine pocket. A pocket has no exit at
          // any distance, which is the thing worth reporting.
          const nx = x + dx * 0.5, nz = z + dz * 0.5;
          // A neighbour on another storey is not a move: stepping up or down more than the controller's
          // own step-up is a fall, and "I could fall out of it" is not an escape from a trap.
          if (Math.abs(p.groundYAt(nx, nz) - g) > 0.34) continue;
          if (!near(nx, g + EYE, nz)) { escape = [+dx.toFixed(1), +dz.toFixed(1)]; break; }
        }
        if (!inter) continue;
        const rec = { region: name, x: +x.toFixed(2), z: +z.toFixed(2), feet: +g.toFixed(2), escape };
        (escape ? pressed : stuck).push(rec);
      }
    }
  }

  p.position.copy(keep);
  return JSON.stringify({
    radius: r, eye: +EYE.toFixed(2), poses, stuck: stuck.length, pressed: pressed.length,
    stuckSample: stuck.slice(0, 40), pressedSample: pressed.slice(0, 12),
  });
})()`;

const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
if (res.result?.exceptionDetails) {
  console.error('eval failed:', res.result.exceptionDetails.text, res.result.exceptionDetails.exception?.description ?? '');
  process.exit(1);
}
const o = JSON.parse(res.result.result.value);
console.log(`radius ${o.radius}  eye ${o.eye}  standing poses tested ${o.poses}`);
console.log(`TRAPPED ${o.stuck}   intersecting-but-can-step-out ${o.pressed}`);
for (const s of o.stuckSample) console.log(`  TRAP     ${s.region}  (${s.x}, ${s.z})  feet ${s.feet}`);
for (const s of o.pressedSample) {
  console.log(`  pressed  ${s.region}  (${s.x}, ${s.z})  feet ${s.feet}  out via ${JSON.stringify(s.escape)}`);
}
ws.close();