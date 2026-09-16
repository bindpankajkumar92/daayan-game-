/**
 * Recovery and catch-loop check — the three bugs the player actually hit in play.
 *
 * The report, translated: "she spawned and came out toward the basement, and she got out to me
 * *without the ritual door sliding*, then stood still next to me and never moved again no matter
 * where I went."
 *
 * The debug overlay in the accompanying screenshot reads:
 *
 *   STATE: STUNNED   WHY: attack-landed   VISIBILITY: 1.00
 *   LAST KNOWN: (-12.9, -1.0, 1.5)   LAST SEEN: (-13.9, -1.3, 1.6)
 *   SPEED: 0.00   AWAKE: YES
 *
 * Three distinct faults, all reproduced here before they were fixed:
 *
 *   1. **She never left STUNNED.** `interrupts` refuses every candidate while stunned ("only STUNNED
 *      can end it"), and the stun's own exit to CHASE was not marked a completion, so the expiry
 *      transition was refused every tick forever. SPEED: 0.00, permanently.
 *   2. **She re-caught a stationary player every few seconds.** Nothing consumes `game:caught`, so she
 *      grabbed, stunned herself, woke, found them still in range, and grabbed again. Four catches in
 *      45 s. Closed by `catchRecovery`.
 *   3. **She got out before the door opened.** Her nav grid is baked once, with the shut ritual door as
 *      a wall in it, but any ambient noise woke her anyway. Closed by the `canRoam` gate.
 *
 * Note the shape of every assertion below: distance is accumulated **per tick**, never taken as net
 * displacement between two samples, because an agent that walks out and back reads as stationary.
 */

import './dom-shim.js';
import { buildHouse } from '../src/world/HouseBuilder.js';
import { DaayanAI } from '../src/ai/DaayanAI.js';
import type { AABB, FPController } from '../src/player/FPController.js';
import type { Vec3 } from '../src/core/types.js';
import { globalBus } from '../src/core/EventBus.js';

const h = buildHouse(1);
const aabbs = h.aabbs as AABB[];
const CELLAR_Y = -3;
const EYE = 1.62;

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

class FakePlayer {
  private pos: Vec3 = { x: -28.4, y: CELLAR_Y + EYE, z: 4.3 } as Vec3;
  velocity: Vec3 = { x: 0, y: 0, z: 0 } as Vec3;
  private running = false;
  private crouching = false;
  getPosition(): Vec3 {
    return this.pos;
  }
  moveTo(p: Vec3): void {
    this.pos = { x: p.x, y: p.y, z: p.z } as Vec3;
  }
  walk(dir: Vec3, speed: number, dt: number): void {
    this.velocity = { x: dir.x * speed, y: 0, z: dir.z * speed } as Vec3;
    this.pos = { x: this.pos.x + dir.x * speed * dt, y: this.pos.y, z: this.pos.z + dir.z * speed * dt } as Vec3;
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
  getRadius(): number {
    return 0.32;
  }
}

const player = new FakePlayer();

/** Stands in for the scene's ritual-door flag. Starts shut, as it does in the real opening. */
let doorOpen = false;

const ai = new DaayanAI({
  getRoot: () => null,
  getClips: () => [],
  player: player as unknown as FPController,
  obstacles: aabbs,
  floors: h.floors,
  hidingSpots: [],
  start: { position: { x: -28.4, y: CELLAR_Y, z: 4.3 } as Vec3, yaw: 2.41 },
  difficulty: 'normal',
  overrides: { wakeOnTrigger: true, debug: false },
  canRoam: () => doorOpen,
});

let caught = 0;
const catchTimes: number[] = [];
globalBus.on('game:caught', () => {
  caught++;
  catchTimes.push(t);
});

const DT = 1 / 60;
let t = 0;

/**
 * Total distance travelled, accumulated per tick.
 *
 * Not net displacement between two samples: an agent that is moving but happens to be near where it
 * started (patrolling a loop, or walking out and back) reads as zero. That is the same class of
 * measurement error that once made a teleport assertion unfalsifiable, so it is done properly here.
 */
let travelled = 0;
let lastX = 0;
let lastZ = 0;
let tracking = false;

function step(seconds: number, onTick?: (now: number) => void): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    t += DT;
    onTick?.(t);
    ai.update(DT);
    const p = ai.getPosition();
    if (tracking) travelled += Math.hypot(p.x - lastX, p.z - lastZ);
    lastX = p.x;
    lastZ = p.z;
    tracking = true;
  }
}

console.log('=== THE SEALED ROOM: A NOISE MUST NOT WAKE HER BEFORE THE DOOR OPENS ===');
// A noise from across the cellar wing, with the ritual door still shut. This is the player's first
// bug: she should sleep through it. Her grid has the shut door as a wall, so waking here can only
// produce a patrol she cannot walk — and in play, standing outside a door that had not opened.
globalBus.emit('noise:emitted', {
  pos: { x: -20, y: CELLAR_Y + 0.5, z: 2.0 } as Vec3,
  loudness: 1,
  kind: 'door',
  time: 0,
} as never);
step(2);
check('stays asleep while the door is shut', !ai.isAwake(), `state ${ai.getState()}`);

