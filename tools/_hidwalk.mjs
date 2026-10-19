/**
 * Scratch probe for the hidden-room stairwell enclosure: can a walker still walk where it should, and is
 * it stopped where it should be stopped.
 *
 * `_hidcover.mjs` reports boxes and `groundYAt`; neither answers "would the player actually get through".
 * This walks short segments by calling the controller's own `collidesAabb` (the horizontal band test, the
 * one a walking move is refused by) and prints the first metre it refuses, so a kerb that fails to stop
 * anyone and a kerb that stops everyone both show up as a number.
 *
 * Usage: node tools/_hidwalk.mjs [portNeedle]
 *
 * Eye height, not feet: `FPController.position.y` is the eye, so a player standing on the flat's 2.4 is
 * at 4.1 and one standing in the room below is at 1.9.
 */
const [NEEDLE = '5174'] = process.argv.slice(2);
const PORT = process.env.CDP_PORT ?? '9222';

/** name, from, to. Each is a straight line the player has a reason to walk. */
const WALKS = [
  ['through the hidden door, west', [19.3, 4.1, -0.46], [17.9, 4.1, -0.46]],
  ['through the hidden door, east', [17.9, 4.1, -0.46], [19.3, 4.1, -0.46]],
  ['flat, south onto the well kerb', [17.0, 4.1, 0.9], [17.0, 4.1, -0.3]],
  ['flat, south onto the west kerb', [15.0, 4.1, 0.9], [15.0, 4.1, -0.3]],
  ['west strip, south into the store', [15.0, 4.1, 1.2], [15.0, 4.1, -2.6]],
  ['store, north onto the south kerb', [16.6, 4.1, -2.7], [16.6, 4.1, -1.4]],
  ['store, north through its 1.3 m doorway', [15.0, 4.1, -2.7], [15.0, 4.1, -1.4]],
  ['flat, east onto the west kerb', [14.9, 4.1, -1.5], [16.1, 4.1, -1.5]],
  ['stair, up the flight to the door', [16.6, 1.9, -0.5], [18.4, 4.1, -0.46]],
];

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
  const V = p.position.constructor;
  const r = p.getRadius ? p.getRadius() : 0.35;
  const keep = [p.position.x, p.position.y, p.position.z];
  const out = [];
  for (const [name, a, b] of ${JSON.stringify(WALKS)}) {
    const n = 60;
    let first = null;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = a[0] + (b[0] - a[0]) * t;
      const y = a[1] + (b[1] - a[1]) * t;
      const z = a[2] + (b[2] - a[2]) * t;
      // Both tests read p.position for the vertical band, so the sample has to become the player.
      p.position.set(x, y, z);
      if (p.collidesAabb(p.position, r) || p.collidesAabbAt(p.position, r)) {
        if (first === null) first = [x, y, z];
      }
    }
    out.push({ name, from: a, to: b, firstBlocked: first ? first.map((v) => Number(v.toFixed(2))) : null });
  }
  p.position.set(keep[0], keep[1], keep[2]);
  if (typeof p.syncCamera === 'function') p.syncCamera();
  return JSON.stringify({ radius: r, out, kept: keep.map((v) => Number(v.toFixed(2))) });
})()`;

const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
if (res.result?.exceptionDetails) {
  console.error('eval failed:', res.result.exceptionDetails.text, res.result.exceptionDetails.exception?.description ?? '');
  process.exit(1);
}
const o = JSON.parse(res.result.result.value);
console.log(`radius ${o.radius}`);
for (const w of o.out) {
  const f = w.firstBlocked;
  console.log(
    `${w.name.padEnd(38)} ${f ? `BLOCKED from (${f.join(', ')})` : 'clear'}   ` +
      `${JSON.stringify(w.from)} -> ${JSON.stringify(w.to)}`,
  );
}
ws.close();