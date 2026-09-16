/**
 * ProcTextures — canvas-generated textures for the house interior.
 *
 * Why procedural instead of image files: Phase 0/1 has no art pipeline yet and no CC0
 * downloads are wired up, but flat vertex colours read as "obviously untextured". Canvas
 * textures cost nothing to ship (no bytes in the bundle) and give us plank seams / plaster
 * mottling / wood grain — the detail the eye actually uses to decide whether a surface looks
 * real. They are not free to *make*, though: ~120 ms each on the target device, all of it on the
 * loading screen. See the note on size below for where that goes.
 *
 * Each generator returns the albedo (sRGB) and nothing else. They used to return a { map, bump }
 * pair, but both call sites disposed the bump on the next line — no material in the game has ever
 * set bumpMap — so half the generation work was being thrown away. Deleted rather than wired up:
 * the imported art carries real normal maps now, and these surfaces are lit by one lantern.
 *
 * Size: 1024, up from 512. The old comment here claimed 512 was "to respect the low-tier
 * textureMaxSize budget", which was not true of the code — QualityManager.textureMaxSize has no
 * reader anywhere in the project, and the device reports GL_MAX_TEXTURE_SIZE 8192. These textures
 * cover the walls, floors and ceilings, i.e. most of the screen most of the time, so they were the
 * softest thing in the frame. Costs no per-frame time: same draws, same shader, and mips keep the
 * minified case identical.
 *
 * What it costs is VRAM and load time, and the load time is worth stating properly because the
 * previous version of this comment claimed the opposite — that culling passes and dropping the bump
 * maps had made 1024 *cheaper* than 512 used to be. It has not. Generation is dominated by addGrain
 * below, which is one getImageData, one pass over every byte and one putImageData per texture, and
 * that term is 96-98% of the total. Culling took the count from 14 passes to 7, but each pass now
 * covers four times the pixels: byte traffic went from 3.67 M px to 7.34 M px, so the term that
 * matters roughly doubled and the halved pass count only pays back the per-call overhead. Measured
 * rather than argued — the grain term alone is 1.81x (155 ms -> 281 ms, desktop Chrome, median of
 * three), and the whole build on the target Redmi (Adreno 613) went 579 ms -> 851 ms. A 47% slower
 * one-time build behind a loading screen, bought deliberately for the sharpest surface in the game.
 */

import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from 'three';

const TEX_SIZE = 1024;

/**
 * One "authored pixel". Every hard-coded pixel measurement below — seam widths, crack step lengths,
 * knot radii, stroke widths — was tuned against a 512 tile, so at any other TEX_SIZE they have to be
 * multiplied by this or the whole texture's detail halves in relative size and the surface reads as a
 * photo of a wall rather than a wall. Feature *counts* deliberately do not scale: 90 mottles across a
 * tile is a look, not a density.
 */
const PX = TEX_SIZE / 512;

/** Deterministic PRNG so the house looks identical every launch (helps repro bug reports). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function newCtx(size = TEX_SIZE): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('[ProcTextures] 2D canvas context unavailable');
  return g;
}

function toTexture(g: CanvasRenderingContext2D, isColor: boolean, repeat: number): CanvasTexture {
  const t = new CanvasTexture(g.canvas);
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.repeat.set(repeat, repeat);
  if (isColor) t.colorSpace = SRGBColorSpace;
  t.generateMipmaps = true;
  return t;
}

/** Sprinkle fine per-pixel grain. Cheap way to kill the "flat gradient" look. */
function addGrain(g: CanvasRenderingContext2D, rand: () => number, amount: number): void {
  const size = g.canvas.width;
  const img = g.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * amount;
    d[i] = clamp255((d[i] ?? 0) + n);
    d[i + 1] = clamp255((d[i + 1] ?? 0) + n);
    d[i + 2] = clamp255((d[i + 2] ?? 0) + n);
  }
  g.putImageData(img, 0, 0);
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * Run `draw` once per wrapped neighbour offset that the feature can actually reach into, so any
 * feature painted near an edge reappears on the opposite side.
 *
 * This matters because the walls tile: a feature clipped at the texture border turns every
 * repeat boundary into a visible line, and a 12 m wall then reads as a grid of identical
 * rectangles. That grid is the single strongest "fake" cue on a large surface — stronger than
 * the texture content itself.
 *
 * `box` is the feature's bounding box in tile pixels, and the offsets whose translated box misses
 * the tile entirely are skipped. This is not an approximation — those passes drew nothing, they were
 * fully clipped by the canvas. It used to run all nine unconditionally, which is fine for a crack but
 * not for plaster's 95 radial blobs: at 1024 those are ~126 px across, so nine passes of a 252 px
 * fillRect each was ~50 M gradient-filled pixels per plaster texture, and three plasters made the
 * loading screen visibly stall. Culling drops most blobs to a single pass, since most of them are
 * nowhere near an edge.
 */
