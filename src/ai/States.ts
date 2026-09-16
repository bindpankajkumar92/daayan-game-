/**
 * States — the behaviours of §3, each implemented as its own handler.
 *
 * §3's rule is that every state has enter logic, update logic, exit logic and transition conditions,
 * and §29 gives the complete behaviour flow they must produce. This file is that flow, written out one
 * state at a time. Adding a state means adding a function here and registering it, not adding a branch
 * to an ever-growing conditional.
 *
 * Two conventions hold throughout, and both are load-bearing:
 *
 * 1. **No state reads `ctx.playerPosition` to decide where to go.** It is available for the two places
 *    the spec sanctions real geometry — the attack range test, and the direct-chase target while she
 *    genuinely has line of sight — and nowhere else. Every navigational decision goes through
 *    `ctx.memoryPosition`, which is belief and can be wrong. §30: "Nothing more."
 *
 * 2. **Every state that can be entered can be left.** Each timeout is a deadline written into the
 *    state's own scratch on `enter`. A state that can only be exited by a player action is a state
 *    that can hang, and a hung Daayan standing motionless in a doorway is a bug the player will see.
 */

import type { Vec3 } from '@/core/types';
import type {
  AIContext,
  DaayanStateHandler,
  StateDirective,
  StateScratch,
  StateStep,
  TransitionReason,
} from './StateMachine';
import type { DaayanConfig } from './DaayanConfig';
import type { SearchPlanner } from './Search';
import type { PatrolSystem } from './Patrol';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z } as Vec3);

/** Flat distance between a point and her feet. */
function flatTo(from: Vec3, to: Vec3): number {
  return Math.hypot(to.x - from.x, to.z - from.z);
}

/** The point she should walk toward: always her belief, never the truth. */
function beliefTarget(ctx: AIContext): Vec3 | null {
  return ctx.memoryPosition;
}

/** A point a fixed distance ahead of a yaw, at a given height — for gaze sweeps. */
function ahead(pos: Vec3, yaw: number, dist: number, y: number): Vec3 {
  return v(pos.x + Math.sin(yaw) * dist, y, pos.z + Math.cos(yaw) * dist);
}

/**
 * A state's return value.
 *
 * `next` is declared as `{...} | undefined` rather than optional because the project builds with
 * `exactOptionalPropertyTypes`, under which an optional property may be *absent* but may not be
 * explicitly `undefined` — and every handler here builds its result with a conditional, which produces
 * exactly that. Spelling the union out is what makes `return { directive, next: undefined }` legal.
 */
type Step = StateStep;

/** Build a directive that stands still. */
const STAND: StateDirective = { destination: null, lookAt: null };

/** Nav points carry plain numbers; the directive wants Vec3s. One conversion, in one place. */
function toVec(p: { x: number; y: number; z: number } | null): Vec3 | null {
  return p ? (v(p.x, p.y, p.z) as Vec3) : null;
}

/**
 * IDLE — she is awake but not yet doing anything, and she is not a threat.
 *
 * This is where she starts, per the wake-on-trigger design: parked where the model already sits, in
 * the ritual room, running no behaviour at all until something wakes her. Keeping the early game calm
 * is the point — the first thing the player should experience is her *moving*, which is far more
 * frightening than an AI that was already hunting before they arrived.
 */
export function makeIdle(cfg: DaayanConfig): DaayanStateHandler {
  return {
    name: 'IDLE',
    enter() {
      /* No timeout: IDLE is left by external evidence, never by the clock. */
    },
    update(_s: StateScratch, ctx: AIContext): Step {
      // Only clear sight or a genuinely loud sound wakes her. A quiet footstep across the house must
      // not, or the "calm before" never happens.
      if (ctx.playerVisible && ctx.visionConfidence >= cfg.visionConfidenceThreshold) {
        return { directive: { destination: null, lookAt: ctx.playerEye }, next: { state: 'CHASE', reason: 'saw-player' } };
      }
      if (ctx.loudSound) {
        const to = ctx.loudSound.position;
        return {
          directive: { destination: to, lookAt: to },
          next: { state: 'INVESTIGATE_SOUND', reason: 'heard-loud' },
        };
      }
      return { directive: STAND, next: undefined };
    },
  };
}

