/**
 * The consequence of being caught — the gap `game:caught` left open.
 *
 * The AI has always emitted `game:caught` exactly once per catch and then held a recovery window open
 * for whoever subscribed. **Nobody ever did.** So being caught cost the player nothing: she grabbed,
 * stunned herself, woke, and the run continued as though nothing had happened. Verified by grep —
 * before this work the only occurrences of the string in `src/` were the emitter and two comments
 * explaining that a subscriber was expected.
 *
 * The fix has two halves, and this suite covers both, because either one alone is useless:
 *
 * 1. **`GameState`** spends a life and reports whether the run continues (`caught`), and can restore
 *    the opening state for a new run (`reset`).
 * 2. **`DaayanAI.resetToStart`** sends her home with an empty head, so a respawned player does not wake
 *    up in the room where they were just caught, with her mid-hunt and her memory still warm.
 *
 * The assertions that matter most are the two the previous behaviour failed outright: a catch must
 * *cost* something, and after a respawn she must not be able to act on what she knew before it.
 */

import './dom-shim.js';
import { buildHouse } from '../src/world/HouseBuilder.js';
import { DaayanAI } from '../src/ai/DaayanAI.js';
import { GameState, STARTING_LIVES } from '../src/game/GameState.js';
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

/** The same minimal player the other suites use. */
class FakePlayer {
  pos: Vec3 = { x: -28.4, y: CELLAR_Y + EYE, z: 4.3 } as Vec3;
  velocity: Vec3 = { x: 0, y: 0, z: 0 } as Vec3;
  getPosition(): Vec3 {
    return this.pos;
  }
  moveTo(p: Vec3): void {
    this.pos = { x: p.x, y: p.y, z: p.z } as Vec3;
  }
  isRunning(): boolean {
    return false;
  }
  isCrouching(): boolean {
    return false;
  }
}

const player = new FakePlayer();
const DT = 1 / 60;

function makeAI(): DaayanAI {
  return new DaayanAI({
    getRoot: () => null,
    getClips: () => [],
    player: player as unknown as FPController,
    obstacles: aabbs,
    floors: h.floors,
    hidingSpots: [],
    start: { position: { x: -28.4, y: CELLAR_Y, z: 4.3 } as Vec3, yaw: 2.41 },
    difficulty: 'normal',
    overrides: { wakeOnTrigger: false, debug: false },
  });
}

// ---------------------------------------------------------------------------
// 1. GameState: a catch costs a life, and the run ends when they run out.
// ---------------------------------------------------------------------------
console.log('=== A CATCH MUST COST SOMETHING ===');
{
  const state = new GameState();

  check('the run starts with lives', state.getLives() === STARTING_LIVES, `${state.getLives()} lives`);

  const first = state.caught();
  check('the first catch survives', first === true, `caught() -> ${first}`);
  check('and costs exactly one life', state.getLives() === STARTING_LIVES - 1, `${state.getLives()} left`);
  check('and is counted', state.getDeaths() === 1, `${state.getDeaths()} death(s)`);

  // Spend the rest.
  let alive = true;
  let catches = 1;
  while (alive) {
    alive = state.caught();
    catches++;
    if (catches > 20) break;
  }

  check('the run ends on the last life', state.isDead(), `lives ${state.getLives()}`);
  check('it took exactly STARTING_LIVES catches to end it', catches === STARTING_LIVES, `${catches} catches`);
  check('and a catch past the end does nothing', state.caught() === false, 'caught() -> false');
  check('lives never go negative', state.getLives() === 0, `${state.getLives()}`);
}

// ---------------------------------------------------------------------------
// 2. A catch during the ending must not spend a life.
// ---------------------------------------------------------------------------
console.log('\n=== A CATCH DURING THE ESCAPE IS NOT A FAILURE ===');
{
  const state = new GameState();
  state.escape();

  const alive = state.caught();
  check('a catch after escaping is refused', alive === false, `caught() -> ${alive}`);
  check('and costs no life', state.getLives() === STARTING_LIVES, `${state.getLives()} lives`);
}

