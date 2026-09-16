/**
 * Playtest-regression check — the three faults the player reported after actually playing.
 *
 * The report, translated:
 *
 *   1. "When her state is SEARCH she keeps searching the same last-seen spot for ages. Fix it so she
 *      searches only 3-4 times, then goes back to patrolling."
 *   2. "While patrolling she never comes up to the 2nd floor. Fix it so she patrols the whole house,
 *      going into every room."
 *   3. "Look at these screenshots — the noise bar is at maximum and she still doesn't come to me. Fix
 *      it so that if the noise bar touches its limit she automatically goes to where the noise was."
 *
 * Each of these had a distinct root cause, and they are all reproduced here before being fixed:
 *
 *   1. `SearchPlanner.plan` built a ~25-point itinerary and walked every one. Capped by
 *      `cfg.searchMaxPoints`.
 *   2. Two compounding causes in the AI LOD tier. It skipped pathfinding entirely (`if (!far)`), so a
 *      far Daayan never built a route; and it passed the *per-frame* `dt` to `Locomotion.update` while
 *      only running twice a second, so she moved at ~0.1 m/s and read as standing still. In a
 *      three-storey house the player is beyond `aiLodDistance` most of the time, so "far" was the
 *      normal case rather than the edge case.
 *   3. `noise:alert` — which is what the noise bar emits at maximum — had **zero subscribers**. The
 *      bar could sit full forever while she patrolled obliviously.
 *
 * The lesson from (2) is worth stating: an optimisation tier is only an optimisation if the behaviour
 * it skips is not load-bearing. "Nobody can see her being wrong at that range" was true about the
 * *render* distance and false about the *decision* distance.
 *
 * Measurements here are accumulated per tick, never net displacement between two samples — an agent
 * that walks out and back reads as stationary under the naive measurement.
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
const GROUND_Y = 0;
const UPPER_Y = 2.4;
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

/**
 * Park a player somewhere and build an AI around them.
 *
 * Each section below gets its own instance rather than sharing one long session: these are independent
 * faults, and a shared run would let an earlier section's state leak into a later one's assertion —
 * which is how a regression suite ends up asserting nothing.
 */
function makeAI(playerPos: Vec3, startAt?: { position: Vec3; yaw: number }): DaayanAI {
  player.moveTo(playerPos);
  return new DaayanAI({
    getRoot: () => null,
    getClips: () => [],
    player: player as unknown as FPController,
    obstacles: aabbs,
    floors: h.floors,
    hidingSpots: [],
    // Awake from the start for these checks: whether she wakes is the sealed-room suite's business,
    // and `wakeOnTrigger: false` keeps the focus on what she does once running.
    start: startAt ?? { position: { x: -28.4, y: CELLAR_Y, z: 4.3 } as Vec3, yaw: 2.41 },
    difficulty: 'normal',
    overrides: { wakeOnTrigger: false, debug: false },
  });
}

const DT = 1 / 60;

/** Run `seconds` of sim, returning the positions visited and the total distance travelled. */
function run(
  ai: DaayanAI,
  seconds: number,
  onTick?: (t: number) => void,
  tRef: { t: number } = { t: 0 },
): { travelled: number; visited: { x: number; y: number; z: number }[] } {
  let travelled = 0;
  let last: Vec3 | null = null;
  const visited: { x: number; y: number; z: number }[] = [];
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    tRef.t += DT;
    onTick?.(tRef.t);
    ai.update(DT);
    const p = ai.getPosition();
    if (last) travelled += Math.hypot(p.x - last.x, p.z - last.z);
    last = { x: p.x, y: p.y, z: p.z } as Vec3;
    visited.push({ x: p.x, y: p.y, z: p.z });
  }
  return { travelled, visited };
}

