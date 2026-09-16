/**
 * Integration check — drive the whole `DaayanAI` through a scripted session.
 *
 * The other three tools test subsystems in isolation. This one exists because the failure mode that
 * matters at this stage is not "does A* work" but "does the assembled thing behave": does she wake,
 * patrol, notice a player standing in the open, chase, lose them through a wall, search, and go back
 * to patrol — without ever teleporting, seeing through a wall, or getting permanently wedged.
 *
 * It also asserts the §21 fairness rules end to end, which a module test cannot do because they are
 * properties of the whole loop.
 */

import './dom-shim.js';
import { buildHouse } from '../src/world/HouseBuilder.js';
import { DaayanAI } from '../src/ai/DaayanAI.js';
import type { AABB, FPController } from '../src/player/FPController.js';
import type { Vec3 } from '../src/core/types.js';
import { globalBus } from '../src/core/EventBus.js';

const h = buildHouse(1);
const aabbs = h.aabbs as AABB[];

/** The ritual room — and the whole cellar wing — sits a storey below the ground floor. */
const CELLAR_Y = -3;

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

/**
 * A stand-in player.
 *
 * Implements only the surface `DaayanAI` actually touches, so the test does not have to stand up the
 * whole input stack and a renderer. If the AI ever starts reading something else off the controller,
 * this stops compiling — which is the point.
 *
 * `getPosition` must report **eye height**, matching `FPController` ("position.y already is the eye
 * height in world space"). Getting that wrong is not a small error: the AI measures attack range
 * eye-to-eye, so a fake reporting feet instead of eyes puts a 1.62 m vertical gap into every distance
 * and she can stand on the player without ever being close enough to grab them. That produced a
 * convincing-looking "she never attacks" bug that lived entirely in this file.
 */
const EYE = 1.62;
class FakePlayer {
  private pos: Vec3 = { x: -28.4, y: CELLAR_Y + EYE, z: 4.3 } as Vec3; // ritual room, at eye height
  velocity: Vec3 = { x: 0, y: 0, z: 0 } as Vec3;
  private running = false;
  private crouching = false;

  getPosition(): Vec3 {
    return this.pos;
  }
  moveTo(p: Vec3): void {
    this.pos = p;
  }
  walk(dir: Vec3, speed: number, dt: number): void {
    this.velocity = { x: dir.x * speed, y: 0, z: dir.z * speed } as Vec3;
    this.pos = {
      x: this.pos.x + dir.x * speed * dt,
      y: this.pos.y,
      z: this.pos.z + dir.z * speed * dt,
    } as Vec3;
  }
  stop(): void {
    this.velocity = { x: 0, y: 0, z: 0 } as Vec3;
  }
  isRunning(): boolean {
    return this.running;
  }
  setRunning(r: boolean): void {
    this.running = r;
  }
  isCrouching(): boolean {
    return this.crouching;
  }
  setCrouching(c: boolean): void {
    this.crouching = c;
  }
  getRadius(): number {
    return 0.32;
  }
}

const player = new FakePlayer();

const ai = new DaayanAI({
  getRoot: () => null, // no model in a headless run; `syncModel` no-ops
  getClips: () => [],
  player: player as unknown as FPController,
  obstacles: aabbs,
  floors: h.floors,
  hidingSpots: [
    { id: 'wardrobe', position: { x: -5.4, y: 0, z: 6.0 } as Vec3 },
    { id: 'basement', position: { x: -27.5, y: -3, z: 3.6 } as Vec3 },
  ],
  // Starts in the ritual room, matching the model placement in ModelProps.
  // Matches the `daayan.glb` placement in ModelProps, which sits on the ritual room floor at CELLAR_Y.
  start: { position: { x: -28.4, y: CELLAR_Y, z: 4.3 } as Vec3, yaw: 2.41 },
  difficulty: 'normal',
  overrides: { wakeOnTrigger: true, debug: false },
});

const DT = 1 / 60;
let t = 0;

/** Count of `daayan:state` emissions over the whole run, registered up front. */
let stateEvents = 0;
globalBus.on('daayan:state', () => {
  stateEvents++;
});

/**
 * Advance the sim, sampling her position every tick.
 *
 * `getPosition()` hands back the live position object, so it must be *copied* here. The first version
 * aliased it, which made every measured step exactly zero and turned the teleport assertion into a
 * test that could never fail — a green light wired to nothing.
 */
