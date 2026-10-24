/**
 * Headless checks for the catch cutscene's timeline.
 *
 * The clip itself is visual, but everything around it is timing and state: the anchor must be on the
 * line she approached on, the camera must be on her before the grab, the hit must fire once, and the
 * sequence must hand control back exactly once. Those are the things that break when the scene is
 * rewired, and they are all testable with fakes.
 */

import { DaayanKill, KILL_TIMING, type KillDeps, type Point3 } from '../src/ai/DaayanKill.js';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

class FakePlayer {
  pos: Point3 = { x: 0, y: 1.7, z: 0 };
  facing = { yaw: 0, pitch: 0 };
  locked = false;
  looks: { yaw: number; pitch: number }[] = [];
  getPosition(): Point3 {
    return this.pos;
  }
  getGroundY(): number {
    return 0;
  }
  getFacing(): { yaw: number; pitch: number } {
    return this.facing;
  }
  look(yaw: number, pitch: number): void {
    this.facing = { yaw, pitch };
    this.looks.push(this.facing);
  }
  setMovementLocked(locked: boolean): void {
    this.locked = locked;
  }
}

class FakeAI {
  pos: Point3 = { x: 0, y: 0, z: -1.2 };
  eye: Point3 = { x: 0, y: 1.6, z: -1.2 };
  allow = true;
  began = false;
  anchor: Point3 | null = null;
  yaw: number | null = null;
  getPosition(): Point3 {
    return this.pos;
  }
  getEye(): Point3 {
    return this.eye;
  }
  beginKill(anchor: Point3, yaw: number): boolean {
    if (!this.allow) return false;
    this.began = true;
    this.anchor = { ...anchor };
    this.yaw = yaw;
    this.pos = { ...anchor };
    this.eye = { x: anchor.x, y: anchor.y + 1.6, z: anchor.z };
    return true;
  }
}

class FakeFx {
  began = 0;
  flashes = 0;
  black: { value: number; seconds: number } | null = null;
  resets = 0;
  begin(): void {
    this.began++;
  }
  flash(): void {
    this.flashes++;
  }
  setBlack(value: number, seconds: number): void {
    this.black = { value, seconds };
  }
  update(): void {
    /* no-op */
  }
  endCinematic(): void {
    /* no-op */
  }
  reset(): void {
    this.resets++;
  }
}

class FakeCamera {
  rx = 0;
  ry = 0;
  rz = 0;
  rotateX(v: number): void {
    this.rx += v;
  }
  rotateY(v: number): void {
    this.ry += v;
  }
  rotateZ(v: number): void {
    this.rz += v;
  }
}

function harness(allow = true) {
  const player = new FakePlayer();
  const ai = new FakeAI();
  ai.allow = allow;
  const hud = { cinematic: false, setCinematic(on: boolean) { this.cinematic = on; } };
  const camera = new FakeCamera();
  const fx = new FakeFx();
  let respawns = 0;
  let deaths = 0;
  const deps: KillDeps = {
    player,
    ai,
    hud,
    camera,
    fx,
    onRespawn: () => respawns++,
    onDeath: () => deaths++,
  };
  const kill = new DaayanKill(deps);
  return {
    kill, player, ai, hud, camera, fx,
    counts: () => ({ respawns, deaths }),
  };
}

function step(kill: DaayanKill, seconds: number): void {
  const dt = 1 / 60;
  for (let t = 0; t < seconds - 1e-9; t += dt) kill.update(dt);
}

// --- Start: anchor and lock -------------------------------------------------
{
  const h = harness();
  check('start returns true when the clip is ready', h.kill.start(true));
  check('player is locked at start', h.player.locked);
  check('HUD is hidden at start', h.hud.cinematic);
  check('FX begins at start', h.fx.began === 1);

  const a = h.ai.anchor;
  const dist = a ? Math.hypot(a.x - h.player.pos.x, a.z - h.player.pos.z) : -1;
  check('anchor is 0.65 m from the player', Math.abs(dist - 0.65) < 1e-6, `${dist.toFixed(3)}`);
  check('anchor keeps her direction', a !== null && Math.abs(a.x) < 1e-6 && a.z < -0.64, a ? `${a.x.toFixed(2)}, ${a.z.toFixed(2)}` : 'none');
  check('anchor keeps her floor', a !== null && Math.abs(a.y - 0) < 1e-6);
  check('she faces the player (yaw 0 at +Z)', h.ai.yaw !== null && Math.abs(h.ai.yaw) < 1e-6, `${h.ai.yaw}`);
}

// --- Look and hit -----------------------------------------------------------
{
  const h = harness();
  h.kill.start(true);
  step(h.kill, 0.5);
  const last = h.player.looks[h.player.looks.length - 1];
  // Eye straight ahead and 0.1 m below the player's eye: yaw 0, pitch -atan(0.1 / 0.65).
  check('camera holds on her eye', Math.abs(last.yaw) < 1e-3, `yaw ${last.yaw.toFixed(3)}`);
  check('camera pitch is down to her eye', Math.abs(last.pitch - -0.1526) < 2e-3, `pitch ${last.pitch.toFixed(3)}`);
  check('no hit before its time', h.fx.flashes === 0);
  step(h.kill, KILL_TIMING.HIT - 0.5 + 0.02);
  check('hit flashes once', h.fx.flashes === 1, `${h.fx.flashes}`);
  check('hit starts the black', h.fx.black !== null && h.fx.black.value === 1);
}

// --- Alive finish -----------------------------------------------------------
{
  const h = harness();
  h.kill.start(true);
  step(h.kill, KILL_TIMING.END + 0.05);
  const c = h.counts();
  check('alive finish respawns once', c.respawns === 1, `${c.respawns}`);
  check('alive finish does not show the death card', c.deaths === 0);
  check('alive finish restores control', !h.player.locked && !h.hud.cinematic);
  check('alive finish lifts the black', h.fx.black !== null && h.fx.black.value === 0);
  check('sequence is inactive after finish', !h.kill.isActive());
}

// --- Dead finish and begin-again reset --------------------------------------
{
  const h = harness();
  h.kill.start(false);
  step(h.kill, KILL_TIMING.END + 0.05);
  const c = h.counts();
  check('dead finish shows the death card', c.deaths === 1, `${c.deaths}`);
  check('dead finish does not respawn', c.respawns === 0);
  check('dead finish keeps the HUD hidden', h.hud.cinematic);
  check('dead finish does not lift the black', h.fx.black !== null && h.fx.black.value === 1);
  h.kill.reset();
  check('reset restores the HUD', !h.hud.cinematic);
  check('reset clears the FX', h.fx.resets === 1);
  check('reset releases the player', !h.player.locked);
}

// --- Missing clip fallback --------------------------------------------------
{
  const h = harness(false);
  check('start refuses when the AI has no clip', h.kill.start(true) === false);
  check('refused start does not lock the player', !h.player.locked);
  check('refused start does not hide the HUD', !h.hud.cinematic);
  check('refused start does not touch the FX', h.fx.began === 0);
}

// --- Re-entry and reset while active ---------------------------------------
{
  const h = harness();
  check('first start wins', h.kill.start(true));
  check('second start is refused while active', h.kill.start(true) === false);
  h.kill.reset();
  check('reset while active stops it', !h.kill.isActive());
  step(h.kill, KILL_TIMING.END + 0.1);
  check('reset while active calls no finish callback', h.counts().respawns === 0 && h.counts().deaths === 0);
}

console.log(failures === 0 ? '\nKILL SEQUENCE OK' : `\n${failures} KILL SEQUENCE CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
