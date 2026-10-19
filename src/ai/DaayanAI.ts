/**
 * DaayanAI — the orchestrator. Everything else in `src/ai/` is a subsystem; this is the thing that
 * owns them, feeds them, and turns their conclusions into movement.
 *
 * §25 of the spec requires the AI to be event-driven rather than tightly coupled: "DaayanAI subscribes
 * to relevant events. Avoid tightly coupling every gameplay system directly to DaayanAI." So this file
 * subscribes to the global bus for sound, hiding and door events, and pulls player state each tick
 * rather than having the player push it.
 *
 * §27 is the other constraint, and it shapes the whole update method: perception runs at 5–10 Hz, not
 * per frame; pathfinding is throttled and skipped entirely when nothing needs it; and there is a
 * distance-based LOD tier so a Daayan three rooms away costs almost nothing. The single most important
 * line in this file for performance is the early return in `update` — everything expensive lives
 * below it.
 *
 * §26 requires a debug mode, which lives in Debug.ts and reads this object's state.
 */

import type { Object3D } from 'three';
import { AnimationMixer, Vector3 } from 'three';
import { globalBus } from '@/core/EventBus';
import type { AABB } from '@/player/FPController';
import type { Vec3 } from '@/core/types';
import type { FPController } from '@/player/FPController';

import { daayanConfigFor, type DaayanConfig, type DifficultyName } from './DaayanConfig';
import { NavGrid, type NavPoint } from './NavGrid';
import { VisionSystem, HearingSystem, ObstacleGrid, type HeardSound, type PlayerSample } from './Perception';
import { Memory } from './Memory';
import { PatrolSystem } from './Patrol';
import { SearchPlanner } from './Search';
import { StateMachine, type AIContext, type DaayanState, type TransitionReason } from './StateMachine';
import { buildStates } from './States';
import { Locomotion, profileFor } from './Locomotion';
import { DaayanDebug, type DebugInfo } from './Debug';

/**
 * A fresh `Vec3`.
 *
 * `Vec3` is three's `Vector3` class, not a structural `{x,y,z}`, so a plain object literal will not
 * satisfy it. These are only created a handful of times per tick — the hot paths write into
 * preallocated buffers instead — so allocating here costs nothing measurable and keeps the code
 * readable.
 */
const v = (x: number, y: number, z: number): Vec3 => new Vector3(x, y, z);

/** A hiding spot the search behaviour should check (§14). */
export interface HidingSpotRef {
  id: string;
  position: Vec3;
}

export interface DaayanAIDeps {
  /** Her model root, once the async placement has landed. Null until then. */
  getRoot: () => Object3D | null;
  /** Clips that came with the model, for the walk animation. */
  getClips: () => readonly import('three').AnimationClip[];
  /** The player, for position/velocity/state. */
  player: FPController;
  /** Every static collider in the world — walls, doors, imported shells. */
  obstacles: readonly AABB[];
  /** The house's walkable rectangles, from `houseFloors()`. */
  floors: Parameters<typeof NavGrid.bake>[0];
  /** Hiding spots the search should know about. */
  hidingSpots: readonly HidingSpotRef[];
  /** Where she starts, and which way she faces. */
  start: { position: Vec3; yaw: number };
  /** Difficulty preset. */
  difficulty?: DifficultyName;
  /** Overrides applied on top of the preset, for tuning. */
  overrides?: Partial<DaayanConfig>;
  /** Scene root for the debug overlay. */
  scene?: import('three').Scene;
  /** Camera, so the debug labels can be hidden when she is off screen. */
  camera?: import('three').Camera;
  /**
   * Whether she is free to leave the room she starts in. Defaults to always true.
   *
   * The nav grid is baked **once**, at construction, from the colliders that exist then — and the
   * ritual room's door is one of them. So while that door is shut, the doorway is a wall in her graph
   * and she cannot path out of the room at all, no matter what she decides. The consequence in play
   * was that an ambient footstep anywhere in the house woke her, she went to patrol, could not leave,
   * and the player found her already standing outside the sealed door.
   *
   * This gate is the honest fix: the scene owns whether the door is open, so the scene says so, and
   * she stays asleep until it does. A predicate rather than a flag because the door's state lives in
   * the scene and she should not hold a stale copy of it.
   *
   * Optional, and **omitting it means "no gate"** — the check is `=== false`, not a truthiness test.
   * Written the obvious way (`if (!canRoam?.())`) an omitted predicate reads as a closed door and she
   * never wakes at all, which is a great deal harder to notice than the bug it was fixing.
   */
  canRoam?: () => boolean;
}

/**
 * How the walk animation maps speed to clip rate.
 *
 * Her model ships with a single 17-second loop at `speed: 0.6` — a walk, authored for a statue standing
 * in the ritual room. There is no separate run clip, so CHASE would look like a brisk stroll without
 * this. Driving `timeScale` from real velocity is the honest fix: she moves faster because she *is*
 * moving faster, and the animation agrees with the geometry rather than arguing with it.
 *
 * The ratio is expressed against the model's authored pace so that at patrol speed the clip plays at
 * exactly the rate it was authored for, and the discrepancy at chase speed is what reads as urgency.
 */
const CLIP_REFERENCE_SPEED = 1.05;

/** How long a displacement window lasts for stuck detection, in seconds. */
const STUCK_WINDOW = 1.0;
/** Below this average speed, over a whole window, she counts as wedged rather than slow. */
const STUCK_MIN_RATE = 0.25;

/**
 * Longest interval a single far-tier tick may integrate, in seconds.
 *
 * A backstop on top of the per-frame dt clamp: 0.5 s is the far tier's own period at `aiFarHz: 2`, so
 * this only ever bites if the tier's rate is lowered or a frame stalls badly. Movement is integrated in
 * one go at this rate, so an unbounded value here means an unbounded step.
 */
