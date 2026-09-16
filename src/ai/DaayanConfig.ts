/**
 * DaayanConfig — every tunable number for the Daayan AI, in one place (§23 of the spec).
 *
 * The spec's one structural rule about difficulty is "Do not hardcode these values throughout the
 * codebase. Make them easy to tune." So nothing in `src/ai/` writes a magic number for anything the
 * spec lists under `DaayanConfig`: it reads it from here. Where a subsystem needs a derived quantity
 * (a repath distance from a repath interval, an attack stop distance from an attack range) it derives
 * it from the value here rather than introducing a second constant.
 *
 * All distances are metres, all times are seconds, all angles are radians *except* the `*Deg` fields,
 * which are degrees because they are the ones a tuner will want to nudge by eye — a 100° FOV and a
 * 120° one are a conversation, 1.745 and 2.094 are not.
 *
 * The defaults are set for *fair and scary* rather than optimal, per §21 and §32. In particular
 * `visionFOVDeg` is 100 rather than the 150+ that would make her perceive like a camera, and
 * `visionConfidenceDecay` is slow enough that breaking line of sight for half a second does not
 * erase her certainty that you are real.
 */

/** Difficulty presets. `custom` is the shape a tuning UI or a save file would populate. */
export type DifficultyName = 'story' | 'normal' | 'nightmare' | 'custom';

export interface DaayanConfig {
  // --- Vision (§6, §7) ---
  /** Beyond this she cannot see the player at all, walls aside. */
  visionRange: number;
  /** Total horizontal field of view, in degrees. Halved for the per-side test. */
  visionFOVDeg: number;
  /** How far above/below her gaze a target may sit and still be seen, in degrees. */
  visionVerticalDeg: number;
  /** LOS rays per player sample, aimed at head / torso / legs. One blocked ray is not blindness. */
  visionRays: number;
  /** Vision confidence gained per second while the player is fully visible. */
  visionConfidenceGain: number;
  /** Confidence lost per second while the player is partially visible. */
  visionConfidenceDecayPartial: number;
  /** Confidence lost per second once the player is fully hidden and only memory remains. */
  visionConfidenceDecay: number;
  /** Confidence at or above which she is certain enough to CHASE. */
  visionConfidenceThreshold: number;
  /**
   * Hysteresis: once above the threshold, she holds CHASE until confidence falls this far *below* it.
   * Without this she flickers between CHASE and SEARCH on a single frame of occlusion (§7).
   */
  visionConfidenceHysteresis: number;
  /** Visibility at or above which a sample counts as "fully visible" rather than partial. */
  visionFullVisibility: number;
  /** Visibility below which a sample contributes nothing — not even suspicion. */
  visionMinVisibility: number;

  // --- Hearing (§8, §9) ---
  /** Loudest sound she can ever perceive, in the loudness units SoundEvents carry. */
  hearingRange: number;
  /** Scales every perceived loudness before it is compared to a threshold. */
  hearingSensitivity: number;
  /** Perceived loudness below which a sound is ignored outright. */
  hearingThreshold: number;
  /** Perceived loudness at or above which a sound is treated as LOUD (hard interrupt). */
  hearingLoudThreshold: number;
  /** Walls damp rather than block (§8), so an obstruction multiplies rather than zeroes. */
  hearingObstructionModifier: number;
  /** How far off a sound's reported position her estimate may be, so she walks near not onto it. */
  hearingPositionJitter: number;

  // --- Investigation & search (§9, §13, §14, §15) ---
  /** How long she spends poking around a sound's source before giving it up. */
  investigationDuration: number;
  /** How long the whole SEARCH behaviour runs before RETURN_TO_PATROL. */
  searchDuration: number;
  /** Radius of the area generated around lastKnownPosition. */
  searchRadius: number;
  /** Points sampled inside the search area. More is smarter and slower. */
  searchPointCount: number;
  /**
   * How many of the planned points she actually visits before giving up and patrolling.
   *
   * `searchPointCount` decides how many candidates are *generated* for ranking; this decides how many
   * she walks. They are separate because a good ranking needs a wide field, but a long tour reads as
   * her being stuck: the player watches her circle the same room for half a minute and concludes the
   * AI has broken. Capped at 4 so a search is a decisive sweep — three or four looks around where she
   * lost you, then back to patrolling the house, which is both scarier and more legible.
   */
  searchMaxPoints: number;
  /** How long she pauses at a search point to look around. Important for horror (§14). */
  searchPauseDuration: number;
  /** Max age of player velocity used to estimate escape direction (§15). */
  escapeVelocityMemory: number;
  /** Weight on escape direction when prioritising search points. 0 disables the guess. */
  escapeDirectionWeight: number;

