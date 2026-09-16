/**
 * Can a player actually max the noise bar by holding Run in a small room?
 *
 * This is the third report of the same symptom — "noise max kar rha hu phir bhi daayan ko nahi pata
 * chal rha hai" — and the first two fixes were both real but both incomplete:
 *
 *   1. `noise:alert` had no subscriber, so nothing listened. Fixed: `DaayanAI` subscribes.
 *   2. The alert only fired on landing on exactly 1.0 while the HUD painted the bar full from 0.75,
 *      and decay outran a stuttering sprint. Fixed: `ALERT_LEVEL` shared with `Hud`, `DECAY_GRACE`.
 *
 * Both of those were about the *bar* and the *listener*. Neither asked the question this suite asks:
 * **can the player get the bar to the threshold in the first place, in a house made of small rooms?**
 *
 * ## What the recording showed
 *
 * Measuring the bar in the video frame by frame: it climbs smoothly from 0.37 and then sits at
 * **0.930 for eight seconds**, flat, while the debug overlay reads:
 *
 *     STATE: PATROL   LAST KNOWN: NONE   LAST SEEN: NONE   LAST HEARD: (empty)
 *     SOUND: (-4.0,1.7,1.0) @0.18   AWARE: YES
 *
 * She is patrolling, has never heard anything above 0.18, and the bar is at 93%. The alert — which
 * delivers loudness 1.0 — never fired. A flat plateau below the threshold means the level genuinely
 * stopped rising, and the only thing that stops it rising is the gait gate.
 *
 * ## Root cause
 *
 * `FPController` decided `actuallyRunning` with:
 *
 *     this.running && !crouching && onGround && wants && (moved > 0.001)
 *
 * That last term asks a *displacement* question to answer an *intent* question. `moveAxis` slides
 * per-axis and rejects an axis outright on contact, so in a small room — the entire game — a
 * sprinting player's `moved` collapses to ~0 on every frame they brush a wall. And the noise system
 * bills every such frame as *decay*, which is 2.3× the sprint gain at range.
 *
 * Measured by driving the real controller in a 3 m room, sprinting wall to wall for 20 s:
 *
 *     before:  running on 35.4% of frames -> bar 0.114, 0 alerts
 *     after:   running on 54.5% of frames -> bar 1.000, 1 alert
 *
 * Four metres was barely better before (0.566, 0 alerts) and is clean after.
 *
 * ## The fix, as asserted below
 *
 * Two halves, and both are needed:
 *
 * - `FPController` remembers a sprint for `RUN_MEMORY` (0.3 s) after the last frame that actually
 *   covered ground, so a wall does not end the gait. `moved` still gates the *footstep*, which is
 *   right — a player pressed against a wall should not keep playing footsteps.
 * - `NoiseSystem` holds the level, neither building nor draining, while the run control is still held
 *   but the body is blocked. Once the control is released the usual grace and decay apply.
 *
 * The second is what makes this robust rather than merely better: the first alone took the 3 m room
 * to 0.527, still short, because a player pinned in a corner can be blocked for far longer than any
 * grace period is willing to cover.
 */

import '../tools/dom-shim.js';
import { Vector3, PerspectiveCamera } from 'three';
import { FPController } from '../src/player/FPController.js';
import { NoiseSystem } from '../src/game/NoiseSystem.js';
import { globalBus } from '../src/core/EventBus.js';
import type { Vec3 } from '../src/core/types.js';

const DT = 1 / 60;

/** The Daayan parked far away, so the distance multiplier sits at its floor (0.25). */
const FAR: Vec3 = { x: 0, y: 0, z: 40 } as Vec3;

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

/**
 * The members `FPController` actually touches on `Engine`, stubbed because Node has no WebGL.
 * The gait decision and the collision slide are pure maths and do not need a renderer.
 */
const engine = {
  camera: new PerspectiveCamera(70, 1, 0.1, 100),
  getTempVec3A: () => new Vector3(),
  getTempVec3B: () => new Vector3(),
  getTempVec3C: () => new Vector3(),
} as unknown as ConstructorParameters<typeof FPController>[0];

