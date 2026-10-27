/**
 * Headless checks for the coffin-burn final task.
 *
 * The fire is visual, but the contract around it is timing and state: the player must be locked at
 * once, the lantern must stay in the hand through the wind-up and leave it at the throw, the throw
 * must ignite the coffin exactly once, the fire must run for the burn window, and the gate/ending
 * callbacks must fire once after the black. Those are the parts that break when the scene is rewired
 * and are safely testable with fakes.
 */

import { CoffinBurn, BURN_TIMING, type CoffinBurnDeps, type Point3 } from '../src/story/CoffinBurn.js';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

class FakePlayer {
  pos: Point3 = { x: 0, y: 1.7, z: 2.2 };
  facing = { yaw: 0, pitch: -0.5 };
  locked = false;
  looks: { yaw: number; pitch: number }[] = [];
  getPosition(): Point3 {
    return this.pos;
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

class FakeFx {
  began = 0;
  resets = 0;
  ended = 0;
  black: { value: number; seconds: number } | null = null;
  begin(): void {
    this.began++;
  }
  setBlack(value: number, seconds: number): void {
    this.black = { value, seconds };
  }
  update(): void {
    /* no-op */
  }
  endCinematic(): void {
    this.ended++;
  }
  reset(): void {
    this.resets++;
  }
}

class FakeFire {
  ignited: Point3 | null = null;
  updates = 0;
  ignite(at: Point3): void {
    this.ignited = { ...at };
  }
  update(): void {
    this.updates++;
  }
}

class FakeProp {
  shown = 0;
  hidden = 0;
  places: { x: number; y: number; z: number; spin: number }[] = [];
  show(): void {
    this.shown++;
  }
  hide(): void {
    this.hidden++;
  }
  place(x: number, y: number, z: number, spin: number): void {
    this.places.push({ x, y, z, spin });
  }
}

class FakeCamera {
  r = 0;
  rotateX(v: number): void {
    this.r += Math.abs(v);
  }
  rotateY(): void {
    /* no-op */
  }
  rotateZ(): void {
    /* no-op */
  }
}

function harness() {
  const player = new FakePlayer();
  const hud = { cinematic: false, setCinematic(on: boolean) { this.cinematic = on; } };
  const touch = { paused: false, setPaused(on: boolean) { this.paused = on; } };
  const held = { visible: true, setVisible(on: boolean) { this.visible = on; } };
  const camera = new FakeCamera();
  const fx = new FakeFx();
  const fire = new FakeFire();
  const prop = new FakeProp();
  let ignites = 0;
  let finishes = 0;
  const deps: CoffinBurnDeps = {
    player,
    hud,
    touch,
    held,
    camera,
    fx,
    fire,
    prop,
    getTarget: () => ({ x: 0, y: 1.0, z: 0 }),
    onIgnite: () => ignites++,
    onFinish: () => finishes++,
  };
  const burn = new CoffinBurn(deps);
  return {
    burn, player, hud, touch, held, camera, fx, fire, prop,
    counts: () => ({ ignites, finishes }),
  };
}

function step(burn: CoffinBurn, seconds: number): void {
  const dt = 1 / 60;
  for (let t = 0; t < seconds - 1e-9; t += dt) burn.update(dt);
}

// --- Start ------------------------------------------------------------------
{
  const h = harness();
  check('start succeeds', h.burn.start());
  check('player is locked', h.player.locked);
  check('HUD is hidden', h.hud.cinematic);
  check('touch controls are paused', h.touch.paused);
  check('held lantern stays in the hand for the wind-up', h.held.visible);
  check('throw prop is hidden during the wind-up', h.prop.shown === 0 && h.prop.places.length === 1);
  check('screen fade begins', h.fx.began === 1);
  check('second start is refused', h.burn.start() === false);
}

// --- Wind-up and hand-off ----------------------------------------------------
{
  const h = harness();
  h.burn.start();
  step(h.burn, BURN_TIMING.THROW_START - 0.05);
  check('the lantern has not left the hand before the throw', h.held.visible && h.prop.shown === 0);
  step(h.burn, 0.1);
  check('the hand-off hides the viewmodel', !h.held.visible);
  check('the hand-off shows the thrown prop', h.prop.shown === 1);
}

// --- Throw and ignition ------------------------------------------------------
{
  const h = harness();
  h.burn.start();
  step(h.burn, (BURN_TIMING.THROW_START + BURN_TIMING.THROW_END) / 2);
  check('prop is still in flight before the throw lands', h.fire.ignited === null && h.prop.hidden === 0);
  check('no camera light hand-off before ignition', h.counts().ignites === 0);
  step(h.burn, BURN_TIMING.THROW_END - (BURN_TIMING.THROW_START + BURN_TIMING.THROW_END) / 2 + 0.03);
  check('fire ignites once', h.fire.ignited !== null && h.counts().ignites === 1, `${h.counts().ignites}`);
  check('ignition is at the coffin target', h.fire.ignited !== null && Math.abs(h.fire.ignited.z) < 1e-6 && Math.abs(h.fire.ignited.y - 1.0) < 1e-6);
  check('prop is hidden on impact', h.prop.hidden === 1);
  check('fire updates while burning', h.fire.updates > 0);
}

// --- Black and ending --------------------------------------------------------
{
  const h = harness();
  h.burn.start();
  step(h.burn, BURN_TIMING.BURN_END + 0.05);
  check('black starts at burn end', h.fx.black !== null && h.fx.black.value === 1);
  check('ending has not fired before the blackout ends', h.counts().finishes === 0);
  step(h.burn, BURN_TIMING.END - BURN_TIMING.BURN_END + 0.06);
  check('gate/ending fires once', h.counts().finishes === 1, `${h.counts().finishes}`);
  check('sequence is inactive after finishing', !h.burn.isActive());
  check('cinematic crosshair guard is removed', h.fx.ended >= 1);
}

// --- Reset after finishing ---------------------------------------------------
{
  const h = harness();
  h.burn.start();
  step(h.burn, BURN_TIMING.END + 0.1);
  h.burn.reset();
  check('reset restores control', !h.player.locked && !h.hud.cinematic && !h.touch.paused);
  check('reset restores the held lantern', h.held.visible);
  check('reset clears the screen fade', h.fx.resets === 1);
  check('reset does not fire the ending again', h.counts().finishes === 1);
}

// --- Reset while active ------------------------------------------------------
{
  const h = harness();
  h.burn.start();
  step(h.burn, 1.0);
  h.burn.reset();
  check('reset stops the sequence', !h.burn.isActive());
  step(h.burn, BURN_TIMING.END + 0.1);
  check('reset while active never reaches the ending', h.counts().finishes === 0);
}

console.log(failures === 0 ? '\nCOFFIN BURN OK' : `\n${failures} COFFIN BURN CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
