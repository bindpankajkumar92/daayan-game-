/**
 * Put the player at a pose in the *desktop* build and screenshot it.
 *
 * This is the desktop twin of `devshot.mjs`, which needs `adb` and a device WebView. Both exist
 * because the same question comes up on both: a screenshot cannot say what it is a picture of, and
 * placement work is guessing until someone looks. `devshot` answers it on the phone; this answers it
 * in the browser the dev server is already serving.
 *
 * Launch the browser first, headless so no window appears:
 *
 *   chrome --headless=new --remote-debugging-port=9222 --user-data-dir=.chromeprof \
 *          --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader http://localhost:5174/
 *
 * Then:
 *
 *   node tools/lookshot.mjs out.png <x> <y> <z> <yawRad> <pitchRad>
 *
 * The pose is written straight onto the controller rather than through `warpTo`, because `warpTo`
 * zeroes velocity and resets the ground state — fine for a respawn, wrong for a look around. `onGround`
 * is set so the first frame does not spend itself falling.
 */

import { writeFileSync } from 'node:fs';

const [out, x, y, z, yaw, pitch] = process.argv.slice(2);
if (!out || z === undefined) {
  console.error('usage: node tools/lookshot.mjs <out.png> <x> <y> <z> <yawRad> [pitchRad]');
  process.exit(2);
}

const PORT = process.env.CDP_PORT ?? '9222';
const MATCH = process.env.CDP_MATCH ?? '';

const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
const page = MATCH ? pages.find((t) => `${t.url} ${t.title}`.includes(MATCH)) : pages[0];
if (!page) {
  console.error('no inspectable page — is the browser running with --remote-debugging-port?');
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
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

function send(method, params = {}) {
  const msgId = ++id;
  ws.send(JSON.stringify({ id: msgId, method, params }));
  return new Promise((res) => pending.set(msgId, res));
}

/** The pose, and the report of where it actually landed — the camera is a separate object. */
const pose = `
(() => {
  const d = window.__daayan;
  if (!d || !d.player) return 'no player';
  const p = d.player;
  p.position.set(${Number(x)}, ${Number(y)}, ${Number(z)});
  p.onGround = true;
  p.look(${Number(yaw)}, ${Number(pitch ?? 0)});
  if (typeof p.syncCamera === 'function') p.syncCamera();
  const c = d.engine.camera.position;
  return 'player=(' + p.position.x.toFixed(2) + ',' + p.position.y.toFixed(2) + ',' + p.position.z.toFixed(2) +
    ') cam=(' + c.x.toFixed(2) + ',' + c.y.toFixed(2) + ',' + c.z.toFixed(2) + ')';
})()
`;

const posed = await send('Runtime.evaluate', { expression: pose, returnByValue: true });
console.log(posed.result?.result?.value ?? JSON.stringify(posed.result));

// Two frames: one for the pose to reach the camera, one for the renderer to draw it.
await send('Runtime.evaluate', {
  expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))',
  awaitPromise: true,
});

const shot = await send('Page.captureScreenshot', { format: 'png' });
const data = shot.result?.data;
if (!data) {
  console.error('captureScreenshot returned nothing:', JSON.stringify(shot).slice(0, 300));
  process.exit(1);
}
writeFileSync(out, Buffer.from(data, 'base64'));
console.log(`wrote ${out}`);
ws.close();