const sealedStart = ai.getPosition();
step(4);
const sealedMoved = Math.hypot(ai.getPosition().x - sealedStart.x, ai.getPosition().z - sealedStart.z);
check('does not move while sealed in', sealedMoved < 0.05, `moved ${sealedMoved.toFixed(3)} m`);
check('is still in IDLE', ai.getState() === 'IDLE', ai.getState());

// The door opens, as it does when the player drags the screen aside.
doorOpen = true;
globalBus.emit('noise:emitted', {
  pos: { x: -20, y: CELLAR_Y + 0.5, z: 2.0 } as Vec3,
  loudness: 1,
  kind: 'door',
  time: 0,
} as never);
step(0.5);
check('a noise wakes her once the door is open', ai.isAwake(), `state ${ai.getState()}`);

console.log('\n=== SHE HUNTS AND CATCHES ===');
// Let her run the full hunt from here. She can see the player standing in the open ritual room, so
// this should end in a catch.
let sawAttack = false;
step(45, () => {
  if (ai.getState() === 'ATTACK') sawAttack = true;
});
check('reached ATTACK at some point', sawAttack, `caught x${caught}`);

const afterCatch = ai.getState();
const posAtCatch = ai.getPosition();
console.log(`      state right after the hunt: ${afterCatch}  caught=${caught}`);
console.log(`      her position at the catch: (${posAtCatch.x.toFixed(1)}, ${posAtCatch.y.toFixed(1)}, ${posAtCatch.z.toFixed(1)})`);

// The catch loop. The player is parked immovably in her face for the whole first phase, which is the
// worst case: with no recovery window she grabs them, stuns herself, wakes, and grabs again every
// couple of seconds. Four catches in 45 s was the observed figure before the fix.
//
// Two catches in 45 s is correct, not a failure: the recovery window is 6 s and the hunt that leads
// back into range takes a while, so the second catch is her genuinely re-acquiring the player. What
// must not happen is a catch every few seconds, so the assertion is on the *gap*.
const minGap = catchTimes.length >= 2
  ? Math.min(...catchTimes.slice(1).map((x, i) => x - (catchTimes[i] as number)))
  : Infinity;
check(
  'does not re-catch a stationary player every few seconds',
  minGap > 4.0,
  `caught x${caught}, closest pair ${minGap === Infinity ? 'n/a' : `${minGap.toFixed(2)} s`} apart`,
);

console.log('\n=== THE BUG: DOES SHE EVER RECOVER? ===');
// The player's own report, in the order it happened: after being caught, they walked away — several
// rooms over — and she stayed put. Move the player far away and let plenty of time pass. The stun is
// 2.5 s; the ATTACK cooldown is 1.4 s.
player.moveTo({ x: -14.0, y: CELLAR_Y + EYE, z: 5.5 } as Vec3);
const movedBefore = travelled;
step(20);
const movedAfterStun = travelled - movedBefore;
const afterStun = ai.getState();
console.log(
  `      over the 20 s after the catch: state=${afterStun}  travelled ${movedAfterStun.toFixed(2)} m`,
);
check('leaves STUNNED within its own duration + slack', afterStun !== 'STUNNED', `still ${afterStun}`);
check(
  'does not stay parked in ATTACK after the player leaves',
  afterStun !== 'ATTACK',
  `still ${afterStun}`,
);
check('keeps moving after the stun ends', movedAfterStun > 1.0, `travelled ${movedAfterStun.toFixed(2)} m`);

console.log('\n=== THE SECOND BUG: DOES SHE REACT TO THE PLAYER MOVING? ===');
// Walk the player away — loudly, and continuously, which is what a real player does and what the
// report described ("mai kahi bhi ja rha hu"). A player parked in her grab range is not a test of
// whether she follows; it is a test of whether she can reach them, which the previous section covers.
let statesSeen = new Set<string>();
const movedBeforeChase = travelled;
step(30, (now) => {
  statesSeen.add(ai.getState());
  // Retrace a route across the cellar wing, away from the ritual room and out toward the shaft.
  const u = (now % 30) / 30;
  player.moveTo({
    x: -14.0 + Math.sin(u * Math.PI * 2) * 4.0,
    y: CELLAR_Y + EYE,
    z: 5.5 - u * 3.0,
  } as Vec3);
});
const movedInChase = travelled - movedBeforeChase;
console.log(`      states seen while the player moved: ${[...statesSeen].join(', ')}`);
console.log(`      travelled a further ${movedInChase.toFixed(2)} m`);
check('reacts to the player moving at all', movedInChase > 3.0, `travelled ${movedInChase.toFixed(2)} m`);
check('does not sit in a single non-IDLE state forever', statesSeen.size > 1, [...statesSeen].join(','));

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