/**
 * PATROL — moving the waypoint network, per §5.
 *
 * The patrol system owns *which* waypoint; this state owns the behaviour around one: walk to it,
 * arrive, slow down, look around, dwell for a randomized spell, then move on. §5 lists exactly those
 * steps, and the dwell is not decoration — it is the pause that makes her read as searching rather
 * than commuting.
 */
export function makePatrol(cfg: DaayanConfig, patrol: PatrolSystem): DaayanStateHandler {
  return {
    name: 'PATROL',
    enter(s: StateScratch, ctx: AIContext) {
      s.dwellUntil = 0;
      // Arriving from RETURN_TO_PATROL she already has a target; from anywhere else she does not.
      if (!patrol.getTarget()) patrol.chooseNext(ctx.now, ctx.memoryPosition, ctx.position);
    },
    update(s: StateScratch, ctx: AIContext): Step {
      const target = patrol.getTarget();
      if (!target || !target.nav) {
        patrol.chooseNext(ctx.now, ctx.memoryPosition, ctx.position);
        return { directive: STAND, next: undefined };
      }

      // --- Interrupts first, in §4's order. ---
      const seen = ctx.playerVisible && ctx.visionConfidence >= cfg.visionConfidenceThreshold;
      if (seen) {
        return { directive: { destination: null, lookAt: ctx.playerEye }, next: { state: 'CHASE', reason: 'saw-player' } };
      }
      // A sound sends her to it, not merely toward the idea of it — see the note in
      // `makeInvestigate` for why returning a null destination here left her rooted to the spot.
      if (ctx.loudSound) {
        const to = ctx.loudSound.position;
        return {
          directive: { destination: to, lookAt: to },
          next: { state: 'INVESTIGATE_SOUND', reason: 'heard-loud' },
        };
      }
      if (ctx.mediumSound) {
        const to = ctx.mediumSound.position;
        return {
          directive: { destination: to, lookAt: to },
          next: { state: 'INVESTIGATE_SOUND', reason: 'heard-medium' },
        };
      }
      // A glimpse, or an unresolved sound, is enough to make her curious but not to send her running.
      // §20's whole purpose: the intermediate state that creates tension.
      if (ctx.visibility > cfg.suspicionVisionThreshold) {
        return {
          directive: { destination: null, lookAt: ctx.playerEye },
          next: { state: 'SUSPICIOUS', reason: 'glimpsed-player' },
        };
      }

      // --- Arrived: dwell and look around. ---
      if (flatTo(ctx.position, toVec(target.nav) as Vec3) < 0.9) {
        if (s.dwellUntil === 0) s.dwellUntil = ctx.now + target.dwell;
        if (ctx.now < (s.dwellUntil as number)) {
          // Sweep the gaze rather than holding it. A held stare during a pause reads as a freeze; a
          // sweep reads as vigilance, which is what §5 is asking for.
          const yaw = Math.sin(ctx.now * 0.7) * 1.2;
          return { directive: { destination: null, lookAt: ahead(ctx.position, yaw, 3.5, ctx.eye.y - 0.15) }, next: undefined };
        }
        // Dwell over: consume the waypoint and pick the next one.
        patrol.arrive(ctx.now);
        patrol.chooseNext(ctx.now, ctx.memoryPosition, ctx.position);
        s.dwellUntil = 0;
        const nextTarget = patrol.getTarget();
        return { directive: { destination: toVec(nextTarget?.nav ?? null), lookAt: null }, next: undefined };
      }

      // --- Still walking. ---
      return { directive: { destination: toVec(target.nav), lookAt: null }, next: undefined };
    },
    exit(s: StateScratch) {
      s.dwellUntil = 0;
    },
  };
}

/**
 * SUSPICIOUS — §20's intermediate state.
 *
 * It exists to create tension rather than to accomplish anything. She slows down, stares toward what
 * she noticed, and may drift *slightly* toward it — which is the behaviour that makes a player whisper
 * "is she coming?" A suspicious state that does not move at all is not frightening; one that moves
 * fully is a chase, and the tension lives in between.
 */