/** A square cell, walls 0.2 m thick, floor at y = 0, with the player centred in it. */
function makeRoom(size: number): FPController {
  const T = 0.2;
  const H = 3.0;
  const p = new FPController(engine);
  p.setAabbs([
    { minX: -T, minY: 0, minZ: -T, maxX: size + T, maxY: H, maxZ: 0 },
    { minX: -T, minY: 0, minZ: size, maxX: size + T, maxY: H, maxZ: size + T },
    { minX: -T, minY: 0, minZ: -T, maxX: 0, maxY: H, maxZ: size + T },
    { minX: size, minY: 0, minZ: -T, maxX: size + T, maxY: H, maxZ: size + T },
  ]);
  p.setFloors([{ x0: -2, x1: size + 2, z0: -2, z1: size + 2, y: 0 }]);
  p.warpTo(new Vector3(size / 2, 1.62, size / 2));
  return p;
}

/** Collect the alerts a sprint produces, and how much of it registered as running. */
function sprint(
  size: number,
  seconds: number,
  drive: (p: FPController, i: number, total: number) => void,
): { level: number; alerts: number[]; runPct: number } {
  const p = makeRoom(size);
  const alerts: number[] = [];
  const off = globalBus.on('noise:alert', (e) => alerts.push(e.level));
  const sys = new NoiseSystem({ player: p, getDaayanPos: () => FAR });
  p.setRun(true);

  const total = Math.round(seconds / DT);
  let runFrames = 0;
  for (let i = 0; i < total; i++) {
    drive(p, i, total);
    const run = p.isRunning();
    if (run) runFrames++;
    sys.update(DT, run);
  }
  off();
  return { level: sys.getLevel(), alerts, runPct: (runFrames / total) * 100 };
}

/** Sprint wall to wall along one axis, reversing at each end. Turns around, as a player would. */
function shuttle(p: FPController, i: number): void {
  const dir = Math.floor((i * DT) / 1.6) % 2 === 0 ? 1 : -1;
  p.look(dir > 0 ? Math.PI : 0, 0);
  p.move(0, 1, DT);
}

/** Sprint laps around a rectangle just inside the walls. */
function laps(size: number) {
  const r = size / 2 + 0.28; // deliberately overshoots, so the player scrapes the walls
  const cx = size / 2;
  const cz = size / 2;
  const perimeter = 8 * r;
  const lapsCount = (4.0 * 20) / perimeter;
  return (p: FPController, i: number, total: number): void => {
    const s = ((i / total) * lapsCount * perimeter) % perimeter;
    const q = perimeter / 4;
    let tx: number;
    let tz: number;
    if (s < q) {
      tx = cx - r + s;
      tz = cz - r;
    } else if (s < 2 * q) {
      tx = cx + r;
      tz = cz - r + (s - q);
    } else if (s < 3 * q) {
      tx = cx + r - (s - 2 * q);
      tz = cz + r;
    } else {
      tx = cx - r;
      tz = cz + r - (s - 3 * q);
    }
    const pos = p.getPosition();
    p.look(Math.atan2(-(tx - pos.x), -(tz - pos.z)), 0);
    p.move(0, 1, DT);
  };
}

// ---------------------------------------------------------------------------
// 1. THE REPORTED BUG: a cupboard-sized room must still let the bar fill.
// ---------------------------------------------------------------------------
console.log('=== A SMALL ROOM MUST NOT MAKE THE BAR UNFILLABLE ===');
{
  const r = sprint(3.0, 20, (p, i) => shuttle(p, i));
  console.log(
    `      3 m room, wall-to-wall sprint: running ${r.runPct.toFixed(1)}% of frames, ` +
      `level=${r.level.toFixed(3)}, alerts=${r.alerts.length}`,
  );
  check('the bar reaches its maximum in a 3 m room', r.level >= 0.99, `level ${r.level.toFixed(3)}`);
  check('and the alert fires', r.alerts.length >= 1, `${r.alerts.length} alert(s)`);
}

