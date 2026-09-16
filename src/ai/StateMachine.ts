/**
 * StateMachine — Daayan's decisions, as a hierarchical finite state machine.
 *
 * §3 and §4 of the spec. The two structural rules it is built to satisfy:
 *
 * 1. **"Do not create one giant AI function containing all behavior."** Every state below is its own
 *    object with its own `enter`, `update` and `exit`. Adding a state means adding an object, not
 *    adding a branch to an ever-growing conditional.
 *
 * 2. **"Higher-priority events must interrupt lower-priority states."** §4's hierarchy — ATTACK,
 *    PLAYER_VISIBLE, HIGH_CONFIDENCE_PLAYER_LOCATION, LOUD_SOUND, MEDIUM_SOUND, INVESTIGATION,
 *    SUSPICIOUS_ACTIVITY, PATROL — is the `interrupts` function. A state declares what it will accept,
 *    and the machine will not let a lower-priority request displace a higher-priority state. Without
 *    that, a distant footstep could pull her out of a chase, which is the classic tell.
 *
 * This file deliberately contains no perception, no pathfinding and no movement maths. It reads a
 * context object the orchestrator fills in, and returns a decision. That is what makes it testable:
 * the transition table can be exercised without a house, a player or a renderer.
 */

import type { Vec3 } from '@/core/types';

/** The nine states of §3, plus RETURN_TO_PATROL and STUNNED from the behaviour flow. */
export type DaayanState =
  | 'IDLE'
  | 'PATROL'
  | 'INVESTIGATE_SOUND'
  | 'SUSPICIOUS'
  | 'CHASE'
  | 'SEARCH'
  | 'INTERCEPT'
  | 'ATTACK'
  | 'RETURN_TO_PATROL'
  | 'STUNNED';

/**
 * Priority ladder (§4), highest first. `interrupts` compares indices into this list.
 *
 * IDLE and RETURN_TO_PATROL sit below PATROL because they are *recovery* states: they exist to get her
 * back to something meaningful, and essentially anything real should be able to interrupt them.
 * STUNNED is above everything because while stunned she is not deciding anything at all.
 */
export const PRIORITY: readonly DaayanState[] = [
  'STUNNED',
  'ATTACK',
  'CHASE',
  'INTERCEPT',
  'INVESTIGATE_SOUND',
  'SEARCH',
  'SUSPICIOUS',
  'PATROL',
  'RETURN_TO_PATROL',
  'IDLE',
];

function priorityOf(state: DaayanState): number {
  const i = PRIORITY.indexOf(state);
  return i === -1 ? PRIORITY.length : i;
}

/** True when `candidate` may displace `current` (§4). Lower index wins. */
export function interrupts(candidate: DaayanState, current: DaayanState): boolean {
  if (candidate === current) return false;
  // STUNNED is special: it interrupts anything, and only STUNNED can end it.
  if (candidate === 'STUNNED') return true;
  if (current === 'STUNNED') return false;
  return priorityOf(candidate) < priorityOf(current);
}

/**
 * States a state is always allowed to hand over to when its own work has moved on.
 *
 * This exists because the priority ladder, applied naively, can trap her. Two real cases, both found
 * by driving the assembled AI rather than by testing the machine:
 *
 *   - INVESTIGATE_SOUND outranks RETURN_TO_PATROL, so when an investigation expires and the state asks
 *     to go back to patrolling, the ladder refuses — and the state re-asks every tick forever. She
 *     stands still.
 *   - CHASE outranks INTERCEPT, so a chase that wants to become a prediction-driven intercept is
 *     refused for the same reason, and she jitters on the spot at the last known position instead of
 *     searching.
 *
 * The ladder is there to stop a *lesser event* pulling her out of a *greater task*; it was never meant
 * to let a state hold itself open after its own work has moved on. Progression is not an interruption.
 *
 * The list is deliberately narrow — the states a hunt or an investigation legitimately flows into:
 * SEARCH (the next phase of the same hunt), and the two recovery states whose entire purpose is "this
 * is over, get back to something meaningful". They can be entered from anywhere that has decided it is
 * finished, but they still cannot be entered *over* something that has not finished — PATROL and
 * RETURN_TO_PATROL both sit below SUSPICIOUS, so a genuine glimpse mid-patrol still wins.
 */
