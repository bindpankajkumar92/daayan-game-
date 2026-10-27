/**
 * The final ritual: the player throws the lantern into the open coffin and burns the son.
 *
 * This is a short in-engine cinematic, not a pre-rendered cutscene. The coffin, skeleton, lantern and
 * room already exist; the only things invented here are the throw arc, the camera hold, the fire
 * hand-off and the black. Keeping it in-engine preserves the exact room the player has been walking
 * through and makes the fire light the same walls the player knows.
 *
 * The lantern is the player's only light. This sequence is the end of the run, so the camera lantern
 * goes out at ignition and the coffin fire takes over; there is no dark walk afterwards. The gate
 * release and the temporary end card are callbacks owned by HouseScene.
 */

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export const BURN_TIMING = {
  /** How long the camera takes to settle on the coffin. */
  LOOK_LOCK: 0.35,
  /** The wind-up: the lantern is still in the player's hand. */
  THROW_START: 0.4,
  /** Lantern leaves the hand, arcs into the coffin, and ignites. */
  THROW_END: 1.15,
  /** The fire has done its work; start closing to black. */
  BURN_END: 3.7,
  BLACK_FADE: 0.6,
  /** Gate release + temporary end card. */
  END: 4.4,
} as const;

const SHAKE_LIFE = 0.35;
/** Look above the body so the shot frames the coffin and the room, not a top-down lid. */
const AIM_LIFT = 0.55;
/** A close player would otherwise be looking almost straight down. */
const MAX_DOWN_PITCH = -0.56;

export interface BurnPlayer {
  getPosition(): Point3;
  getFacing(): { yaw: number; pitch: number };
  look(yaw: number, pitch: number): void;
  setMovementLocked(locked: boolean): void;
}

export interface BurnHud {
  setCinematic(on: boolean): void;
}

export interface BurnTouch {
  setPaused(on: boolean): void;
}

export interface BurnHeld {
  setVisible(on: boolean): void;
}

export interface BurnCamera {
  rotateX(angle: number): void;
  rotateY(angle: number): void;
  rotateZ(angle: number): void;
}

export interface BurnFx {
  begin(): void;
  setBlack(value: number, seconds: number): void;
  update(dt: number): void;
  endCinematic(): void;
  reset(): void;
}

export interface BurnFire {
  ignite(at: Point3): void;
  update(dt: number): void;
}

export interface BurnProp {
  show(): void;
  hide(): void;
  place(x: number, y: number, z: number, spin: number): void;
}

export interface CoffinBurnDeps {
  player: BurnPlayer;
  hud: BurnHud;
  touch: BurnTouch;
  held: BurnHeld;
  camera: BurnCamera;
  fx: BurnFx;
  fire: BurnFire;
  prop: BurnProp | null;
  /** World point at the centre of the son's skeleton / coffin fire. */
  getTarget: () => Point3;
  /** Camera lantern off, fire light on, audio hook for a user-supplied ignition. */
  onIgnite: () => void;
  /** Gate release and the temporary ending card (Phase 2 replaces the card). */
  onFinish: () => void;
}

function lerpAngle(from: number, to: number, t: number): number {
  let delta = to - from;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return from + delta * t;
}

export class CoffinBurn {
  private active = false;
  private elapsed = 0;
  private startYaw = 0;
  private startPitch = 0;
  private targetYaw = 0;
  private targetPitch = 0;
  private throwFrom: Point3 = { x: 0, y: 0, z: 0 };
  private target: Point3 = { x: 0, y: 0, z: 0 };
  private released = false;
  private thrown = false;
  private blackStarted = false;
  private shakeAmp = 0;
  private shakeElapsed = 0;

  constructor(private readonly deps: CoffinBurnDeps) {}

  isActive(): boolean {
    return this.active;
  }

