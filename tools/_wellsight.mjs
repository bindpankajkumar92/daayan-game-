/**
 * Can the hidden stairwell be seen from this stance? One ray per named surface inside the well.
 *
 * `_hidview.mjs` answers "what fills the frame", but it answers in screen cells, and a 9x7 grid is 11
 * degrees apart — wide enough for a whole sightline to pass between two cells with "nothing" reported
 * either side of it. The report this exists for is narrower than that: standing *here*, is any of the
 * flight or the room below on screen at all. So the sample points are the well's own surfaces (every
 * tread, the room floor inside the shaft, both long walls' inner faces) and a point counts as seen
 * only when the game's own `look()` comes back with a hit *on that point*.
 *
 * Usage:
 *   node tools/_wellsight.mjs <needle> <x> <eyeY> <z> <hudYaw>
 *
 * `hudYaw` is the readout's own `yaw(...)`. The aim is derived, not assumed: `look()` takes the
 * controller's Euler yaw, which is the HUD angle rotated by pi, and the sign of that relation has been
 * got wrong before, so the tool calibrates it in the page — three aims at known Euler angles, then the
 * horizontal and vertical rate between them — instead of restating a convention in a second place.
 *
 * The one way this tool can lie is stated at the end of every run: `look()` casts from
 * `camera.position + 0.5 * dir` to clear the camera's own children, so an occluder nearer than half a
 * metre to the eye is behind the ray's own origin and invisible to every row. A stance pressed against
 * the surface it is testing cannot answer for that surface, and the run says so rather than reporting
 * the geometry behind it as a sighting.
 *
 * `CDP_PORT` / `CDP_MATCH` match the other tools.
 */
