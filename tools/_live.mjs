/**
 * Throwaway: pose the hand inside the *running* build and screencap it as the player sees it.
 *
 * Supersedes tools/_hand.mjs, which was measuring the wrong thing, twice over.
 *
 * It recentred the fist to `held` local (0,0,-0.32) so it could sit in the middle of the frame; the build
 * holds it at HOLD, 18.5 cm right at 27 cm out, about 34 degrees off axis. At that offset the camera sees a
 * different side of the hand, so a pose judged centred does not survive being put back.
 *
 * And its magnifier was not a zoom. Scaling `held` grows the hand about the grip point, which is also the
 * point it is being viewed from — so every part of the hand moved as far away as it grew. What that seemed
 * to magnify was the near side of a now 40 cm hand swelling while the far side shrank: a fish-eye. Narrowing
 * the fov instead does nothing either, because `held` is a *child of the camera*: aiming or zooming carries
 * the hand along with it and it stays 34 degrees off centre. What does work is `setViewOffset`, which renders
 * a sub-rectangle of the very same frustum at full canvas size — a true crop and zoom of the player's view,
 * same rays, same visible side of the hand.
 *
 *   node tools/_live.mjs out.png                               # the pose the installed build wrote, 1x
 *   node tools/_live.mjs out.png '{"wrist":[[0,60,-70]]}'      # live override, degrees, null = keep shipped
 *   node tools/_live.mjs out.png null 0.6                      # zoomed to the hand, padded by 0.6 of a side
 *
 * One entry per joint in the chain, so a one-joint chain like `wrist` still takes a list of one: the inner
 * triple is the joint. `{"wrist":[null,null,-20]}` looks like it sets z but sets nothing at all.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import sharp from 'sharp';

const ADB = process.env.ADB ?? 'adb';
const [out = 'live.png', poseArg, zoomArg] = process.argv.slice(2);
const PORT = process.env.CDP_PORT ?? '9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  execFileSync('sh', ['tools/_fwd.sh'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no inspectable page');
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
  const ev = (expression) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      // A dead WebView never answers, and waiting on it forever looks identical to a slow evaluate.
      const t = setTimeout(() => (pending.delete(n), reject(new Error('evaluate timed out'))), 20000);
      pending.set(n, (m) => {
        clearTimeout(t);
        if (m.result?.exceptionDetails) {
          reject(new Error(m.result.exceptionDetails.exception?.description ?? 'threw'));
        } else resolve(m.result.result.value);
      });
      ws.send(
        JSON.stringify({
          id: n,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      );
    });
  return { ws, ev };
}

// Tapping BEGIN is conditional on the menu actually being up. Its buttons stay in the DOM behind a hidden
// layer once the game starts, so an unconditional tap at those coordinates lands on RUN and the player
// sprints off down the corridor mid-measurement.
const BEGIN = `(() => {
  const layer = document.getElementById('menu-layer');
  if (!layer || getComputedStyle(layer).display === 'none') return JSON.stringify({gone: true});
  const b = [...layer.querySelectorAll('button')].find((x) => /BEGIN|START|PLAY/i.test(x.textContent||''));
  if (!b) return JSON.stringify({gone: true});
  const r = b.getBoundingClientRect(), k = window.devicePixelRatio || 1;
  return JSON.stringify({disabled: b.disabled, x: Math.round((r.left+r.width/2)*k), y: Math.round((r.top+r.height/2)*k)});
})()`;

const rig = `(() => {
  const d = window.__daayan, e = d.engine, cam = e.camera, R = e.renderer;
  const V = cam.position.constructor;
  let arms=null, held=null;
  e.scene.traverse((o) => { if (o.name === 'held.arms') arms = o; if (o.name === 'held') held = o; });
  if (!arms || !held) return 'no rig';
  const bone = (n) => { let f=null; arms.traverse((o)=>{ if(o.name===n) f=o; }); return f; };
  if (!window.__base) {
    // Captured before any live write. The loader has already applied FIST by now, so this is the *shipped*
    // pose rather than the authored one — which is exactly the baseline a sweep wants to edit from.
    window.__base = {};
    arms.traverse((o) => { if (/^[RL]_/.test(o.name)) window.__base[o.name] = [o.rotation.x,o.rotation.y,o.rotation.z]; });
  }
  const DIG = {
    point: ['R_point1_030','R_point2_031','R_point3_032'],
    middle: ['R_middle1_034','R_middle2_035','R_middle3_036'],
    ring: ['R_ring1_038','R_ring2_039','R_ring3_040'],
    pink: ['R_pink1_042','R_pink2_043','R_pink3_044'],
    thumb: ['R_thumb1_026','R_thumb2_027','R_thumb3_028'],
    wrist: ['R_wrist_025'],
  };
  const GRIP = ['R_point1_030','R_middle1_034','R_ring1_038','R_pink1_042','R_point3_032','R_middle3_036','R_ring3_040','R_pink3_044'];

  /** Hide every DOM layer over the canvas; the HUD sits exactly where the zoomed hand lands. */
  const overlays = (hide) => {
    for (const el of document.body.children) {
      if (el.id === 'app') continue;
      if (hide) { if (el.dataset.lv === undefined) el.dataset.lv = el.style.display; el.style.display = 'none'; }
      else if (el.dataset.lv !== undefined) { el.style.display = el.dataset.lv; delete el.dataset.lv; }
    }
  };

  window.__unlive = () => {
    cam.clearViewOffset();
    cam.updateProjectionMatrix();
    overlays(false);
    d.loop.start();
    return 'restored';
  };

  window.__live = (spec, zoom) => {
    const D = Math.PI/180;
    // The build never scales \`held\`, so forcing 1 costs nothing and makes the tool idempotent. An earlier
    // experiment left it at 3 and every measurement after that read a 156 mm palm as though it were shipped.
    held.scale.setScalar(1);
    for (const [dig, vals] of Object.entries(spec || {})) {
      const names = DIG[dig]; if (!names) continue;
      for (let i = 0; i < names.length; i++) {
        const j = bone(names[i]); const r = vals[i];
        if (!j || r === undefined) continue;
        const base = window.__base[names[i]] ?? [0,0,0];
        const a = Array.isArray(r) ? r : [r];
        j.rotation.x = a[0] == null ? base[0] : a[0]*D;
        j.rotation.y = a[1] == null ? base[1] : a[1]*D;
        j.rotation.z = a[2] == null ? base[2] : a[2]*D;
      }
    }
    arms.updateMatrixWorld(true);
    // The loader's own anchoring: grip mean onto \`held\`'s origin. Skipping it slides the fist off the bail,
    // because closing the fingers moves the mean and the build re-reads it *after* FIST.
    //
    // \`arms.position\` has to go back to zero first. worldToLocal returns the grip in held space *including*
    // whatever offset arms already carries, and the loader only ever runs this from zero — so negating it on
    // an already-anchored rig subtracts the offset twice and the hand walks toward the camera, one doubling
    // per call. That is what made the fist look five times its shipped size on the second measurement.
    arms.position.set(0, 0, 0);
    arms.updateMatrixWorld(true);
    const g = new V(); let n = 0;
    for (const nm of GRIP) { const j = bone(nm); if (j) { g.add(j.getWorldPosition(new V())); n++; } }
    g.multiplyScalar(1/n);
    held.updateWorldMatrix(true, false);
    arms.position.copy(held.worldToLocal(g.clone())).negate();
    arms.updateMatrixWorld(true);

    cam.clearViewOffset();
    cam.updateProjectionMatrix();
    const box = () => {
      let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9,m=0;
      arms.traverse((o) => {
        if (!/^R_(wrist|point|middle|ring|pink|thumb)/.test(o.name)) return;
        const p = o.getWorldPosition(new V()).project(cam);
        x0=Math.min(x0,p.x); x1=Math.max(x1,p.x); y0=Math.min(y0,p.y); y1=Math.max(y1,p.y); m++;
      });
      return m ? [x0,y0,x1,y1] : null;
    };
    const ndc = box();

    // Where each bare segment lands. The glove is fingerless from joint 2 out, so joints 2/3/4 are the only
    // skin on screen, and how they spread in NDC is the whole question of whether a fist reads.
    const seen = {};
    for (const [dig, names] of Object.entries(DIG)) {
      if (dig === 'wrist') continue;
      // 'R_point1_030' -> 'R_point2_031'. The suffix is zero padded in the file, so rebuilding it by
      // arithmetic has to pad too or every lookup past joint 1 silently misses.
      seen[dig] = [2,3,4].map((i) => {
        const nm = names[0].replace(/1_(\\d+)$/, (m, s) => i + '_' + String(Number(s) + i - 1).padStart(s.length, '0'));
        const j = bone(nm);
        if (!j) return null;
        const w = j.getWorldPosition(new V());
        const c = cam.worldToLocal(w.clone());
        const p = w.clone().project(cam);
        return [+p.x.toFixed(3), +p.y.toFixed(3), +(-c.z).toFixed(3)];
      });
    }

    let view = null;
    if (zoom != null && ndc) {
      d.loop.stop();
      overlays(true);
      const W = R.domElement.width, H = R.domElement.height;
      const px = (v) => (v*0.5+0.5)*W, py = (v) => (1-(v*0.5+0.5))*H;
      const bw = px(ndc[2])-px(ndc[0]), bh = py(ndc[1])-py(ndc[3]);
      const pad = zoom * Math.max(bw, bh);
      let w = bw + 2*pad, h = bh + 2*pad;
      // Match the canvas aspect or the sub-rectangle comes out stretched when it is blown up to fill it.
      const A = W/H;
      if (w/h > A) h = w/A; else w = h*A;
      let x = px(ndc[0]) + bw/2 - w/2, y = py(ndc[3]) + bh/2 - h/2;
      x = Math.max(0, Math.min(W-w, x)); y = Math.max(0, Math.min(H-h, y));
      cam.setViewOffset(W, H, Math.round(x), Math.round(y), Math.round(w), Math.round(h));
      cam.updateProjectionMatrix();
      R.setRenderTarget(null);
      R.render(e.scene, cam);
      view = [Math.round(x), Math.round(y), Math.round(w), Math.round(h), +(W/w).toFixed(2)];
    }

    const w2 = bone('R_wrist_025');
    const deg = (r) => +(r*180/Math.PI).toFixed(1);
    return JSON.stringify({
      ndc: ndc ? ndc.map((v)=>+v.toFixed(4)) : null,
      view,
      wrist: w2 ? [deg(w2.rotation.x),deg(w2.rotation.y),deg(w2.rotation.z)] : null,
      seen,
    });
  };
  return 'ok';
})()`;

let info = null;
let ws = null;
let ev = null;
for (let attempt = 0; attempt < 3 && !info; attempt++) {
  try {
    const c = await connect();
    ws = c.ws;
    ev = c.ev;
    const btn = JSON.parse(await ev(BEGIN));
    if (!btn.gone) {
      // BEGIN stays disabled while assets warm, and tapping it early does nothing at all.
      for (let i = 0; i < 120 && JSON.parse(await ev(BEGIN)).disabled; i++) await sleep(1000);
      execFileSync(ADB, ['shell', 'input', 'tap', String(btn.x), String(btn.y)]);
      await sleep(2500);
    }
    const installed = await ev(rig);
    if (installed !== 'ok') throw new Error(installed ?? 'rig install returned nothing');
    info = JSON.parse(await ev(`__live(${poseArg ?? 'null'}, ${zoomArg ?? 'null'})`));
  } catch (err) {
    console.error(`${err.message} — retrying`);
    if (ws) ws.close();
    ws = null;
  }
}
if (!info) {
  console.error('never reached gameplay');
  process.exit(1);
}
console.log(JSON.stringify(info));

await sleep(400);
const png = execFileSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 });
// Put the view back before letting go, so the app is not left frozen and zoomed if nothing runs after this.
if (zoomArg) await ev('__unlive()').catch(() => {});
if (ws) ws.close();

writeFileSync(out, png);
const meta = await sharp(png).metadata();
console.log(`${out}  ${png.length} bytes  ${meta.width}x${meta.height}`);
if (!zoomArg && info.ndc) {
  // Unzoomed frames still want a crop, because at 1x the hand is a few hundred pixels of a 2460 wide shot.
  const W = meta.width, H = meta.height;
  const [nx0, ny0, nx1, ny1] = info.ndc;
  const px = (n) => (n * 0.5 + 0.5) * W;
  const py = (n) => (1 - (n * 0.5 + 0.5)) * H;
  const pad = 0.6 * Math.max(px(nx1) - px(nx0), py(ny0) - py(ny1));
  const l = Math.max(0, Math.round(px(nx0) - pad));
  const t = Math.max(0, Math.round(py(ny1) - pad));
  const box = {
    left: l,
    top: t,
    width: Math.min(W - l, Math.round(px(nx1) - px(nx0) + 2 * pad)),
    height: Math.min(H - t, Math.round(py(ny0) - py(ny1) + 2 * pad)),
  };
  const scale = Math.min(3, 1100 / box.width);
  await sharp(png).extract(box).resize({ width: Math.round(box.width * scale), kernel: 'lanczos3' }).png()
    .toFile(out.replace(/\.png$/, '-c.png'));
  console.log(`  + crop ${JSON.stringify(box)}`);
}