export function makeSuspicious(cfg: DaayanConfig): DaayanStateHandler {
  return {
    name: 'SUSPICIOUS',
    enter(s: StateScratch, ctx: AIContext) {
      // Arm a deadline so a state with no escalation path still ends. §20: "If nothing happens:
      // SUSPICIOUS -> PATROL."
      s.deadline = ctx.now + cfg.suspicionDuration;
      // Freeze the direction she is curious about, so she has one fixed thing to watch rather than
      // chasing a target she has not yet agreed to chase.
      s.anchor = ctx.memoryPosition ?? ctx.playerEye;
    },
    update(s: StateScratch, ctx: AIContext): Step {
      // Stronger evidence escalates to a full investigation.
      if (ctx.loudSound) {
        const to = ctx.loudSound.position;
        return {
          directive: { destination: to, lookAt: to },
          next: { state: 'INVESTIGATE_SOUND', reason: 'heard-loud' },
        };
      }
      if (ctx.mediumSound) {
        const to = ctx.mediumSound.position;
        return {
          directive: { destination: to, lookAt: to },
          next: { state: 'INVESTIGATE_SOUND', reason: 'heard-medium' },
        };
      }
      const seen = ctx.playerVisible && ctx.visionConfidence >= cfg.visionConfidenceThreshold;
      if (seen) {
        return { directive: { destination: null, lookAt: ctx.playerEye }, next: { state: 'CHASE', reason: 'saw-player' } };
      }
      // Fresh evidence extends her patience; the deadline is the backstop.
      if (ctx.now >= (s.deadline as number)) {
        return { directive: STAND, next: { state: 'PATROL', reason: 'nothing-to-do' }, complete: true };
      }

      const anchor = (s.anchor as Vec3) ?? beliefTarget(ctx);
      if (!anchor) return { directive: STAND, next: undefined };

      // Drift toward it, but only part way. `suspicionApproachDistance` caps the approach so she gets
      // menacing without arriving — arriving is what investigation is for.
      const d = flatTo(ctx.position, anchor);
      if (d > cfg.suspicionApproachDistance) {
        const step = Math.min(d - cfg.suspicionApproachDistance, 2.5);
        const dx = (anchor.x - ctx.position.x) / d;
        const dz = (anchor.z - ctx.position.z) / d;
        return {
          directive: {
            destination: v(ctx.position.x + dx * step, ctx.position.y, ctx.position.z + dz * step),
            lookAt: anchor,
          },
          next: undefined,
        };
      }
      return { directive: { destination: null, lookAt: anchor }, next: undefined };
    },
  };
}

/**
 * INVESTIGATE_SOUND — §9.
 *
 * She walks to where she thinks the sound came from, then slows, looks around, waits and re-evaluates.
 * The critical instruction is the last one: "Do NOT make her instantly know that the player was
 * responsible." This state therefore never escalates on its own — only sight or a new sound can do
 * that — and if neither comes she returns to patrol having found nothing, which is correct.
 */