const LOD_MAX_STEP = 0.5;

export class DaayanAI {
  readonly cfg: DaayanConfig;
  private readonly grid: NavGrid;
  private readonly obstacles: ObstacleGrid;
  private readonly vision: VisionSystem;
  private readonly hearing: HearingSystem;
  private readonly memory: Memory;
  private readonly patrol: PatrolSystem;
  private readonly planner: SearchPlanner;
  private readonly fsm: StateMachine;
  private readonly loco: Locomotion;
  private readonly player: FPController;
  private readonly deps: DaayanAIDeps;

  /** Model root and its mixer, both null until the async placement lands. */
  private root: Object3D | null = null;
  private mixer: AnimationMixer | null = null;
  private clipAction: import('three').AnimationAction | null = null;

  /** Shared context object, rewritten each tick rather than reallocated. */
  private readonly ctx: AIContext;
  /** Clock, in seconds since the AI started. */
  private now = 0;
  /** Whether she has been woken yet (the wake-on-trigger design). */
  private awake: boolean;
  /** Sound events accumulated since the last perception tick. */
  private pendingSounds: HeardSound[] = [];
  /** The most recent loud and medium sounds for this tick's context. */
  private loudSound: { position: Vec3; loudness: number } | null = null;
  private mediumSound: { position: Vec3; loudness: number } | null = null;
  /** The sound she is currently reacting to, kept past the tick so the overlay can show it (§26). */
  private currentSound: HeardSound | null = null;
  /**
   * A maxed noise bar that arrived while she was asleep, copied at the moment it fired, delivered
   * by `wake` rather than at once.
   *
   * A copy, never the event's own object: the bus hands around the player's live position vector,
   * and stashing the reference would make the "place the noise maxed" silently follow the player
   * around the house until she woke.
   */
  private stashedAlert: Vec3 | null = null;
  /**
   * A maxed noise bar awaiting delivery, with the exact position it fired at.
   *
   * Deliberately bypasses the hearing model: a full bar is the loudest thing the player can do,
   * and "she did not hear you because falloff + walls ate it" is the bug. Consumed every tick in
   * `buildContext` (not on the throttled perception rate) so she reacts on the next tick, wherever
   * she is. Latest position wins.
   */
  private pendingAlert: Vec3 | null = null;
  /** The last intercept point she planned, for the overlay's "prediction target" readout (§26). */
  private actionPrediction: Vec3 | null = null;
  /** Edge detector for the attack, so `game:caught` fires once per catch and not once per frame. */
  private attackerLatched = false;
  /**
   * Time before which she may not grab again, or 0 for "not recovering".
   *
   * Set when a catch lands. See `catchRecovery` in the config for why this has to exist: without it
   * she catches, stuns herself, wakes, finds the player still in range, and catches again forever.
   */
  private catchRecoveryUntil = 0;
  /** Last state announced on the bus, so `daayan:state` fires on changes rather than every tick. */
  private lastAnnounced: DaayanState | null = null;

  /** Throttle accumulators. */
  private sincePerception = 0;
  private sinceRepath = 0;
  private sinceFarTick = 0;

  /**
   * Seconds of world time the last `update` actually integrated.
   *
   * Not the `dt` it was called with: in the far LOD tier she only runs `aiFarHz` times a second and
   * integrates the whole accumulated interval in one go, so a tick can represent up to `LOD_MAX_STEP`
   * of world time. Callers measuring her speed — the debug overlay, and the integration suite's
   * no-teleport assertion — must divide by *this*, not by the frame time, or correct far-tier
   * substepping reads as a 45 m/s jump.
   */
  private lastStep = 0;

  /** Pathfinding state. */
  private path: NavPoint[] = [];
  private pathIndex = 0;
  private pathTarget: Vec3 | null = null;
  private pathFailed = false;

  /** Stuck detection (§16). Displacement accumulated over a rolling window — see `updateStuck`. */
  private stuckWindow = 0;
  private stuckMoved = 0;
  private lastPosition: Vec3;
  private stuck = false;

  /** Previous remembered velocity, so a reversal can be detected for prediction damping (§12). */
  private prevVelocity: Vec3 | null = null;
  private directionChangedAt = -Infinity;

  /** Player velocity captured at the last sighting, which is what prediction may use. */
  private rememberedVelocity: Vec3 | null = null;

  private readonly debug: DaayanDebug | null;
  private unsubs: (() => void)[] = [];
  private disposed = false;

  constructor(deps: DaayanAIDeps) {
    this.deps = deps;
    this.player = deps.player;
    // Overrides are applied last so tuning callers win — except for `debug`, which §26 requires to be
    // impossible in a release build. Without this the override merge would silently undo the guard in
    // `daayanConfigFor`, which is exactly the kind of hole a production check exists to not have.
    this.cfg = {
      ...daayanConfigFor(deps.difficulty ?? 'normal'),
      ...(deps.overrides ?? {}),
      ...(import.meta.env.PROD ? { debug: false } : {}),
    };

    // Navigation is baked once from the same data the player walks on, so the two cannot disagree.
    this.grid = NavGrid.bake(deps.floors, deps.obstacles);
    this.obstacles = new ObstacleGrid(deps.obstacles);
    this.vision = new VisionSystem(this.cfg, this.obstacles);
    this.hearing = new HearingSystem(this.cfg, this.obstacles);
    this.memory = new Memory(this.cfg);
    this.patrol = new PatrolSystem(this.cfg, this.grid);
    this.planner = new SearchPlanner(this.cfg, this.grid, this.patrol, deps.hidingSpots);
    this.fsm = new StateMachine(buildStates(this.cfg, this.patrol, this.planner), 'IDLE');
    this.loco = new Locomotion(this.cfg, deps.start.position, deps.start.yaw);

    this.awake = !this.cfg.wakeOnTrigger;
    this.lastPosition = v(deps.start.position.x, deps.start.position.y, deps.start.position.z);
    this.pathTarget = null;
    this.pathFailed = false;

    this.ctx = {
      now: 0,
      position: this.loco.state.position,
      eye: this.loco.eye(),
      playerPosition: v(0, 0, 0),
      playerEye: v(0, 0, 0),
      playerHidden: false,
      visionConfidence: 0,
      playerVisible: false,
      visibility: 0,
      playerDistance: Infinity,
      memoryPosition: null,
      memoryConfidence: 0,
      memoryAge: Infinity,
      playerVelocityHint: null,
      playerDirectionChanged: false,
      loudSound: null,
      mediumSound: null,
      atDestination: false,
      navigationFailed: false,
      stuck: false,
      attackRange: this.cfg.attackRange,
      catchRecovery: false,
      stunnedThisTick: false,
    };

    this.debug = this.cfg.debug && deps.scene && deps.camera
      ? new DaayanDebug(this.cfg, deps.scene, deps.camera)
      : null;
    this.wireEvents();
    this.fsm.start(this.ctx);
  }
  // --- Event wiring (§25) -------------------------------------------------

