/**
 * Open the hidden door, let the leaf swing, then walk from the nook through the doorway and down the
 * stair to the hidden room floor. End to end, in one command.
 *
 * Usage: node tools/probe-chain.mjs [portNeedle]
 *
 * Why this is the check that matters: the red key had no in-game pickup, so the door's prompt stayed
 * "Locked", the blocker box never dropped, and the player was pinned at x 19.11 — the blocker's face
 * plus the player radius. That is exactly the pose the player reported as stuck. Nothing short of
 * key -> door -> walk proves it fixed.
 *
 * TIMING IS THE WHOLE TRAP HERE, so it is spelled out rather than implied:
 *   `engine.clock` advances by the fixed timestep once per logic step. `GameLoop` clamps a frame to
 *   `maxFrameDt` (0.1 s) and runs at most 8 steps per frame, and a Chrome tab that is not being
 *   composited drives `requestAnimationFrame` at about 1 Hz. The result is game time running ~10x
 *   slower than wall time. The door's swing is `tween(1.6)` + `settle(0.5)` = 2.1 s of GAME time,
 *   which is ~21 real seconds. Waiting `setTimeout(3000)` burns 3 real seconds, i.e. about 0.3 s of
 *   simulation, leaves the leaf mid-swing, and then reports the door as stuck. So every wait in this
 *   file is expressed in game seconds, against `__daayan.clock()`, and the walk itself drives `move()`
 *   directly (no rAF at all) so the traversal is deterministic regardless of framerate.
 */
const [NEEDLE = '5174'] = process.argv.slice(2);
const PORT = process.env.CDP_PORT ?? '9222';
/** Per-increment travel. Under the player radius (0.35) so no step can tunnel a thin collider. */
const STEP = 0.05;
/** Game seconds to allow the leaf to swing and settle before walking: tween(1.6) + settle(0.5). */
const SETTLE_GAME_SECONDS = 2.4;

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
const evalJs = async (expression, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r.result?.exceptionDetails) {
    throw new Error(`${r.result.exceptionDetails.text} ${r.result.exceptionDetails.exception?.description ?? ''}`);
  }
  return r.result?.result?.value;
};

/**
 * The five-event pointer+touch sequence. A plain `.click()` does not fire the touch control —
 * HouseScene wires `setOnInteract()` to this button's `pointerdown`.
 */
const PRESS = `
  const press = () => {
    const b = document.getElementById('tc-btn-interact');
    const r = b.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2,
                clientY: r.top + r.height / 2, pointerId: 1, pointerType: 'touch', isPrimary: true };
    b.dispatchEvent(new PointerEvent('pointerdown', o));
    b.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true }));
    b.dispatchEvent(new PointerEvent('pointerup', o));
    b.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true }));
    b.dispatchEvent(new MouseEvent('click', o));
  };
  const wait = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  // Wait for N seconds of SIMULATION time. Never wall time, never a rAF count: see the header note.
  const waitGame = async (seconds) => {
    const from = g.clock();
    const deadline = Date.now() + 60000;
    while (g.clock() - from < seconds) {
      if (Date.now() > deadline) throw new Error('game clock stalled: ' + (g.clock() - from).toFixed(2) + 's of ' + seconds);
      await wait();
    }
    return g.clock() - from;
  };
`;

// 1. Take the red key off the gurney, if it is still there. Posed at the pillow, pitched down.
const got = await evalJs(`(async () => {
  const g = window.__daayan, p = g.player;
  ${PRESS}
  p.warpTo(new (p.position.constructor)(-17.4, -3 + p.currentEyeHeight(), 6.9), 3.1416);
  p.addLookDelta(0, -(0.35 - p.facing.x));
  await wait();
  const won = g.interactables().current;
  const label = g.interactables().nearest && g.interactables().nearest.label;
  if (won !== 'blackmagic.red-key') return JSON.stringify({ took: false, won, label,
    note: label === null ? 'label is null — the key is already held' : 'not offered' });
  press();
  await wait();
  return JSON.stringify({ took: true, via: 'tc-btn-interact' });
})()`, true);
console.log('1. red key :', got);