export function makeInvestigate(cfg: DaayanConfig): DaayanStateHandler {
  return {
    name: 'INVESTIGATE_SOUND',
    enter(s: StateScratch) {
      // The dwell clock is armed on *arrival*, not here: the walk may be long, and a deadline set at
      // entry would cut the investigation short for a sound on the far side of the house.
      s.arrivedAt = 0;
    },
    update(s: StateScratch, ctx: AIContext): Step {
      if (ctx.playerVisible && ctx.visionConfidence >= cfg.visionConfidenceThreshold) {
        return { directive: { destination: null, lookAt: ctx.playerEye }, next: { state: 'CHASE', reason: 'saw-player' } };
      }
      // §29: "new stronger sound? -> update target". Re-entering resets the arrival clock, which is
      // what makes a second bang actually send her somewhere new.
      //
      // The destination is the sound, not the remembered position. The first version of this returned
      // `destination: null` and relied on re-entry to pick up the updated memory, which was wrong: the
      // machine re-runs the new state on the same tick, `interrupts` refuses a self-transition, and the
      // null directive was what survived — so she turned her head toward every noise and never walked
      // to one. Returning the target directly is both simpler and what the spec describes.
      if (ctx.loudSound) {
        const to = ctx.loudSound.position;
        return {
          directive: { destination: to, lookAt: to },
          next: { state: 'INVESTIGATE_SOUND', reason: 'heard-loud' },
        };
      }

      const target = beliefTarget(ctx);
      if (!target) {
        // The memory expired underneath her; there is nothing left to investigate.
        return { directive: STAND, next: { state: 'RETURN_TO_PATROL', reason: 'investigation-timeout' }, complete: true };
      }

      if (flatTo(ctx.position, target) < 1.6) {
        if (s.arrivedAt === 0) s.arrivedAt = ctx.now;
        if (ctx.now - (s.arrivedAt as number) > cfg.investigationDuration) {
          // She has looked around and found nothing. SEARCH rather than patrol, because §29 routes
          // arrival at a sound into SEARCH and because a small area sweep is the honest response to
          // "something made a noise here".
          return { directive: STAND, next: { state: 'SEARCH', reason: 'investigation-timeout' }, complete: true };
        }
        // Sweep the gaze across the area. Two out-of-phase sines so the pattern does not loop visibly.
        const yaw = Math.sin(ctx.now * 0.9) * 1.3 + Math.sin(ctx.now * 0.37) * 0.4;
        return { directive: { destination: null, lookAt: ahead(ctx.position, yaw, 3.2, ctx.eye.y - 0.35) }, next: undefined };
      }

      s.arrivedAt = 0;
      return { directive: { destination: toVec(target), lookAt: toVec(target) }, next: undefined };
    },
    exit(s: StateScratch) {
      s.arrivedAt = 0;
    },
  };
}

/**
 * SEARCH — §13, §14. The state that exists so losing her does not reset her.
 *
 * The spec calls this "critical": when she loses sight she must not immediately forget. So this state
 * walks a *prioritised list* of points around the last known position — not just the position itself —
 * pausing at each to look around, and runs until a timeout expires.
 */
export function makeSearch(cfg: DaayanConfig, planner: SearchPlanner): DaayanStateHandler {
  return {
    name: 'SEARCH',
    enter(_s: StateScratch, ctx: AIContext, reason: TransitionReason) {
      // Generate the itinerary once, on entry. Regenerating every tick would make her tour a moving
      // set of points, which reads as indecision; a fixed list reads as a plan.
      planner.plan(ctx.memoryPosition ?? ctx.position, ctx.now);
      void reason;
    },
    update(_s: StateScratch, ctx: AIContext): Step {
      // Sight regained ends the search immediately (§13).
      if (ctx.playerVisible && ctx.visionConfidence >= cfg.visionConfidenceThreshold) {
        return { directive: { destination: null, lookAt: ctx.playerEye }, next: { state: 'CHASE', reason: 'saw-player' } };
      }
      // A loud sound elsewhere is more informative than the current guess (§13 point 4).
      if (ctx.loudSound) {
        const to = ctx.loudSound.position;
        return {
          directive: { destination: to, lookAt: to },
          next: { state: 'INVESTIGATE_SOUND', reason: 'heard-loud' },
        };
      }
      // A medium sound re-aims her without abandoning the search entirely: she investigates it.
      if (ctx.mediumSound) {
        const to = ctx.mediumSound.position;
        return {
          directive: { destination: to, lookAt: to },
          next: { state: 'INVESTIGATE_SOUND', reason: 'heard-medium' },
        };
      }
      // Timeout (§13 point 5).
      if (planner.expired(ctx.now, cfg.searchDuration)) {
        return { directive: STAND, next: { state: 'RETURN_TO_PATROL', reason: 'search-timeout' }, complete: true };
      }

      // Pause and look around at each point (§14: "occasionally pause and look around. This pause is
      // important for horror").
      if (planner.pauseRemaining(ctx.now) > 0) {
        const yaw = Math.sin(ctx.now * 1.1) * 1.5 + Math.sin(ctx.now * 0.43) * 0.5;
        return { directive: { destination: null, lookAt: ahead(ctx.position, yaw, 3.5, ctx.eye.y - 0.2) }, next: undefined };
      }

      const point = planner.current();
      if (!point) {
        return { directive: STAND, next: { state: 'RETURN_TO_PATROL', reason: 'search-timeout' }, complete: true };
      }
      if (flatTo(ctx.position, toVec(point.nav) as Vec3) < 1.1) {
        planner.beginPause(ctx.now, cfg.searchPauseDuration);
        return { directive: { destination: null, lookAt: null }, next: undefined };
      }
      return { directive: { destination: toVec(point.nav), lookAt: toVec(point.nav) }, next: undefined };
    },
  };
}

