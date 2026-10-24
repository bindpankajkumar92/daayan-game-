/**
 * FPController — first-person camera/character controller.
 * - Walk / run / crouch
 * - Capsule-AABB collision against a simple AABB list (house interior)
 * - 0.35m stair step-up
 * - Ground-snap raycast
 * - Emits noise:emitted events on footstep (Footsteps plays them; HeldLantern jolts on them)
 *
 * Phase 0: no house geometry yet. AABB list is empty; controller works in open space.
 * Phase 1+ builders will register AABBs via Engine's collision registry.
 */

import { Vector3, Euler, MathUtils } from 'three';
import type { Engine } from '@/core/Engine';
import { globalBus } from '@/core/EventBus';

/**
 * Metres of ground covered between one boot and the next. This is the whole of the footstep cadence:
 * steps are spent out of distance actually travelled, not counted off a wall clock.
 *
 * The version this replaced was a timer — `footstepTimer += dt * (running ? 2.4 : 1.6)` — and it was
 * wrong in three separate ways at once. It ran while the player stood still, because `move()` is called
 * every frame and the only gate was `onGround`. It ran while the player was pressed into a wall, because
 * the timer never saw that the position had not changed. And 1.6 Hz at a walk speed of 2.2 m/s implies a
 * 1.375 m stride, which is not a walk — the boots landed at a stroll while the world went past at a jog,
 * which is exactly the sync the user is asking for.
 *
 * The numbers are ordinary human ones for the speeds in `opts`: 2.2 / 0.85 = 2.6 Hz at a walk,
 * 4.0 / 1.15 = 3.5 Hz at a run (a real sprint cadence), 1.1 / 0.7 = 1.6 Hz crouched, which is slow and
 * deliberate because that is what crouching is for.
 */
const STRIDE = { walk: 0.85, run: 1.15, crouch: 0.7 };

/** How loud each gait is, in metres the daayan can hear it from. Also drives the playback volume. */
const LOUDNESS = { walk: 2.5, run: 4.0, crouch: 1.0 };

/**
 * How long a sprint survives without covering ground, in seconds.
 *
 * A sprinting player in a small room is repeatedly blocked for a frame or two by a wall or a corner.
 * Those frames carry no displacement, and treating them as "stopped" made the noise bar impossible to
 * fill — see the note at the gait decision in `move`. This is the memory that rides them out, and it
 * is deliberately the same order of magnitude as `NoiseSystem.DECAY_GRACE`, because the two are
 * answering the same question from opposite ends: neither will punish a brief interruption.
 */
const RUN_MEMORY = 0.3;

/**
 * Longest horizontal slide `move` makes in one go, in metres. Under the shallowest tread in the house
 * (the hidden stair's 0.22 m), so no substep can hop a tread and see a rise it is not allowed to climb.
 */
const MAX_SUBSTEP = 0.1;

export interface AABB {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/**
 * A walkable surface. The controller snaps the player's feet to the highest one they are
 * standing over. Structurally identical to HouseLayout's FloorRect, declared here so the player
 * package does not depend on the world package.
 */
export interface FloorRect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  y: number;
}

export interface FPSControllerOptions {
  walkSpeed?: number; // m/s
  runSpeed?: number; // m/s
  crouchSpeed?: number; // m/s
  eyeHeight?: number; // m
  crouchEyeHeight?: number; // m
  radius?: number; // m
  gravity?: number; // m/s^2
  stepUpHeight?: number; // m
}

export class FPController {
  readonly position: Vector3 = new Vector3(0, 1.7, 0);
  readonly velocity: Vector3 = new Vector3();
  readonly facing: Euler = new Euler(0, 0, 0, 'YXZ');
  private onGround = true;
  private crouching = false;
  private running = false;
  private actuallyRunning = false;

  /**
   * Seconds of run-gait credit left, refreshed whenever the player actually covers ground.
   * See `RUN_MEMORY` — this is what lets a sprint survive bumping into a wall.
   */
  private runMemory = 0;
  /**
   * A hiding place owns the camera position while this is true. This is stronger than zero movement:
   * zero input still applies gravity and ground snap, which would pull a camera placed under a bed or
   * inside a wardrobe back onto the room floor on the next frame.
   */
  private movementLocked = false;
  private aabbs: AABB[] = [];
  private floors: FloorRect[] = [];
  /** Last resolved floor height. Sticky, so a gap between two floor rects is not a death pit. */
  private groundY = 0;
  /**
   * Fraction of the current stride already walked. Starts at 1 — i.e. primed — so the first step lands
   * on the frame the player starts moving rather than a stride later; see the idle branch in move().
   */
  private stepPhase = 1;
  private readonly opts: Required<FPSControllerOptions>;