console.log('\n=== AND IN THE SIZES EITHER SIDE OF IT ===');
for (const size of [4.0, 6.0]) {
  const r = sprint(size, 20, (p, i) => shuttle(p, i));
  console.log(
    `      ${size} m room: running ${r.runPct.toFixed(1)}%, level=${r.level.toFixed(3)}, ` +
      `alerts=${r.alerts.length}`,
  );
  check(`the bar reaches maximum in a ${size} m room`, r.level >= 0.99, `level ${r.level.toFixed(3)}`);
  check(`the alert fires in a ${size} m room`, r.alerts.length >= 1, `${r.alerts.length} alert(s)`);
}

// ---------------------------------------------------------------------------
// 2. A lap that scrapes the walls — the gait must survive continuous contact.
// ---------------------------------------------------------------------------
console.log('\n=== A SPRINT THAT SCRAPES THE WALLS STILL COUNTS AS RUNNING ===');
{
  const r = sprint(3.0, 20, laps(3.0));
  console.log(
    `      3 m room, wall-scraping laps: running ${r.runPct.toFixed(1)}% of frames, ` +
      `level=${r.level.toFixed(3)}, alerts=${r.alerts.length}`,
  );
  check(
    'almost every frame of a scraping sprint counts as running',
    r.runPct > 95,
    `${r.runPct.toFixed(1)}%`,
  );
  check('the bar fills', r.level >= 0.99, `level ${r.level.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// 3. The other direction: releasing run must still drain the bar, promptly.
// ---------------------------------------------------------------------------
console.log('\n=== LETTING GO STILL DRAINS THE BAR ===');
{
  const p = makeRoom(3.0);
  const alerts: number[] = [];
  globalBus.on('noise:alert', (e) => alerts.push(e.level));
  const sys = new NoiseSystem({ player: p, getDaayanPos: () => FAR });
  p.setRun(true);
  for (let i = 0; i < 60 * 20; i++) {
    shuttle(p, i);
    sys.update(DT, p.isRunning());
  }
  const peaked = sys.getLevel();

  // Release the control and stand still.
  p.setRun(false);
  const atRelease = sys.getLevel();
  for (let i = 0; i < 60 * 8; i++) {
    p.move(0, 0, DT);
    sys.update(DT, p.isRunning());
  }
  console.log(
    `      peaked ${peaked.toFixed(3)} -> at release ${atRelease.toFixed(3)} -> ` +
      `after 8 s still ${sys.getLevel().toFixed(3)}`,
  );
  check('the bar was maxed before the release', peaked >= 0.99, `${peaked.toFixed(3)}`);
  check('releasing run drains the bar', sys.getLevel() < 0.05, `${sys.getLevel().toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// 4. Standing still from the start never fills anything.
// ---------------------------------------------------------------------------
console.log('\n=== STANDING STILL IS STILL SILENT ===');
{
  const r = sprint(3.0, 30, (p) => p.move(0, 0, DT));
  console.log(`      30 s idle: level=${r.level.toFixed(3)}, alerts=${r.alerts.length}`);
  check('standing still fires nothing', r.alerts.length === 0, `${r.alerts.length} alert(s)`);
  check('and the bar stays at zero', r.level === 0, `level ${r.level.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// 5. Walking (run never pressed) must not fill the bar either.
// ---------------------------------------------------------------------------
console.log('\n=== WALKING MUST NOT MAX THE BAR ===');
{
  const p = makeRoom(3.0);
  const alerts: number[] = [];
  globalBus.on('noise:alert', (e) => alerts.push(e.level));
  const sys = new NoiseSystem({ player: p, getDaayanPos: () => FAR });
  p.setRun(false);
  for (let i = 0; i < 60 * 30; i++) {
    shuttle(p, i);
    sys.update(DT, p.isRunning());
  }
  console.log(`      30 s walking: level=${sys.getLevel().toFixed(3)}, alerts=${alerts.length}`);
  check('walking never reaches the alert', alerts.length === 0, `${alerts.length} alert(s)`);
  check('a walking bar stays low', sys.getLevel() < 0.5, `level ${sys.getLevel().toFixed(3)}`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