// 2. Open the hidden door from the nook side. Report the prompt before and after so "Locked" vs
// "Turn the red key" is on the record.
const opened = await evalJs(`(async () => {
  const g = window.__daayan, p = g.player;
  ${PRESS}
  p.warpTo(new (p.position.constructor)(19.6, 2.4 + p.currentEyeHeight(), -0.46), Math.PI / 2);
  await wait();
  const near = g.interactables().nearest;
  const before = near ? { id: near.id, dist: Number(near.dist.toFixed(3)), facing: Number(near.facing.toFixed(3)), label: near.label } : null;
  const clockBefore = g.clock();
  press();
  // Wait out the swing in GAME time, not wall time.
  const advanced = await waitGame(${SETTLE_GAME_SECONDS});
  const lines = (document.body.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
  return JSON.stringify({ promptBefore: before, gameSecondsWaited: Number(advanced.toFixed(2)),
    gameClock: [Number(clockBefore.toFixed(2)), Number(g.clock().toFixed(2))],
    toast: lines.filter((s) => /key turns|wall opens/i.test(s)) });
})()`, true);
console.log('2. door    :', opened);

// 3. Walk from the nook, through the doorway, down the stair. One evaluation, fixed increments, no
// frame boundary in the middle — the controller re-seats its own groundY as it descends.
const walked = await evalJs(`(() => {
  const p = window.__daayan.player;
  const eye = p.currentEyeHeight();
  const X0 = 19.6, Z0 = -0.46, X1 = 16.2, Z1 = -0.46, N = 260;
  p.warpTo(new (p.position.constructor)(X0, 2.4 + eye, Z0), Math.PI / 2);
  p.onGround = true;
  const DT = 1 / 60, speed = p.opts.walkSpeed;
  const dx = (X1 - X0) / N, dz = (Z1 - Z0) / N;
  let stuck = null, prevX = X0, prevZ = Z0;
  const marks = [];
  for (let i = 1; i <= N; i++) {
    const tx = X0 + dx * i, tz = Z0 + dz * i;
    // Aim at the next waypoint, but never travel more than STEP in one frame, so a thin collider
    // cannot be tunnelled and the "stuck" reading is the wall itself rather than the increment.
    const len = Math.hypot(tx - p.position.x, tz - p.position.z) || 1;
    const ux = (tx - p.position.x) / len, uz = (tz - p.position.z) / len;
    const adv = Math.min(${STEP}, len);
    // move(strafe, forward, dt) is FACING-relative AND speed-scaled, so divide by (speed * dt) to
    // travel a fixed world increment. Passing the increment directly moves ~0.002 m and reads as
    // "instantly stuck".
    const sinY = Math.sin(p.facing.y), cosY = Math.cos(p.facing.y);
    const strafe = ux * cosY - uz * sinY;
    const forward = -ux * sinY - uz * cosY;
    const mag = adv / (speed * DT);
    p.move(strafe * mag, forward * mag, DT);
    const moved = Math.hypot(p.position.x - prevX, p.position.z - prevZ);
    prevX = p.position.x; prevZ = p.position.z;
    // Mark each time the feet drop more than a fifth of a storey step, so the descent shows.
    if (marks.length === 0 || Math.abs(p.position.y - marks[marks.length - 1][1]) > 0.2) {
      marks.push([Number(p.position.x.toFixed(2)), Number(p.position.y.toFixed(2))]);
    }
    if (moved < 0.002 && stuck === null) {
      stuck = [Number(p.position.x.toFixed(3)), Number(p.position.y.toFixed(3)), Number(p.position.z.toFixed(3))];
    }
  }
  return JSON.stringify({ feetY: Number((p.position.y - eye).toFixed(3)),
    finalX: Number(p.position.x.toFixed(2)), finalZ: Number(p.position.z.toFixed(2)),
    eye, stuck, descent: marks });
})()`);
console.log('3. walk    :', walked);

const o = JSON.parse(walked);
if (o.stuck) console.log(`\nSTILL BLOCKED at ${JSON.stringify(o.stuck)}`);
else console.log(`\nCLEAR — walked through the door and down to x ${o.finalX}, feet at y ${o.feetY}`);
ws.close();
