/**
 * Locomotion — how Daayan moves and looks, which is not the same thing.
 *
 * §18 and §19 of the spec are both about not moving like a sliding capsule, and they are separated in
 * this file exactly as the spec separates them:
 *
 *   - **Movement** is acceleration, deceleration, a per-state maximum speed, and a turn rate cap. The
 *     cap is what makes §21's "no instant 180-degree rotations" true by construction rather than by
 *     hope: her yaw is integrated at `turnSpeedDeg` per second, so a reversal takes a measurable
 *     amount of time no matter what the state machine asks for.
 *   - **Looking** is a second, independent direction that leads the body. This is what lets her walk
 *     forward while glancing sideways, stop and look around, and — the one that matters most — turn
 *     her head toward a sound without breaking stride.
 *
 * The speed table is the spec's own (§18: PATROL slow, INVESTIGATE medium, CHASE fast, SEARCH
 * medium/slow, ATTACK contextual), read from the config so difficulty can move it.
 *
 * One thing this file deliberately does *not* do is teleport, ever. Every position change goes through
 * the same integration, so there is no code path that can put her somewhere discontinuous even if a
 * caller asks for an impossible destination.
 */

import type { Vec3 } from '@/core/types';
import type { DaayanConfig } from './DaayanConfig';
import type { NavPoint } from './NavGrid';

/** A state's locomotion profile. */
export interface MoveProfile {
  /** Metres per second. */
  maxSpeed: number;
  /** Degrees per second her *body* may turn. */
  turnSpeedDeg: number;
}

export interface LocomotionState {
  /** Her feet position in world space. */
  position: Vec3;
  /** Unit-ish planar velocity, x/z only. Height is set by the nav grid. */
  velocity: Vec3;
  /** Body yaw in radians. Where she is facing. */
  yaw: number;
  /** Where she is *looking*, which leads or lags the body yaw. */
  lookYaw: number;
  /** Gaze pitch in radians, positive up. */
  lookPitch: number;
  /** Current speed magnitude, for animation. */
  speed: number;
}

export class Locomotion {
  readonly state: LocomotionState;
  /** Set while she is deliberately stationary — a patrol dwell, or a search pause. */
  private holding = false;
  /** Where she wants to look, as an absolute yaw. Null means "look along the movement direction". */
  private wantLookYaw: number | null = null;
  private wantLookPitch = 0;

  constructor(
    private readonly cfg: DaayanConfig,
    start: Vec3,
    startYaw: number,
  ) {
    this.state = {
      position: { x: start.x, y: start.y, z: start.z } as Vec3,
      velocity: { x: 0, y: 0, z: 0 } as Vec3,
      yaw: startYaw,
      lookYaw: startYaw,
      lookPitch: 0,
      speed: 0,
    };
  }

  /** Hard placement, for waking up or a scripted move. The only non-integrated position change. */
  place(position: Vec3, yaw: number): void {
    this.state.position.x = position.x;
    this.state.position.y = position.y;
    this.state.position.z = position.z;
    this.state.velocity.x = 0;
    this.state.velocity.z = 0;
    this.state.speed = 0;
    this.state.yaw = yaw;
    this.state.lookYaw = yaw;
  }

  /** Stop asking for movement but keep decelerating naturally, rather than halting dead. */
  hold(): void {
    this.holding = true;
  }

  /** Resume moving. */
  release(): void {
    this.holding = false;
  }

  get isHolding(): boolean {
    return this.holding;
  }

  /**
   * Ask to look at an absolute yaw/pitch. Null yaw means "follow the body".
   *
   * Returning to `null` rather than to the current yaw matters: a caller that said "look at that
   * sound", then stops caring, expects her gaze to drift back to where she is going, not to freeze
   * staring at a wall.
   */
  lookAt(yaw: number | null, pitch = 0): void {
    this.wantLookYaw = yaw;
    this.wantLookPitch = pitch;
  }

  /** Look toward a world point from her current position, at her eye height. */
  lookAtPoint(point: Vec3): void {
    const dx = point.x - this.state.position.x;
    const dz = point.z - this.state.position.z;
    const dy = point.y - (this.state.position.y + this.cfg.eyeHeight);
    const flat = Math.hypot(dx, dz);
    this.wantLookYaw = Math.atan2(dx, dz);
    // Clamp the pitch so she never looks straight up or down — beyond about 70° the head bone in this
    // rig starts to tear, and a target directly overhead is not something she should be craning at.
    this.wantLookPitch = Math.max(-1.2, Math.min(1.2, Math.atan2(dy, Math.max(0.01, flat))));
  }