/**
 * CHASE — §11, §12.
 *
 * Two modes. DIRECT CHASE targets the player's real position and is used only while she has reliable
 * line of sight — which is the fair reading of the spec's "Use when Daayan has reliable line of sight",
 * and the reason `playerPosition` is legitimate here: she can see them. INTERCEPT targets a predicted
 * point and is entered only when she has *lost* sight, in which case the prediction is built from
 * memory and velocity rather than from knowledge.
 *
 * Losing line of sight does not drop her to patrol. It drops her to SEARCH (§13), which is the entire
 * point of the design.
 */
export function makeChase(cfg: DaayanConfig, planner: SearchPlanner): DaayanStateHandler {
  return {
    name: 'CHASE',
    enter() {
      /* No timer: a chase ends when she loses them, catches them, or is stunned. */
    },
    update(_s: StateScratch, ctx: AIContext): Step {
      // --- Attack when close enough. ---
      // Suppressed during recovery: chasing into ATTACK would put her straight back into a grab the
      // moment the window closed, which is the loop `catchRecovery` exists to break.
      if (ctx.playerDistance <= ctx.attackRange && !ctx.catchRecovery) {
        return { directive: { destination: null, lookAt: ctx.playerEye }, next: { state: 'ATTACK', reason: 'in-attack-range' } };
      }

      if (ctx.playerVisible) {
        // DIRECT CHASE: she can see them, so heading at them is both fair and correct.
        return { directive: { destination: ctx.playerPosition, lookAt: ctx.playerEye }, next: undefined };
      }

      // --- Lost sight. Hysteresis (§7) means one occluded frame is not a lost player. ---
      const stillSure = ctx.memoryPosition && ctx.memoryConfidence >= cfg.visionConfidenceThreshold - cfg.visionConfidenceHysteresis;
      if (!stillSure) {
        return { directive: STAND, next: { state: 'SEARCH', reason: 'lost-player' }, complete: true };
      }

      // INTERCEPT: no sight, so she commits to the predicted point only when the prediction is
      // trustworthy. §12 requires the prediction to weaken when the player is slow, erratic or
      // unobserved, and `planner.intercept` returns null in exactly those cases.
      const prediction = planner.intercept(ctx, cfg);
      if (prediction) {
        // `complete`, not an interruption: this is the same hunt moving to its next phase, and CHASE
        // outranks INTERCEPT, so without the exemption the ladder would refuse and she would grind.
        return { directive: { destination: prediction.point, lookAt: prediction.point }, next: { state: 'INTERCEPT', reason: 'lost-player' }, complete: true };
      }

      // She is chasing a memory she is already standing on: the player is not visible, her belief has
      // not moved her, and there is nowhere left to run. Grinding here would leave her jittering on the
      // spot (the final path point is held rather than consumed, and the arrival radius does not clear
      // the threshold), so she hands over to a search, which is what "I last saw them here" should
      // actually produce.
      if (ctx.memoryPosition && flatTo(ctx.position, ctx.memoryPosition) < 1.0) {
        return { directive: STAND, next: { state: 'SEARCH', reason: 'lost-player' }, complete: true };
      }
      return { directive: { destination: ctx.memoryPosition, lookAt: ctx.memoryPosition }, next: undefined };
    },
  };
}