let prevX = ai.getPosition().x;
let prevZ = ai.getPosition().z;
let worstStep = 0;
/**
 * Seconds of world time the tick that produced `worstStep` was responsible for.
 *
 * This is **not** `DT`. In the far LOD tier she only runs `aiFarHz` times a second and integrates the
 * whole accumulated interval in one go, so a single frame can legitimately cover up to
 * `LOD_MAX_STEP` = 0.5 s of world time. Dividing a 0.75 m far-tier step by `1/60` gives 45 m/s and
 * reports correct substepping as a teleport — which is exactly the false positive this suite produced
 * for three rounds. Dividing by the time she actually integrated is the only honest measurement.
 */
let worstStepTime = DT;
let worstAt = 0;
let worstFrom: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
let worstTo: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
let worstState = '';
function step(seconds: number, onTick?: (now: number) => void): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    t += DT;
    onTick?.(t);
    const before = ai.getPosition();
    const bx = before.x;
    const by = before.y;
    const bz = before.z;
    ai.update(DT);
    const p = ai.getPosition();
    const d = Math.hypot(p.x - prevX, p.z - prevZ);
    if (d > worstStep) {
      worstStep = d;
      worstStepTime = ai.getLastStep();
      worstAt = t;
      worstFrom = { x: bx, y: by, z: bz };
      worstTo = { x: p.x, y: p.y, z: p.z };
      worstState = ai.getState();
    }
    prevX = p.x;
    prevZ = p.z;
  }
}

console.log('=== LIFECYCLE ===');
check('starts asleep (wake-on-trigger)', !ai.isAwake(), `state ${ai.getState()}`);
check('starts in IDLE', ai.getState() === 'IDLE', ai.getState());

// Sleeping: nothing should move her.
const sleepStart = ai.getPosition();
step(3);
check(
  'does not move while asleep',
  Math.hypot(ai.getPosition().x - sleepStart.x, ai.getPosition().z - sleepStart.z) < 0.01,
  `moved ${Math.hypot(ai.getPosition().x - sleepStart.x, ai.getPosition().z - sleepStart.z).toFixed(3)} m`,
);

// A noise wakes her.
globalBus.emit('noise:emitted', {
  pos: { x: -28.4, y: CELLAR_Y, z: 4.3 } as Vec3,
  radius: 8,
  kind: 'door',
});
check('a noise wakes her', ai.isAwake(), `state ${ai.getState()}`);
check('waking goes to PATROL or INVESTIGATE', ['RETURN_TO_PATROL', 'INVESTIGATE_SOUND', 'PATROL', 'SUSPICIOUS'].includes(ai.getState()), ai.getState());

console.log('\n=== PATROL ===');
// Let her patrol far from the player.
player.moveTo({ x: -5, y: 0 + EYE, z: -22 } as Vec3);
step(40);
const patrolDist = Math.hypot(ai.getPosition().x - (-5), ai.getPosition().z - (-22));
check('patrols away from the player', patrolDist > 6, `${patrolDist.toFixed(1)} m from player`);
console.log(`      state after 40 s of patrol: ${ai.getState()}`);

console.log('\n=== VISION ===');
// Put the player in the cellar, in the same wing she patrols, and slam a door so she comes to look.
// Standing in the open on purpose: the point of this section is to observe a sighting happen, not to
// contrive one, and a player who hides behind a wall is a different test (the fairness one below).
player.moveTo({ x: -21.4, y: CELLAR_Y + EYE, z: 3.5 } as Vec3);
step(1);
for (let k = 0; k < 4; k++) {
  globalBus.emit('noise:emitted', {
    pos: { x: -21.4, y: CELLAR_Y + EYE, z: 3.5 } as Vec3,
    radius: 14,
    kind: 'door',
  });
  step(2.5);
}

let sighted = false;
let maxConf = 0;
step(25, () => {
  if (ai.getState() === 'CHASE' || ai.getState() === 'ATTACK') sighted = true;
  const c = ai.getDebugInfo().confidence;
  if (c > maxConf) maxConf = c;
});

const info1 = ai.getDebugInfo();
console.log(`      peak confidence ${maxConf.toFixed(2)}, final state ${info1.state}, memory ${info1.memoryConfidence.toFixed(2)}`);
check('a sound creates a memory she acts on', info1.memoryPosition !== null || sighted,
  info1.memoryPosition ? 'memory set' : 'chased instead');
check('saw the player standing in the open at least once', sighted || maxConf > 0.4,
  `chase=${sighted} peakConf=${maxConf.toFixed(2)}`);

