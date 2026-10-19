/**
 * Screenshot the game from a chosen eye pose, after verifying that spot is actually clear of geometry.
 *
 * Usage: node tools/shot-room.mjs <out.png> <x> <feetY> <z> <yaw> <pitch> [portNeedle] [waitGameSeconds]
 *
 * `lookshot.mjs` poses and shoots, but the hidden room is 6 x 6.6 m of solid boxes and most poses
 * land the eye *inside* a collider, which renders as a flat smear that looks like a broken scene
 * rather than a bad camera. This checks the point against the controller's own collider list first
 * and refuses rather than writing a misleading image.
 *
 * Two corrections that matter more than they look:
 *   - The pose goes in through `warpTo()`, not by assigning `position` and calling `look()`.
 *     Hand-assignment leaves the camera quaternion stale, so the render — and the interaction
 *     picker — still sees the OLD heading. `warpTo` seeds position, yaw, groundY and re-syncs.
 *   - The settle wait is in GAME time (`__daayan.clock()`), because rAF runs at about 1 Hz in a tab
 *     Chrome is not compositing and game time therefore trails wall time by ~10x. Waiting two rAFs
 *     advances the simulation by ~0.03 s, which is not enough for a toast to appear or a tween to
 *     finish — that is how a working screen photographs as a blank one.
 *
 * `features` is echoed before the shot so a prompt or toast in the image can be checked against
 * what the DOM actually held at that instant.
 */
import { writeFileSync } from 'node:fs';

const [out, x, feetY, z, yaw, pitch, NEEDLE = '5174', waitSeconds = '0.4'] = process.argv.slice(2);
if (!out || pitch === undefined) {
  console.error('usage: node tools/shot-room.mjs <out.png> <x> <feetY> <z> <yaw> <pitch> [portNeedle] [waitGameSeconds]');
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
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  const entry = pending.get(m.id);
  if (entry) {
    pending.delete(m.id);
    entry(m);
  }
});
await new Promise((res) => ws.addEventListener('open', res, { once: true }));
const send = (method, params = {}) => {
  const n = ++id;
  ws.send(JSON.stringify({ id: n, method, params }));
  return new Promise((res) => pending.set(n, res));
};

const expr = `(async () => {
  const d = window.__daayan;
  if (!d || !d.player) return JSON.stringify({ ok: false, why: 'no player' });
  const p = d.player;
  const [X, Y, Z] = [${Number(x)}, ${Number(feetY)}, ${Number(z)}];
  // Refuse to write an image from inside a wall — see this tool's header.
  const r = p.getRadius ? p.getRadius() : 0.3;
  const blocked = (p.aabbs || []).filter((a) =>
    X + r > a.minX && X - r < a.maxX && Z + r > a.minZ && Z - r < a.maxZ &&
    Y + 0.1 > a.minY && Y + 1.6 < a.maxY);
  if (blocked.length) {
    return JSON.stringify({ ok: false, blockedBy: blocked.length,
      boxes: blocked.slice(0, 3).map((a) => [a.minX, a.maxX, a.minY, a.maxY, a.minZ, a.maxZ].map((n) => Number(n.toFixed(2)))) });
  }
  // warpTo takes the EYE position, so add the current eye height to the feet value given on the CLI.
  const eye = p.currentEyeHeight();
  p.warpTo(new (p.position.constructor)(X, Y + eye, Z), ${Number(yaw)});
  p.addLookDelta(0, -(${Number(pitch)} - p.facing.x));
  // Wait in game seconds so the world has actually advanced before the frame is captured.
  const from = typeof d.clock === 'function' ? d.clock() : 0;
  const deadline = Date.now() + 90000;
  while (typeof d.clock === 'function' && d.clock() - from < ${Number(waitSeconds)}) {
    if (Date.now() > deadline) break;
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  }
  const near = d.interactables ? d.interactables() : null;
  const lines = (document.body.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
  return JSON.stringify({ ok: true, feet: [X, Y, Z], eye,
    gameClock: typeof d.clock === 'function' ? Number(d.clock().toFixed(2)) : null,
    current: near && near.current,
    nearest: near && near.nearest,
    hudLines: lines.slice(0, 10) });
})()`;

const posed = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
const val = posed.result?.result?.value;
if (posed.result?.exceptionDetails) {
  console.error('eval failed:', posed.result.exceptionDetails.text, posed.result.exceptionDetails.exception?.description ?? '');
  ws.close();
  process.exit(1);
}
console.log(val);
if (typeof val === 'string' && val.includes('"ok":false')) {
  console.error('refusing: that eye position is inside geometry');
  ws.close();
  process.exit(1);
}

const shot = await send('Page.captureScreenshot', { format: 'png' });
const data = shot.result?.data;
if (!data) {
  console.error('no screenshot data');
  process.exit(1);
}
writeFileSync(out, Buffer.from(data, 'base64'));
console.log(`wrote ${out}`);
ws.close();
