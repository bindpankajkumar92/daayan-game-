/**
 * Reproduce a reported "quicksand" trap: the player sinks, cannot leave, and every step is fought.
 *
 * Usage: node tools/probe-quicksand.mjs <x> <z> <yaw> [portNeedle]
 *
 * Why: "stuck like quicksand" is a different fault from "stopped by a wall". A wall stops one axis
 * and the player slides along it. Quicksand means the player moves but does not *get* anywhere —
 * which happens when the floor under the feet keeps changing and the controller re-seats the player
 * every frame, so horizontal motion is cancelled by the ground snap. This distinguishes them:
 *   - it drives move() in small increments in every direction out of the spot
 *   - after each step it reports the feet height AND the net displacement
 *   - if the feet oscillate between two floor values while displacement collapses, it is the floor
 *     query alternating between two surfaces (a "lid" over a hole), not a wall.
 */
const [sx, sz, yawArg, NEEDLE = '5174'] = process.argv.slice(2);
if (sz === undefined) {
  console.error('usage: node tools/probe-quicksand.mjs <x> <z> <yaw> [portNeedle]');
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
  const eye = p.currentEyeHeight();
  const X0 = ${Number(sx)}, Z0 = ${Number(sz)}, YAW = ${Number(yawArg)};
  p.warpTo(new (p.position.constructor)(X0, 1.05 + eye, Z0), YAW);
  p.onGround = true;
  const DT = 1 / 60, speed = p.opts.walkSpeed;

  // The ground under this exact spot, and around it — a big spread with a small gap is the lid.
  const spread = [];
  for (const [x, z] of [[X0, Z0], [X0, Z0 - 0.2], [X0, Z0 + 0.2], [X0 - 0.3, Z0], [X0 + 0.3, Z0],
                        [X0, Z0 + 0.4], [X0, Z0 + 0.5], [X0, Z0 + 0.6]]) {
    spread.push({ at: [Number(x.toFixed(2)), Number(z.toFixed(2))],
      groundY: Number(p.groundYAt(x, z).toFixed(3)) });
  }

  // Try to escape in 8 directions. For each: total displacement, and how the feet height behaved.
  const runs = [];
  for (const deg of [0, 45, 90, 135, 180, 225, 270, 315]) {
    const ang = (deg * Math.PI) / 180;
    const ux = Math.sin(ang), uz = Math.cos(ang);
    p.warpTo(new (p.position.constructor)(X0, 1.05 + eye, Z0), YAW);
    p.onGround = true;
    const startX = p.position.x, startZ = p.position.z;
    const feetTrace = [];
    for (let i = 0; i < 60; i++) {
      const sinY = Math.sin(p.facing.y), cosY = Math.cos(p.facing.y);
      const strafe = ux * cosY - uz * sinY;
      const forward = -ux * sinY - uz * cosY;
      const mag = 0.05 / (speed * DT);
      p.move(strafe * mag, forward * mag, DT);
      if (i % 10 === 0) feetTrace.push(Number((p.position.y - eye).toFixed(3)));
    }
    const dist = Math.hypot(p.position.x - startX, p.position.z - startZ);
    // Did the feet bounce between two heights? That is the re-seat fight, not a wall.
    const uniq = [...new Set(feetTrace)];
    runs.push({ deg, travelled: Number(dist.toFixed(3)),
      endFeet: Number((p.position.y - eye).toFixed(3)),
      feetSamples: feetTrace, oscillates: uniq.length > 2 });
  }

  return JSON.stringify({ start: [X0, Z0], yaw: YAW, spread,
    groundNow: Number(p.groundYAt(X0, Z0).toFixed(3)),
    runs, aabbsAtSpot: (p.aabbs || []).filter((a) =>
      X0 + 0.35 > a.minX && X0 - 0.35 < a.maxX && Z0 + 0.35 > a.minZ && Z0 - 0.35 < a.maxZ)
      .map((a) => ({ x: [Number(a.minX.toFixed(2)), Number(a.maxX.toFixed(2))],
                     y: [Number(a.minY.toFixed(2)), Number(a.maxY.toFixed(2))],
                     z: [Number(a.minZ.toFixed(2)), Number(a.maxZ.toFixed(2))] })) });
})()`;

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
if (r.result?.exceptionDetails) {
  console.error('eval failed:', r.result.exceptionDetails.text, r.result.exceptionDetails.exception?.description ?? '');
  process.exit(1);
}
const o = JSON.parse(r.result.result.value);
console.log(`spot (${o.start[0]}, ${o.start[1]})  yaw ${o.yaw}  groundY here = ${o.groundNow}`);
console.log('\nground under and around the spot:');
for (const s of o.spread) console.log(`  z ${String(s.at[1]).padStart(6)}  ->  ${s.groundY}`);
console.log('\ncolliders overlapping the player cylinder here:');
for (const a of o.aabbsAtSpot) console.log('  x', a.x, ' y', a.y, ' z', a.z);
console.log('\nescape attempts (60 steps of 0.05 m each):');
for (const run of o.runs) {
  console.log(`  ${String(run.deg).padStart(3)}deg  travelled ${String(run.travelled).padStart(6)}  endFeet ${String(run.endFeet).padStart(5)}  feet ${JSON.stringify(run.feetSamples)}${run.oscillates ? '   <-- FEET OSCILLATE' : ''}`);
}
ws.close();
