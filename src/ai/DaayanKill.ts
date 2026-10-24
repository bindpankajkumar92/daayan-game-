/**
 * The catch cutscene: one grab, one sword hit, black.
 *
 * The animation itself lives in `daayan-kill.glb` and is played by the AI (it owns her mixer). This
 * class owns only the things the clip cannot: where she stands relative to the player, where the
 * camera looks, the hit flash, the black frame, and the hand-off back to the game.
 *
 * Two choices are deliberate:
 *
 * - **The camera rotates, it never translates.** A dolly toward her can put the camera inside a
 *   wall in a narrow bedroom, and the anchor is chosen from her real approach line precisely so this
 *   works in any room. Shake is rotation-only for the same reason.
 * - **She is placed 0.65 m from the player's eye along the line she just walked.** The clip was
 *   authored at that distance, so the grab reaches the lens without root motion. Moving her along
 *   that line is safe: it is the space she just crossed.
 *
 * Every finish path is one-way. `active` is cleared before the callbacks run, so a callback that
 * triggers another catch cannot re-enter a finished sequence.
 */

/** Plain read-only position; three's Vector3 satisfies it, and tests can pass an object literal. */
export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/**
 * The clip is authored with the grab at 0.33 s and the blade impact at 0.95 s, then played at 0.5x
 * (see `KILL_TIME_SCALE` in DaayanAI). These are the wall-clock times after that slowdown: the grab
 * lands at 0.66 s, the sword at 1.90 s, and the whole beat including the blackout lasts 2.35 s.
 */
export const KILL_TIMING = {
  /** How long the forced look takes to reach her. A cut, not a pan. */
  LOOK_LOCK: 0.08,
  /** The clip's left hand reaches the lens here; camera jolt. */
  GRAB: 0.66,
  /** Blade impact; flash and black begin. */
  HIT: 1.9,
  BLACK_FADE: 0.4,
  /** Warp/death card, after the black is complete. */
  END: 2.35,
  /** Black lifts over this long after a bed respawn. */
  FADE_IN: 0.6,
} as const;

/** Authored distance from the player's eye to her root. Changing it means re-authoring the clip. */
const ANCHOR_DISTANCE = 0.65;

const SHAKE_LIFE = 0.3;

export interface KillPlayer {
  getPosition(): Point3;
  /** The floor under the player's feet; the kill must stay on their storey, not hers. */
  getGroundY(): number;
  getFacing(): { yaw: number; pitch: number };
  look(yaw: number, pitch: number): void;
  setMovementLocked(locked: boolean): void;
}

export interface KillAI {
  getPosition(): Point3;
  getEye(): Point3;
  beginKill(anchor: Point3, yaw: number): boolean;
}

export interface KillHud {
  setCinematic(on: boolean): void;
}

export interface KillCamera {
  rotateX(angle: number): void;
  rotateY(angle: number): void;
  rotateZ(angle: number): void;
}

export interface KillFxLike {
  begin(): void;
  flash(): void;
  setBlack(value: number, seconds: number): void;
  update(dt: number): void;
  endCinematic(): void;
  reset(): void;
}

export interface KillDeps {
  player: KillPlayer;
  ai: KillAI;
  hud: KillHud;
  camera: KillCamera;
  fx: KillFxLike;
  /** Warp to the bed, reset her, and show the wake toast. */
  onRespawn: () => void;
  /** Show the existing "the house keeps you" card. */
  onDeath: () => void;
}

function lerpAngle(from: number, to: number, t: number): number {
  let delta = to - from;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return from + delta * t;
}

export class DaayanKill {
  private active = false;
  private alive = true;
  private elapsed = 0;
  private startYaw = 0;
  private startPitch = 0;
  private targetYaw = 0;
  private targetPitch = 0;
  private grabbed = false;
  private hit = false;
  private shakeAmp = 0;
  private shakeElapsed = 0;

  constructor(private readonly deps: KillDeps) {}

  isActive(): boolean {
    return this.active;
  }