  start(): boolean {
    if (this.active) return false;
    const { player, fx, prop } = this.deps;
    const p = player.getPosition();
    const target = this.deps.getTarget();
    const facing = player.getFacing();
    const fwdX = -Math.sin(facing.yaw);
    const fwdZ = -Math.cos(facing.yaw);
    const rightX = Math.cos(facing.yaw);
    const rightZ = -Math.sin(facing.yaw);

    this.startYaw = facing.yaw;
    this.startPitch = facing.pitch;
    const dx = target.x - p.x;
    const dz = target.z - p.z;
    this.targetYaw = Math.atan2(-dx, -dz);
    this.targetPitch = Math.min(
      -0.12,
      Math.max(
        MAX_DOWN_PITCH,
        Math.atan2(target.y + AIM_LIFT - p.y, Math.max(0.001, Math.hypot(dx, dz))),
      ),
    );
    this.throwFrom = {
      x: p.x + fwdX * 0.5 - rightX * 0.22,
      y: p.y - 0.45,
      z: p.z + fwdZ * 0.5 - rightZ * 0.22,
    };
    this.target = { ...target };

    this.active = true;
    this.elapsed = 0;
    this.released = false;
    this.thrown = false;
    this.blackStarted = false;
    this.shakeAmp = 0;
    this.shakeElapsed = 0;

    player.setMovementLocked(true);
    this.deps.hud.setCinematic(true);
    this.deps.touch.setPaused(true);
    fx.begin();
    prop?.place(this.throwFrom.x, this.throwFrom.y, this.throwFrom.z, 0);
    player.look(this.startYaw, this.startPitch);
    return true;
  }

  update(rawDt: number): void {
    if (!this.active) return;
    const dt = Math.min(Math.max(rawDt, 0), 0.1);
    this.elapsed += dt;
    const { player, fire, camera, fx, prop } = this.deps;

    const lookT = Math.min(this.elapsed / BURN_TIMING.LOOK_LOCK, 1);
    const eased = lookT * lookT * (3 - 2 * lookT);
    player.look(
      lerpAngle(this.startYaw, this.targetYaw, eased),
      this.startPitch + (this.targetPitch - this.startPitch) * eased,
    );

    if (!this.released && this.elapsed >= BURN_TIMING.THROW_START) {
      this.released = true;
      this.deps.held.setVisible(false);
      prop?.show();
      this.addShake(0.004);
    }

    const throwT = Math.min(
      Math.max(
        (this.elapsed - BURN_TIMING.THROW_START) / (BURN_TIMING.THROW_END - BURN_TIMING.THROW_START),
        0,
      ),
      1,
    );
    if (this.released && !this.thrown && prop) {
      const arc = Math.sin(Math.PI * throwT) * 0.38;
      prop.place(
        this.throwFrom.x + (this.target.x - this.throwFrom.x) * throwT,
        this.throwFrom.y + (this.target.y - this.throwFrom.y) * throwT + arc,
        this.throwFrom.z + (this.target.z - this.throwFrom.z) * throwT,
        this.elapsed * 11,
      );
    }

    if (this.released && !this.thrown && throwT >= 1) {
      this.thrown = true;
      prop?.hide();
      fire.ignite(this.target);
      this.deps.onIgnite();
      this.addShake(0.012);
    }

    if (this.thrown) fire.update(dt);

    if (this.shakeAmp > 0) {
      this.shakeElapsed += dt;
      const k = Math.max(0, 1 - this.shakeElapsed / SHAKE_LIFE);
      if (k <= 0) {
        this.shakeAmp = 0;
      } else {
        camera.rotateX(Math.sin(this.shakeElapsed * 88) * this.shakeAmp * k);
        camera.rotateY(Math.cos(this.shakeElapsed * 51) * this.shakeAmp * k * 0.6);
        camera.rotateZ(Math.sin(this.shakeElapsed * 66) * this.shakeAmp * k * 0.4);
      }
    }

    if (!this.blackStarted && this.elapsed >= BURN_TIMING.BURN_END) {
      this.blackStarted = true;
      fx.setBlack(1, BURN_TIMING.BLACK_FADE);
    }

    fx.update(dt);
    if (this.elapsed >= BURN_TIMING.END) this.finish();
  }

  reset(): void {
    this.active = false;
    this.deps.fx.reset();
    this.deps.fx.endCinematic();
    this.deps.hud.setCinematic(false);
    this.deps.touch.setPaused(false);
    this.deps.held.setVisible(true);
    this.deps.player.setMovementLocked(false);
    this.deps.prop?.hide();
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
    this.deps.fx.endCinematic();
    this.deps.onFinish();
  }
}
