/**
 * What escapes at the well's north-west corner, and from which eye.
 *
 * `_wellsight` reports "seen" or "hidden" per surface and truncates the chain, which is not enough to tell a
 * sighting *through the well's mouth* from one *over the head's top edge*: both come back as a hit on the
 * flight, and only the hit's own coordinates say which. This prints the whole `look()` string and the eye it
 * was cast from, for the pressed stance's first four tread rays, so the corner can be argued from numbers.
 *
 * **The default eye is the landing (14.91), not the pressed stance (15.76) it started as.** `look()` casts
 * from `camera.position + 0.5 * dir`, an offset that clears the camera's own children — the lantern, the arm,
 * the fist — and the head's face is 0.35 m from the pressed stance: from there the ray starts 0.15 m *past*
 * the wall, so every row was reporting the geometry behind it. That is how this tool once argued a wall into
 * existence that already met its corner; the closing paragraph of the head's own doc in `HouseRooms` records
 * it. A stance inside 0.55 m of the plane now gets a warning line instead of a reading, and the rows print
 * each ray's crossing of the head's plane so the reader can see where a shadowed row would land.
 *
 * Usage: node tools/_wellcorner.mjs [needle] [x] [eyeY] [z]
 */
const [NEEDLE = '5174', X = '14.91', EYE_Y = '4.1', Z = '0.46'] = process.argv.slice(2);
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
  const d = window.__daayan, p = d.player, cam = d.engine.camera;
  const v = new cam.position.constructor();
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const hor = (q) => Math.atan2(q.x, q.z);
  const ele = (q) => Math.asin(Math.max(-1, Math.min(1, q.y / q.length())));
  const calib = (yaw, pitch) => { p.look(yaw, pitch); cam.getWorldDirection(v); return { h: hor(v), e: ele(v) }; };
  const c00 = calib(0, 0), c10 = calib(1, 0), c01 = calib(0, 1);
  const sh = wrap(c10.h - c00.h) || 1, se = wrap(c01.e - c00.e) || 1;
  const eyeX = ${Number(X)}, eyeY = ${Number(EYE_Y)}, eyeZ = ${Number(Z)};
  const at = (k) => { const m = /at\\(([^)]*)\\)/.exec(k); return m ? m[1] : '?'; };
  const out = [];
  for (let i = 0; i < 4; i++) {
    const t = { x: 18.61 - 0.3 * i - 0.15, y: 2.4 - 0.275 * (i + 1) + 0.02, z: -0.46 };
    const dx = t.x - eyeX, dy = t.y - eyeY, dz = t.z - eyeZ;
    const th = Math.atan2(dx, dz);
    const ph = Math.asin(dy / Math.sqrt(dx * dx + dy * dy + dz * dz));
    p.position.set(eyeX, eyeY, eyeZ);
    p.look(wrap(th - c00.h) / sh, (ph - c00.e) / se);
    const camNow = cam.position.toArray().map((n) => +n.toFixed(3));
    // Where this ray crosses the head's own plane, which is the number the corner argument turns on.
    const s = (16.11 - camNow[0]) / dx;
    const cross = [16.11, +(camNow[1] + s * dy).toFixed(3), +(camNow[2] + s * dz).toFixed(3)];
    const raw = String(d.look());
    out.push({ tread: i, target: [+t.x.toFixed(2), +t.y.toFixed(2), +t.z.toFixed(2)], cam: camNow, cross, hit: at(raw), chain: raw.replace(/^chain=/, '').split(' at ')[0].slice(0, 60) });
  }
  p.position.set(14.91, 4.1, 0.46);
  return JSON.stringify(out);
})()`;

const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
if (res.result?.exceptionDetails) {
  console.error('eval failed:', res.result.exceptionDetails.text, res.result.exceptionDetails.exception?.description ?? '');
  process.exit(1);
}
const rows = JSON.parse(res.result.result.value);
const clearance = 16.11 - Number(X);
console.log(`eye (${X}, ${EYE_Y}, ${Z}) — head plane at x 16.11, drawn z -1.28..0.36, y 2.4..4.1`);
if (clearance < 0.55) {
  console.log(
    `\n  WARNING  this eye is ${clearance.toFixed(2)} m from the plane, inside the 0.5 m offset ` +
      `look() starts its ray at.\n           Every row below is the geometry BEHIND the head, not through it. ` +
      `Move back to 14.91 or further.`,
  );
}
for (const r of rows) {
  console.log(
    `\ntread${r.tread} at (${r.target.join(', ')})` +
      `\n    camera (${r.cam.join(', ')})   crosses x 16.11 at (${r.cross.join(', ')})` +
      `\n    hit at (${r.hit})   ${r.chain}`,
  );
}
ws.close();