/**
 * INTERCEPT — §12's predicted pursuit.
 *
 * Deliberately short-lived. Entered from CHASE when sight is lost but a prediction is still credible;
 * it re-checks for sight constantly, returning to a direct chase the instant she gets it, and decays
 * into SEARCH the moment the prediction stops being defensible.
 */
export function makeIntercept(cfg: DaayanConfig, planner: SearchPlanner): DaayanStateHandler {
  return {
    name: 'INTERCEPT',
    enter(s: StateScratch, ctx: AIContext) {
      // A hard cap, because §12's whole point is that this is a limited, uncertain guess. Even if the
      // prediction keeps looking plausible, she does not get to chase a guess indefinitely.
      s.deadline = ctx.now + cfg.predictionMaxTime * 4;
    },
    update(s: StateScratch, ctx: AIContext): Step {
      if (ctx.playerDistance <= ctx.attackRange && !ctx.catchRecovery) {
        return { directive: { destination: null, lookAt: ctx.playerEye }, next: { state: 'ATTACK', reason: 'in-attack-range' } };
      }
      // Sight regained: back to a direct chase immediately.
      if (ctx.playerVisible && ctx.visionConfidence >= cfg.visionConfidenceThreshold) {
        return { directive: { destination: ctx.playerPosition, lookAt: ctx.playerEye }, next: { state: 'CHASE', reason: 'saw-player' } };
      }
      if (ctx.now >= (s.deadline as number)) {
        return { directive: STAND, next: { state: 'SEARCH', reason: 'lost-player' }, complete: true };
      }
      const prediction = planner.intercept(ctx, cfg);
      if (!prediction) {
        return { directive: STAND, next: { state: 'SEARCH', reason: 'lost-player' }, complete: true };
      }
      return { directive: { destination: prediction.point, lookAt: prediction.point }, next: undefined };
    },
  };
}

/**
 * ATTACK — the terminal state of a hunt.
 *
 * §29 leaves the outcome to "a gameplay-specific result", so this looks at the player, signals the
 * catch, and then behaves sanely: it does not stand there swinging at nothing, and if the player gets
 * away it degrades to SEARCH rather than resetting to patrol.
 */
export function makeAttack(cfg: DaayanConfig): DaayanStateHandler {
  return {
    name: 'ATTACK',
    enter(s: StateScratch, ctx: AIContext) {
      s.attackAt = ctx.now;
      s.landed = false;
    },
    update(s: StateScratch, ctx: AIContext): Step {
      // Post-catch recovery: she has just grabbed them and is giving the encounter its beat. She may
      // still walk and see, but she will not land another catch until the window closes — see
      // `catchRecovery` in the config for the loop this closes.
      if (ctx.catchRecovery) {
        return { directive: STAND, next: undefined };
      }

      const since = ctx.now - (s.attackAt as number);

      // Still in range: look straight at them (§19's "Looking at the player before attacking") and
      // land the catch once the wind-up has elapsed.
      if (ctx.playerDistance <= ctx.attackRange * 1.25) {
        if (!s.landed && since >= cfg.attackCooldown * 0.35) {
          s.landed = true;
          // The catch is emitted by the orchestrator, which sees the `attack-landed` reason. Going to
          // STUNNED here is what gives the player their beat to react (or in future, to be respawned).
          return { directive: { destination: null, lookAt: ctx.playerEye }, next: { state: 'STUNNED', reason: 'attack-landed' } };
        }
        return { directive: { destination: null, lookAt: ctx.playerEye }, next: undefined };
      }

      // They got away. Not a hard reset — she searches (§29).
      if (ctx.playerDistance > ctx.attackRange * 1.6) {
        return { directive: STAND, next: { state: 'SEARCH', reason: 'target-escaped' }, complete: true };
      }
      return { directive: { destination: ctx.playerPosition, lookAt: ctx.playerEye }, next: undefined };
    },
  };
}