function tileable(
  g: CanvasRenderingContext2D,
  box: { x0: number; y0: number; x1: number; y1: number },
  draw: () => void,
): void {
  const size = g.canvas.width;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const ox = dx * size;
      const oy = dy * size;
      if (box.x1 + ox <= 0 || box.x0 + ox >= size) continue;
      if (box.y1 + oy <= 0 || box.y0 + oy >= size) continue;
      g.save();
      g.translate(ox, oy);
      draw();
      g.restore();
    }
  }
}

/** Bounding box of a radial feature, for `tileable`. */
function around(x: number, y: number, r: number): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: x - r, y0: y - r, x1: x + r, y1: y + r };
}

/** Bounding box of a polyline walked from (x0,y0) by `steps`, widened by half a stroke. */
function walkBox(
  x0: number,
  y0: number,
  steps: Array<[number, number]>,
  lineWidth: number,
): { x0: number; y0: number; x1: number; y1: number } {
  let x = x0;
  let y = y0;
  const box = { x0, y0, x1: x0, y1: y0 };
  for (const [dx, dy] of steps) {
    x += dx;
    y += dy;
    if (x < box.x0) box.x0 = x;
    if (x > box.x1) box.x1 = x;
    if (y < box.y0) box.y0 = y;
    if (y > box.y1) box.y1 = y;
  }
  const pad = lineWidth * 0.5 + 1;
  box.x0 -= pad;
  box.y0 -= pad;
  box.x1 += pad;
  box.y1 += pad;
  return box;
}

/**
 * Wood plank floor. Horizontal planks with per-plank tint variation, long grain streaks,
 * dark seams between boards and short end-joints so the rows don't look like one long board.
 */
