/**
 * Throwaway: one command per candidate pose — forward, install, pose, render, screencap, crop.
 *
 * Iterating on the fist over separate `cdp.mjs` calls does not survive this phone: it foregrounds other
 * apps on its own, Daayan gets killed, and the relaunch drops every global the previous call installed —
 * which shows up as `__handview is not defined` two commands into a sweep. So everything the render needs
 * is sent as one evaluate, and the shot is taken in the same run.
 *
 *   node tools/_hand.mjs out.png '{"point":[-90,-95,-20]}' '{"k":4,"lantern":true}'
 *   node tools/_hand.mjs out.png rest            # authored rest pose, FIST not applied
 *   node tools/_hand.mjs out.png ship            # the FIST the build ships
 *   node tools/_hand.mjs --restore
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const ADB = process.env.ADB ?? 'adb';
const args = process.argv.slice(2);
const RESTORE = args[0] === '--restore';
const [out, poseArg, optArg] = args;

/** What src/player/HeldLantern.ts ships, so a candidate can be diffed against it in one place. */
const SHIP = {
  point: [-45, -75, -45],
  middle: [-45, -78, -45],
  ring: [-42, -76, -42],
  pink: [-78, -100, -58],
  thumb: [[20, 46, 47], -80, -40],
};

execFileSync('sh', ['tools/_fwd.sh'], { stdio: ['ignore', 'pipe', 'inherit'] });

const PORT = process.env.CDP_PORT ?? '9222';
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) {
  console.error('no inspectable page');
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

const rig = readFileSync('tools/_handrig.js', 'utf8');
let mkScript;
if (RESTORE) {
  mkScript = () => `${rig};\n(window.__handrestore ? __handrestore() : 'nothing installed')`;
} else {
  const opts = optArg ?? '{"k":4,"lantern":true}';
  let pose;
  if (poseArg === 'rest') pose = null;
  else if (poseArg === 'ship' || poseArg === undefined) pose = JSON.stringify(SHIP);
  else pose = poseArg;
  const setPose = pose
    ? `__setfist(${pose})`
    : `(() => { let a=null; window.__daayan.engine.scene.traverse(o=>{if(o.name==='held.arms')a=o});
         let n=0; a.traverse(o=>{const r=window.__rest[o.name]; if(r){o.rotation.set(r[0],r[1],r[2]); n++;}});
         a.updateMatrixWorld(true); return 'rest on '+n; })()`;
  // Let the app's own loop run for a moment before the render freezes it: HeldLantern scales the rig by
  // PALM_SPAN and anchors the grip on a tick, so freezing straight after a relaunch renders a half-built
  // hand — smaller, and at the wrong depth.
  mkScript = (settle) => `(async () => {
    const _installed = ${rig};
    if (${settle}) await new Promise((r) => setTimeout(r, ${settle}));
    return JSON.stringify([${setPose}, __handview(${opts})]);
  })()`;
}

let value = null;
let ok = false;
for (let attempt = 0; attempt < 4 && !ok; attempt++) {
  // Restore *before* a retry, never after the last attempt: __handrestore un-hides the world and restarts
  // the loop, so calling it at the end leaves the screencap showing the game instead of the render.
  if (attempt) await evaluate('window.__handrestore ? __handrestore() : 0');
  const res = await evaluate(mkScript(attempt === 0 ? 400 : 2500));
  if (res.result?.exceptionDetails) {
    console.error('THREW:', res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text);
    process.exit(1);
  }
  value = res.result.result.value;
  if (RESTORE) break;
  const v = JSON.parse(JSON.parse(value)[1]);
  const off = Math.hypot(...v.gripCam.map((c, i) => c - v.heldPos[i]));
  // A couple of cm is HeldLantern's own sway landing one more frame before the loop stops. 20 cm means the
  // rig is still at its raw GLB scale because the setup tick has not run.
  ok = off < 0.03;
  if (!ok) console.error(`grip ${off.toFixed(4)} m off held origin — rig not set up yet, letting it tick and retrying`);
}
if (!ok && !RESTORE) console.error('WARNING: rig never anchored — this frame is a half-built hand, do not judge it');
console.log(value);
ws.close();
if (RESTORE) process.exit(0);

await new Promise((r) => setTimeout(r, 700));
const png = execFileSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 });
writeFileSync(out, png);

// Crop to where the hand reported itself, not to a fixed box: at k=4 the hand's extent changes with the
// pose, and a fixed box was quietly clipping it — which made a fragment look like the whole fist.
const view = JSON.parse(JSON.parse(value)[1]);
const meta = await sharp(png).metadata();
const W = meta.width, H = meta.height;
let box = { left: 620, top: 40, width: 1180, height: 1000 };
if (view.ndc) {
  const [nx0, ny0, nx1, ny1] = view.ndc;
  const px = (n) => (n * 0.5 + 0.5) * W;
  const py = (n) => (1 - (n * 0.5 + 0.5)) * H;
  // Joint bounds only; the mesh reaches well past the last joint, so pad by 55% of the larger side. Less
  // than that clipped the bare finger segments off the left edge, which is the one thing being judged.
  const pad = 0.55 * Math.max(px(nx1) - px(nx0), py(ny0) - py(ny1));
  const l = Math.max(0, Math.round(px(nx0) - pad));
  const t = Math.max(0, Math.round(py(ny1) - pad));
  box = {
    left: l,
    top: t,
    width: Math.min(W - l, Math.round(px(nx1) - px(nx0) + 2 * pad)),
    height: Math.min(H - t, Math.round(py(ny0) - py(ny1) + 2 * pad)),
  };
}
const scale = Math.min(2.5, 1100 / box.width);
await sharp(png).extract(box).resize({ width: Math.round(box.width * scale), kernel: 'lanczos3' }).png()
  .toFile(out.replace(/\.png$/, '-c.png'));
console.log(`${out}  ${png.length} bytes  + ${out.replace(/\.png$/, '-c.png')}  crop ${JSON.stringify(box)}`);