// ---------------------------------------------------------------------------
// 3. Reset restores a fresh run.
// ---------------------------------------------------------------------------
console.log('\n=== BEGIN AGAIN RESTORES THE OPENING STATE ===');
{
  const state = new GameState();
  state.solve('ritual');
  state.collectKey('key-ritual');
  state.openLock('key-ritual');
  state.raiseTension('TERRIFYING');
  state.caught();
  state.caught();
  state.caught();
  const deathsBefore = state.getDeaths();

  state.reset();

  check('lives come back', state.getLives() === STARTING_LIVES, `${state.getLives()} lives`);
  check('the run is playable again', !state.isDead(), 'not dead');
  check('puzzles are unsolved', !state.isSolved('ritual'), 'ritual cleared');
  check('keys are gone', !state.hasKey('key-ritual'), 'key cleared');
  check('locks are shut', !state.isLockOpen('key-ritual'), 'lock cleared');
  check('clue-read flags are cleared', !state.hasSeen('anything'), 'seen cleared');
  check(
    'tension is back to NORMAL',
    state.getTension() === 'NORMAL',
    `tension ${state.getTension()}`,
  );
  check('the gate wants three bolts again', state.locksRemaining() === 3, `${state.locksRemaining()} left`);
  // Deliberately preserved: a new run should still be able to report how the last one went.
  check('the death count survives as history', state.getDeaths() === deathsBefore, `${state.getDeaths()} death(s)`);
}

// ---------------------------------------------------------------------------
// 4. respawn: she goes home, and forgets.
// ---------------------------------------------------------------------------
console.log('\n=== AFTER A RESPAWN SHE MUST NOT KNOW WHERE THE PLAYER WAS ===');
{
  const ai = makeAI();
  const start = { ...ai.getPosition() } as Vec3;

  // Let her find the player and commit: put them in the open, in range, in front of her.
  player.moveTo({ x: -26.0, y: CELLAR_Y + EYE, z: 4.0 } as Vec3);
  for (let i = 0; i < 60 * 6; i++) ai.update(DT);

  const info = ai.getDebugInfo();
  const huntedState = ai.getState();
  const hadBelief = info.memoryPosition !== null || info.confidence > 0;
  console.log(
    `      before respawn: state=${huntedState} confidence=${info.confidence.toFixed(2)} ` +
      `memory=${info.memoryPosition ? 'held' : 'none'}`,
  );
  check('she had accumulated belief about the player', hadBelief, `state ${huntedState}`);

  // She catches them.
  ai.resetToStart();

  const after = ai.getDebugInfo();
  const home = { ...ai.getPosition() } as Vec3;
  const homeDist = Math.hypot(home.x - start.x, home.y - start.y, home.z - start.z);

  console.log(
    `      after respawn:  state=${ai.getState()} confidence=${after.confidence.toFixed(2)} ` +
      `memory=${after.memoryPosition ? 'held' : 'none'}  moved home ${homeDist.toFixed(2)} m`,
  );

  check('she is back at her start', homeDist < 0.01, `${homeDist.toFixed(3)} m from start`);
  check('her vision confidence is cleared', after.confidence === 0, `${after.confidence.toFixed(3)}`);
  check('her memory of the player is cleared', after.memoryPosition === null, 'memory null');
  check('she has no last-seen position', after.lastSeen === null, 'lastSeen null');
  check('she has no last-heard position', after.lastHeard === null, 'lastHeard null');
  check('she has no path', after.path.length === 0, `${after.path.length} points`);
  check('she is not stuck-flagged', !after.stuck, 'stuck false');
  check('she is still awake', after.awake, `awake ${after.awake}`);
}

