/**
 * Perception check — is Daayan's sight and hearing actually fair?
 *
 * Run: esbuild → node (see the header of nav-check.ts for the pattern).
 *
 * The spec's §21 is a list of things Daayan must *not* do, and every one of them is testable without a
 * GPU because perception is pure geometry plus arithmetic:
 *
 *   - she must not see through a wall
 *   - she must not have a 360° field of view
 *   - she must not detect the player merely because they are within a radius
 *   - she must not hear every sound regardless of distance
 *   - her confidence must not be binary, and must decay rather than snap (§7)
 *
 * A perception bug that lets her see through a wall is the single most immersion-destroying failure
 * this feature can have, and it is invisible in playtesting — you just think she is very good. So it
 * is worth pinning down here.
 */

import './dom-shim.js';
import { buildHouse } from '../src/world/HouseBuilder.js';
import { ObstacleGrid, VisionSystem, HearingSystem, SOUND_LOUDNESS } from '../src/ai/Perception.js';
import { daayanConfigFor } from '../src/ai/DaayanConfig.js';
import type { AABB } from '../src/player/FPController.js';
import type { Vec3 } from '../src/core/types.js';

const h = buildHouse(1);
const obstacles = new ObstacleGrid(h.aabbs as AABB[]);
const cfg = daayanConfigFor('normal');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z } as Vec3);
const sample = (eye: Vec3, hidden = false) => ({
  eye,
  feet: v(eye.x, eye.y - 1.6, eye.z),
  velocity: v(0, 0, 0),
  eyeHeight: 1.6,
  hidden,
});

console.log('=== VISION ===');

// 1. Straight down the hall, unobstructed: she should see the player.
{
  const vision = new VisionSystem(cfg, obstacles);
  // Haller at (0,1.6,-3.5) looking north (+z) at a player 4 m away, same room, no wall between.
  const her = v(0, 1.6, -3.5);
  const player = sample(v(0, 1.6, 0.5));
  const yaw = Math.atan2(0 - 0, 0.5 - -3.5); // atan2(dx, dz) toward the player
  for (let i = 0; i < 40; i++) vision.sample(her, yaw, 0, player, 1 / 8);
  check('open sightline detects the player', vision.getConfidence() > 0.5,
    `confidence ${vision.getConfidence().toFixed(2)}`);
  check('open sightline reaches full confidence', vision.isConfident(true), '');
}

// 2. Same distance, but she is facing away: FOV must reject it.
{
  const vision = new VisionSystem(cfg, obstacles);
  const her = v(0, 1.6, -3.5);
  const player = sample(v(0, 1.6, 0.5));
  const yaw = Math.PI; // looking south, away from the player
  for (let i = 0; i < 40; i++) vision.sample(her, yaw, 0, player, 1 / 8);
  check('behind her is not seen', vision.getConfidence() < 0.05,
    `confidence ${vision.getConfidence().toFixed(2)}`);
}

// 3. THE WALL TEST. Two points in different rooms with a wall between them, well inside vision range.
{
  const vision = new VisionSystem(cfg, obstacles);
  // Bedroom (-9..-1, z 2.6..10.2) and hallway (z 0..2.6) share the z=2.6 wall.
  // Stand in the hallway at (-7, 1.6, 1.0) looking north; player in the bedroom at (-7, 1.6, 5.0).
  const her = v(-7, 1.6, 1.0);
  const player = sample(v(-7, 1.6, 5.0));
  const yaw = Math.atan2(0, 4.0); // facing +z, straight at the player
  let anyVisible = false;
  for (let i = 0; i < 40; i++) {
    const r = vision.sample(her, yaw, 0, player, 1 / 8);
    if (r.visibility > 0) anyVisible = true;
  }
  check('WALL blocks sight', !anyVisible && vision.getConfidence() < 0.05,
    `visibility stayed 0, confidence ${vision.getConfidence().toFixed(2)}`);
}