  // --- Patrol scoring (§5) ---
  /** Distance in metres at which the distance term bottoms out at its floor. */
  patrolDistanceFalloff: number;
  /** Divisor on a waypoint's age, in seconds, for the "time since last visit" term. */
  patrolVisitAgeScale: number;
  /** Ceiling on the "time since last visit" term, so an old waypoint cannot dominate forever. */
  patrolVisitAgeCap: number;
  /** Radius around the player's last known position in which waypoints get a boost. */
  patrolActivityRadius: number;
  /** How much that boost can reach. 2.2 means a waypoint at the player's feet scores 3.2x. */
  patrolActivityWeight: number;
  /** Each prior visit to a waypoint divides its score by (1 + n * this). */
  patrolRepetitionPenalty: number;
  /** Fractional jitter on every score, two-sided. 0.25 gives a 0.75–1.25 spread. */
  patrolRandomness: number;
  /** Divisor on a storey's age, in seconds, for the "time since she patrolled that floor" term. */
  patrolStoreyAgeScale: number;
  /** Ceiling on the storey-age term, so a long-unvisited floor cannot dominate forever. */
  patrolStoreyAgeCap: number;

  // --- Suspicion (§20) ---  /** Confidence the player must be glimpsed at to register as suspicious rather than nothing. */
  suspicionVisionThreshold: number;
  /** Perceived loudness that is audible but too quiet to investigate. */
  suspicionSoundThreshold: number;
  /** How long she stays suspicious with no further evidence before returning to patrol. */
  suspicionDuration: number;
  /** How far she is willing to drift toward a suspicious direction. */
  suspicionApproachDistance: number;

  // --- Movement (§18, §19) ---
  /** Metres per second by state. She walks slowly enough to be creeped up on while patrolling. */
  patrolSpeed: number;
  investigateSpeed: number;
  chaseSpeed: number;
  searchSpeed: number;
  /** Acceleration and deceleration, in m/s². They differ so starts and stops are not mirrors. */
  acceleration: number;
  deceleration: number;
  /** How fast her body yaw may turn, in degrees per second. The cap that bans instant 180s (§21). */
  turnSpeedDeg: number;
  /** How fast her head/gaze yaw leads her body, in degrees per second. */
  lookSpeedDeg: number;
  /** Vertical gaze travel, in degrees per second. */
  lookPitchSpeedDeg: number;
  /** How high above her feet her eyes sit, for both LOS origin and attack range. */
  eyeHeight: number;

  // --- Delay / reaction (§24) ---
  /** Seconds before she reacts to a quiet, ambiguous cue. */
  reactionDelayQuiet: number;
  /** Seconds before she reacts to a loud one. */
  reactionDelayLoud: number;
  /** Seconds before she reacts to clear sight. Closest to instant, but never zero. */
  reactionDelayVisual: number;

  // --- Prediction / interception (§12) ---
  /** Master switch and multiplier for `predictedPos = pos + vel * t` extrapolation. 0 = off. */
  predictionStrength: number;
  /** Longest lead time the extrapolation may use. */
  predictionMaxTime: number;
  /** Spec §12: prediction weakens while the player is slow, erratic, or unseen. */
  predictionDirectionChangePenalty: number;
  predictionMinPlayerSpeed: number;
  /** How far off the predicted point may be from the player's real one before we give up on it. */
  predictionMaxLead: number;

  // --- Memory (§10) ---
  /** lastKnownPosition is still actionable for this long after the last evidence. */
  memoryDuration: number;
  /** Confidence below which a remembered position stops driving behaviour at all. */
  memoryMinConfidence: number;