// ---------------------------------------------------------------------------
// 5. The thing the reset is actually for: she cannot walk to where they were.
// ---------------------------------------------------------------------------
console.log('\n=== SHE MUST NOT WALK TO THE OLD CATCH SITE AFTER A RESPAWN ===');
{
  const ai = makeAI();

  // A loud noise at a distinctive spot, so she has a concrete place to head for.
  const scene: Vec3 = { x: -26.0, y: CELLAR_Y + 0.5, z: 4.0 } as Vec3;
  player.moveTo({ x: -26.0, y: CELLAR_Y + EYE, z: 4.0 } as Vec3);
  globalBus.emit('noise:emitted', { pos: scene, radius: 14, kind: 'door' });
  for (let i = 0; i < 60 * 4; i++) ai.update(DT);

  const before = ai.getDebugInfo();
  const believed = before.memoryPosition;

  ai.resetToStart();

  /**
   * Asserted here, before she is given thirty seconds to think, and that placement is the point.
   *
   * This used to be checked after the loop below, which made it flaky: the player is parked 22 m away,
   * only 4 m outside her 18 m vision range, so a patrol that happens to drift toward them re-acquires
   * and refills memory — legitimately. The failure then reads as "reset did not clear memory" when what
   * actually happened is "she saw him again", and those want different fixes. The reset is what is
   * under test, so the reset is what this measures; the loop below keeps its own, separate claim.
   */
  check(
    'a reset clears where she thinks the player is',
    ai.getDebugInfo().memoryPosition === null,
    ai.getDebugInfo().memoryPosition === null ? 'memory null' : 'memory survived the reset',
  );

  // Now let her run with the player genuinely out of the way. The position matters: `DaayanAI.update`
  // returns early when the player is beyond `aiSleepDistance` (55 m), so parking them at (60, 60)
  // would freeze her for a reason that has nothing to do with this test and make it pass vacuously.
  // 22 m away, on the same storey but out of her 18 m vision range, keeps her live and ignorant.
  player.moveTo({ x: -7.0, y: CELLAR_Y + EYE, z: 4.0 } as Vec3);
  let closestToScene = Infinity;
  const visited: { x: number; z: number }[] = [];
  for (let i = 0; i < 60 * 30; i++) {
    ai.update(DT);
    const p = ai.getPosition();
    const d = Math.hypot(p.x - scene.x, p.z - scene.z);
    if (d < closestToScene) closestToScene = d;
    if (i % 60 === 0) visited.push({ x: p.x, z: p.z });
  }

  console.log(
    `      before respawn she was heading to (${believed?.x.toFixed(1)}, ${believed?.z.toFixed(1)})` +
      ` — after 30 s she got within ${closestToScene.toFixed(2)} m of it`,
  );

  // She *starts* 2.4 m from the noise in plan view, so proximity alone proves nothing — she would be
  // within 3 m of it standing still at home. What distinguishes "patrolling past it" from "deliberately
  // returning to it" is whether she then *leaves*: a cleared memory means the spot is worth no more
  // than anywhere else, so she wanders off. An uncleared one parks her on it, which is precisely the
  // bug the reset exists to prevent.
  const spread = Math.max(...visited.map((p) => Math.hypot(p.x - scene.x, p.z - scene.z)));

  console.log(`      over the same 30 s she ranged up to ${spread.toFixed(1)} m away from it`);

  // Reported, not asserted: whether she re-acquired during those thirty seconds is information about
  // her patrol, not a claim about the reset, and failing on it made a correct reset look broken.
  console.log(
    `      after 30 s her memory is ${ai.getDebugInfo().memoryPosition === null ? 'still clear' : 'populated again'}`,
  );
  check(
    'and does not park on where she last heard them',
    spread > 6,
    `ranged ${spread.toFixed(1)} m from the old site`,
  );
}

// ---------------------------------------------------------------------------
// 6. Two respawns in a row: still home, still clean.
// ---------------------------------------------------------------------------
console.log('\n=== REPEATED RESPAWNS DO NOT DRIFT OR ACCUMULATE ===');
{
  const ai = makeAI();
  const start = { ...ai.getPosition() } as Vec3;

  player.moveTo({ x: -26.0, y: CELLAR_Y + EYE, z: 4.0 } as Vec3);
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 60 * 3; i++) ai.update(DT);
    ai.resetToStart();
  }

  const home = ai.getPosition();
  const drift = Math.hypot(home.x - start.x, home.y - start.y, home.z - start.z);
  const info = ai.getDebugInfo();

  console.log(
    `      after 3 cycles: drift ${drift.toFixed(4)} m, confidence ${info.confidence.toFixed(3)}, ` +
      `memory ${info.memoryPosition ? 'held' : 'none'}`,
  );

  check('she has not drifted off her start', drift < 0.01, `${drift.toFixed(4)} m`);
  check('and her head is still empty', info.confidence === 0 && info.memoryPosition === null, 'clean');
}

// ---------------------------------------------------------------------------
// 7. And she still works afterwards — a reset must not brick her.
// ---------------------------------------------------------------------------
console.log('\n=== SHE STILL HUNTS AFTER A RESPAWN ===');
{
  const ai = makeAI();

  // Catch, respawn, then give her a living player to find.
  player.moveTo({ x: -26.0, y: CELLAR_Y + EYE, z: 4.0 } as Vec3);
  for (let i = 0; i < 60 * 3; i++) ai.update(DT);
  ai.resetToStart();

  player.moveTo({ x: -26.0, y: CELLAR_Y + EYE, z: 4.0 } as Vec3);
  let sawPlayer = false;
  let peak = 0;
  for (let i = 0; i < 60 * 12; i++) {
    ai.update(DT);
    const info = ai.getDebugInfo();
    if (info.confidence > peak) peak = info.confidence;
    if (info.confidence >= 0.65) sawPlayer = true;
  }

  console.log(`      after the respawn she rebuilt confidence to ${peak.toFixed(2)}`);
  check('she perceives the player again after a respawn', sawPlayer, `peak ${peak.toFixed(2)}`);
  check('she is not wedged in a dead state', ai.getState() !== 'IDLE', `state ${ai.getState()}`);

  ai.dispose();
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