const [NEEDLE = '5174', X = '14.91', EYE_Y = '4.1', Z = '0.46', HY = '1.67'] = process.argv.slice(2);
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
  if (!p) return 'no player';
  const keep = { x: p.position.x, y: p.position.y, z: p.position.z, fy: p.facing.y, fx: p.facing.x };
  const eyeX = ${Number(X)}, eyeY = ${Number(EYE_Y)}, eyeZ = ${Number(Z)};
  p.position.set(eyeX, eyeY, eyeZ);
  // A Vector3 without importing three: the camera's own position is one.
  const v = new cam.position.constructor();
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const hor = (q) => Math.atan2(q.x, q.z);
  const ele = (q) => Math.asin(Math.max(-1, Math.min(1, q.y / q.length())));
  const calib = (yaw, pitch) => { p.look(yaw, pitch); cam.getWorldDirection(v); return { h: hor(v), e: ele(v) }; };
  const c00 = calib(0, 0), c10 = calib(1, 0), c01 = calib(0, 1);
  const sh = wrap(c10.h - c00.h) || 1;
  const se = wrap(c01.e - c00.e) || 1;
  const aim = (dx, dy, dz) => {
    const th = Math.atan2(dx, dz);
    const ph = Math.asin(dy / Math.sqrt(dx * dx + dy * dy + dz * dz));
    return { yaw: wrap(th - c00.h) / sh, pitch: (ph - c00.e) / se };
  };
  // The well's own contents, from HouseRooms: treads at x1 = UP_HIDDEN_DOOR.x - 0.3i, top UP_Y - 0.275(i+1).
  const s = [];
  for (let i = 0; i < 8; i++) {
    s.push({ n: 'tread' + i, x: 18.61 - 0.3 * i - 0.15, y: 2.4 - 0.275 * (i + 1) + 0.02, z: -0.46 });
  }
  s.push({ n: 'room floor W', x: 16.6, y: 0.21, z: -0.46 });
  s.push({ n: 'room floor E', x: 18.3, y: 0.21, z: -0.46 });
  s.push({ n: 'parapet inner', x: 17.4, y: 2.6, z: 0.14 });
  s.push({ n: 'cheek inner', x: 17.4, y: 2.6, z: -1.06 });
  const at = (k) => {
    const m = /at\\(([^)]*)\\)/.exec(k);
    return m ? m[1].split(',').map(Number) : null;
  };
  const out = [];
  for (const q of s) {
    const dx = q.x - eyeX, dy = q.y - eyeY, dz = q.z - eyeZ;
    const a = aim(dx, dy, dz);
    p.look(a.yaw, a.pitch);
    const raw = String(d.look());
    const h = at(raw);
    const hit = h ? [h[0], h[1], h[2]] : null;
    const sd = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const hd = hit ? Math.hypot(hit[0] - eyeX, hit[1] - eyeY, hit[2] - eyeZ) : null;
    out.push({
      n: q.n,
      gap: hit ? +Math.hypot(hit[0] - q.x, hit[1] - q.y, hit[2] - q.z).toFixed(3) : null,
      d: hd === null ? null : +hd.toFixed(2),
      sd: +sd.toFixed(2),
      chain: raw.replace(/^chain=/, '').split(' at ')[0].slice(0, 78),
    });
  }
  p.position.set(keep.x, keep.y, keep.z);
  p.look(keep.fy, keep.fx);
  return JSON.stringify({ calib: [+sh.toFixed(3), +se.toFixed(3)], out });
})()`;

const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
if (res.result?.exceptionDetails) {
  console.error('eval failed:', res.result.exceptionDetails.text, res.result.exceptionDetails.exception?.description ?? '');
  process.exit(1);
}
const o = JSON.parse(res.result.result.value);
console.log(`aim calibration: yaw rate ${o.calib[0]}, pitch rate ${o.calib[1]}  (1/1 means the Euler is the HUD angle rotated by pi)`);
/**
 * Three verdicts, not two, because two were hiding a judgement call.
 *
 * A tread sample names a rect from `hiddenStairFloors`, and the rect is not the surface: the flight that
 * is drawn is a fitted .glb, and its own fit error against those rects measures 0.16 .. 0.20 m (treads 0-4
 * from the reported stance). So a hit within 0.25 of the intended point is the surface, or the model fitted
 * to it, and counts as **SEEN**. Beyond that the ray came back near the point but *on something else* —
 * `graze` — which is not a sighting, and calling it one is how a 0.297 m near-miss on the room's own mesh
 * read as a leak from north of the parapet until it was printed separately. Past 0.75 it is simply hidden.
 *
 * A chain naming the flight is a sighting whatever the gap says: that is the model itself coming back.
 */
const onFlight = (chain) => /wood_stairs|hidden-stair/i.test(chain);
let seen = 0;
let graze = 0;
let near = null;
for (const q of o.out) {
  const fight = onFlight(q.chain);
  const verdict = fight || (q.gap !== null && q.gap <= 0.25) ? 'SEEN  ' : q.gap !== null && q.gap <= 0.75 ? 'graze ' : 'hidden';
  if (verdict === 'SEEN  ') seen++;
  if (verdict === 'graze ') graze++;
  if (q.d !== null && (near === null || q.d < near)) near = q.d;
  console.log(
    `  ${q.n.padEnd(13)} ${verdict} gap ${String(q.gap).padStart(6)}  hit at ${String(q.d).padStart(4)} m of ${String(q.sd).padStart(4)} m  ${q.chain}`,
  );
}
const tail = graze ? ` (+${graze} graze${graze > 1 ? 's' : ''}, which are not sightings)` : '';
console.log(`\n${seen}/${o.out.length} sample point(s) inside the well visible from (${X}, ${EYE_Y}, ${Z}) at HUD yaw ${HY}${tail}`);
/**
 * And the one way this tool can lie, said out loud.
 *
 * `look()` casts from `camera.position + 0.5 * dir` — an offset that clears the lantern, the arm and the
 * fist, which are children of the camera. So an occluder nearer than 0.5 m to the eye is *behind the ray's
 * own origin*: it is invisible to every row, and the row reports the geometry beyond it as though the
 * occluder were not there. That is how a stance pressed against the head read as a sighting of the room
 * below, and how a wall that already met its corner got lengthened for it.
 *
 * A stance cannot be declared blind from the sample distances — the well's surfaces are 2..5 m from any
 * stance that can see them. What can be said is when a row's own first hit lands within a whisker of the
 * offset: that means the ray is finding its first surface immediately after starting, and something nearer
 * may have been skipped. So the flag is a "check this stance" and not a verdict, and the honest rule for a
 * surface within half a metre of the eye is not to probe it — reason about it, or move back.
 */
if (near !== null && near < 0.6) {
  console.log(
    `\n  CAUTION  a row's first hit is at ${near} m, barely past the 0.5 m offset look() starts its ray at.` +
      `\n           If this stance is inside half a metre of a wall, that wall is invisible to these rays and` +
      `\n           rows that look like leaks may be the geometry behind it. Re-run from further back.`,
  );
}
ws.close();