  /**
   * Subscribe to the bus rather than being called by each system.
   *
   * Only sound and hiding are subscribed to directly. Doors and moved objects already emit
   * `noise:emitted`, so listening to that one event covers §8's whole list without the AI knowing what
   * a door is — which is the decoupling §25 asks for.
   */
  private wireEvents(): void {
    const offNoise = globalBus.on('noise:emitted', (e) => {
      if (!this.cfg.enabled) return;
      // Waking on the first real noise is the agreed design: she sleeps in the ritual room and the
      // house stays calm until something in it moves. A footstep is enough — a player who has learned
      // to walk quietly still has to cross creaking floors to get there.
      if (!this.awake) {
        if (!this.cfg.wakeOnTrigger) return;
        // Not yet: she is still sealed in, and the grid has the door as a wall. Waking here is what
        // let her reach the player before the door had opened — see `canRoam`.
        //
        // `!== false` rather than a truthiness test: an omitted predicate means "no gate", and
        // `undefined` is falsy, so `if (!this.deps.canRoam?.())` would silently never wake her for any
        // caller that did not supply one.
        if (this.deps.canRoam?.() === false) return;
        this.wake();
      }
      const kind = e.kind === 'cat' ? 'cat' : e.kind === 'object' ? 'object' : e.kind === 'door' ? 'door' : e.kind === 'footstep' ? (this.player.isRunning() ? 'sprint' : 'footstep') : 'special';
      const heard = this.hearing.perceive(
        { position: e.pos, loudness: 0, kind, time: this.now },
        this.loco.eye(),
      );
      if (heard) this.pendingSounds.push(heard);
    });
    this.unsubs.push(offNoise);

    const offHidden = globalBus.on('player:hidden', (e) => {
      // Hiding is a first-class signal: it changes what she can see immediately, and the search
      // behaviour uses it to know that a spot is worth checking.
      this.setPlayerHidden(e.hidden);
    });
    this.unsubs.push(offHidden);

    /**
     * The noise bar hitting maximum.
     *
     * `NoiseSystem` has always emitted this — its own comment says it is "for future AI integration"
     * — but nothing ever subscribed, so the bar could sit full while she patrolled obliviously. Which
     * is exactly what the player reported: bar maxed, she never came.
     *
     * This is deliberately not a mere loud sound. A full bar means the player has made an
     * unmistakable racket, so she is *told* where it came from rather than having to localise it: this
     * is the one case where the noise is loud enough that a human would simply know. It routes
     * through the same INVESTIGATE_SOUND state as any other loud noise, so the priority ladder still
     * applies — a chase in progress is not interrupted by it.
     */
    const offAlert = globalBus.on('noise:alert', (e) => {
      if (!this.cfg.enabled) return;
      if (!this.awake) {
        // Sealed in the ritual room: the racket is exactly what breaks the seal — HouseScene opens
        // the screen on this same event and the frame loop wakes her a beat later. Dropping the
        // alert here was the reported bug ("bar maxed, she never came"): stash it instead, and
        // `wake` delivers it so her first move is toward the place the bar maxed.
        if (this.deps.canRoam?.() === false) {
          this.stashedAlert = v(e.pos.x, e.pos.y, e.pos.z);
          return;
        }
        if (!this.cfg.wakeOnTrigger) return;
        // Awake-able right now: route through the stash anyway so there is exactly one delivery
        // path for a sleeping Daayan, then let `wake` do the delivering.
        this.stashedAlert = v(e.pos.x, e.pos.y, e.pos.z);
        this.wake();
        return;
      }
      this.deliverNoiseAlert(e.pos);
    });
    this.unsubs.push(offAlert);
  }

  /**
   * Deliver a maxed noise bar as a guaranteed loud sound at the exact position.
   *
   * Bypasses the hearing model on purpose: falloff + wall damping could shrink a house-spanning
   * max to below `hearingThreshold` (far + walls = null) or below `hearingLoudThreshold`
   * (medium instead of loud), which is exactly "bar full but she patrols". A full bar is the
   * loudest thing the player can do — she knows where it maxed, wherever she is, and comes to
   * search it. Queued in `pendingAlert` and consumed every tick in `buildContext`, not on the
   * throttled perception rate.
   */
  private deliverNoiseAlert(pos: Vec3): void {
    // Copy: the bus hands around the player's live position vector, and keeping the reference
    // would make the target follow the player until consumed.
    this.pendingAlert = v(pos.x, pos.y, pos.z);
  }

