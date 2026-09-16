/**
 * The noise bar's own bug — found by reading the player's screen recording frame by frame.
 *
 * The previous fix made the AI *listen*: `noise:alert` now has a subscriber, is routed through the
 * hearing model with a house-spanning range floor, and is stashed while she is sealed in. All of that
 * is correct, and `playtest-check.ts` BUG 3 proves it — she walks 67 m to within 0.14 m of a maxed bar.
 *
 * But the video shows the bar **full, red, pulsing** while the overlay reads:
 *
 *     STATE: IDLE   AWAKE: NO   SOUND: NONE   LAST HEARD: NONE
 *
 * She is asleep and has heard nothing. Which means the alert never fired at all — the AI half is
 * downstream of a signal that was never sent. The bug is in `NoiseSystem`, not in the AI.
 *
 * ## Root cause
 *
 * `NoiseSystem.update` integrates sprint noise at `RUN_NOISE_RATE * mult * dt`, and `addNoise` clamps
 * to 1.0. The alert fires on the frame the level first reaches exactly 1.0:
 *
 *     this.level = Math.min(1.0, this.level + amount);
 *     if (this.level >= 1.0 && !this.hasAlerted) { ...emit... }
 *
 * With `dt = 1/60` and `RUN_NOISE_RATE = 0.38`, each frame adds `0.38/60 = 0.006333`. Starting from 0
 * the level walks 0.006333, 0.012667, ... and what matters is whether any partial sum lands exactly on
 * 1.0. `0.38/60` is not representable in binary, so the sums carry floating-point error and the last
 * step overshoots: the level jumps from ~0.9967 to a clamped 1.0, and `Math.min` puts it *exactly* at
 * 1.0 — so `>= 1.0` does fire. **But only if the sprint runs long enough to reach the clamp.**
 *
 * The real failure is the one the video shows, and it is a race the player can lose in either
 * direction:
 *
 *   1. `actuallyRunning` requires `moved > 0.001` *this frame* — a player who runs into a wall, or
 *      whose last frame was short, has `isRunning()` return false. On that frame the `else` branch runs
 *      and the bar **decays by `0.22/60 = 0.00367`** — more than half of the sprint gain of 0.006333.
 *      So a sprint that is even slightly stuttery nets out to barely filling at all.
 *   2. The bar visually reads as "full" long before it is full, because `Hud.setNoiseLevel` paints the
 *      fill red and pulsing from `level >= 0.75`. A player at 0.96 sees a full-looking red bar and
 *      reasonably reports "noise max hai" — but 0.96 is below the 1.0 threshold, and the alert is
 *      never emitted.
 *
 * (2) is the honest explanation of the report: **the bar has no maximum that the player can see.** The
 * red state covers a 0.25-wide band, so "I maxed it" and "the game registered a maximum" are different
 * claims, and no on-screen element distinguishes them.
 *
 * ## The fix, as asserted below
 *
 * - The alert must fire on **crossing** a threshold that the UI actually shows, not on landing exactly
 *   on 1.0. `NOISE_ALERT_LEVEL` is that threshold, and the HUD's red band is narrowed to match it, so
 *   "the bar is red" and "she heard it" become the same statement.
 * - Decay must not outrun a stuttering sprint. Decay applies only after a short grace period of not
 *   running, so a single dropped frame cannot undo two frames of sprint.
 */

import './dom-shim.js';
import { globalBus } from '../src/core/EventBus.js';
import { NoiseSystem } from '../src/game/NoiseSystem.js';
import type { Vec3 } from '../src/core/types.js';

const DT = 1 / 60;

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

/** Minimal stand-in for `FPController`: only the three methods `NoiseSystem` actually calls. */
class FakePlayer {
  pos: Vec3 = { x: 0, y: 1.62, z: 0 } as Vec3;
  running = false;
  crouching = false;
  getPosition(): Vec3 {
    return this.pos;
  }
  isRunning(): boolean {
    return this.running;
  }
  isCrouching(): boolean {
    return this.crouching;
  }
}

/** The Daayan parked far away, so the distance multiplier sits at its floor (0.25). */
const FAR: Vec3 = { x: 0, y: 0, z: 40 } as Vec3;

function make(): { sys: NoiseSystem; player: FakePlayer; alerts: number[] } {
  const player = new FakePlayer();
  const alerts: number[] = [];
  const off = globalBus.on('noise:alert', (e) => alerts.push(e.level));
  const sys = new NoiseSystem({ player, getDaayanPos: () => FAR });
  // `off` is dropped when the suite exits, which is fine for a one-shot process.
  void off;
  return { sys, player, alerts };
}