export function makeWoodFloor(seed = 1337, plankCount = 8): CanvasTexture {
  const rand = mulberry32(seed);
  const g = newCtx();
  const size = TEX_SIZE;
  const plankH = size / plankCount;

  g.fillStyle = '#6b4a2c';
  g.fillRect(0, 0, size, size);

  for (let p = 0; p < plankCount; p++) {
    const y = p * plankH;
    // Per-plank base tone.
    const lum = 0.78 + rand() * 0.34;
    g.fillStyle = `rgb(${Math.round(120 * lum)},${Math.round(82 * lum)},${Math.round(48 * lum)})`;
    g.fillRect(0, y, size, plankH);

    // Long grain streaks.
    const streaks = 26 + Math.floor(rand() * 18);
    for (let s = 0; s < streaks; s++) {
      const sy = y + rand() * plankH;
      const dark = 0.55 + rand() * 0.35;
      g.strokeStyle = `rgba(${Math.round(70 * dark)},${Math.round(44 * dark)},${Math.round(24 * dark)},${0.18 + rand() * 0.3})`;
      g.lineWidth = (0.6 + rand() * 1.6) * PX;
      g.beginPath();
      g.moveTo(0, sy);
      const wobble = (rand() - 0.5) * plankH * 0.5;
      g.bezierCurveTo(size * 0.33, sy + wobble, size * 0.66, sy - wobble, size, sy + wobble * 0.4);
      g.stroke();
    }

    // Knots — a couple of dark ellipses per plank.
    if (rand() > 0.55) {
      const kx = rand() * size;
      const ky = y + plankH * (0.3 + rand() * 0.4);
      const kr = (3 + rand() * 6) * PX;
      const grad = g.createRadialGradient(kx, ky, 0, kx, ky, kr);
      grad.addColorStop(0, 'rgba(48,28,14,0.85)');
      grad.addColorStop(1, 'rgba(48,28,14,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.ellipse(kx, ky, kr, kr * 0.65, 0, 0, Math.PI * 2);
      g.fill();
    }

    // Seam above this plank.
    g.fillStyle = 'rgba(28,16,8,0.85)';
    g.fillRect(0, y, size, 1.6 * PX);

    // One end-joint so planks are not full width.
    const jx = Math.floor(rand() * size);
    g.fillStyle = 'rgba(30,18,9,0.7)';
    g.fillRect(jx, y, 1.4 * PX, plankH);
  }

  addGrain(g, rand, 16);
  return toTexture(g, true, 1);
}

/**
 * Aged plaster wall. Mottled base, soft damp patches and a few hairline cracks — the things
 * that separate "old house" from "grey box".
 *
 * Seamless: every feature is drawn through `tileable()` and nothing is biased toward an edge,
 * because the walls repeat this texture every 2.4 m and any edge-anchored detail would print a
 * grid across them.
 */
export function makePlaster(seed = 4242, tint: 'warm' | 'cool' = 'warm'): CanvasTexture {
  const rand = mulberry32(seed);
  const g = newCtx();
  const size = TEX_SIZE;

  const base = tint === 'warm' ? [84, 84, 86] : [72, 74, 78];
  g.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
  g.fillRect(0, 0, size, size);

  // Soft mottling — overlapping low-contrast radial blobs, wrapped so the tile is seamless.
  for (let i = 0; i < 90; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = (18 + rand() * 90) * PX;
    const shift = (rand() - 0.5) * 20;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(
      0,
      `rgba(${clamp255((base[0] ?? 0) + shift)},${clamp255((base[1] ?? 0) + shift)},${clamp255((base[2] ?? 0) + shift)},0.25)`,
    );
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    tileable(g, around(x, y, r), () => {
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    });
  }

  // Damp/water stains — dark grunge.
  for (let i = 0; i < 6; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = (40 + rand() * 70) * PX;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(40,40,40,0.30)');
    grad.addColorStop(0.6, 'rgba(40,40,40,0.12)');
    grad.addColorStop(1, 'rgba(40,40,40,0)');
    tileable(g, around(x, y, r), () => {
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    });
  }

  // Hairline cracks — subtle distress.
  g.strokeStyle = 'rgba(45,45,45,0.35)';
  for (let c = 0; c < 7; c++) {
    const x0 = rand() * size;
    const y0 = rand() * size;
    const lw = (0.7 + rand() * 0.8) * PX;
    const segs = 5 + Math.floor(rand() * 8);
    const steps: Array<[number, number]> = [];
    for (let s = 0; s < segs; s++) steps.push([(rand() - 0.5) * 40 * PX, rand() * 34 * PX]);
    tileable(g, walkBox(x0, y0, steps, lw), () => {
      let x = x0;
      let y = y0;
      g.lineWidth = lw;
      g.beginPath();
      g.moveTo(x, y);
      for (const [ddx, ddy] of steps) {
        x += ddx;
        y += ddy;
        g.lineTo(x, y);
      }
      g.stroke();
    });
  }

  addGrain(g, rand, 20);
  return toTexture(g, true, 1);
}

/**
 * Vertical-grain wood panel — doors, skirting boards, furniture, ceiling beams.
 * `shade` scales the base tone so one generator covers light trim and near-black beams.
 */
export function makeWoodPanel(seed = 909, shade = 1.0): CanvasTexture {
  const rand = mulberry32(seed);
  const g = newCtx();
  const size = TEX_SIZE;

  g.fillStyle = `rgb(${Math.round(94 * shade)},${Math.round(62 * shade)},${Math.round(36 * shade)})`;
  g.fillRect(0, 0, size, size);

  // Vertical grain — long bezier streaks down the panel.
  for (let s = 0; s < 150; s++) {
    const x = rand() * size;
    const dark = 0.5 + rand() * 0.5;
    g.strokeStyle = `rgba(${Math.round(58 * shade * dark)},${Math.round(36 * shade * dark)},${Math.round(20 * shade * dark)},${0.12 + rand() * 0.28})`;
    g.lineWidth = (0.5 + rand() * 2.2) * PX;
    g.beginPath();
    g.moveTo(x, 0);
    const w = (rand() - 0.5) * 26 * PX;
    g.bezierCurveTo(x + w, size * 0.35, x - w, size * 0.7, x + w * 0.4, size);
    g.stroke();
  }

  // Two horizontal rail shadows so flat panels read as joinery, not a single slab.
  for (const ry of [size * 0.33, size * 0.67]) {
    g.fillStyle = 'rgba(30,18,10,0.45)';
    g.fillRect(0, ry, size, 2.4 * PX);
    g.fillStyle = 'rgba(255,225,190,0.07)';
    g.fillRect(0, ry + 2.4 * PX, size, 2 * PX);
  }

  addGrain(g, rand, 14);
  return toTexture(g, true, 1);
}

/** Dark tongue-and-groove ceiling boards. Narrow planks, low contrast, heavy shadowing. */
export function makeCeilingBoards(seed = 7171): CanvasTexture {
  const rand = mulberry32(seed);
  const g = newCtx();
  const size = TEX_SIZE;
  const boards = 12;
  const h = size / boards;

  g.fillStyle = '#3a2f26';
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < boards; i++) {
    const y = i * h;
    const lum = 0.8 + rand() * 0.3;
    g.fillStyle = `rgb(${Math.round(62 * lum)},${Math.round(50 * lum)},${Math.round(40 * lum)})`;
    g.fillRect(0, y, size, h);
    // Groove between boards.
    g.fillStyle = 'rgba(12,9,7,0.9)';
    g.fillRect(0, y, size, 2 * PX);
  }
  addGrain(g, rand, 12);
  return toTexture(g, true, 1);
}