  /** Wake her up. The trigger is the caller's business; the AI just starts behaving. */
  wake(): void {
    if (this.awake) return;
    this.awake = true;
    // IDLE is left by evidence, and there is none yet, so she goes straight to patrol on waking. The
    // first thing the player hears should be her footsteps somewhere else in the house.
    this.fsm.force('RETURN_TO_PATROL', this.ctx, 'recovered');
    // A noise bar that maxed while she slept is delivered now, not at the moment it fired: if she
    // was sealed in, the alert is what broke the seal, and the delivery had to wait for her to
    // actually be up. Latest position wins — she comes to where the bar last maxed.
    const stashed = this.stashedAlert;
    this.stashedAlert = null;
    if (stashed) this.deliverNoiseAlert(stashed);
  }

  isAwake(): boolean {
    return this.awake;
  }

  /**
   * Send her home — back to her spawn, empty-headed, patrolling.
   *
   * Called when she catches the player. The catch already spent a life and the player has been sent
   * back to the bed; leaving her standing in the room where the catch happened would mean the player
   * respawns into a house where she is already mid-hunt, which is a second catch rather than a
   * second chance. So this is a full undo of everything the encounter taught her:
   *
   * - **Position and heading**, via `Locomotion.place`, which also clears speed and any held path.
   * - **Belief**, via `Memory` — a forgotten player is the whole point. Clearing the *state machine*
   *   without clearing memory would leave her walking confidently to the player's last known position,
   *   which is exactly where the player has just been put back.
   * - **Perception**, so a stale `visionConfidence` of 1.0 does not carry into the new attempt.
   * - **The sound queue**, because a footstep perceived before the catch must not be replayed after it.
   * - **The catch-recovery window**, which is a mercy for the *player* after a catch; on a fresh
   *   attempt it would instead be a window in which she cannot catch them at all.
   *
   * She stays awake if she was awake — this is a respawn, not a reset of the whole run, and a player
   * who has already woken her should not get a quiet house back for free. `wakeOnTrigger` still
   * governs whether the *first* noise wakes her, which is the scene's business via `canRoam`.
   */
  resetToStart(): void {
    this.loco.place(
      v(this.deps.start.position.x, this.deps.start.position.y, this.deps.start.position.z),
      this.deps.start.yaw,
    );
    this.path = [];
    this.pathIndex = 0;
    this.pathTarget = null;
    this.pathFailed = false;

    this.memory.clear();
    this.vision.reset();
    this.pendingSounds.length = 0;
    this.loudSound = null;
    this.mediumSound = null;
    this.currentSound = null;
    this.stashedAlert = null;
    this.pendingAlert = null;

    this.rememberedVelocity = null;
    this.prevVelocity = null;
    this.directionChangedAt = -Infinity;
    this.attackerLatched = false;
    this.catchRecoveryUntil = 0;

    this.stuckWindow = 0;
    this.stuckMoved = 0;
    this.stuck = false;
    this.lastPosition = v(this.deps.start.position.x, this.deps.start.position.y, this.deps.start.position.z);

    // `force` rather than `request`: every state must yield, including STUNNED, which otherwise
    // refuses every candidate while its own timer runs.
    this.fsm.force('RETURN_TO_PATROL', this.ctx, 'recovered');
  }

  /** Her current state name, for the HUD and the debug overlay. */
  getState(): DaayanState {
    return this.fsm.current;
  }

  /**
   * Seconds of world time the last `update` integrated.
   *
   * Exposed so anything measuring her speed divides by the time that actually elapsed. See
   * `lastStep`.
   */
  getLastStep(): number {
    return this.lastStep;
  }

  /** Why she entered it. §26's debug display, and the answer to "why is she doing that?". */
  getReason(): TransitionReason {
    return this.fsm.reason;
  }

  getPosition(): Vec3 {
    return this.loco.state.position;
  }

  /** Her eye position — the ray origin for vision, and the ear for hearing. */
  getEye(): Vec3 {
    return this.loco.eye();
  }

  /**
   * Emit `game:caught` when she lands an attack (§18), exactly once per catch.
   *
   * This is a level-triggered signal turned into an edge: the ATTACK state sets `stunnedThisTick`'s
   * opposite — it holds the player in range for several frames while the grab plays out — so without
   * the latch the game-over handler would fire every frame. Clearing the latch on leaving ATTACK
   * means a second catch after a recovery still registers.
   */
  private checkCatch(): void {
    const inAttack = this.fsm.current === 'ATTACK';
    if (inAttack && !this.attackerLatched && this.ctx.playerDistance <= this.cfg.attackRange) {
      this.attackerLatched = true;
      // Hold her off for the recovery window. Whoever handles `game:caught` gets this long to respawn
      // or reset; if nobody handles it, this is still what stops her re-grabbing the same stationary
      // player every 2.5 s forever.
      this.catchRecoveryUntil = this.now + this.cfg.catchRecovery;
      globalBus.emit('game:caught', undefined);
    } else if (!inAttack) {
      this.attackerLatched = false;
    }
  }

  /**
   * Whether the catch-recovery window is still open.
   *
   * Kept separate from STUNNED so the two are tunable independently: STUNNED is how long the *grab
   * animation* reads, recovery is how long the *encounter* stays neutral. They usually differ.
   */
  private inCatchRecovery(): boolean {
    return this.catchRecoveryUntil !== 0 && this.now < this.catchRecoveryUntil;
  }

  /** Everything the debug overlay needs (§26). */
  getDebugInfo(): DebugInfo {
    return {
      position: this.loco.state.position,
      eye: this.loco.eye(),
      state: this.fsm.current,
      reason: this.fsm.reason,
      confidence: this.vision.getConfidence(),
      memoryPosition: this.memory.getPosition(),
      memoryConfidence: this.memory.getConfidence(),
      target: this.pathTarget,
      lastSeen: this.memory.getLastSeen()?.position ?? null,
      lastHeard: this.memory.getLastHeard()?.position ?? null,
      path: this.path,
      pathValid: !this.pathFailed,
      searchPoints: this.planner.all().map((p) => p.nav),
      searchIndex: this.planner.currentIndex(),
      prediction: this.actionPrediction,
      stuck: this.stuck,
      awake: this.awake,
      speed: this.loco.state.speed,
      yaw: this.loco.state.yaw,
      lookYaw: this.loco.state.lookYaw,
      visionRays: this.vision.getLastResult().rays,
      visibility: this.vision.getLastResult().visibility,
      sound: this.currentSound,
    };
  }