  // --- Performance / scheduling (§11, §27) ---
  /** Perception runs at this rate, not once per frame. 5–10 Hz per the spec. */
  perceptionHz: number;
  /** Path recalculation rate while chasing. Throttled hard (§11). */
  repathHzChase: number;
  /** Path recalculation rate while doing anything calmer. */
  repathHzPatrol: number;
  /**
   * AI LOD: beyond this distance from the player she drops to `aiFarHz` logic.
   * The point is that a Daayan three rooms away should not cost a chase's worth of raycasts.
   */
  aiLodDistance: number;
  /** Update rate for the far LOD tier. */
  aiFarHz: number;
  /**
   * Pathfinding rate in the far LOD tier.
   *
   * She must keep moving when the player is far away, because in a three-storey house the player is
   * *usually* far away — that is the normal case, not the exception. Skipping pathfinding in the far
   * tier meant she only built a route when the player happened to come within `aiLodDistance`, so in
   * play she stood frozen wherever she was and never patrolled the house at all.
   *
   * Kept well below `repathHzPatrol` because the point of the tier is still to be cheap: at this rate
   * a route is re-planned roughly every second, which is plenty for a waypoint that never moves.
   */
  farRepathHz: number;
  /** Beyond this, subsystem logic is skipped entirely until the player comes nearer. */
  aiSleepDistance: number;

  // --- Combat (§ATTACK) ---
  /** How close she must be to attack. Measured eye-to-eye, so it is a real grab range. */
  attackRange: number;
  /** Seconds between attack attempts. */
  attackCooldown: number;
  /** How long she is stunned when the player lands a defensive action. */
  stunDuration: number;
  /**
   * Seconds she stays stunned **after landing a catch**, before she can act again.
   *
   * Distinct from `stunDuration`, which is the player-defence stun. This is her own recovery beat
   * after a grab, and it is what stops the catch loop: without it, a player who does not move is
   * caught, she stuns herself for `stunDuration`, wakes, finds them still in range, and catches again
   * — forever, four times in ten seconds in a headless run. Whoever subscribes to `game:caught` gets
   * this whole window to respawn, play a death beat, or reset the encounter, and nothing about that
   * decision belongs in the AI.
   *
   * Must be comfortably longer than `stunDuration`, or the loop reopens.
   */
  catchRecovery: number;

  // --- Flow / integration ---
  /**
   * Whether she is active at world load or sleeps in the ritual room until woken.
   * True per the agreed design: early game stays calm and she is woken by a trigger.
   */
  wakeOnTrigger: boolean;
  /** Toggle for the debug overlay (§26). Forced off in production builds. */
  debug: boolean;
  /** Master kill switch, so the previous static-Daayan behaviour can be restored for comparison. */
  enabled: boolean;
}

/**
 * The shipped defaults. Every field the spec names appears here; the grouping follows the spec's own
 * order so a reader can hold the PDF and this file side by side.
 */
export const DAAYAN_CONFIG: DaayanConfig = {
  // Vision
  visionRange: 18,
  visionFOVDeg: 100,
  visionVerticalDeg: 35,
  visionRays: 3,
  visionConfidenceGain: 1.6,
  visionConfidenceDecayPartial: 0.9,
  visionConfidenceDecay: 0.35,
  visionConfidenceThreshold: 0.65,
  visionConfidenceHysteresis: 0.25,
  visionFullVisibility: 0.85,
  visionMinVisibility: 0.05,

  // Hearing
  hearingRange: 34,
  hearingSensitivity: 1.0,
  hearingThreshold: 0.16,
  hearingLoudThreshold: 0.6,
  hearingObstructionModifier: 0.65,
  hearingPositionJitter: 0.9,

  // Investigation & search
  investigationDuration: 9,
  searchDuration: 24,
  searchRadius: 9,
  searchPointCount: 7,
  searchMaxPoints: 4,
  searchPauseDuration: 1.6,
  escapeVelocityMemory: 1.2,
  escapeDirectionWeight: 1.35,

  // Patrol scoring
  patrolDistanceFalloff: 10,
  patrolVisitAgeScale: 45,
  patrolVisitAgeCap: 4.0,
  patrolActivityRadius: 18,
  patrolActivityWeight: 2.2,
  patrolRepetitionPenalty: 0.25,
  patrolRandomness: 0.25,
  patrolStoreyAgeScale: 90,
  patrolStoreyAgeCap: 4.0,

  // Suspicion
  suspicionVisionThreshold: 0.18,
  suspicionSoundThreshold: 0.3,
  suspicionDuration: 7,
  suspicionApproachDistance: 4,

  // Movement
  patrolSpeed: 1.05,
  investigateSpeed: 1.7,
  chaseSpeed: 3.35,
  searchSpeed: 1.5,
  acceleration: 4.2,
  deceleration: 6.5,
  turnSpeedDeg: 260,
  lookSpeedDeg: 420,
  lookPitchSpeedDeg: 180,
  eyeHeight: 1.62,

  // Reaction
  reactionDelayQuiet: 0.85,
  reactionDelayLoud: 0.28,
  reactionDelayVisual: 0.12,

  // Prediction
  predictionStrength: 0.75,
  predictionMaxTime: 1.1,
  predictionDirectionChangePenalty: 0.6,
  predictionMinPlayerSpeed: 0.9,
  predictionMaxLead: 3.2,

  // Memory
  memoryDuration: 26,
  memoryMinConfidence: 0.12,

  // Performance
  perceptionHz: 8,
  repathHzChase: 6,
  repathHzPatrol: 2,
  aiLodDistance: 26,
  aiFarHz: 2,
  farRepathHz: 1,
  aiSleepDistance: 55,

  // Combat
  attackRange: 1.5,
  attackCooldown: 1.4,
  stunDuration: 2.5,
  catchRecovery: 6.0,

  // Flow
  wakeOnTrigger: true,
  debug: false,
  enabled: true,
};