  /**
   * Begin the beat. Returns false when her kill action is not available (model still loading, clip
   * missing, or already playing), and the caller must use the old instant-catch path instead.
   */
  start(alive: boolean): boolean {
    if (this.active) return false;
    const { player, ai } = this.deps;
    const p = player.getPosition();
    const her = ai.getPosition();

    let dx = her.x - p.x;
    let dz = her.z - p.z;
    let dist = Math.hypot(dx, dz);
    if (dist < 0.05) {
      const f = player.getFacing();
      dx = -Math.sin(f.yaw);
      dz = -Math.cos(f.yaw);
      dist = 1;
    }
    const anchor: Point3 = {
      x: p.x + (dx / dist) * ANCHOR_DISTANCE,
      y: player.getGroundY(),
      z: p.z + (dz / dist) * ANCHOR_DISTANCE,
    };
    // Her forward is +Z, and she must look at the player.
    const yaw = Math.atan2(p.x - anchor.x, p.z - anchor.z);
    if (!ai.beginKill(anchor, yaw)) return false;

    const eye = ai.getEye();
    const vx = eye.x - p.x;
    const vz = eye.z - p.z;
    const facing = player.getFacing();
    this.startYaw = facing.yaw;
    this.startPitch = facing.pitch;
    this.targetYaw = Math.atan2(-vx, -vz);
    this.targetPitch = Math.atan2(eye.y - p.y, Math.max(0.001, Math.hypot(vx, vz)));

    this.alive = alive;
    this.elapsed = 0;
    this.grabbed = false;
    this.hit = false;
    this.shakeAmp = 0;
    this.shakeElapsed = 0;
    this.active = true;

    player.setMovementLocked(true);
    this.deps.hud.setCinematic(true);
    this.deps.fx.begin();
    player.look(this.startYaw, this.startPitch);
    return true;
  }

  update(rawDt: number): void {
    const dt = Math.min(Math.max(rawDt, 0), 0.1);
    if (!this.active) {
      // The black outlives the beat: after a respawn the fade-in is the only thing left to drive.
      // The scene calls this every frame, so it does not need a second clock for that.
      this.deps.fx.update(dt);
      return;
    }
    this.elapsed += dt;
    const { player, fx, camera } = this.deps;

    // The look is forced for the whole beat, not just the lock-in: main drops look input while
    // cinematic, and re-writing it here means a stray sync cannot leave the camera off her.
    const t = Math.min(1, this.elapsed / KILL_TIMING.LOOK_LOCK);
    const eased = t * t * (3 - 2 * t);
    player.look(
      lerpAngle(this.startYaw, this.targetYaw, eased),
      this.startPitch + (this.targetPitch - this.startPitch) * eased,
    );

    if (!this.grabbed && this.elapsed >= KILL_TIMING.GRAB) {
      this.grabbed = true;
      this.addShake(0.006);
    }

    if (!this.hit && this.elapsed >= KILL_TIMING.HIT) {
      this.hit = true;
      fx.flash();
      fx.setBlack(1, KILL_TIMING.BLACK_FADE);
      this.addShake(0.02);
    }

    if (this.shakeAmp > 0) {
      this.shakeElapsed += dt;
      const k = Math.max(0, 1 - this.shakeElapsed / SHAKE_LIFE);
      if (k <= 0) {
        this.shakeAmp = 0;
      } else {
        camera.rotateX(Math.sin(this.shakeElapsed * 92) * this.shakeAmp * k);
        camera.rotateY(Math.cos(this.shakeElapsed * 57) * this.shakeAmp * k * 0.7);
        camera.rotateZ(Math.sin(this.shakeElapsed * 73) * this.shakeAmp * k * 0.5);
      }
    }

    fx.update(dt);
    if (this.elapsed >= KILL_TIMING.END) this.finish();
  }

  /** Restore everything the sequence touched. Safe to call after the death card's begin-again. */
  reset(): void {
    this.active = false;
    this.deps.fx.reset();
    this.deps.hud.setCinematic(false);
    this.deps.player.setMovementLocked(false);
  }

  dispose(): void {
    this.active = false;
  }

  private addShake(amount: number): void {
    this.shakeAmp = Math.max(this.shakeAmp, amount);
    this.shakeElapsed = 0;
  }

  private finish(): void {
    if (!this.active) return;
    this.active = false;
    const { player, hud, fx } = this.deps;
    // The overlay itself blocks movement on the death path, so the lock must come off either way.
    player.setMovementLocked(false);
    fx.endCinematic();
    if (this.alive) {
      this.deps.onRespawn();
      fx.setBlack(0, KILL_TIMING.FADE_IN);
      hud.setCinematic(false);
    } else {
      // Keep the black and the hidden HUD: they sit under the death card until begin-again resets.
      this.deps.onDeath();
    }
  }
}