  constructor(private engine: Engine, options: FPSControllerOptions = {}) {
    this.opts = {
      walkSpeed: options.walkSpeed ?? 2.2,
      runSpeed: options.runSpeed ?? 4.0,
      crouchSpeed: options.crouchSpeed ?? 1.1,
      eyeHeight: options.eyeHeight ?? 1.7,
      crouchEyeHeight: options.crouchEyeHeight ?? 1.1,
      radius: options.radius ?? 0.35,
      gravity: options.gravity ?? 18,
      stepUpHeight: options.stepUpHeight ?? 0.35,
    };
    this.syncCamera();
  }

  setAabbs(aabbs: AABB[]): void {
    this.aabbs = aabbs;
  }

  addAabb(a: AABB): void {
    this.aabbs.push(a);
  }

  /** Register every walkable surface in the level. Without this the floor is assumed to be y=0. */
  setFloors(floors: FloorRect[]): void {
    this.floors = floors;
  }

  /**
   * Height of the surface the player is standing on at (x, z).
   *
   * Picks the highest floor that is not above stepping range, so a stair tread wins over the
   * landing below it but an upper storey does not yank the player through its ceiling. Returns
   * the last known height when standing over nothing, which turns an unnoticed 1 cm gap between
   * two floor rects into a non-event instead of an infinite fall.
   */
  groundYAt(x: number, z: number): number {
    const feet = this.position.y - this.currentEyeHeight();
    const reach = feet + this.opts.stepUpHeight + 0.02;
    let best = -Infinity;
    let bestAny = -Infinity;
    for (const f of this.floors) {
      if (x < f.x0 || x > f.x1 || z < f.z0 || z > f.z1) continue;
      if (f.y > bestAny) bestAny = f.y;
      if (f.y <= reach && f.y > best) best = f.y;
    }
    if (best > -Infinity) return best;
    if (bestAny > -Infinity) return bestAny;
    return this.groundY;
  }

  /** Height of the surface currently underfoot. */
  getGroundY(): number {
    return this.groundY;
  }

  /** Set the look direction (radians, applied to camera Euler). */
  look(yaw: number, pitch: number): void {
    this.facing.set(pitch, yaw, 0, 'YXZ');
    this.syncCamera();
  }

  /** Current look direction, for a caller that needs to ease from where the player is looking. */
  getFacing(): { yaw: number; pitch: number } {
    return { yaw: this.facing.y, pitch: this.facing.x };
  }