/**
 * Named presets. They only touch the fields that actually change difficulty — perception acuity,
 * speed and how forgiving the memory is — so two presets never disagree about a geometry constant.
 *
 * `story` is for a player who wants the house, not the chase: she is slower than the player's run,
 * her FOV is narrow enough to slip past, and her memory of you fades fast.
 * `nightmare` is still fair by §21 — she never sees through a wall or ignores your sound — she is
 * simply fast, attentive and hard to shake.
 */
const PRESETS: Record<Exclude<DifficultyName, 'custom'>, Partial<DaayanConfig>> = {
  story: {
    visionRange: 14,
    visionFOVDeg: 84,
    visionConfidenceGain: 1.2,
    visionConfidenceDecay: 0.55,
    hearingRange: 26,
    hearingSensitivity: 0.85,
    hearingThreshold: 0.22,
    chaseSpeed: 3.0,
    searchDuration: 16,
    searchRadius: 7,
    predictionStrength: 0.45,
    memoryDuration: 18,
    reactionDelayQuiet: 1.1,
    reactionDelayLoud: 0.4,
    // A longer mercy beat on Story: being caught should feel like a near-miss, not a stun-lock.
    catchRecovery: 9.0,
  },
  normal: {},
  nightmare: {
    visionRange: 22,
    visionFOVDeg: 116,
    visionConfidenceGain: 2.0,
    visionConfidenceDecay: 0.26,
    hearingRange: 40,
    hearingSensitivity: 1.15,
    hearingThreshold: 0.12,
    chaseSpeed: 3.75,
    patrolSpeed: 1.25,
    investigateSpeed: 1.95,
    searchDuration: 32,
    searchRadius: 11,
    searchPointCount: 9,
    searchMaxPoints: 5,
    predictionStrength: 0.92,
    memoryDuration: 36,
    reactionDelayQuiet: 0.6,
    reactionDelayLoud: 0.2,
    reactionDelayVisual: 0.08,
    // Nightmare gives back the least: she is on you again quickly, but the loop is still closed.
    catchRecovery: 4.0,
  },
};

/** Apply a preset on top of the shipped defaults, returning a fresh config. */
export function daayanConfigFor(name: DifficultyName): DaayanConfig {
  const base = name === 'custom' ? { ...DAAYAN_CONFIG } : { ...DAAYAN_CONFIG, ...PRESETS[name] };
  // §26: "Debug mode must be disabled in production." Enforced here rather than left to the caller
  // because this function is the single construction point for every config the AI ever uses, so a
  // `debug: true` that leaks out of a tuning session cannot follow the game onto a device. Vite
  // statically folds `import.meta.env.PROD`, so in a release build this is `{ ...base, debug: false }`
  // with the branch gone entirely — the overlay is not merely switched off, it is not shipped.
  return import.meta.env.PROD ? { ...base, debug: false } : base;
}

/** Horizontal FOV as a half-angle in radians, which is what the vision test actually uses. */
export function visionHalfFov(cfg: DaayanConfig): number {
  return (cfg.visionFOVDeg * Math.PI) / 360;
}

/** Vertical detection limit as a half-angle in radians. */
export function visionHalfVertical(cfg: DaayanConfig): number {
  return (cfg.visionVerticalDeg * Math.PI) / 360;
}