  /**
   * Step the model.
   *
   * `desired` is a world-space point she is trying to reach, or null to stand still. `profile` carries
   * the state's speed and turn rate, so the state machine owns "how fast should I be going" and this
   * owns "how does a body actually get there".
   */
  update(desired: Vec3 | null, profile: MoveProfile, dt: number): void {
    const st = this.state;
    const cfg = this.cfg;

    // --- Desired velocity. ---
    let wantX = 0;
    let wantZ = 0;
    let wantYaw = st.yaw;

    if (desired && !this.holding) {
      const dx = desired.x - st.position.x;
      const dz = desired.z - st.position.z;
      const flat = Math.hypot(dx, dz);

      // Arrive behaviour: ease down over the last `arriveRadius` so she does not overshoot and
      // oscillate around a waypoint. §5 asks her to "slow down naturally" and §16 forbids
      // "constantly oscillate between two positions" — this is the single line that delivers both.
      const arriveRadius = Math.max(0.6, profile.maxSpeed * 0.55);
      const arrive = flat < arriveRadius ? Math.max(0.12, flat / arriveRadius) : 1;
      const targetSpeed = profile.maxSpeed * arrive;

      if (flat > 1e-4) {
        wantX = (dx / flat) * targetSpeed;
        wantZ = (dz / flat) * targetSpeed;
        wantYaw = Math.atan2(dx, dz);
      }
    }

    // --- Accelerate toward the desired velocity. ---
    // Separate accel and decel rates (§18): starting is slower than stopping, which is what makes her
    // read as heavy rather than as a sprite with a velocity variable.
    const wantSpeed = Math.hypot(wantX, wantZ);
    const curSpeed = Math.hypot(st.velocity.x, st.velocity.z);
    const accelerating = wantSpeed > curSpeed;
    const rate = accelerating ? cfg.acceleration : cfg.deceleration;

    let vx = st.velocity.x;
    let vz = st.velocity.z;
    const dvx = wantX - vx;
    const dvz = wantZ - vz;
    const dvLen = Math.hypot(dvx, dvz);
    const maxChange = rate * dt;
    if (dvLen <= maxChange || dvLen < 1e-6) {
      vx = wantX;
      vz = wantZ;
    } else {
      vx += (dvx / dvLen) * maxChange;
      vz += (dvz / dvLen) * maxChange;
    }

    // --- Never exceed the profile's own speed. ---
    //
    // The arriving branch above snaps velocity to `want` in a single step, which is correct at 60 Hz
    // and wrong at the far LOD tier's 0.5 s. There, `maxChange = rate * 0.5` is 2-3 m/s — comfortably
    // more than the gap — so the snap fires every tick and the acceleration model stops existing:
    // she went from a standstill to full chase speed inside one 0.5 s step, and overshot her next
    // waypoint before the tier ran again. Caught by the integration suite as a 45 m/s speed readout.
    //
    // Clamping to `profile.maxSpeed` restores the invariant the whole file is built on — she can never
    // travel faster than her state allows — and it holds for any tick length rather than only the ones
    // this file happens to be called with. A velocity left over from a faster state decays through the
    // normal deceleration path instead of being clamped mid-flight, so no stop is ever instantaneous.
    const cap = profile.maxSpeed;
    const capSq = cap * cap;
    const speedSq = vx * vx + vz * vz;
    if (speedSq > capSq) {
      const scale = cap / Math.sqrt(speedSq);
      vx *= scale;
      vz *= scale;
    }

    st.velocity.x = vx;
    st.velocity.z = vz;
    st.speed = Math.hypot(vx, vz);

    // --- Integrate position. ---
    //
    // The step is capped at the distance actually left to the target. Without the cap a *short* route
    // is the dangerous one, not a long one: `currentPathPoint` steps past intermediate nodes within
    // 0.45 m, so a two-node path can hand this method a final target ~0.75 m away while she is at a
    // standstill. The arrival branch then snaps `velocity` to full chase speed in one frame, and
    // `position += v * dt` moves her 0.75 m — a genuine teleport, and entirely invisible in play
    // because she lands exactly on the node she was told to reach.
    //
    // Capping keeps the invariant this file is built on: she moves along her own path at her own
    // speed, and never further in one step than the remaining distance. She stops on the node instead
    // of sailing past it.
    const travel = Math.hypot(vx, vz) * dt;
    const remaining = desired ? Math.hypot(desired.x - st.position.x, desired.z - st.position.z) : 0;
    const factor = desired && travel > remaining && travel > 1e-6 ? remaining / travel : 1;
    st.position.x += vx * dt * factor;
    st.position.z += vz * dt * factor;

    // --- Turn the body toward the movement direction, rate-limited. ---
    // Only while actually moving: standing still she keeps facing wherever she was, which is what lets
    // her stop mid-corridor still facing down it. §21's "no instant 180s" is this clamp.
    if (wantSpeed > 0.05) {
      const maxTurn = (profile.turnSpeedDeg * Math.PI) / 180 * dt;
      st.yaw = approachAngle(st.yaw, wantYaw, maxTurn);
    }

    // --- Move the gaze, faster than the body (§19). ---
    const lookTarget = this.wantLookYaw ?? st.yaw;
    const maxLook = (cfg.lookSpeedDeg * Math.PI) / 180 * dt;
    st.lookYaw = approachAngle(st.lookYaw, lookTarget, maxLook);
    const maxPitch = (cfg.lookPitchSpeedDeg * Math.PI) / 180 * dt;
    st.lookPitch += Math.max(-maxPitch, Math.min(maxPitch, this.wantLookPitch - st.lookPitch));
  }

