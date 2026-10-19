/**
 * Pose the player, confirm the interaction system picks a given id, then press it — atomically.
 *
 * Usage: node tools/probe-use.mjs <x> <y> <z> <yaw> <pitch> <expectId> [port]
 *
 * Why this exists: `lookshot.mjs` sets the pose, but the interaction system re-picks its candidate
 * every frame from the *live* camera. Two separate tool invocations leave one or more frames in
 * between, and if anything moves the camera in that gap the candidate is gone by the time the press
 * lands — which reads as "the button does nothing" even though both halves work.
 *
 * This does all of it in one CDP evaluation, in one frame's worth of work: set the pose, read back
 * what the system would offer, and fire `use()` only if it matches. It reports what it saw either
 * way, so a mismatch names the object that actually won instead of failing silently.
 */
const [x, y, z, yaw, pitch, expect, NEEDLE = '5174'] = process.argv.slice(2);
if (!expect || pitch === undefined) {
  console.error('usage: node tools/probe-use.mjs <x> <y> <z> <yaw> <pitch> <expectId> [portNeedle]');
  process.exit(2);
}
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

const expr = `(async () => {
  const g = window.__daayan;
  const c = g.player;
  // warpTo() is the only correct way in: it seeds position, yaw, groundY and calls syncCamera().
  // Assigning position/yaw by hand leaves the camera quaternion stale, so getWorldDirection()
  // still reports the *old* heading and the interaction picker sees facing ~0 — which reads as
  // "the object is not in range" when it is 1.4 m away and dead ahead.
  c.warpTo(new (c.position.constructor)(${x}, ${y}, ${z}), ${yaw});
  // Pitch is facing.x, which warpTo() does not take. addLookDelta() writes it and re-syncs.
  c.addLookDelta(0, -(${pitch} - c.facing.x));
  // Two frames so engine.update() re-picks the candidate from the camera we just set.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const probe = g.interactables();
  const won = probe.current;
  let fired = false;
  let via = 'none';
  if (won === ${JSON.stringify(expect)}) {
    const btn = document.getElementById('tc-btn-interact');
    if (btn) {
      // A plain .click() does not fire the touch control; the full five-event pointer+touch
      // sequence does. HouseScene wires setOnInteract() to this button's pointerdown.
      const r = btn.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 1, pointerType: 'touch', isPrimary: true };
      btn.dispatchEvent(new PointerEvent('pointerdown', opts));
      btn.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true }));
      btn.dispatchEvent(new PointerEvent('pointerup', opts));
      btn.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true }));
      btn.dispatchEvent(new MouseEvent('click', opts));
      via = 'tc-btn-interact';
      fired = true;
    } else {
      g.interact && g.interact.use && g.interact.use();
      via = 'interact.use()';
      fired = true;
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }
  const after = g.interactables();
  const layer = document.getElementById('overlay-layer');
  const overlayOpen = !!layer && getComputedStyle(layer).display !== 'none';
  return JSON.stringify({ posed: [${x}, ${y}, ${z}], yaw: ${yaw}, pitch: ${pitch},
    won, nearest: probe.nearest, fired, via, afterCurrent: after.current, overlayOpen });
})()`;

const outRes = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
if (outRes.result?.exceptionDetails) {
  console.error('eval failed:', outRes.result.exceptionDetails.text, outRes.result.exceptionDetails.exception?.description ?? '');
  process.exit(1);
}
console.log(outRes.result.result.value);
ws.close();