  addLookDelta(dYaw: number, dPitch: number): void {
    this.facing.y -= dYaw;
    this.facing.x = MathUtils.clamp(this.facing.x - dPitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
    this.syncCamera();
  }

  setCrouch(v: boolean): void {
    if (this.crouching === v) return;
    this.crouching = v;
    // Crouching is a deliberate change of gait, so a run's credit does not survive it.
    if (v) {
      this.actuallyRunning = false;
      this.runMemory = 0;
    }
    // Re-seat the eye on the current floor rather than assuming the floor is y=0.
    if (this.onGround) this.position.y = this.groundY + this.currentEyeHeight();
    this.syncCamera();
  }

  setRun(v: boolean): void {
    this.running = v;
    // Releasing the control, crouching, or losing the floor is a decision, not a blocked frame, so
    // the gait credit goes with them rather than lingering.
    if (!v) {
      this.actuallyRunning = false;
      this.runMemory = 0;
    }
  }

  isCrouching(): boolean {
    return this.crouching;
  }

  /**
   * True only when the player is actively sprinting across the floor
   * (run button held + movement input + physically displaced + on ground + not crouching).
   * Standing still while holding the run button does NOT count as running.
   */
  isRunning(): boolean {
    return this.actuallyRunning;
  }

  /** Raw run button/key toggle state. */
  isRunIntent(): boolean {
    return this.running;
  }

  isOnGround(): boolean {
    return this.onGround;
  }

  /** The collision capsule's radius, in metres. What "the player brushed against it" means. */
  getRadius(): number {
    return this.opts.radius;
  }

  /**
   * Freeze or release translation without freezing look. Hiding places use this after warping the
   * camera into their pocket; menus do not need it because main.ts skips the simulation entirely.
   */
  setMovementLocked(locked: boolean): void {
    this.movementLocked = locked;
    if (locked) {
      this.velocity.set(0, 0, 0);
      this.running = false;
      this.actuallyRunning = false;
      this.runMemory = 0;
      this.stepPhase = 1;
    }
  }

  isMovementLocked(): boolean {
    return this.movementLocked;
  }

  /** Move relative to current facing. x = strafe (+right), y = forward (+forward). */
  move(strafe: number, forward: number, dt: number): void {
    if (this.movementLocked) {
      this.actuallyRunning = false;
      this.runMemory = 0;
      // Camera still follows look() / addLookDelta(). No gravity, collision or footstep while hidden.
      this.syncCamera();
      return;
    }
    // Where the feet were before this frame's slide, for the footstep cadence at the bottom.
    const x0 = this.position.x;
    const z0 = this.position.z;

    // Compute world-space direction from facing.
    const sinY = Math.sin(this.facing.y);
    const cosY = Math.cos(this.facing.y);
    // forward in local = -Z, but rotated by yaw:
    const fx = -sinY;
    const fz = -cosY;
    const rx = cosY;
    const rz = -sinY;

    const speed = this.crouching ? this.opts.crouchSpeed : this.running ? this.opts.runSpeed : this.opts.walkSpeed;

    const vx = (rx * strafe + fx * forward) * speed;
    const vz = (rz * strafe + fz * forward) * speed;

    // Horizontal move-and-slide with stair step-up, in substeps of at most MAX_SUBSTEP metres.
    //
    // One big slide per frame was the "player walks under the stair" bug. The hidden flight's treads
    // are 0.22 m deep and 0.275 m apart in height; running at 4 m/s on a 15 fps frame covers 0.27 m,
    // so the feet skipped a whole tread and landed two rises (0.55 m) below the one ahead. That is past
    // `groundYAt`'s step-up reach, so it picked the room floor under the flight instead, and the player
    // carried on beneath the stair. A substep never crosses more than one tread, so every rise the
    // controller sees is one it can climb. Gravity and ground snap run per substep for the same reason.
    const travel = Math.hypot(vx, vz) * dt;
    const steps = Math.max(1, Math.ceil(travel / MAX_SUBSTEP));
    const sdt = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.moveAxis(vx, vz, sdt);
      // Gravity (always applied; landing handled below).
      this.velocity.y -= this.opts.gravity * sdt;
      this.moveAxisVertical(sdt);
    }

    // The camera is a separate object and only follows through syncCamera(). Leaving it out here
    // was the "player does not move" bug: position advanced every step but the view stayed put, so
    // walking looked like nothing at all until a look-drag called addLookDelta() -> syncCamera()
    // and the camera jumped to wherever the player had already walked. Rotation appeared to work
    // for the same reason. Unconditional, because gravity can change position.y on a still frame.
    this.syncCamera();

    // --- Footsteps: one per stride of ground the player actually covered ---
    //
    // Three gates, and each one is a bug that used to be audible. `onGround`, so there are no steps in
    // mid-air. A real displacement, so walking into a wall is silent — the slide is per-axis and either
    // axis can be rejected outright, which the old timer could not see. And a real *input*, because this
    // method is called with zeroes behind an open overlay and gravity alone can move `position`.
    const wants = Math.hypot(strafe, forward) > 0.01;
    const moved = Math.hypot(this.position.x - x0, this.position.z - z0);

    // --- Is the player *sprinting*, for the purpose of making noise? ---
    //
    // This used to require `moved > 0.001` on the current frame, and that was the bug the player
    // filmed: the bar would climb toward full, stall, and she never came. The game is set in a
    // house of small rooms, so a sprinting player is *constantly* brushing a wall or rounding a
    // corner. `moveAxis` slides per-axis and rejects an axis outright on contact, so `moved` collapses
    // to ~0 on exactly those frames — and every one of them counted as "not running", which the
    // noise system then billed as decay. Measured in a 3 m room: 1.4% of frames registered as
    // running, so the bar could not fill at all.
    //
    // The mistake was asking a *displacement* question to answer an *intent* question. Whether a wall
    // blocked two centimetres of this frame's slide is not a decision the player made; holding the
    // run control into a corner is. So the gait is decided by intent (`wants`) plus the physical
    // preconditions (on ground, not crouching), and `moved` is demoted to what it is actually good
    // for: gating the *footstep* below, because a player pressed against a wall should not keep
    // playing footsteps.
    //
    // `hasMovedRecently` is a short memory rather than a per-frame test, so a single blocked frame
    // cannot flip the gait. It is the same shape of fix, for the same reason, as `DECAY_GRACE` in
    // `NoiseSystem`: one dropped frame must not undo a second of effort.
    if (moved > 0.001) this.runMemory = RUN_MEMORY;
    else this.runMemory = Math.max(0, this.runMemory - dt);

    this.actuallyRunning =
      this.running && !this.crouching && this.onGround && wants && this.runMemory > 0;
    if (this.onGround && wants && moved > 1e-5) {
      const stride = this.crouching ? STRIDE.crouch : this.running ? STRIDE.run : STRIDE.walk;
      this.stepPhase += moved / stride;
      if (this.stepPhase >= 1) {
        // Keep the fraction rather than resetting to zero, so a long frame that covers more than one
        // stride does not swallow the overshoot and drift the cadence late. Only one step is emitted
        // per frame either way: at 4 m/s a 33 ms frame is 0.13 m, an eighth of a stride, so a frame
        // long enough to owe two steps is a hitch the player already felt.
        this.stepPhase -= Math.floor(this.stepPhase);
        globalBus.emit('noise:emitted', {
          pos: this.engine.getTempVec3A().copy(this.position),
          radius: this.crouching ? LOUDNESS.crouch : this.running ? LOUDNESS.run : LOUDNESS.walk,
          kind: 'footstep',
        });
      }
    } else if (!wants) {
      // Primed, not zeroed. A player who stops mid-stride and sets off again should hear the boot land
      // on the frame they start, not after another 0.85 m of silent walking — that lag is the whole of
      // what reads as the sound being out of step with the movement.
      this.stepPhase = 1;
    }
  }