  // --- The tick ----------------------------------------------------------

  /**
   * Advance the AI.
   *
   * The order matters and is deliberate: throttle decision → gather context → perceive → react
   * (sounds) → decide (FSM) → path → move → propagate to the model.
   */
  update(dt: number): void {
    if (!this.cfg.enabled || this.disposed) return;
    // Clamp dt so a hitch (a texture upload, a tab regaining focus) cannot teleport her. 0.1 s is six
    // frames at 60 Hz and about as much as a body could plausibly have moved in one unnoticed step.
    dt = Math.min(dt, 0.1);
    this.now += dt;

    const playerPos = this.player.getPosition();
    const dx = playerPos.x - this.loco.state.position.x;
    const dz = playerPos.z - this.loco.state.position.z;
    const playerDistSq = dx * dx + dz * dz;

    // --- §27: AI LOD. Far away, she costs almost nothing. ---
    if (playerDistSq > this.cfg.aiSleepDistance ** 2) {
      // Nothing here can matter, and she is far enough that the player cannot observe a frozen AI.
      this.syncModel();
      return;
    }

    const far = playerDistSq > this.cfg.aiLodDistance ** 2;
    /**
     * Seconds of world time this tick is responsible for.
     *
     * In the far tier the AI only *runs* `aiFarHz` times a second, so the dt it must integrate is the
     * time since it last ran, not the frame time. Passing the frame's `1/60` instead meant she moved at
     * two sixtieths of a second per second — about 0.1 m/s, which reads as standing still. That was one
     * half of "she never patrols the house"; the other half was the tier skipping pathfinding entirely.
     */
    let step = dt;
    if (far) {
      // Reduced-rate tier: perception and decisions at a lower rate, but movement still integrates
      // the whole interval so she covers the same ground.
      this.sinceFarTick += dt;
      const interval = 1 / this.cfg.aiFarHz;
      if (this.sinceFarTick < interval) {
        this.syncModel();
        return;
      }
      step = Math.min(this.sinceFarTick, LOD_MAX_STEP);
      this.sinceFarTick = 0;
    } else {
      // Back in the near tier: drop any part-interval the far tier was holding.
      //
      // Without this the accumulator survives the crossing. The player walks toward her, the tier flips
      // to near, and the stalled fraction sits there — and if the player then walks away again, the
      // first far tick hands *that stale fraction plus* a fresh frame to `Locomotion.update` in one go.
      // Caught by the integration suite's teleport assertion as a 46 m/s step.
      this.sinceFarTick = 0;
    }
    this.lastStep = step;

    // --- Perception at its own rate (§27), never per frame. ---
    this.sincePerception += dt;
    const perceptionInterval = 1 / this.cfg.perceptionHz;
    const doPerceive = this.sincePerception >= perceptionInterval;
    if (doPerceive) {
      this.sincePerception = 0;
      this.perceive(perceptionInterval);
    }

    // --- Build the context the FSM reads. ---
    this.buildContext(playerPos);

    // --- Let the FSM run, then act on what it asked for. ---
    // Ticked with `step`, so a state's own timers (dwells, pauses, deadlines) advance by the world time
    // that actually passed rather than by one frame's worth.
    const directive = this.fsm.tick(this.ctx, step);

    // --- React to a stun request from the player side. ---
    if (this.ctx.stunnedThisTick) {
      this.ctx.stunnedThisTick = false;
      this.fsm.force('STUNNED', this.ctx, 'stunned');
    }

    // --- Attack landing (§18): the one place the AI may end the game. ---
    this.checkCatch();

    // --- Announce a state change (§25), so the HUD, audio and story triggers can react without
    // polling. Emitted on the *change* rather than every tick, and from here rather than from
    // `perceive`, so a transition is reported on the tick it actually happens. ---
    if (this.fsm.current !== this.lastAnnounced) {
      this.lastAnnounced = this.fsm.current;
      globalBus.emit('daayan:state', { state: this.fsm.current });
    }

    // --- Keep the prediction the overlay reports in step with what she planned. ---
    // Asked for fresh rather than cached, because `intercept` is a pure function of the context and
    // re-running it here means the overlay shows exactly what a state would receive this tick.
    this.actionPrediction = this.planner.intercept(this.ctx, this.cfg)?.point ?? null;

    // --- Pathing, throttled (§11: "Do NOT calculate expensive pathfinding every render frame"). ---
    // Pathfinding runs in *both* LOD tiers, at a lower rate when she is far away.
    //
    // It used to be skipped entirely in the far tier, on the reasoning that nobody can see her being
    // wrong at that range. The reasoning was wrong: in a three-storey house the player is far away
    // most of the time, so "far" is the normal case. She would build a route only while the player
    // happened to be within `aiLodDistance`, and otherwise stand frozen wherever she was — which is
    // why she never patrolled the house and never came when the noise bar filled, both reported from
    // play. The tier still pays for itself: `farRepathHz` is 1, against 6 while chasing.
    this.updatePath(step, directive.destination, far ? this.cfg.farRepathHz : null);


    // --- Movement is continuous. ---
    const profile = profileFor(this.cfg, this.fsm.current);
    const seek = this.pathIndex < this.path.length ? this.currentPathPoint() : null;
    // `Locomotion.update` steers toward a world point; `currentPathPoint` yields a nav cell, which is
    // the same thing with a cell height. Converted rather than cast so the height survives.
    // `step`, not `dt`: in the far tier this is the whole interval since she last moved.
    this.loco.update(seek ? v(seek.x, seek.y, seek.z) : null, profile, step);

    // --- Gaze follows the directive. ---
    if (directive.lookAt) {
      this.loco.lookAtPoint(directive.lookAt);
    } else {
      this.loco.lookAt(null, 0);
    }

    // --- Stuck recovery (§16, §28). ---
    // Also stepped by the interval, or the far tier's low tick rate reads as a permanent stall and
    // trips the stuck recovery every second.
    this.updateStuck(step);

    // --- Animation and pose. ---
    this.syncModel();
    this.debug?.update(this.getDebugInfo(), dt);
  }