/** A worn patterned rug — one draw call that does a lot of "this is a lived-in room" work. */
export function makeRug(seed = 2468): CanvasTexture {
  const rand = mulberry32(seed);
  const g = newCtx();
  const size = TEX_SIZE;

  g.fillStyle = '#6d2b28';
  g.fillRect(0, 0, size, size);

  // Border bands.
  const bands: Array<[number, string]> = [
    [0.04, '#3a1614'],
    [0.07, '#a8823c'],
    [0.10, '#3a1614'],
  ];
  for (const [inset, color] of bands) {
    g.strokeStyle = color;
    g.lineWidth = size * 0.022;
    g.strokeRect(size * inset, size * inset, size * (1 - inset * 2), size * (1 - inset * 2));
  }

  // Central medallion.
  g.save();
  g.translate(size / 2, size / 2);
  for (let i = 0; i < 8; i++) {
    g.rotate((Math.PI * 2) / 8);
    g.fillStyle = i % 2 === 0 ? 'rgba(168,130,60,0.75)' : 'rgba(58,22,20,0.75)';
    g.beginPath();
    g.ellipse(size * 0.14, 0, size * 0.075, size * 0.032, 0, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = '#a8823c';
  g.beginPath();
  g.arc(0, 0, size * 0.05, 0, Math.PI * 2);
  g.fill();
  g.restore();

  // Wear — bleached patches where feet land.
  for (let i = 0; i < 26; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = (14 + rand() * 46) * PX;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(190,170,140,0.16)');
    grad.addColorStop(1, 'rgba(190,170,140,0)');
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }

  addGrain(g, rand, 22);
  const t = toTexture(g, true, 1);
  t.wrapS = t.wrapT = RepeatWrapping;
  return t;
}