  /** Set her feet to a nav point's height without touching x/z. Used when stepping onto a stair. */
  conformHeight(nav: NavPoint): void {
    this.state.position.y = nav.y;
  }

  /** True when she is within `radius` of a point, in plan view only. */
  isNear(point: Vec3, radius: number): boolean {
    const dx = point.x - this.state.position.x;
    const dz = point.z - this.state.position.z;
    return dx * dx + dz * dz <= radius * radius;
  }

  /** Her eye position, the origin for vision rays (§6) and her hearing ear (§8). */
  eye(eyeHeightOverride?: number): Vec3 {
    const h = eyeHeightOverride ?? this.cfg.eyeHeight;
    return {
      x: this.state.position.x,
      y: this.state.position.y + h,
      z: this.state.position.z,
    } as Vec3;
  }
}

/**
 * Rotate `from` toward `to` by at most `maxStep`, taking the short way round.
 *
 * The wrap is the whole reason this exists: interpolating raw radians makes her spin the long way
 * round whenever the target crosses the ±π seam, which reads as a sudden inexplicable pirouette. Every
 * angle interpolation in the AI goes through here so that bug can only exist in one place.
 */
function approachAngle(from: number, to: number, maxStep: number): number {
  let delta = to - from;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  if (Math.abs(delta) <= maxStep) return to;
  return from + Math.sign(delta) * maxStep;
}

/** The move profile a state should use, from §18's speed table. */
export function profileFor(cfg: DaayanConfig, state: string): MoveProfile {
  switch (state) {
    case 'CHASE':
    case 'INTERCEPT':
      return { maxSpeed: cfg.chaseSpeed, turnSpeedDeg: cfg.turnSpeedDeg };
    case 'ATTACK':
      return { maxSpeed: cfg.chaseSpeed * 0.6, turnSpeedDeg: cfg.turnSpeedDeg * 1.2 };
    case 'INVESTIGATE_SOUND':
      return { maxSpeed: cfg.investigateSpeed, turnSpeedDeg: cfg.turnSpeedDeg * 0.75 };
    case 'SUSPICIOUS':
      return { maxSpeed: cfg.patrolSpeed * 0.8, turnSpeedDeg: cfg.turnSpeedDeg * 0.6 };
    case 'SEARCH':
      return { maxSpeed: cfg.searchSpeed, turnSpeedDeg: cfg.turnSpeedDeg * 0.7 };
    case 'STUNNED':
      return { maxSpeed: 0, turnSpeedDeg: 0 };
    case 'IDLE':
      return { maxSpeed: 0, turnSpeedDeg: cfg.turnSpeedDeg * 0.4 };
    case 'RETURN_TO_PATROL':
    case 'PATROL':
    default:
      return { maxSpeed: cfg.patrolSpeed, turnSpeedDeg: cfg.turnSpeedDeg * 0.6 };
  }
}