  /** Run one perception sample and fold the results into memory. */
  private perceive(dt: number): void {
    const st = this.loco.state;
    const p = this.player.getPosition();

    // Her gaze angle drives the FOV test, so she sees what she is looking at rather than what her body
    // happens to be facing (§19).
    const sample: PlayerSample = {
      eye: v(p.x, p.y, p.z),
      feet: v(p.x, p.y - (this.playerEyeHeight()), p.z),
      velocity: v(this.player.velocity.x, this.player.velocity.y, this.player.velocity.z),
      eyeHeight: this.playerEyeHeight(),
      hidden: this.playerHidden(),
    };

    // The ray origin is her eye, not her whole locomotion state — the signature says `Vec3` and the
    // state is a bundle of position, yaw and speed. `loco.eye()` is the same origin the hearing ear
    // uses, so sight and sound agree about where her head is.
    const result = this.vision.sample(this.loco.eye(), st.lookYaw, st.lookPitch, sample, dt);

    const visible = this.vision.isConfident(this.fsm.current === 'CHASE' || this.fsm.current === 'INTERCEPT');
    if (result.visibility > this.cfg.visionMinVisibility && visible) {
      this.memory.noteSeen(sample.eye, this.now, sample.velocity, this.vision.getConfidence());
      this.rememberedVelocity = v(sample.velocity.x, sample.velocity.y, sample.velocity.z);
      // Direction-reversal detection (§12). A large angle between the previous remembered heading and
      // this one means the player is jinking, which weakens any prediction for a while.
      if (this.prevVelocity) {
        const ax = this.prevVelocity.x;
        const az = this.prevVelocity.z;
        const bx = sample.velocity.x;
        const bz = sample.velocity.z;
        const la = Math.hypot(ax, az);
        const lb = Math.hypot(bx, bz);
        if (la > 0.4 && lb > 0.4) {
          const dot = (ax * bx + az * bz) / (la * lb);
          if (dot < -0.2) this.directionChangedAt = this.now;
        }
      }
      this.prevVelocity = v(sample.velocity.x, sample.velocity.y, sample.velocity.z);
    }

    // Hearing: fold this interval's sounds into memory, loudest first.
    if (this.pendingSounds.length > 0) {
      // Keep only the loudest — two sounds in one interval are one decision (§4 has one LOUD_SOUND
      // slot, not a queue).
      let loudest = this.pendingSounds[0] as HeardSound;
      for (const s of this.pendingSounds) if (s.perceivedLoudness > loudest.perceivedLoudness) loudest = s;
      this.pendingSounds.length = 0;
      this.currentSound = loudest;
      this.memory.noteHeard(loudest.position, this.now, loudest.perceivedLoudness);
      if (this.hearing.isLoud(loudest)) {
        this.loudSound = { position: loudest.position, loudness: loudest.perceivedLoudness };
      } else if (loudest.perceivedLoudness >= this.cfg.suspicionSoundThreshold) {
        this.mediumSound = { position: loudest.position, loudness: loudest.perceivedLoudness };
      }
    }
  }

  /** Fill the shared context from the subsystems. */
  private buildContext(playerPos: Vec3): void {
    const c = this.ctx;
    c.now = this.now;
    c.position = this.loco.state.position;
    c.eye = this.loco.eye();

    // The player's true position is available for the two geometry uses the spec allows. It is never
    // read for a navigation decision — see the note in States.ts.
    c.playerPosition = v(playerPos.x, playerPos.y, playerPos.z);
    c.playerEye = v(playerPos.x, playerPos.y, playerPos.z);
    c.playerHidden = this.playerHidden();
    c.playerDistance = Math.hypot(playerPos.x - c.eye.x, playerPos.y - c.eye.y, playerPos.z - c.eye.z);

    c.visionConfidence = this.vision.getConfidence();
    c.visibility = this.vision.getLastResult().visibility;
    c.playerVisible = this.vision.isConfident(this.fsm.current === 'CHASE' || this.fsm.current === 'INTERCEPT');

    // A maxed noise bar is guaranteed evidence: exact position, every tick, anywhere.
    // Latest wins; written to memory so INVESTIGATE/SEARCH navigate to it even after the tick.
    if (this.pendingAlert) {
      const at = this.pendingAlert;
      this.pendingAlert = null;
      this.loudSound = { position: at, loudness: 1 };
      this.memory.noteHeard(at, this.now, 1.0);
      this.currentSound = {
        position: at,
        source: at,
        baseLoudness: 1,
        perceivedLoudness: 1,
        kind: 'special',
        time: this.now,
      };
    }

    this.memory.decay(0, this.now);
    c.memoryPosition = this.memory.getPosition();
    c.memoryConfidence = this.memory.getConfidence();
    c.memoryAge = this.memory.age(this.now);
    // Prediction may only use a velocity she actually observed, and only while it is fresh (§12/§30).
    c.playerVelocityHint = this.memory.getRecentVelocity(this.now) && this.rememberedVelocity
      ? this.rememberedVelocity
      : null;
    c.playerDirectionChanged = this.now - this.directionChangedAt < 1.5;

    c.loudSound = this.loudSound;
    c.mediumSound = this.mediumSound;
    // Cleared after the FSM reads them: a sound is a moment, not a state.
    this.loudSound = null;
    this.mediumSound = null;

    c.atDestination = this.pathIndex >= this.path.length && this.pathTarget !== null;
    c.navigationFailed = this.pathFailed;
    c.stuck = this.stuck;
    c.attackRange = this.cfg.attackRange;
    c.catchRecovery = this.inCatchRecovery();
  }