// 4. Same test through an actual doorway — the wall's opening must let sight through.
{
  const vision = new VisionSystem(cfg, obstacles);
  // The bedroom door is at x=-5, z=2.6. Stand just south of it, player just north of it, aligned.
  const her = v(-5, 1.6, 1.2);
  const player = sample(v(-5, 1.6, 4.2));
  const yaw = Math.atan2(0, 3.0);
  for (let i = 0; i < 40; i++) vision.sample(her, yaw, 0, player, 1 / 8);
  check('DOORWAY admits sight', vision.getConfidence() > 0.4,
    `confidence ${vision.getConfidence().toFixed(2)}`);
}

// 5. Hysteresis: confidence must decay, not snap, and must do so at a finite rate (§7).
{
  const vision = new VisionSystem(cfg, obstacles);
  const her = v(0, 1.6, -3.5);
  const player = sample(v(0, 1.6, 0.5));
  const yaw = Math.atan2(0, 4.0);
  for (let i = 0; i < 60; i++) vision.sample(her, yaw, 0, player, 1 / 8);
  const full = vision.getConfidence();
  // Now turn away and sample for one second.
  const away = Math.PI;
  for (let i = 0; i < 8; i++) vision.sample(her, away, 0, player, 1 / 8);
  const after = vision.getConfidence();
  check('confidence decays rather than snapping', after > 0 && after < full,
    `${full.toFixed(2)} -> ${after.toFixed(2)} after 1 s`);
  // And it should take a real amount of time to forget, not a frame.
  check('decay is gradual (still >0 after 1 s)', after > full * 0.5,
    `${((after / full) * 100).toFixed(0)}% retained`);
}

// 6. Range limit: a clear sightline beyond visionRange must not detect.
{
  const vision = new VisionSystem(cfg, obstacles);
  // The upper flat's main room is empty and about 10 x 11 m, but no single straight run in the house
  // exceeds visionRange, so the honest way to test the range gate is to place the two ends of the
  // longest clear run and shorten the range out from under the test rather than hunt for a corridor.
  const tight = { ...cfg, visionRange: 6 };
  const tv = new VisionSystem(tight, obstacles);
  const her = v(16, 2.4 + 1.6, 8.5);
  const player = sample(v(24, 2.4 + 1.6, 8.5));
  const yaw = Math.atan2(8, 0);
  for (let i = 0; i < 40; i++) tv.sample(her, yaw, 0, player, 1 / 8);
  console.log(`      (distance ${Math.hypot(8, 0).toFixed(1)} m, range ${tight.visionRange} m)`);
  check('beyond visionRange is not seen', tv.getConfidence() < 0.05,
    `confidence ${tv.getConfidence().toFixed(2)}`);

  // And just inside the same shrunken range it must detect, so the gate is a range test and not a
  // blunt "upper flat is invisible" artefact.
  const inside = { ...cfg, visionRange: 12 };
  const iv = new VisionSystem(inside, obstacles);
  for (let i = 0; i < 40; i++) iv.sample(her, yaw, 0, player, 1 / 8);
  check('inside visionRange is seen', iv.getConfidence() > 0.5,
    `confidence ${iv.getConfidence().toFixed(2)}`);
}

// 7. Hiding caps visibility.
{
  const vision = new VisionSystem(cfg, obstacles);
  const her = v(0, 1.6, -3.5);
  const player = sample(v(0, 1.6, 0.5), true);
  const yaw = Math.atan2(0, 4.0);
  for (let i = 0; i < 40; i++) vision.sample(her, yaw, 0, player, 1 / 8);
  check('hidden player is never fully seen', !vision.isConfident(true),
    `confidence ${vision.getConfidence().toFixed(2)}`);
}

console.log('\n=== HEARING ===');

