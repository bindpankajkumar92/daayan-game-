/**
 * Measure the upper flat's shell where it actually lands on the screen, on the device, at one pose.
 *
 * The point is to stop arguing about whole-frame averages. The shell's own pixels are found by hiding it
 * for one shot and diffing: whatever changed is what it was covering, exactly, with no raycasting and no
 * assumption about what occludes what. Then the featurelessness measure runs inside that mask and outside
 * it, so "the panel is smooth and its neighbours are not" becomes two numbers from the same frame.
 *
 * A noise floor is measured rather than assumed: two shots are taken in the *same* state first, because
 * this game flickers its lantern and grades every frame through a fullscreen pass, and a diff threshold
 * picked by eye would either swallow the panel or count the flicker as panel.
 *
 *   node tools/_shellmeasure.mjs <outPrefix> <x> <y> <z> <yawRad> [pitchRad]
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import sharp from 'sharp';

const [prefix, x, y, z, yaw, pitch] = process.argv.slice(2);
if (!prefix || z === undefined) {
  console.error('usage: node tools/_shellmeasure.mjs <outPrefix> <x> <y> <z> <yawRad> [pitchRad]');
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
const evaluate = async (expression) => {
  const n = ++id;
  const res = await new Promise((resolve) => {
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? 'threw');
  return res.result.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => {
  const png = execFileSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(name, png);
  return name;
};
// MEASURE_BODY
const pose = await evaluate(`(() => {
  const d = window.__daayan, p = d.player;
  p.movementLocked = true;
  p.position.set(${+x}, ${+y}, ${+z});
  p.velocity.set(0, 0, 0);
  p.facing.y = ${+yaw};
  p.facing.x = ${+(pitch ?? 0)};
  d.engine.camera.position.copy(p.position);
  d.engine.camera.quaternion.setFromEuler(p.facing);
  // The shell, by what it is: the sealed material carries the flag once dressShell has run, and before
  // that fix shipped it is the only opaque, unmapped, slate-tinted material in the scene.
  const shell = [];
  d.engine.scene.traverse((o) => {
    if (!o.isMesh) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    if (ms.some((m) => m && (m.userData.sealed === true || (!m.map && m.color && m.color.getHex() === 0x4a4a52)))) shell.push(o);
  });
  window.__shell = shell;
  return JSON.stringify({
    shell: shell.map((o) => o.name),
    map: shell.map((o) => { const m = Array.isArray(o.material) ? o.material[0] : o.material; return m.map ? (m.map.name || 'set') : 'NONE'; }),
    uv: shell.map((o) => (o.geometry.attributes.uv ? o.geometry.attributes.uv.count : 0)),
    colour: shell.map((o) => { const m = Array.isArray(o.material) ? o.material[0] : o.material; return '#' + m.color.getHexString(); }),
  });
})()`);
console.log(`pose set: ${pose}`);
await sleep(1400);
const A = await shot(`${prefix}-a.png`);
await sleep(500);
const B = await shot(`${prefix}-b.png`);
await evaluate('window.__shell.forEach((o) => (o.visible = false)); "hidden"');
await sleep(600);
const C = await shot(`${prefix}-hidden.png`);
await evaluate('window.__shell.forEach((o) => (o.visible = true)); "shown"');
ws.close();
// STATS_BODY
const grey = async (f) => {
  const { data, info } = await sharp(f).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { d: data, w: info.width, h: info.height };
};
const [a, b, c] = await Promise.all([grey(A), grey(B), grey(C)]);
const { w, h } = a;
// Noise floor from two shots of the same state: the largest per-pixel difference the flicker and the
// grade pass produce on their own. The mask threshold has to clear it or it is measuring the lantern.
let floor = 0;
let floorSum = 0;
for (let i = 0; i < w * h; i++) {
  const d = Math.abs(a.d[i] - b.d[i]);
  floorSum += d;
  if (d > floor) floor = d;
}
const T = Math.max(6, floor + 2);
const mask = new Uint8Array(w * h);
let inN = 0;
for (let i = 0; i < w * h; i++) {
  if (Math.abs(b.d[i] - c.d[i]) > T) { mask[i] = 1; inN++; }
}
console.log(`noise floor: max ${floor}, mean ${(floorSum / (w * h)).toFixed(2)} -> mask threshold ${T}`);
console.log(`shell covers ${((inN / (w * h)) * 100).toFixed(1)}% of ${w}x${h}`);

const CUTS = [0.01, 0.02, 0.04];
const stat = (want) => {
  let n = 0, sum = 0;
  const below = new Float64Array(CUTS.length);
  for (let py = 1; py < h - 1; py++) {
    for (let px = 1; px < w - 1; px++) {
      const i = py * w + px;
      if (mask[i] !== want) continue;
      n++; sum += b.d[i];
      let s = 0, s2 = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const v = b.d[(py + dy) * w + (px + dx)];
        s += v; s2 += v * v;
      }
      const mu = s / 9;
      const rc = Math.sqrt(Math.max(0, s2 / 9 - mu * mu)) / Math.max(1, mu);
      for (let k = 0; k < CUTS.length; k++) if (rc < CUTS[k]) below[k]++;
    }
  }
  return `${String(n).padStart(8)} px  mean ${(sum / Math.max(1, n)).toFixed(1).padStart(5)}  ` +
    CUTS.map((cut, k) => `rc<${cut}: ${((below[k] / Math.max(1, n)) * 100).toFixed(1)}%`).join('  ');
};
console.log(`  shell  ${stat(1)}`);
console.log(`  rest   ${stat(0)}`);