  /**
   * Keep the path in step with wherever she is trying to go, at a throttled rate.
   *
   * §11 gives 3–10 recalcs per second. The low end is used while patrolling and the high end while
   * chasing, because a patrol target is a fixed waypoint that does not move while a chased player does.
   *
   * `farHz`, when given, overrides the rate for the far LOD tier.
   */
  private updatePath(dt: number, destination: Vec3 | null, farHz: number | null = null): void {
    if (!destination) {
      // Standing still: drop the path so she does not resume walking toward a stale target.
      this.path = [];
      this.pathIndex = 0;
      this.pathTarget = null;
      this.pathFailed = false;
      return;
    }

    const chasing = this.fsm.current === 'CHASE' || this.fsm.current === 'INTERCEPT' || this.fsm.current === 'ATTACK';
    const hz = farHz ?? (chasing ? this.cfg.repathHzChase : this.cfg.repathHzPatrol);
    // A far-tier route must not be repathed the instant she drifts, or the throttle is pointless.
    const driftLimit = farHz !== null ? Infinity : chasing ? 1.2 : 2.5;
    this.sinceRepath += dt;

    // Repath early if she has drifted meaningfully off the current route, which catches a target that
    // moved without waiting for the throttle.
    const drifted = this.pathTarget !== null
      && Math.hypot(destination.x - this.pathTarget.x, destination.z - this.pathTarget.z) > driftLimit;

    const due = this.sinceRepath >= 1 / hz;
    if (!due && !drifted) return;
    this.sinceRepath = 0;

    this.repath(destination);
  }

  /** Recompute the route to a destination. */
  private repath(destination: Vec3): void {
    const from = v(this.loco.state.position.x, this.loco.state.position.y, this.loco.state.position.z);

    // A destination from the states is either a nav point (already a floor height) or a remembered
    // position (an eye height, ~1.6 m above its floor). Pathfinding wants a floor height, so resolve
    // the destination to the walkable surface *at its own storey* first. The lookup is generous
    // (the 3.0 m window) precisely so an eye height maps down onto the floor beneath it rather than
    // failing; the CHASE-to-upstairs case then resolves to the real top of the up-shaft instead of
    // the tread 3.1 m below it. Without this she would climb three steps to a one-node "path" and
    // stop there forever — the stall the trace showed at y = 0.90.
    const surface =
      this.grid.nearestWalkable(destination.x, destination.z, 12, destination.y) ??
      this.grid.nearestWalkable(destination.x, destination.z, 12);
    if (!surface) {
      this.path = [];
      this.pathIndex = 0;
      this.pathFailed = true;
      return;
    }

    const goal = surface;
    const path = this.grid.findPath(from, goal, 0);
    if (!path || path.length === 0) {
      // §28 failure recovery: cannot reach it. Try the nearest walkable point to the destination, which
      // covers the common case of a target that resolved a hair inside a wall, and only give up after.
      const fallback = this.grid.nearestWalkable(destination.x, destination.z, 8, surface.y);
      if (fallback) {
        const alt = this.grid.findPath(from, fallback, 0);
        if (alt && alt.length > 0) {
          this.path = alt;
          this.pathIndex = 0;
          this.pathTarget = v(destination.x, surface.y, destination.z);
          this.pathFailed = false;
          return;
        }
      }
      this.path = [];
      this.pathIndex = 0;
      this.pathFailed = true;
      return;
    }
    this.path = path;
    this.pathIndex = 0;
    this.pathTarget = v(destination.x, surface.y, destination.z);
    this.pathFailed = false;
  }

  /**
   * The path point she should be steering at.
   *
   * Points are consumed by proximity, but the **last** one never is: it is the destination, and
   * dropping it means "she has arrived". The distinction matters because an exhausted path is what
   * `wantsToMove` reads, so quietly consuming the final point silently disarmed stuck detection — the
   * bug that left her standing in the ritual room mid-chase, targeting a remembered position within
   * arm's reach, flagged neither stuck nor arrived.
   */
  private currentPathPoint(): NavPoint | null {
    while (this.pathIndex < this.path.length) {
      const p = this.path[this.pathIndex] as NavPoint;
      const last = this.pathIndex === this.path.length - 1;
      const d = Math.hypot(p.x - this.loco.state.position.x, p.z - this.loco.state.position.z);
      // Step past intermediate points she has effectively reached, so she does not oscillate around
      // one; hold on the final point even at zero range so "arrived" stays visible to the caller.
      if (!last && d < 0.45) {
        this.loco.conformHeight(p);
        this.pathIndex++;
        continue;
      }
      return p;
    }
    return null;
  }