  private moveAxis(vx: number, vz: number, dt: number): void {
    const r = this.opts.radius;
    const next = this.engine.getTempVec3A().copy(this.position);
    next.x += vx * dt;
    // X axis
    if (!this.collidesAabb(next, r)) {
      this.position.x = next.x;
    }
    next.copy(this.position);
    next.z += vz * dt;
    // Z axis
    if (!this.collidesAabb(next, r)) {
      this.position.z = next.z;
    }
  }

  private moveAxisVertical(dt: number): void {
    const r = this.opts.radius;
    const eye = this.currentEyeHeight();
    this.groundY = this.groundYAt(this.position.x, this.position.z);
    const next = this.engine.getTempVec3A().copy(this.position);
    next.y += this.velocity.y * dt;

    // Stair step-up: if moving up slowly and there's a step in the way, lift.
    if (this.velocity.y < 0) {
      const footY = next.y - eye;
      if (this.collidesAabbAt(next, r)) {
        // Try stepping up: cast upward a short distance.
        const stepUp = this.engine.getTempVec3B().copy(next);
        stepUp.y += this.opts.stepUpHeight;
        if (!this.collidesAabbAt(stepUp, r)) {
          next.y = stepUp.y;
          this.velocity.y = 0;
          this.onGround = true;
        } else {
          // Hit a wall or ceiling.
          this.velocity.y = 0;
          this.onGround = true;
        }
      } else {
        this.onGround = footY <= this.groundY + 0.02;
        if (this.onGround) {
          this.position.y = this.groundY + eye;
          this.velocity.y = 0;
        } else {
          this.position.y = next.y;
        }
      }
    } else {
      // Going up — apply directly, no stair logic (jumping not in Phase 0).
      if (this.collidesAabbAt(next, r)) {
        this.velocity.y = 0;
      } else {
        this.position.y = next.y;
      }
    }
  }

  private collidesAabbAt(p: Vector3, r: number): boolean {
    for (const a of this.aabbs) {
      if (
        p.x + r > a.minX &&
        p.x - r < a.maxX &&
        p.y + r > a.minY &&
        p.y - r < a.maxY &&
        p.z + r > a.minZ &&
        p.z - r < a.maxZ
      ) {
        return true;
      }
    }
    return false;
  }

  private collidesAabb(p: Vector3, r: number): boolean {
    // Only colliders overlapping the player's own vertical band can block a horizontal move.
    // These bounds are world-space on purpose: the basement sits at y = -3, so testing against
    // eye height above an assumed y=0 floor would let the player walk through cellar walls.
    const minY = p.y - this.currentEyeHeight();
    const maxY = p.y;
    for (const a of this.aabbs) {
      if (a.maxY <= minY + 0.05) continue; // underfoot (treads, plinths)
      if (a.minY >= maxY + 0.05) continue; // overhead (door headers, ceilings)
      if (
        p.x + r > a.minX &&
        p.x - r < a.maxX &&
        maxY > a.minY &&
        minY < a.maxY &&
        p.z + r > a.minZ &&
        p.z - r < a.maxZ
      ) {
        return true;
      }
    }
    return false;
  }

  private currentEyeHeight(): number {
    return this.crouching ? this.opts.crouchEyeHeight : this.opts.eyeHeight;
  }

  private syncCamera(): void {
    // position.y already is the eye height in world space (floor height + eye offset).
    this.engine.camera.position.copy(this.position);
    this.engine.camera.quaternion.setFromEuler(this.facing);
  }

  /** Snap to a position (e.g. respawn). Resets velocity. */
  warpTo(pos: Vector3, yaw?: number): void {
    this.position.copy(pos);
    this.velocity.set(0, 0, 0);
    this.actuallyRunning = false;
    this.runMemory = 0;
    this.onGround = true;
    this.groundY = this.groundYAt(pos.x, pos.z);
    if (yaw !== undefined) this.facing.y = yaw;
    this.syncCamera();
  }

  getPosition(): Vector3 {
    return this.position;
  }
}