const COMPLETION_TARGETS: ReadonlySet<DaayanState> = new Set<DaayanState>([
  'PATROL',
  'RETURN_TO_PATROL',
  'SEARCH',
  'INTERCEPT',
]);

/** True when a state may hand over to `candidate` because its own work is done. */
export function canComplete(candidate: DaayanState): boolean {
  return COMPLETION_TARGETS.has(candidate);
}

/**
 * Why a transition is happening. The FSM records this so the debug overlay can answer "why is she
 * doing that?", which §32 lists as a quality target and which is genuinely hard to debug otherwise.
 */
export type TransitionReason =
  | 'saw-player'
  | 'lost-player'
  | 'heard-loud'
  | 'heard-medium'
  | 'heard-quiet'
  | 'glimpsed-player'
  | 'arrived'
  | 'investigation-timeout'
  | 'search-timeout'
  | 'search-found'
  | 'in-attack-range'
  | 'attack-landed'
  | 'target-escaped'
  | 'stunned'
  | 'stun-over'
  | 'nothing-to-do'
  | 'recovered';

/**
 * Everything a state may read. Filled in by the orchestrator each tick.
 *
 * Kept as one object rather than a dozen parameters so a new state can be added without changing every
 * signature in the file, and so the FSM stays a pure function of this snapshot.
 */
export interface AIContext {
  /** Seconds since the AI started. All timestamps use this clock. */
  now: number;
  /** Her feet position. */
  position: Vec3;
  /** Her eye position, for range tests. */
  eye: Vec3;
  /** Where the player actually is. Only ever read for geometry that is fair — see the note below. */
  playerPosition: Vec3;
  /** The player's eye position. */
  playerEye: Vec3;
  /** True when the player is inside a hiding spot. */
  playerHidden: boolean;

  /** Smoothed vision confidence (§7), 0..1. */
  visionConfidence: number;
  /** True when vision confidence has crossed the threshold with hysteresis applied. */
  playerVisible: boolean;
  /** Roughly how much of the player the last sample could see, 0..1. */
  visibility: number;
  /** Range to the player, metres. */
  playerDistance: number;

  /** Her best estimate of the player's position (§10), or null when she has nothing. */
  memoryPosition: Vec3 | null;
  /** How much that estimate is trusted, 0..1. */
  memoryConfidence: number;
  /** Seconds since the most recent evidence of any kind. */
  memoryAge: number;
  /**
   * The player's velocity as *she remembers it*, or null when the record has gone stale.
   *
   * Deliberately the remembered value and not the player's live velocity. §12 sanctions prediction,
   * but predicting from a velocity she could only know by reading the player's current state while
   * unable to see them is precisely the "omniscient" failure §30 forbids. It is expired by
   * `memoryDuration`'s velocity rule, so a long-lost player's direction genuinely goes unknown.
   */
  playerVelocityHint: Vec3 | null;
  /** True when the player's heading has recently reversed hard, which weakens any prediction (§12). */
  playerDirectionChanged: boolean;

  /** A loud sound arrived this tick, if any. */
  loudSound: { position: Vec3; loudness: number } | null;
  /** A medium sound arrived this tick, if any. */
  mediumSound: { position: Vec3; loudness: number } | null;

  /** Whether the current navigation target has been reached. */
  atDestination: boolean;
  /** True when no path could be found and she has nowhere valid to go. */
  navigationFailed: boolean;
  /** True when she has been stationary while trying to move for too long (§16 stuck detection). */
  stuck: boolean;

  /** Distance to the player, measured eye-to-eye, for the attack test. */
  attackRange: number;
  /**
   * True while she is inside the post-catch recovery window and must not grab again.
   *
   * Distinct from being stunned: she can walk and see during recovery, she simply may not land
   * another catch. Without this, a player who does not move is caught every couple of seconds for the
   * whole session, and she reads as broken rather than threatening.
   */
  catchRecovery: boolean;
  /** True when a defensive action has stunned her. */
  stunnedThisTick: boolean;
}