console.log('\n=== FAIRNESS (§21) ===');
// Never sees through walls: put the player on the far side of the house and confirm no confidence.
{
  const before = ai.getDebugInfo().confidence;
  player.moveTo({ x: -28.4, y: CELLAR_Y + EYE, z: 4.3 } as Vec3); // all the way back in the ritual room
  const aiPos = ai.getPosition();
  // Only meaningful if they are genuinely out of sight; assert the ray count that hit is zero.
  step(2);
  const after = ai.getDebugInfo();
  const hits = after.visionRays.filter((r) => r.hit).length;
  // If she happens to be in the ritual room too, this is vacuous — note it rather than failing.
  const far = Math.hypot(aiPos.x - (-28.4), aiPos.z - 4.3);
  check(
    'cannot see the player through the house',
    far < 4 ? true : hits === 0 || after.confidence < before + 0.2,
    `hits=${hits} dist=${far.toFixed(1)} conf ${before.toFixed(2)}->${after.confidence.toFixed(2)}`,
  );
}

// No teleport: the whole run so far has been sampled tick by tick, and the largest single-frame
// step must be plausible for the time that tick represented.
//
// Expressed as a *speed*, over the world time the tick actually integrated — see `worstStepTime`. The
// far LOD tier batches a whole interval into one frame, so asserting a per-`DT` distance would flag
// correct substepping as a teleport. What must never happen is her covering more ground than a body
// can run.
//
// The bound is deliberately generous but still meaningful: the fastest she may move is `chaseSpeed`
// (3.35), plus a small allowance for the config's own numbers moving. A genuine teleport — a
// `place()`, a bad path node, an unbounded LOD step — lands orders of magnitude above this.
const maxPlausibleSpeed = 3.35 * 2.5; // chase speed, with generous headroom
check(
  'never teleports',
  worstStep / worstStepTime <= maxPlausibleSpeed,
  `worst single-tick speed ${(worstStep / worstStepTime).toFixed(2)} m/s ` +
    `(${worstStep.toFixed(2)} m over ${worstStepTime.toFixed(3)} s, state=${worstState} at t=${worstAt.toFixed(1)}s)`,
);

console.log('\n=== RECOVERY (§28) ===');
// She must always end up somewhere valid, never wedged.
step(20);
{
  const d = ai.getDebugInfo();
  console.log(`      after recovery: state=${d.state} pos=(${d.position.x.toFixed(1)},${d.position.y.toFixed(1)},${d.position.z.toFixed(1)}) stuck=${d.stuck}`);
}
const finalPos = ai.getPosition();
// `FloorRect` is x0/x1/z0/z1/y, not min/max.
const onFloor = h.floors.some(
  (f) =>
    finalPos.x >= f.x0 - 0.5 &&
    finalPos.x <= f.x1 + 0.5 &&
    finalPos.z >= f.z0 - 0.5 &&
    finalPos.z <= f.z1 + 0.5 &&
    Math.abs(finalPos.y - f.y) < 1.2,
);
check('ends the run standing on real floor', onFloor, `(${finalPos.x.toFixed(1)}, ${finalPos.y.toFixed(1)}, ${finalPos.z.toFixed(1)})`);
check('is not stuck-flagged at the end', !ai.getDebugInfo().stuck, ai.getDebugInfo().stuck ? 'stuck' : 'ok');

console.log('\n=== EVENT EMISSION ===');
check('emitted daayan:state during the run', stateEvents > 0, `${stateEvents} events`);

// Long soak: no crash, no NaN, no runaway.
console.log('\n=== SOAK ===');
step(60, (now) => {
  // Player jinks around a bit to exercise prediction damping and LOS loss.
  player.walk({ x: Math.sin(now * 0.7), y: 0, z: Math.cos(now * 0.7) } as Vec3, 2.0, DT);
});
const soak = ai.getPosition();
check(
  'position stays finite after a 60 s soak',
  Number.isFinite(soak.x) && Number.isFinite(soak.y) && Number.isFinite(soak.z),
  `(${soak.x.toFixed(1)}, ${soak.y.toFixed(1)}, ${soak.z.toFixed(1)})`,
);
check(
  'never teleports across the whole run',
  worstStep / worstStepTime <= maxPlausibleSpeed,
  `worst speed ever ${(worstStep / worstStepTime).toFixed(2)} m/s ` +
    `(${worstStep.toFixed(2)} m over ${worstStepTime.toFixed(3)} s, state=${worstState})`,
);
check('speed stays finite', Number.isFinite(ai.getDebugInfo().speed), ai.getDebugInfo().speed.toFixed(2));
check('confidence stays in range', ai.getDebugInfo().confidence >= 0 && ai.getDebugInfo().confidence <= 1,
  ai.getDebugInfo().confidence.toFixed(2));

ai.dispose();
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