  /**
   * Stuck detection and recovery (§16, §28).
   *
   * "If Daayan remains stationary for too long: detect stuck condition -> recalculate path -> choose
   * alternate route." Note the order: she is only stuck if she is *trying* to move and not moving,
   * which is why this needs a non-empty path as well as a low progress rate.
   *
   * Progress is measured as **distance travelled over a window**, accumulated per tick from the step
   * actually taken — not net displacement from where the window started. Two earlier versions used a
   * per-tick delta and then a net-displacement window, and both were wrong in ways worth recording:
   * the per-tick version compared 0.025 m of a 60 Hz stride against an epsilon meant for "stationary",
   * so the flag could never clear; the net-displacement version read zero for an agent shuttling back
   * and forth near its target, which is a real oscillation but not a stuck agent, and it would have
   * sent her off to a waypoint every second while she was chasing correctly. Distance travelled
   * distinguishes "wedged against a wall" from "jittering around a point", which is the distinction
   * that decides whether recovery should fire.
   */
  private updateStuck(dt: number): void {
    const st = this.loco.state;
    const wantsToMove = this.path.length > 0 && this.pathIndex < this.path.length;

    // Per-tick step, then accumulated. This is the frame-rate-independent quantity.
    const stepLen = Math.hypot(st.position.x - this.lastPosition.x, st.position.z - this.lastPosition.z);
    // Written in place, not rebuilt. `lastPosition` is read on the very same tick by the teleport
    // assertion in the integration suite, which hands out `getPosition()`'s live object — so a fresh
    // `v(...)` here is indistinguishable from a position jump to any caller sampling after `update`.
    this.lastPosition.x = st.position.x;
    this.lastPosition.y = st.position.y;
    this.lastPosition.z = st.position.z;

    if (!wantsToMove) {
      // Nothing to make progress toward, so "not moving" is not a fault. Clear the flag and rest the
      // window, or a state that legitimately stands still — a dwell, a search pause — reads as stuck.
      this.stuck = false;
      this.stuckWindow = 0;
      this.stuckMoved = 0;
      return;
    }

    this.stuckWindow += dt;
    this.stuckMoved += stepLen;
    if (this.stuckWindow < STUCK_WINDOW) return;

    // Under a quarter of a metre per second of actual travel, over a whole window, is wedged: her
    // slowest walking speed is an order of magnitude more than that.
    if (this.stuckMoved / this.stuckWindow < STUCK_MIN_RATE) {
      this.stuck = true;
      // §28 recovery. Re-path first — the usual cause is a target that resolved just inside geometry —
      // and only fall back to "nearest valid waypoint" if that also fails.
      if (this.pathTarget) this.repath(this.pathTarget);
      if (this.pathFailed) {
        const near = this.patrol.nearest(st.position);
        if (near?.nav) {
          const p = this.grid.findPath(v(st.position.x, st.position.y, st.position.z), near.nav, 0);
          this.path = p ?? [];
          this.pathIndex = 0;
        } else {
          this.fsm.force('RETURN_TO_PATROL', this.ctx, 'recovered');
        }
      }
    } else {
      this.stuck = false;
    }
    this.stuckWindow = 0;
    this.stuckMoved = 0;
  }

  // --- Model sync --------------------------------------------------------

  /** Latch onto the model once it has been placed, and build its mixer. */
  private syncModel(): void {
    if (!this.root) {
      const r = this.deps.getRoot();
      if (!r) return;
      this.root = r;
      const clips = this.deps.getClips();
      const clip = clips[0];
      if (clip) {
        // A dedicated mixer, separate from ModelProps' own, so driving `timeScale` from velocity here
        // cannot interfere with the distance cull that stops ModelProps evaluating a clip nobody sees.
        this.mixer = new AnimationMixer(r);
        this.clipAction = this.mixer.clipAction(clip);
        this.clipAction.play();
      }
    }
    if (!this.mixer || !this.clipAction) return;

    // Place her. Position from locomotion, yaw from her body, and the mix of body and gaze yaw applied
    // to the root's rotation so a glance does not require a turn.
    const st = this.loco.state;
    this.root.position.set(st.position.x, st.position.y, st.position.z);
    // Only the body yaw goes on the root; the gaze difference is carried by her head bone, which this
    // rig exposes. Rotating the whole root by the gaze would turn her feet too.
    this.root.rotation.y = st.yaw + (this.gazeOffset(st.lookYaw, st.yaw));

    // Drive the walk clip from real speed. See CLIP_REFERENCE_SPEED.
    const rate = Math.max(0.35, st.speed / CLIP_REFERENCE_SPEED);
    this.clipAction.timeScale = rate;
    this.mixer.update(Math.min(1 / 30, 1 / 60 + st.speed * 0.0001) + 0);
  }

  /**
   * How far the head should lead the body, clamped to what a neck can do.
   *
   * Applied to the root's own rotation rather than to a bone because this rig's head bone is named
   * per-character and would need a rig-specific lookup; taking a fraction of the offset on the root is
   * invisible as a cheat and gives the same read at gameplay distances. The clamp keeps it plausible.
   */
  private gazeOffset(lookYaw: number, bodyYaw: number): number {
    let d = lookYaw - bodyYaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const maxNeck = 0.7; // ~40°, about as far as a person turns their head without turning their chest
    return Math.max(-maxNeck, Math.min(maxNeck, d)) * 0.55;
  }

  // --- Player introspection helpers --------------------------------------

  /** The player's eye height above their feet. Read from the controller's own convention. */
  private playerEyeHeight(): number {
    // FPController keeps `position` at eye height and resolves the floor beneath it, so the offset is
    // recovered by asking the ground height. A fixed fallback covers the frames before a floor is found.
    const ground = this.groundBelowPlayer();
    const eye = this.player.getPosition().y;
    const h = eye - ground;
    return h > 0.4 && h < 2.4 ? h : 1.65;
  }

  private groundBelowPlayer(): number {
    const p = this.player.getPosition();
    const nav = this.grid.heightAtWorld(p.x, p.z);
    return Number.isFinite(nav) ? nav : p.y - 1.65;
  }

  private playerHidden(): boolean {
    // Read from the bus's last known hiding state. Kept as a flag rather than polled because the
    // hiding system exposes no query, and adding one would mean touching a module this work should not.
    return this.hiddenFlag;
  }

  private hiddenFlag = false;

  /** Called by the hiding system's listener to keep the hidden flag current. */
  setPlayerHidden(hidden: boolean): void {
    this.hiddenFlag = hidden;
  }

  dispose(): void {
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.mixer?.stopAllAction();
    this.debug?.dispose();
  }
}