// ---------------------------------------------------------------------------
// 1. THE REPORTED BUG: the bar LOOKS full and the alert never fires.
// ---------------------------------------------------------------------------
console.log('=== BUG: A BAR THAT READS AS FULL MUST FIRE THE ALERT ===');
{
  const { sys, player, alerts } = make();
  player.running = true;

  // Sprint for as long as a player would before concluding "it is maxed". At `RUN_NOISE_RATE` 0.38/s
  // and the far multiplier 0.25 the net gain is 0.095/s, so 20 s is a generous read of "I held run".
  let visualFullAt = -1;
  for (let t = 0; t < 20; t += DT) {
    sys.update(DT, true);
    if (visualFullAt < 0 && sys.getLevel() >= 0.75) visualFullAt = t;
  }

  console.log(
    `      after 20 s of held sprint: level=${sys.getLevel().toFixed(3)}, ` +
      `first looked full at ${visualFullAt < 0 ? 'never' : `${visualFullAt.toFixed(1)} s`}, ` +
      `alerts=${alerts.length}`,
  );

  check('a sustained sprint does eventually reach the alert', alerts.length >= 1, `${alerts.length} alert(s)`);
  // The alert fires on *entering the full band*, not on landing exactly on 1.0 — see `ALERT_LEVEL`. So
  // the assertion is that it fired at or above the band boundary, and that the band boundary is the
  // same value the HUD paints red.
  check(
    'the alert fires as the bar enters its full band',
    alerts.length > 0 && alerts[0] >= NoiseSystem.ALERT_LEVEL,
    alerts.length ? `alert at ${alerts[0].toFixed(3)}, band starts at ${NoiseSystem.ALERT_LEVEL}` : 'no alert',
  );
  check(
    'the alert level is the level the HUD paints red',
    NoiseSystem.ALERT_LEVEL === 0.75,
    `ALERT_LEVEL=${NoiseSystem.ALERT_LEVEL}`,
  );
}

// ---------------------------------------------------------------------------
// 2. THE REAL FAILURE MODE: a stuttering sprint never fills the bar.
// ---------------------------------------------------------------------------
console.log('\n=== A STUTTERING SPRINT MUST STILL FILL THE BAR ===');
{
  const { sys, player, alerts } = make();

  // One dropped frame in four: `actuallyRunning` is false on that frame because `moved > 0.001` failed
  // — running into a wall corner, or a hitch. This is the sequence the video shows.
  let runningFrames = 0;
  for (let i = 0; i < 60 * 20; i++) {
    const running = i % 4 !== 0;
    player.running = running;
    if (running) runningFrames++;
    sys.update(DT, running);
  }

  console.log(
    `      ${runningFrames} of ${60 * 20} frames running: level=${sys.getLevel().toFixed(3)}, alerts=${alerts.length}`,
  );

  check('a stuttering sprint still fills the bar', sys.getLevel() >= 0.99, `level ${sys.getLevel().toFixed(3)}`);
  check('and still fires the alert', alerts.length >= 1, `${alerts.length} alert(s)`);
}

// ---------------------------------------------------------------------------
// 3. The alert is an edge, not a level: no machine-gunning while the bar sits high.
// ---------------------------------------------------------------------------
console.log('\n=== THE ALERT FIRES ONCE PER CROSSING, NOT EVERY FRAME ===');
{
  const { sys, player, alerts } = make();
  player.running = true;

  // 30 s held: the bar is above the threshold for most of it.
  for (let i = 0; i < 60 * 30; i++) sys.update(DT, true);

  console.log(`      30 s held: level=${sys.getLevel().toFixed(3)}, alerts=${alerts.length}`);
  check('one alert per sustained max, not one per frame', alerts.length === 1, `${alerts.length} alert(s)`);
}

// ---------------------------------------------------------------------------
// 4. It re-arms: a second max after a real lull must be heard again.
// ---------------------------------------------------------------------------
console.log('\n=== A SECOND MAX, AFTER A LULL, IS HEARD AGAIN ===');
{
  const { sys, player, alerts } = make();

  player.running = true;
  for (let i = 0; i < 60 * 12; i++) sys.update(DT, true);
  const afterFirst = alerts.length;

  // Quiet long enough to fall well below the re-arm point.
  player.running = false;
  for (let i = 0; i < 60 * 12; i++) sys.update(DT, false);
  const levelAfterLull = sys.getLevel();

  player.running = true;
  for (let i = 0; i < 60 * 12; i++) sys.update(DT, true);

  console.log(
    `      first burst -> ${afterFirst} alert(s); lull dropped to ${levelAfterLull.toFixed(3)}; ` +
      `second burst -> ${alerts.length} alert(s)`,
  );

  check('the first burst alerts', afterFirst >= 1, `${afterFirst} alert(s)`);
  check('a lull re-arms the alert', levelAfterLull < 0.5, `level ${levelAfterLull.toFixed(3)}`);
  check('the second burst alerts again', alerts.length > afterFirst, `${alerts.length} alert(s) total`);
}

// ---------------------------------------------------------------------------
// 5. Standing still stays silent.
// ---------------------------------------------------------------------------
console.log('\n=== WALKING AND STANDING STILL MUST NOT MAX THE BAR ===');
{
  const { sys, player, alerts } = make();
  player.running = false;

  for (let i = 0; i < 60 * 60; i++) sys.update(DT, false);

  console.log(`      60 s idle: level=${sys.getLevel().toFixed(3)}, alerts=${alerts.length}`);
  check('a minute of standing still fires nothing', alerts.length === 0, `${alerts.length} alert(s)`);
  check('and the bar sits at zero', sys.getLevel() === 0, `level ${sys.getLevel().toFixed(3)}`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