/** What a state wants the orchestrator to do. */
export interface StateDirective {
  /** World point she is trying to reach, or null to stand still. */
  destination: Vec3 | null;
  /** World point she wants to look at, or null to look where she is going. */
  lookAt: Vec3 | null;
}

/**
 * Per-state working memory, handed to `update` so a state can keep a timer or a cursor without owning
 * a field on the machine.
 *
 * This is passed *into* the handler rather than being stashed on the context, which was the first
 * design and was wrong: writing `ctx._arriveAt` from a state meant a state's private bookkeeping lived
 * on an object every other state also reads, so two states using the same ad-hoc field name would
 * silently collide, and the debug overlay could not tell a state's internal flag from real context.
 * The machine owns one scratch per states-and-machine, so a field here belongs to exactly one
 * currently-active state by construction.
 */
export interface StateScratch {
  /** Time the current state was entered. Written by the machine. */
  enteredAt: number;
  /** Free-form slots for the active state's own bookkeeping. */
  [key: string]: unknown;
}

/** What a state decides on a tick: what to do, and optionally where to go next. */
export interface StateStep {
  directive: StateDirective;
  /**
   * The state this one wants to move to, or undefined to stay.
   *
   * Written as a required property whose type includes `undefined` rather than as `next?:` because the
   * project builds with `exactOptionalPropertyTypes`. Under that flag an optional property may be
   * *absent* but may not be explicitly `undefined`, and every handler here builds its result from a
   * conditional — which produces exactly `next: undefined`. Typing it this way means handlers can
   * return either shape and the compiler accepts both.
   */
  next: { state: DaayanState; reason: TransitionReason } | undefined;
  /**
   * Set when this step is a *hand-over* rather than an interruption, which exempts it from the
   * priority ladder. See `canComplete` — without it a state whose priority sits above the state it
   * wants to return to can never return, and stands still forever.
   *
   * Deliberately opt-in and narrow: only states that have finished their own work should set it, and
   * only for a `canComplete` target. Everything else still goes through §4.
   */
  complete?: boolean;
}

export interface DaayanStateHandler {
  readonly name: DaayanState;
  /**
   * Called once on entry, with the reason, and a scratch pre-cleared for this state.
   */
  enter(scratch: StateScratch, ctx: AIContext, reason: TransitionReason): void;
  /** Called every AI tick. */
  update(scratch: StateScratch, ctx: AIContext, dt: number): StateStep;
  /** Called once on exit. */
  exit?(scratch: StateScratch, ctx: AIContext): void;
}

export class StateMachine {
  private state: DaayanState;
  private handler: DaayanStateHandler;
  private lastReason: TransitionReason = 'nothing-to-do';
  private readonly handlers = new Map<DaayanState, DaayanStateHandler>();
  private readonly scratch: StateScratch = { enteredAt: 0 };
  /** Counts entries per state, so a state can tell a fresh visit from a return. */
  private readonly entries = new Map<DaayanState, number>();

  constructor(
    handlers: readonly DaayanStateHandler[],
    initial: DaayanState = 'IDLE',
  ) {
    for (const h of handlers) this.handlers.set(h.name, h);
    const first = this.handlers.get(initial);
    if (!first) throw new Error(`[DaayanAI] no handler registered for initial state ${initial}`);
    this.state = initial;
    this.handler = first;
  }

  get current(): DaayanState {
    return this.state;
  }

  get reason(): TransitionReason {
    return this.lastReason;
  }

  get enteredAt(): number {
    return this.scratch.enteredAt;
  }

  /** Seconds spent in the current state. */
  timeInState(now: number): number {
    return now - this.scratch.enteredAt;
  }

  /** How many times a state has been entered, 0 before the first. */
  entriesFor(state: DaayanState): number {
    return this.entries.get(state) ?? 0;
  }