// 8. A loud sound nearby is heard; the same sound across the house is not.
{
  const hearing = new HearingSystem(cfg, obstacles);
  const ear = v(0, 1.6, -3.5);
  const near = hearing.perceive(
    { position: v(2, 1.6, -2), loudness: SOUND_LOUDNESS.door, kind: 'door', time: 0 },
    ear,
  );
  check('nearby door is heard', near !== null, near ? `perceived ${near.perceivedLoudness.toFixed(2)}` : '');

  // The ritual room is ~35 m away and behind two storeys of wall.
  const far = hearing.perceive(
    { position: v(-28.4, -1.4, 4.3), loudness: SOUND_LOUDNESS.door, kind: 'door', time: 0 },
    ear,
  );
  check('distant door across the house is NOT heard', far === null,
    far ? `perceived ${far.perceivedLoudness.toFixed(2)}` : 'rejected');
}

// 9. Distance falloff is monotonic.
{
  const hearing = new HearingSystem(cfg, obstacles);
  const ear = v(0, 1.6, -3.5);
  const d = [2, 5, 10, 16].map((dist) =>
    hearing.perceive(
      { position: v(dist, 1.6, -3.5), loudness: 1.0, kind: 'break', time: 0 },
      ear,
    ),
  );
  const vals = d.map((x) => (x ? x.perceivedLoudness : 0));
  const monotonic = vals.every((val, i) => i === 0 || val <= (vals[i - 1] as number) + 1e-6);
  check('loudness falls off with distance', monotonic, vals.map((x) => x.toFixed(2)).join(' > '));
}

// 10. Louder sounds are perceived as louder than quiet ones at the same spot.
{
  const hearing = new HearingSystem(cfg, obstacles);
  const ear = v(0, 1.6, -3.5);
  const quiet = hearing.perceive({ position: v(3, 1.6, -2), loudness: SOUND_LOUDNESS.footstep, kind: 'footstep', time: 0 }, ear);
  const loud = hearing.perceive({ position: v(3, 1.6, -2), loudness: SOUND_LOUDNESS.sprint, kind: 'sprint', time: 0 }, ear);
  check('quiet steps below loud-run', (quiet?.perceivedLoudness ?? 0) < (loud?.perceivedLoudness ?? 0),
    `${quiet?.perceivedLoudness.toFixed(3) ?? 'null'} < ${loud?.perceivedLoudness.toFixed(3) ?? 'null'}`);
}

// 11. Walls damp but never fully block (§8) — a wall between must leave a smaller but nonzero value.
{
  const hearing = new HearingSystem(cfg, obstacles);
  const ear = v(-5, 1.6, 1.2); // hallway side of the bedroom door
  const sameSide = hearing.perceive({ position: v(-5, 1.6, 0.2), loudness: 0.6, kind: 'object', time: 0 }, ear);
  const throughWall = hearing.perceive({ position: v(-8, 1.6, 4.0), loudness: 0.6, kind: 'object', time: 0 }, ear);
  check('wall damps rather than blocks',
    sameSide !== null && throughWall !== null && throughWall.perceivedLoudness < sameSide.perceivedLoudness,
    `${sameSide?.perceivedLoudness.toFixed(3) ?? 'null'} vs through-wall ${throughWall?.perceivedLoudness.toFixed(3) ?? 'null'}`);
}

// 12. Estimated position is jittered, not exact (§9).
{
  const hearing = new HearingSystem(cfg, obstacles);
  const ear = v(0, 1.6, -3.5);
  const src = v(3, 1.6, -2);
  let maxErr = 0;
  let exactCount = 0;
  for (let i = 0; i < 60; i++) {
    const s = hearing.perceive({ position: src, loudness: 0.8, kind: 'break', time: 0 }, ear);
    if (!s) continue;
    const err = Math.hypot(s.position.x - src.x, s.position.z - src.z);
    maxErr = Math.max(maxErr, err);
    if (err < 1e-9) exactCount++;
  }
  check('sound position is estimated, not exact', maxErr > 0 && exactCount === 0,
    `max error ${maxErr.toFixed(2)} m over 60 samples`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