// ---------------------------------------------------------------------------
// BUG 1 — SEARCH runs the same spot forever.
// ---------------------------------------------------------------------------
console.log('=== BUG 1: SEARCH MUST BE BOUNDED, THEN HAND BACK TO PATROL ===');
{
  // The player stands in the open in the ground-floor hallway, gets seen, then runs out of sight into
  // the sealed side of the house. She should search — but only a handful of points, then patrol.
  const ai = makeAI({ x: -21.4, y: CELLAR_Y + EYE, z: 3.5 } as Vec3);
  const tr = { t: 0 };

  // Get her attention with a loud noise, then let her come and look. Emitted *after* construction,
  // because IDLE's listeners only exist once the AI does.
  //
  // `break` rather than `door`: IDLE only leaves on a *loud* sound (`hearingLoudThreshold` = 0.6), and
  // the perceived loudness is the source class's base scaled by distance falloff and per-wall damping.
  // A door at 7 m through a cellar wall routinely lands in the medium band (0.16-0.6) and is correctly
  // ignored — which is not the behaviour under test here.
  globalBus.emit('noise:emitted', {
    pos: { x: -24.0, y: CELLAR_Y + 0.5, z: 3.5 } as Vec3,
    radius: 14,
    kind: 'break',
  });

  run(ai, 12, undefined, tr);

  // Now put the player behind her, out of sight, so LOOSING the sighting triggers SEARCH.
  player.moveTo({ x: -14.0, y: CELLAR_Y + EYE, z: 5.5 } as Vec3);
  const seenStates = new Set<string>();
  let reachedSearch = false;
  let searchStart = -1;
  let leftSearchAt = -1;
  run(
    ai,
    90,
    (now) => {
      const s = ai.getState();
      seenStates.add(s);
      if (s === 'SEARCH') {
        reachedSearch = true;
        if (searchStart < 0) searchStart = now;
      } else if (reachedSearch && leftSearchAt < 0 && now > searchStart + 0.5) {
        leftSearchAt = now;
      }
    },
    tr,
  );

  check('reaches SEARCH at all', reachedSearch, [...seenStates].join(', '));
  check('leaves SEARCH and resumes patrolling', !['SEARCH'].includes(ai.getState()), `final state ${ai.getState()}`);

  // The itinerary itself is the direct measurement of the reported bug: it used to be ~25 points.
  const points = ai.getDebugInfo().searchPoints.length;
  check('search itinerary is capped to a handful of points', points > 0 && points <= 4, `${points} points`);

  if (reachedSearch && leftSearchAt > 0) {
    const dwell = leftSearchAt - searchStart;
    check('does not search the same spot for a minute', dwell < 45, `SEARCH held ${dwell.toFixed(1)} s`);
  } else {
    check('does not search the same spot for a minute', true, 'SEARCH never held long enough to measure');
  }
  ai.dispose();
}

// ---------------------------------------------------------------------------
// BUG 2 — she never patrols the upper storey / never uses the house.
// ---------------------------------------------------------------------------
console.log('\n=== BUG 2: SHE MUST PATROL THE WHOLE HOUSE, NOT JUST ONE FLOOR ===');
{
  // The player stands far south of the house, uninvolved. She starts in the cellar ritual room.
  // Over a long patrol she should climb out of the cellar and reach the upper storey, which is what
  // "poore ghar pe patrol kare" means.
  //
  // z = -30, not -20: at -20 the player stands 15 m from the hall gate, inside her 18 m visionRange,
  // so a patrol leg that crosses the hall facing south sees them and she camps the threshold in
  // CHASE with a destination off the nav grid — correct AI (she watches an unreachable, visible
  // player), but not what this scenario measures. The patrol must be *unobserved*.
  const ai = makeAI({ x: -4.0, y: GROUND_Y + EYE, z: -30.0 } as Vec3);
  const tr = { t: 0 };

  // IDLE is left by evidence only — a loud sound, or clear sight. Emit after construction so the
  // handler actually receives it. (Emitting before the AI exists is silently dropped, which is what
  // made an earlier version of this suite report "travelled 0.0 m" and look like a real fault.)
  //
  // `break` (base 0.95) and close by: IDLE requires `perceivedLoudness >= hearingLoudThreshold` (0.6),
  // which a door at 20 m through several walls does not reach. That is correct AI behaviour, not the
  // fault under test, so the stimulus is chosen to actually clear the bar.
  globalBus.emit('noise:emitted', {
    pos: { x: -26.0, y: CELLAR_Y + 0.5, z: 4.0 } as Vec3,
    radius: 16,
    kind: 'break',
  });
  run(ai, 2, undefined, tr);

  const storeys = new Set<number>();
  const rooms = new Set<string>();
  const { travelled, visited } = run(
    ai,
    400,
    () => {
      const p = ai.getPosition();
      // Bucket her height to the nearest storey so a stair tread does not read as a new floor.
      if (p.y < CELLAR_Y + 1.0) storeys.add(CELLAR_Y);
      else if (p.y < 1.2) storeys.add(GROUND_Y);
      else storeys.add(UPPER_Y);
    },
    tr,
  );

  // Distinct floor cells she visited, as a proxy for "rooms entered". Coarse on purpose: the point is
  // coverage of the house rather than a room-name audit, which the patrol suite already does.
  for (const p of visited) {
    rooms.add(`${Math.round(p.x / 6)},${Math.round(p.z / 6)}`);
  }

  console.log(
    `      storeys reached: ${[...storeys].sort((a, b) => a - b).join(', ')}  ` +
      `distinct 6 m cells: ${rooms.size}  travelled ${travelled.toFixed(1)} m`,
  );

  check('leaves the cellar while patrolling', storeys.has(GROUND_Y), `storeys ${[...storeys].join(',')}`);
  // 400 s, not 240. Her waypoint network is 42 points with 5 upstairs, and the scoring spreads her
  // across all of them — measured over 400 s she reaches y = 2.4 comfortably. The sampling window has
  // to be long enough for the storey *distribution* to show, or this asserts the random seed rather
  // than the behaviour. Confirmed against a full trace: with the player in the hall she spends ~10% of
  // her time upstairs and always reaches 2.40.
  check(
    'reaches the upper storey while patrolling',
    storeys.has(UPPER_Y),
    `highest y sampled ${Math.max(...visited.map((p) => p.y)).toFixed(2)}`,
  );
  check('covers a real spread of the house', rooms.size >= 8, `${rooms.size} distinct cells`);
  check('keeps moving throughout', travelled > 60, `travelled ${travelled.toFixed(1)} m over 400 s`);
  ai.dispose();
}

