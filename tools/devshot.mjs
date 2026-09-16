/**
 * Set a pose in the *running device* build and screenshot it with `adb exec-out screencap`.
 *
 * Why not tools/.shot.mjs: `Page.captureScreenshot` never returns on an Android WebView, so the desktop
 * path hangs at exit 13. `screencap` grabs the framebuffer instead, which also means the app has to be
 * in the foreground — check `dumpsys activity activities | grep topResumedActivity` if a shot comes back
 * looking like the launcher.
 *
 * The forward has to be live and pointed at the *current* WebView pid; it changes every time the
 * WebView is recreated:
 *
 *   adb shell cat /proc/net/unix | grep webview_devtools_remote
 *   adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 *   node tools/devshot.mjs out.png <x> <y> <z> <yawRad> <pitchRad>
 *
 * Yaw is taken in *radians of `player.facing._y`*, unwrapped, exactly as the live object carries it —
 * the point of this tool is to reproduce a pose read off the running game, and rounding it to degrees
 * first loses the thing being reproduced.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [out, x, y, z, yaw, pitch] = process.argv.slice(2);
if (!out || z === undefined) {
  console.error('usage: node tools/devshot.mjs <out.png> <x> <y> <z> <yawRad> [pitchRad]');
  process.exit(2);
}

const PORT = process.env.CDP_PORT ?? '9222';
const ADB = process.env.ADB ?? `${process.env.LOCALAPPDATA}\\Android\\Sdk\\platform-tools\\adb.exe`;

const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) {
  console.error('no inspectable page — is the app in the foreground?');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) (pending.get(m.id)(m), pending.delete(m.id));
});
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
const evaluate = (expression) =>
  new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    ws.send(
      JSON.stringify({
        id: n,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }),
    );
  });

const res = await evaluate(`(() => {
  const d = window.__daayan, p = d.player;
  p.movementLocked = true;
  p.position.set(${+x}, ${+y}, ${+z});
  p.velocity.set(0, 0, 0);
  p.facing.y = ${+yaw};
  p.facing.x = ${+(pitch ?? 0)};
  const c = d.engine.camera;
  c.position.copy(p.position);
  c.quaternion.setFromEuler(p.facing);
  return JSON.stringify({
    pos: [+c.position.x.toFixed(2), +c.position.y.toFixed(2), +c.position.z.toFixed(2)],
    ground: p.groundY,
  });
})()`);
if (res.result?.exceptionDetails) {
  console.error('THREW:', res.result.exceptionDetails.exception?.description);
  process.exit(1);
}
console.log(res.result.result.value);
ws.close();

// The culler runs off an interval, not off the camera, so a pose set this way is not fully populated
// until it next fires. Same 1200 ms the desktop shot tool waits.
await new Promise((r) => setTimeout(r, 1300));
// `exec-out` rather than `shell`, and straight into a Buffer: `shell` translates \n and corrupts a PNG,
// and piping binary through PowerShell's `Set-Content -Encoding Byte` fails outright — the pipeline hands
// it strings, one error per line of the image.
const png = execFileSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 });
writeFileSync(out, png);
console.log(`${out}  ${png.length} bytes`);