  /** Prime the initial state's scratch and run its enter, so the first tick is not special-cased. */
  start(ctx: AIContext): void {
    this.scratch.enteredAt = ctx.now;
    this.entries.set(this.state, 1);
    this.handler.enter(this.scratch, ctx, 'nothing-to-do');
  }

  /**
   * Force a state, ignoring the priority ladder.
   *
   * Used for STUNNED (which by definition overrides everything) and by the orchestrator's failure
   * recovery, which has to be able to put her back on patrol regardless of what she was doing.
   */
  force(state: DaayanState, ctx: AIContext, reason: TransitionReason): void {
    this.transition(state, ctx, reason);
  }

  /**
   * Request a transition, honouring §4's priority ladder.
   *
   * Returns whether the transition happened. A refusal is not an error: "a distant footstep did not
   * pull her out of a chase" is the system working, and the caller can inspect the return value if it
   * cares to log it.
   */
  request(state: DaayanState, ctx: AIContext, reason: TransitionReason): boolean {
    if (!interrupts(state, this.state)) return false;
    this.transition(state, ctx, reason);
    return true;
  }

  /**
   * Hand over because the current state has finished its work, bypassing the priority ladder.
   *
   * Only `canComplete` targets are honoured, and only from a state that is not STUNNED — a state
   * cannot declare itself done while she is incapacitated. Everything else falls back to `request`, so
   * a bug that sets `complete` on an arbitrary target degrades to correct behaviour rather than
   * teleporting her into CHASE.
   */
  private complete(state: DaayanState, ctx: AIContext, reason: TransitionReason): boolean {
    // STUNNED is the one state that may hand over to *anything*, because it is the only state whose
    // own work is a fixed timer with no successor implied. `interrupts` refuses every candidate while
    // she is stunned ("only STUNNED can end it"), so without this exemption the stun's own expiry
    // transition is refused and she is stunned for the rest of the session — which is exactly what
    // happened in play: she caught the player, went to STUNNED, and stood there at 0.00 speed forever.
    //
    // The exit still has to be declared a completion by the caller, so a bug that emits `complete` on
    // an arbitrary target from an arbitrary state degrades to `request` rather than teleporting her.
    if (this.state === 'STUNNED') {
      if (state === this.state) return false;
      this.transition(state, ctx, reason);
      return true;
    }
    if (!canComplete(state)) return this.request(state, ctx, reason);
    if (state === this.state) return false;
    this.transition(state, ctx, reason);
    return true;
  }

  private transition(state: DaayanState, ctx: AIContext, reason: TransitionReason): void {
    const next = this.handlers.get(state);
    if (!next) {
      // eslint-disable-next-line no-console
      console.warn(`[DaayanAI] ignoring transition to unregistered state ${state}`);
      return;
    }
    this.handler.exit?.(this.scratch, ctx);
    // Clear the scratch to just the clock, so no field leaks from the outgoing state into the
    // incoming one. A handler that needs something to survive a transition keeps it outside this.
    for (const key of Object.keys(this.scratch)) {
      if (key !== 'enteredAt') delete this.scratch[key];
    }
    this.scratch.enteredAt = ctx.now;
    this.state = state;
    this.handler = next;
    this.lastReason = reason;
    this.entries.set(state, (this.entries.get(state) ?? 0) + 1);
    next.enter(this.scratch, ctx, reason);
  }

  /** Run the current state for this tick, applying any transition it asks for. */
  tick(ctx: AIContext, dt: number): StateDirective {
    const out = this.handler.update(this.scratch, ctx, dt);
    if (out.next) {
      // A state asking to move itself does so through the same ladder, so a state cannot escalate
      // past something more important than itself by returning a `next` — unless it has declared the
      // step a completion, which is the one case the ladder must not referee.
      const moved = out.complete === true
        ? this.complete(out.next.state, ctx, out.next.reason)
        : this.request(out.next.state, ctx, out.next.reason);
      if (moved) {
        // Re-run the new state this tick so a transition does not cost a frame of inaction.
        return this.tick(ctx, dt);
      }
    }
    return out.directive;
  }
}