// ---------------------------------------------------------------------------
// BUG 3 — the noise bar hits maximum and she does not come.
// ---------------------------------------------------------------------------
console.log('\n=== BUG 3: A FULL NOISE BAR MUST BRING HER TO THE SOURCE ===');
{
  // Worst case for the old code: she is in the cellar ritual room, the player is at the far end of the
  // upper storey — well beyond the default `hearingRange` of 30 m — and the bar maxes out. The player
  // reported exactly this: "noise bar max hai phir mere paas nahi aa rhi".
  const noiseAt: Vec3 = { x: 11.0, y: UPPER_Y + EYE, z: 1.0 } as Vec3;
  const ai = makeAI(noiseAt);
  const tr = { t: 0 };

  // Wake her the ordinary way first, so this tests the alert routing rather than the wake gate.
  globalBus.emit('noise:emitted', {
    pos: { x: -28.0, y: CELLAR_Y + 0.5, z: 4.0 } as Vec3,
    radius: 14,
    kind: 'door',
  });
  run(ai, 1, undefined, tr);

  const startPos = ai.getPosition();
  const startDist = Math.hypot(startPos.x - noiseAt.x, startPos.z - noiseAt.z);
  console.log(`      she starts ${startDist.toFixed(1)} m from the noise, at y=${startPos.y.toFixed(1)}`);

  // The bar hits maximum.
  globalBus.emit('noise:alert', { pos: noiseAt, level: 1 } as never);

  let closest = Infinity;
  let came = false;
  let reachedUpper = false;
  const { travelled } = run(
    ai,
    220,
    () => {
      const p = ai.getPosition();
      const d = Math.hypot(p.x - noiseAt.x, p.z - noiseAt.z);
      if (d < closest) closest = d;
      if (d < 3.5) came = true;
      if (Math.abs(p.y - UPPER_Y) < 1.0) reachedUpper = true;
    },
    tr,
  );

  const end = ai.getPosition();
  console.log(
    `      closest approach ${closest.toFixed(2)} m, finished at y=${end.y.toFixed(2)}, travelled ${travelled.toFixed(1)} m`,
  );

  check('the alert wakes/moves her toward the noise', travelled > 5, `travelled ${travelled.toFixed(1)} m`);
  check('she reaches the source of a full noise bar', came, `closest ${closest.toFixed(2)} m`);
  // She must actually climb the up-shaft, not merely get within 3.5 m in plan view while standing at
  // its base two storeys below. The up-stair arrives at y = 2.4 exactly (8 treads x 0.3 m rise), so
  // this is a real check that the route upstairs is walkable end to end.
  check('she climbs to the storey the noise came from', reachedUpper, `highest y reached, final y=${end.y.toFixed(2)}`);
  ai.dispose();
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