/**
 * RETURN_TO_PATROL — the recovery state of §29.
 *
 * It exists rather than transitioning straight to PATROL so she walks back *into* the network from
 * wherever she is, instead of having a waypoint selected from a position the network does not cover
 * and setting off across the house in a straight line through walls.
 */
export function makeReturnToPatrol(patrol: PatrolSystem): DaayanStateHandler {
  return {
    name: 'RETURN_TO_PATROL',
    enter(s: StateScratch, ctx: AIContext) {
      s.deadline = ctx.now + 60; // Backstop: if she cannot rejoin the network, go anyway.
      const near = patrol.nearest(ctx.position);
      if (near) patrol.chooseNext(ctx.now, null, toVec(near.nav) ?? ctx.position);
    },
    update(s: StateScratch, ctx: AIContext): Step {
      if (ctx.playerVisible && ctx.visionConfidence >= 0.3) {
        return { directive: { destination: null, lookAt: ctx.playerEye }, next: { state: 'CHASE', reason: 'saw-player' } };
      }
      if (ctx.loudSound) {
        const to = ctx.loudSound.position;
        return {
          directive: { destination: to, lookAt: to },
          next: { state: 'INVESTIGATE_SOUND', reason: 'heard-loud' },
        };
      }
      const target = patrol.getTarget();
      // Rejoined the network, or out of patience: hand over to PATROL, which dwells properly.
      if (!target?.nav || flatTo(ctx.position, toVec(target.nav) as Vec3) < 1.2 || ctx.now >= (s.deadline as number)) {
        return { directive: STAND, next: { state: 'PATROL', reason: 'recovered' }, complete: true };
      }
      return { directive: { destination: toVec(target.nav), lookAt: null }, next: undefined };
    },
  };
}

/**
 * STUNNED — §3's last state, and the one that makes every other state interruptible.
 *
 * It sits at the top of the priority ladder so nothing can pull her out early, and it exits on its own
 * timer to whatever is *appropriate given the world now*: if she still has a bead on the player she
 * resumes the hunt, otherwise she searches, otherwise she patrols. That is what §29 means by "stun
 * ends -> previous appropriate state" — appropriate to the situation, not to a remembered string,
 * because the situation may have changed while she was stunned.
 */
export function makeStunned(cfg: DaayanConfig): DaayanStateHandler {
  return {
    name: 'STUNNED',
    enter(s: StateScratch, ctx: AIContext) {
      s.stunUntil = ctx.now + cfg.stunDuration;
    },
    update(s: StateScratch, ctx: AIContext): Step {
      if (ctx.now >= (s.stunUntil as number)) {
        if (ctx.playerVisible && ctx.visionConfidence >= cfg.visionConfidenceThreshold) {
          // `complete` because the stun is over: the ladder refuses everything while she is stunned,
          // so an expiry that goes through `request` is refused and never happens.
          return {
            directive: { destination: null, lookAt: ctx.playerEye },
            next: { state: 'CHASE', reason: 'stun-over' },
            complete: true,
          };
        }
        if (ctx.memoryPosition && ctx.memoryConfidence > 0.3) {
          return { directive: STAND, next: { state: 'SEARCH', reason: 'stun-over' }, complete: true };
        }
        return { directive: STAND, next: { state: 'RETURN_TO_PATROL', reason: 'stun-over' }, complete: true };
      }
      // Stand still. A null destination keeps Locomotion decelerating naturally, so an interrupted
      // chase skids to a halt rather than stopping dead on a frame boundary.
      return { directive: STAND, next: undefined };
    },
  };
}

/** Every handler, wired to its collaborators. The orchestrator passes this to the StateMachine. */
export function buildStates(
  cfg: DaayanConfig,
  patrol: PatrolSystem,
  planner: SearchPlanner,
): DaayanStateHandler[] {
  return [
    makeIdle(cfg),
    makePatrol(cfg, patrol),
    makeSuspicious(cfg),
    makeInvestigate(cfg),
    makeSearch(cfg, planner),
    makeChase(cfg, planner),
    makeIntercept(cfg, planner),
    makeAttack(cfg),
    makeReturnToPatrol(patrol),
    makeStunned(cfg),
  ];
}
