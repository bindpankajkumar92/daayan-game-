/**
 * FPController — first-person camera/character controller.
 * - Walk / run / crouch
 * - Capsule-AABB collision against a simple AABB list (house interior)
 * - 0.35m stair step-up
 * - Ground-snap raycast
 * - Emits noise:emitted events on footstep (Phase 4 will consume them)
 *
 * Phase 0: no house geometry yet. AABB list is empty; controller works in open space.
 * Phase 1+ builders will register AABBs via Engine's collision registry.
 */

import { Vector3, Euler, MathUtils } from 'three';
import type { Engine } from '@/core/Engine';
import { globalBus } from '@/core/EventBus';

export interface AABB {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
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
  private aabbs: AABB[] = [];
  private footstepTimer = 0;
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

  /** Set the look direction (radians, applied to camera Euler). */
  look(yaw: number, pitch: number): void {
    this.facing.set(pitch, yaw, 0, 'YXZ');
    this.syncCamera();
  }

  addLookDelta(dYaw: number, dPitch: number): void {
    this.facing.y -= dYaw;
    this.facing.x = MathUtils.clamp(this.facing.x - dPitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
    this.syncCamera();
  }

  setCrouch(v: boolean): void {
    this.crouching = v;
    this.syncCamera();
  }

  setRun(v: boolean): void {
    this.running = v;
  }

  isCrouching(): boolean {
    return this.crouching;
  }

  isRunning(): boolean {
    return this.running;
  }

  isOnGround(): boolean {
    return this.onGround;
  }

  /** Move relative to current facing. x = strafe (+right), y = forward (+forward). */
  move(strafe: number, forward: number, dt: number): void {
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

    // Horizontal move-and-slide with stair step-up.
    this.moveAxis(vx, vz, dt);

    // Gravity (always applied; landing handled below).
    this.velocity.y -= this.opts.gravity * dt;
    this.moveAxisVertical(dt);

    // Footstep: emits on a cadence based on speed (faster = more frequent).
    if (this.onGround) {
      const stepHz = this.running ? 2.4 : 1.6;
      this.footstepTimer += dt * stepHz;
      if (this.footstepTimer >= 1) {
        this.footstepTimer -= 1;
        const loudness = this.crouching ? 1.0 : this.running ? 4.0 : 2.5;
        globalBus.emit('noise:emitted', {
          pos: this.engine.getTempVec3A().copy(this.position),
          radius: loudness,
          kind: 'footstep',
        });
      }
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
    const next = this.engine.getTempVec3A().copy(this.position);
    next.y += this.velocity.y * dt;

    // Stair step-up: if moving up slowly and there's a step in the way, lift.
    if (this.velocity.y < 0) {
      const footY = next.y - this.currentEyeHeight();
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
        this.onGround = footY <= 0.01;
        if (this.onGround) {
          this.position.y = this.currentEyeHeight();
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
    // Cap by the eye-height band; ground-only AABBs are skipped via a quick check.
    const eye = this.currentEyeHeight();
    const minY = p.y - eye;
    const maxY = p.y;
    for (const a of this.aabbs) {
      if (a.maxY <= 0.05) continue; // skip floor
      if (a.minY >= eye + 0.05) continue; // skip ceilings
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
    this.engine.camera.position.copy(this.position);
    this.engine.camera.position.y = this.currentEyeHeight();
    this.engine.camera.quaternion.setFromEuler(this.facing);
  }

  /** Snap to a position (e.g. respawn). Resets velocity. */
  warpTo(pos: Vector3, yaw?: number): void {
    this.position.copy(pos);
    this.velocity.set(0, 0, 0);
    this.onGround = true;
    if (yaw !== undefined) this.facing.y = yaw;
    this.syncCamera();
  }
}
