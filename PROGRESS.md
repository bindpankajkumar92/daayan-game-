# Daayan — Progress Log

## 2026-09-14 — THE bar bug, third time: a sprinting player in a small room was not "running"

The player reported the same symptom a third time, with a fresh recording. They were right again, and
this time the cause was upstream of everything the previous two passes had touched.

### What the recording showed

The bar was measured frame by frame at 30 fps. It climbs smoothly from 0.37, then sits at **0.930 —
flat — for eight seconds**, and only begins to drain at the end. The debug overlay across that whole
plateau reads:

```
STATE: PATROL   LAST KNOWN: NONE   LAST SEEN: NONE   LAST HEARD: (empty)
SOUND: (-4.0,1.7,1.0) @0.18   AWARE: YES
```

She is patrolling, has **never heard anything above 0.18**, and the bar is at 93%. The `noise:alert`
event — which delivers loudness 1.0 — never fired. A flat plateau below the threshold means the level
genuinely stopped rising, and the only thing that stops it rising is the gait gate.

### Root cause

`FPController` decided `actuallyRunning` with:

```ts
this.running && !this.crouching && this.onGround && wants && (moved > 0.001)
```

The last term asks a **displacement** question to answer an **intent** question. `moveAxis` slides
per-axis and rejects an axis outright on contact, so in a small room — the entire game — a sprinting
player's `moved` collapses to ~0 on every frame they brush a wall. `NoiseSystem` bills each of those
frames as *decay*, which at range is **2.3× the sprint gain**.

Driving the **real** controller in a 3 m room, sprinting wall to wall for 20 s:

| room | running frames (before) | bar (before) | running frames (after) | bar (after) |
|---|---|---|---|---|
| 3 m | 35.4 % | **0.114, 0 alerts** | 54.5 % | **1.000, 1 alert** |
| 4 m | 49.9 % | **0.566, 0 alerts** | 67.9 % | **1.000, 1 alert** |
| 6 m | 78.7 % | 1.000, 2 alerts | 96.5 % | 1.000, 1 alert |

Four metres was the case that matters — a small bedroom — and it could not fill the bar at all.

### The fix

Two halves, and both are needed:

- **`FPController`** keeps a sprint alive for `RUN_MEMORY = 0.3 s` after the last frame that actually
  covered ground. `moved` is demoted to what it is good for: gating the *footstep*, because a player
  pressed against a wall should not keep playing footsteps. The credit is dropped on any real change
  of intent — `setRun(false)`, `setCrouch(true)`, `setMovementLocked(true)`, `warpTo`.
- **`NoiseSystem`** holds the level — neither building nor draining — while the run control is still
  held but the body is blocked (`HOLD_WHILE_INTENT`, read through `isRunIntent()`). This is what makes
  the fix robust rather than merely better: the first half alone took the 3 m room only to 0.527,
  because a player pinned in a corner is blocked for far longer than any grace period covers.

`DECAY_GRACE` was raised 0.25 → 0.3 to sit exactly on `RUN_MEMORY`, so the two systems cannot
disagree about whether a sprint is still in progress.

### Verification

New suite `tools/small-room-check.ts`, wired into `run-ai-checks.mjs` immediately after `noise-bar`.
It is the counterpart to that suite, and the distinction is the whole lesson: `noise-bar-check.ts`
feeds `update()` a *synthetic* `isRunning`, so it can only ever prove the code downstream of that flag.
This one drives the real `FPController` and lets the flag be **produced** by real movement.

Six groups: the bar fills in 3 / 4 / 6 m rooms; a wall-scraping lap still counts as running (>95 % of
frames); releasing run still drains the bar to zero; standing still and walking still fire nothing.

`npm run check:ai` — **9 suites, ALL SUITES PASS**. `tsc --noEmit` clean. `vite build` clean
(849.58 kB / 236.43 kB gzip).

### Reading it on the device

The three passes each failed in play, so the live reading matters more than the suite. `__daayan.bar()`
(DEV only) prints the gait as the noise system sees it:

```
__daayan.bar()   ->   { intent: true, running: false, level: 0.930, alerted: true }
```

`intent: true, running: false` is the small-room case — holding run while pressed against a wall — and
that combination must **hold** the bar rather than drain it. `alerted` is the other half: the bar is at
its limit *and* the alert went out, which is the claim the player was actually making when they said
she never noticed. `handles.bar` is stripped from the release bundle (the surviving
`hasFiredAlert(){...}` definition is unreachable — zero call sites in `dist`).

### The lesson, for the third time

Each pass looked at the layer below the last and found the real fault:

1. The **listener** was missing (`noise:alert` had no subscriber) — fixed, and it was genuinely broken.
2. The **emitter** fired at the wrong threshold and decay outran a stutter — fixed, also real.
3. The **flag feeding the emitter** was never true, because a displacement test was used to answer a
   question about intent.

A suite that supplies the input it means to be testing can only ever prove the code downstream of
that input. `noise-bar-check.ts` passes `isRunning` in; the bug was that nothing ever set it.

## 2026-09-13 (latest) — being caught finally costs something

`game:caught` had **zero subscribers**. The AI emitted it exactly once per catch, held a recovery window
open for whoever would handle it, and nothing ever did — so she grabbed the player, stunned herself,
woke up, and the run simply carried on. Being caught was a free animation. The config comment even said
so: *"Whoever subscribes to `game:caught` gets this whole window to respawn, play a death beat, or reset
the encounter."*

Three lives, a death overlay, and a real respawn now close it.

### What was built

| File | Change |
|---|---|
| `GameState.ts` | `STARTING_LIVES = 3`, `caught()`, `isDead()`, `getLives()`, `getDeaths()`, `reset()` |
| `DaayanAI.ts` | `resetToStart()` — sends her home with an empty head |
| `HouseScene.ts` | `game:caught` handler: spend a life, warp to the bed, reset her, overlay or toast |
| `Hud.ts` | Life beads, top-left, dimmed as they are spent |
| `Strings.ts` | Hinglish for the caught/ending/begin-again copy |

### The two halves, and why both were needed

**1. The catch has to cost something.** `GameState.caught()` spends a life and returns whether the run
continues, so the scene knows whether to respawn or end. It is guarded on `escaped`, because a catch
landing on the same frame as the ending must not spend a life the player has already earned their way
out of. Verified: exactly `STARTING_LIVES` catches end a run, and a fourth does nothing.

**2. A respawn must actually reset her** — and this is the half that is easy to get subtly wrong.
Warping the *player* back to the bed while leaving *her* mid-hunt in the room they were caught in is not
a second chance, it is a second catch. So `resetToStart()` undoes everything the encounter taught her:
position and heading (via `Locomotion.place`), memory, vision confidence, the sound queue, stuck
tracking, the prediction history, the attack latch, and the catch-recovery window.

That last one is worth stating: `catchRecovery` is a mercy for the *player* after a catch — on a fresh
attempt it would instead be a window in which she cannot catch them at all. Clearing it is what makes a
respawn neutral rather than generous.

She stays **awake** if she was awake. This is a respawn, not a restart, and a player who has already
woken her should not get a quiet house back for free.

### Verification

New suite `tools/caught-check.ts`, 33 checks, wired into `npm run check:ai`:

```
=== A CATCH MUST COST SOMETHING ===
PASS  the run starts with lives  3 lives
PASS  the run ends on the last life  lives 0
PASS  it took exactly STARTING_LIVES catches to end it  3 catches
PASS  a catch past the end does nothing  caught() -> false
=== A CATCH DURING THE ESCAPE IS NOT A FAILURE ===
PASS  a catch after escaping is refused  caught() -> false
=== BEGIN AGAIN RESTORES THE OPENING STATE ===
PASS  lives come back  3 lives
PASS  the death count survives as history  3 death(s)
=== AFTER A RESPAWN SHE MUST NOT KNOW WHERE THE PLAYER WAS ===
      before respawn: state=ATTACK confidence=1.00 memory=held
      after respawn:  state=RETURN_TO_PATROL confidence=0.00 memory=none  moved home 0.00 m
PASS  she is back at her start  0.000 m from start
PASS  her memory of the player is cleared  memory null
=== SHE MUST NOT WALK TO THE OLD CATCH SITE AFTER A RESPAWN ===
      over the same 30 s she ranged up to 16.3 m away from it
PASS  and does not park on where she last heard them  ranged 16.3 m from the old site
=== SHE STILL HUNTS AFTER A RESPAWN ===
      after the respawn she rebuilt confidence to 1.00
PASS  she perceives the player again after a respawn  peak 1.00
```

`npm run check:ai` — **8 suites, all pass**. `tsc --noEmit` and `vite build` clean.

### A test bug worth recording

My first version of the "does not park on the old site" check parked the player at `(60, 60)` to get
them out of the way — which is beyond `aiSleepDistance` (55 m), where `update` returns early and she
**does not tick at all**. She stood frozen for 30 s and the check failed, which looked like a bug in
`resetToStart` and was actually a bug in the test.

The lesson is the same shape as the `noise:alert` one earlier today: when a test fails, the first
question is whether the *test* is wrong. Here the fix was to place the player 22 m away — on the same
storey, live, but outside her 18 m vision range — so she patrols genuinely rather than being switched
off. With that corrected she ranges **16.3 m** from the old site instead of 2.4 m.

## 2026-09-13 (later) — THE real bug: the bar could never fill from a stuttering run

The player's recording, read frame by frame. At the moment they say the bar is maxed, the debug overlay
reads:

```
STATE: IDLE    WHY: nothing-to-do    SOUND: NONE    LAST HEARD: NONE    AWAKE: NO
NOISE bar: full, red, pulsing
```

She is **asleep and has heard nothing**. So `noise:alert` never fired at all — the AI half was never
the problem, and the previous session's work on it (subscriber, range floor, stash-on-wake, seal-break)
is all downstream of a signal that was not being sent. **The bug is in `NoiseSystem`, not in the AI.**

### Root cause: decay outran sprinting by 2.3×

```
sprint gain:  RUN_NOISE_RATE × mult × dt = 0.38 × 0.25 / 60 = 0.001583 per frame
decay:        DECAY_RATE × dt            = 0.22       / 60 = 0.003667 per frame
```

At the far distance multiplier (0.25) a single non-running frame subtracts **2.3× what a running frame
adds**. And `FPController.actuallyRunning` requires real displacement *on the current frame* —
`moved > 0.001` — so a wall corner, a hitch, or a single short frame is enough to trip it.

Reproduced in `tools/noise-bar-check.ts`: **one dropped frame in four, sprinted for 20 s, left the bar
at 0.329 with zero alerts.** The player's run was interrupted just often enough that the bar hovered and
fell back instead of filling. That is exactly what the video shows.

There is a second, independent half. `Hud.setNoiseLevel` paints the fill red and pulsing from
`level >= 0.75`, but `addNoise` only fired the alert on landing on exactly 1.0. So the top quarter of
the bar was dead space where the UI said "maxed" and the game had registered nothing — a player at 0.96
was looking at a red, pulsing, full bar and was simply wrong about it. **The bar had no maximum the
player could see.**

### The fix

- `NoiseSystem.DECAY_GRACE` (0.25 s) — decay only begins after the player has genuinely stopped. Rides
  out a hitch or a corner; symmetric with `FPController`'s existing footstep priming, which already
  treats a brief stop as not having stopped.
- `NoiseSystem.ALERT_LEVEL` (0.75) — the alert fires on **crossing into the bar's full band**, not on
  landing exactly on 1.0. Exported and read by `Hud` for the band boundary, so "the bar is red" and
  "she heard it" are now literally the same statement rather than two literals that happened to differ.
- `REARM_LEVEL` (0.3) + `REARM_DELAY` (0.4 s) — replaces the old `level < 0.75` re-arm, so a second
  genuine max is heard again but a flicker at the boundary is not.

### Verification

New suite `tools/noise-bar-check.ts`, wired into `npm run check:ai` **before** the AI suites — every
other noise test is downstream of the alert this one proves is emitted:

| Check | Before | After |
|---|---|---|
| Stuttering sprint fills the bar | **0.329, 0 alerts** | 1.000, 1 alert |
| Held sprint fires the alert | pass | pass, at 0.751 |
| One alert per max, not per frame | pass | pass |
| A second max after a lull is heard again | pass | pass |
| A minute of standing still fires nothing | pass | pass |

`npm run check:ai` — **all 7 suites pass**, no regressions in the AI or playtest suites.
`tsc --noEmit` and `vite build` clean.

## 2026-09-13 (later) — three bugs from the first real playtest

The player's report: *"after spawning she was coming out toward the basement, and she got out to me

> **Superseded.** The entry above found the real cause — the bar could not fill from a stuttering run,
> so the alert was never emitted at all. What follows is still accurate about the AI half and the
> verification it records stands; its closing conclusion that "the mechanic works" was drawn from a
> headless harness that called `noise:alert` directly, and so could not see that in play the event never
> fired. Kept as written, because the mistake is worth keeping: **a suite that injects the event it is
> meant to be testing can only ever prove the code downstream of it.**

The report, second time round: *"just after spawn I max the noise and she still does not know. Fix it
so that wherever I am, if I hit noise max, she comes to where the noise maxed."*

This was **already implemented** in the previous session — the `noise:alert` tree — and the ask here
was to establish that it actually works rather than to rebuild it. It does, and the checks below are
the evidence; what was genuinely missing was a way to see it happen live.

### Why the previous version could still look broken

The bug had two halves and only one of them was fixed before:

1. **The AI half.** `noise:alert` had zero subscribers, so a full bar meant nothing. Fixed previously:
   `DaayanAI` subscribes, routes it through the hearing model with a house-spanning range floor, and
   stashes it while she is sealed in. Already correct.
2. **The wiring half.** `NoiseSystem.addNoise` fires `noise:alert` exactly once, on the frame the bar
   *touches* 1.0, and `hasAlerted` is only cleared once the level falls back below 0.75. So a player
   who maxes the bar, lets it decay a little, and maxes it again inside that window gets **no second
   alert** — she comes, finds nothing, drifts back, and the bar that is now visibly full again does
   nothing. That is a plausible reading of "she still doesn't know", and it is by design rather than a
   fault: one full bar is one event.

The honest answer to the report is therefore that the mechanic **works** — measured, not asserted: a
Daayan in the cellar ritual room walks 65.9 m across two storeys to within **0.52 m** of a noise that
maxed on the upper floor, 39.5 m away, which is far outside her 34 m `hearingRange`.

### What was added

- `NoiseSystem.fill()` — drives the bar to its limit through `addNoise`, so it fires the *real*
  `noise:alert` rather than a second path that merely resembles it.
- `HouseScene.ts` — `window.__daayan` in DEV builds only (`import.meta.env.DEV` is statically folded,
  so it is absent from a release bundle). `__daayan.noise()` fills the bar wherever the player stands,
  `__daayan.state()` prints her state and distance, `__daayan.open()` opens the ritual screen without
  waiting for a full bar.

The point of the probe is that the wiring half cannot be tested from a headless suite: whether a
sprint fills the bar, whether the fill fires the alert at the right moment, and whether she then routes
to where the player stood all depend on the live controller and the live scene. `tools/playtest-check.ts`
BUG 3 proves the AI half; this proves the other.

### Verification

`npm run check:ai` — all six suites pass, playtest BUG 3 included. `tsc --noEmit` and `vite build` clean.

## 2026-09-13 (later) — the noise-max report, first attempt: the AI half (superseded)

> **Superseded by the entry at the top of this file**, which found the real cause: the bar could not
> fill from a stuttering run, so the alert was never emitted at all. What follows is still accurate
> about the AI half and its measurements stand. Its closing conclusion that "the mechanic works" was
> drawn from a headless harness that *called `noise:alert` directly*, and so could not see that in play
> the event never fired. Kept as written, because the mistake is worth keeping: **a suite that injects
> the very event it is meant to be testing can only ever prove the code downstream of it.**

The report, second time round: *"just after spawn I max the noise and she still does not know. Fix it
so that wherever I am, if I hit noise max, she comes to where the noise maxed."*

This was **already implemented** in the previous session — the `noise:alert` tree — and the ask here
was to establish that it actually works rather than to rebuild it. It does, and the checks below are
the evidence; what was genuinely missing was a way to see it happen live.

The bug had two halves and only one of them was fixed before:

1. **The AI half.** `noise:alert` had zero subscribers, so a full bar meant nothing. Fixed previously:
   `DaayanAI` subscribes, routes it through the hearing model with a house-spanning range floor, and
   stashes it while she is sealed in. Already correct.
2. **The wiring half.** `NoiseSystem.addNoise` fires `noise:alert` exactly once, on the frame the bar
   *touches* 1.0, and `hasAlerted` is only cleared once the level falls back below 0.75. So a player
   who maxes the bar, lets it decay a little, and maxes it again inside that window gets **no second
   alert** — she comes, finds nothing, drifts back, and the bar that is now visibly full again does
   nothing. That is a plausible reading of "she still doesn't know", and it is by design rather than a
   fault: one full bar is one event.

The honest answer to the report is therefore that the mechanic **works** — measured, not asserted: a
Daayan in the cellar ritual room walks 65.9 m across two storeys to within **0.52 m** of a noise that
maxed on the upper floor, 39.5 m away, which is far outside her 34 m `hearingRange`.

**What was added here:** `NoiseSystem.fill()` (drives the bar through the real `addNoise`, so it fires
the real alert) and DEV-only `window.__daayan` handles in `HouseScene.ts` — `noise()`, `level()`,
`state()`, `open()`. The point of the probe is that the wiring half cannot be tested from a headless
suite: whether a sprint fills the bar, whether the fill fires the alert at the right moment, and whether
she then routes to where the player stood all depend on the live controller and the live scene.

`npm run check:ai` — all six suites as they stood then passed. `tsc --noEmit` and `vite build` clean.
`fill()` and the probes are still in place and still used; only the conclusion was wrong.

## 2026-09-13 (later) — three bugs from the first real playtest: the stun lock, the re-catch loop, the seal
The player's report: *"after spawning she was coming out toward the basement, and she got out to me
without the ritual door sliding. Then she came and stood still next to me, and after that she never
moved again no matter where I went."*

The debug overlay in their screenshot made the diagnosis immediate:

```
STATE: STUNNED   WHY: attack-landed   VISIBILITY: 1.00
LAST KNOWN: (-12.9, -1.0, 1.5)   SPEED: 0.00   AWAKE: YES
```

`SPEED: 0.00` with `WHY: attack-landed` is the whole story — she was stunned *because she caught the
player*, and a stun lasts 2.5 s, not forever.

Reproduced all three headlessly before touching anything (`tools/recovery-check.ts`, kept as a
permanent suite).

### 1. She could never leave STUNNED
`interrupts` refuses every candidate while she is stunned — *"STUNNED is special: it interrupts
anything, and only STUNNED can end it"* — so the stun's own expiry transition was refused. The
SEARCH and RETURN_TO_PATROL exits had been marked `complete: true` to bypass the ladder; the CHASE
exit had not. She asked to leave, was refused, and asked again, forever.

- `States.ts` — STUNNED's exit to CHASE marked `complete: true`.
- `StateMachine.ts` — `complete()` now lets STUNNED hand over to anything, since it is the only state
  whose own work is a fixed timer with no implied successor.

### 2. She re-caught a stationary player every few seconds
`game:caught` has **no subscribers** — the game has no death or caught state at all. So the catch had
no consequence, and she grabbed, stunned herself, woke, found the player still in range, and grabbed
again: **four catches in 45 s** in the harness.

The spec leaves the outcome to *"a gameplay-specific result"* (§29), so rather than invent one, the AI
now holds a recovery window after a catch and whoever subscribes gets that time to act.

- `DaayanConfig.ts` — new `catchRecovery` (normal 6 s, story 9 s, nightmare 4 s). Must exceed
  `stunDuration` or the loop reopens.
- `DaayanAI.ts` — `catchRecoveryUntil`, set in `checkCatch`; exposed as `ctx.catchRecovery`.
- `States.ts` — CHASE, INTERCEPT and ATTACK all refuse to engage during recovery.

Measured: closest pair of catches went from ~2.5 s to 8.5 s.

### 3. She got out of the room before the door opened
Her nav grid is baked **once**, at construction, and the shut ritual door is a collider in it — so
while it is closed the doorway is a wall in her graph. But `wireEvents` woke her on *any*
`noise:emitted`, so an ambient footstep anywhere in the house woke her while she was still sealed in.

- `DaayanAI.ts` — new optional `canRoam` predicate; she will not wake on ambient noise while it
  returns false.
- `HouseScene.ts` — `canRoam: () => ritualOpen`, so the scene owns the answer.

Worth noting: my first version of this gate was `if (!this.deps.canRoam?.())`, which reads as
"closed" for every caller that omits the predicate — `undefined` is falsy. It silently made her
sleep forever in `ai-integration-check`, which is exactly the class of bug the gate was fixing. It is
`=== false` now, and commented as such.

### Verification
`npm run check:ai` — **five** suites now, all passing. `tsc --noEmit` and `vite build` clean.

## 2026-09-13 — the Daayan AI, built from the system specification

Implemented `Daayan AI System Specification.pdf` (32 sections) as `src/ai/` — eleven modules, ~4.8k lines.
Deterministic throughout: an FSM over perception, memory and navigation. No LLM, no neural network, and
nothing that needs a model file at runtime.

### Modules (`src/ai/`)

| File | Role |
|---|---|
| `DaayanConfig.ts` | Every tunable in one place (§23), difficulty presets, `debug` force-off in release |
| `Perception.ts` | Vision with confidence + hysteresis (§5–6), hearing with falloff (§7) |
| `Memory.ts` | Decaying belief about the player's position (§8) |
| `NavGrid.ts` | Navigation graph over the real house rects; A*, LOS, `roomAt` |
| `Patrol.ts` | Weighted waypoint selection across all three storeys (§9) |
| `Search.ts` | Search-area generation from a last-known position (§13), prediction/interception (§15) |
| `Locomotion.ts` | Steering, corridor conforming, stuck detection (§28) |
| `States.ts` | The ten states and their transitions (§10–11) |
| `StateMachine.ts` | Priority ladder + `complete` bypass for expiry transitions |
| `Debug.ts` | §26 overlay: world-space vis/rays/path/markers + text readout |
| `DaayanAI.ts` | Orchestrator: the tick, event wiring, catch detection, debug payload |

### Wiring
`HouseScene.ts` constructs her; her spawn is read from the same `MODEL_PLACEMENTS` row that places the
`daayan.glb` mesh, so the AI and the visible statue cannot drift apart. She wakes 1.2 s after the ritual
door finishes opening — long enough that her first footstep does not land on top of the door's noise. She
does not tick while an overlay (note-reading) is open. `Hiding.ts` gained `getSpots()` so §14's "a search
checks the places a player could hide" is real rather than stubbed.

### Verification
`npm run check:ai` — four headless suites, no browser, no test framework:

- `nav-check` — pathfinding across all three storeys, doorway connectivity
- `perception-check` — walls block, doorways admit, confidence decays, loudness falls off, sound position
  is estimated rather than exact
- `patrol-check` — all 42 waypoints baked and reachable, all storeys covered, no immediate repeats,
  player-hint biasing, memory decay
- `ai-integration-check` — full scripted lifecycle IDLE → INVESTIGATE → SEARCH → CHASE → ATTACK →
  STUNNED → recovery, plus a 60 s soak. Asserts §21 fairness directly: never sees through walls, never
  teleports (worst single-frame step 0.028 m), never omniscient.

All four pass. `tsc --noEmit` and `vite build` both clean; `debug:!1` confirmed baked into `dist/`.

### Two bugs worth remembering
**The ladder can trap a state.** `INVESTIGATE_SOUND` (priority 4) outranks `RETURN_TO_PATROL` (8), and
`CHASE` (2) outranks `INTERCEPT` (3) — so those states could never hand off, and she stood still forever.
Fixed generically: expiry transitions carry `complete: true` and bypass the ladder via a `COMPLETION_TARGETS`
set, rather than each site being special-cased.

**Sound-reaction branches returned `destination: null`.** A state re-requesting *itself* with a null
destination is refused by `interrupts()` (candidate === current), so the null directive survived and froze
her. Every sound branch now returns the heard position as its destination.

Also: `npx.cmd` cannot be spawned from Node on Windows (`EINVAL`). `tools/run-ai-checks.mjs` calls
esbuild's `buildSync` API directly instead.

## 2026-09-04/05 — upper-storey "view glitch": seven rounds, seven different bugs

### Round 1 — degenerate-triangle depth failure (fixed, measured)
A triangle with a vertex near the camera plane has w → 0, its 1/w interpolation collapses, and the
fragment's depth lands metres out. Reads as a black wedge punched through plaster or floor that changes
shape as the player walks, visible only at diagonal views.

Bounded the longest *triangle* edge to ≤1 m at four sites — `Fixtures.boxMesh`, `Batch.box`/cylinders,
`HouseBuilder.slabPlane`/`worldBox`, and the `HouseProps` stair rail. The `Math.SQRT2` factor is the
point: bounding a quad's *side* to 1 m still leaves a 1.41 m diagonal, and the failure is a property of
the triangle.

- Desktop detector, 720 upper-storey poses: `posesWithWedge 17 → 0`, `blackMax 2637 → 9`.
- Ground-floor control, 864 poses: 0 wedges, `blackMax 70`.
- Device, worst pose, app foregrounded: `blackPx 11323 → 7`.

Imported GLB shell refuted as a culprit.

### Round 2 — the upper flat was wearing the cellar's plaster (fixed)
The user re-reported "view glitches" with 7 device photos after round 1 shipped. Round 1 was not the
cause of what those photos show, and neither was it design intent: **the `upper` room was tagged
`tone: 'cellar'`.**

`HouseBuilder` reads exactly one flag to choose a wall material — `room.tone === 'plaster' ? wallWarm :
wallCool` — and the same flag gates the skirting. So the two walls of the upper flat the imported model
leaves for us to draw came out on the cool plaster map under wallCool's `0x9aa0a8` tint, with no
skirting board. Those two walls are the first ones the player meets: the west wall is the way in off the
upper stair, the south wall carries the door into the rear wing. Everything they abut — `upshaft`
through that west wall, `up-store` / `up-child` / `up-shrine` through their doorways — is warm,
brick-patched, skirted plaster. Hence a large smooth blue-grey panel appearing and disappearing as those
walls came in and out of frame.

Corroborated in-repo before the change: `upshaft`'s wall comment already said "that room is cellar-toned
where this stair is plaster", and worked around the seam geometrically without questioning the tone.

Fixes:
- `HouseRooms.ts` — `upper` room `tone: 'cellar'` → `'plaster'`.
- `HouseBuilder.ts` — the `UPPER_PATCH` landing floor/ceiling now read the upper room's tone instead of
  hardcoding `floorStone` + `wallCool`. That patch covers the room the player walks into first, so it
  was the last cellar-toned surface upstairs; it also means the next tone change only has to be made
  once.
- `tools/audit-tones.ts` — new. Groups rooms by `floorY` and fails if one storey holds more than one
  tone, then prints the material that actually landed on each `-walls` mesh and on the landing patches.
- `tools/dom-shim.ts` — path-family 2D no-ops (`bezierCurveTo` and siblings) and event no-ops on
  non-canvas elements, so `buildHouse` runs under plain Node for the audit above.

Audit after the change (`npx tsx tools/audit-tones.ts`):

```
y= -3.00  cellar    shaft basement ritual black
y=  0.00  plaster   hall hallway bedroom living backhall kitchen pooja store upshaft
y=  2.40  plaster   upper up-store up-child up-shrine
upper-walls            wallWarm
upper-patch-floor-0    floorWood
upper-patch-ceil-0     ceil (timber boards)
OK — every storey is one tone.
```

`upper-skirt` now exists; skirted rooms 12 → 13. Before the change the y=2.40 row split into
`cellar upper` / `plaster up-store up-child up-shrine` — read from the source line, not re-measured.

Build clean (`tsc --noEmit && vite build`), bundle `index-C56dp3sf.js`.

### Confirmed on device
The user played the build and reported "sab jagah ho gye solve bas ye 2 door ke paas bache hai" — the
blue-grey panels are gone everywhere, which is round 2 closed by the person who reported it. What
remained was the doorway in round 3 below.

### Open, unrelated to the above
Perf on the upper storey: the photos show 100–172k triangles, 116 draws, 1% low 18.3 FPS and the
renderer auto-downshifting scale to 0.65x. Round 1's subdivision is part of that triangle count. Worth
a budget pass; it is a separate axis from the material bug and does not produce a pixel artefact.

### Round 3 — two unfilled slots at the upper flat's back doorway (fixed)
After round 2 shipped the report narrowed to "sab jagah ho gye solve bas ye 2 door ke paas bache hai",
with three photos of a dark band lying across the floorboards at a threshold. Two things were wrong at
that one doorway, and neither was round 1 or round 2.

**The defect.** A floor here is a `PlaneGeometry`, so it has no thickness and therefore no edge. Where
two floors abut in plan at different heights the difference is not a step, it is a hole: nothing is
drawn across the band between them and the player sees through to fog. `UPPER_PATCH.floorY` is
`UP_Y - 0.06` = 2.34, chosen so the landing patch sits 1 cm *under* the imported flat's own slab at 2.35
and can never z-fight it; the rear wing's three rooms floor at `UP_Y` = 2.40. They abut along z = −1.93
with zero overlap, and `up-store`'s north side is deliberately absent along that line because it is the
way in from the flat's back door — its own source comment says so. So the walk-in route crosses a 60 mm
slot underfoot and a 220 mm one overhead, where the wing's 5.10 ceiling meets the patch's 5.32.

Measured, before touching anything (`tools/_step.ts`, since deleted):

```
up-store-floor / upper-patch-floor-0: step -60 mm  abut  (w 4.200 d -0.000)
up-child-floor / upper-patch-floor-0: step -60 mm  abut  (w 1.300 d -0.000)
up-child-floor / upper-patch-floor-1: step -60 mm  abut  (w 3.400 d -0.000)
```

**Refuted first, cheaply.** Coplanar z-fighting: `tools/audit-coplanar.ts` (new, keepable) reports 0
unseparated overlaps out of 37 flat surfaces. Contact-shadow decals: no door placement carries
`shadow:`. The two wing doors as round-1 w→0 sites: a near-plane A/B over 64 poses each, moving
`camera.near` by 0.1 mm and counting *black* flipped pixels, gives `posesWithWedge 0`, `blackMax 20`
and `22` — noise.

**Fix.** A generic riser pass in `HouseBuilder.ts`: every horizontal plane the builder draws registers
itself in a `slabs` list, `findRisers()` pairs like with like where they meet in plan (facing edges
within 2 cm, a shared run of at least 20 cm, a step between 2 mm and 0.5 m), and one vertical quad per
join closes the slot. It faces the side the slot is actually visible from — for floors the *lower* of
the two, since over the higher one that band is solid ground; for ceilings the *higher*, since under the
lower one it is outside the room — and wears the other slab's material, because it is that slab's
exposed edge. Built with `slabPlane`, so round 1's ≤1 m triangle bound still holds, and UV'd by
`worldUv` off its own normals, so the strip picks up the boards of the floor it hangs off without being
told which way it is turned. Merged per material; no `aabbs` entry, a 60 mm lip is not a wall.

Generic rather than six hand-placed quads because these heights are tuned against an imported model and
will be tuned again.

It found a third join nobody was looking for: the Black Magic Room is `height: 2.82` against the
basement's 2.80, so their ceilings abut 20 mm apart along z = 6.6 with the basement's north wall topping
out below both. A real hole, and an invisible one — toggling that quad's `visible` at the pose it is
widest changes 0 pixels above a 12-luma threshold. Kept anyway, at 16 triangles; leaving a known hole
because it is small is how the 60 mm one survived this long.

Cost: 68 triangles, 3 draw calls, 3 merged meshes (`risers-0..2`).

**Before / after**, same pose, headless Chrome on `dist/`, counting pixels under 26/255 luma inside a
floor rectangle clear of the door leaf and the player's arm:

```
(16.5, 4.04, -1.10) yaw 0 pitch -58   black 1210 -> 110   changed 5.65%
(16.5, 4.04, -1.60) yaw 0 pitch -68   black  431 -> 189   changed 3.17%
```

The ceiling band is not worth a number — `.thresh/14-ceil-slot.png` has a 220 mm blue-black stripe
across the timber and `.thresh/17-ceil-slot-after.png` has continuous boards.

`npx tsx tools/audit-coplanar.ts` still OK afterwards; the risers share edges with the planes they
close, they do not overlap them. `tsc --noEmit && vite build` clean, bundle `index-DUyBvncW.js`.

### Round 3, second half — imported geometry never got round 1's triangle bound
Round 1 bounded procedural triangle edges to ≤1 m. The asset pipeline only ever *removes* triangles
(`weld` + meshoptimizer `simplify` + `EXT_meshopt_compression`), so no imported mesh was ever subject to
it. `tools/optimize-models.mjs` now has a `subdivide()` pass between `simplify` and `resample`, using
edge-based refinement: every over-length edge is split in *every* triangle that owns it, keyed by
quantised endpoint position, so there are no T-junctions and no cracks. Applied to the two door files,
which are the geometry the player presses their face against.

```
door.glb        2.6 -> 0.19 MB  93%   tris 590 -> 1126   split @1m
door_inner.glb  3.2 -> 0.32 MB  90%   tris 988 -> 1266
```

`tools/glb-edges.mjs`: 0 triangles over 1 m, longest 0.96 m and 0.99 m. Bounding boxes byte-identical
before and after (`126.783 x 221.846 x 30.006`, `396.429 x 793.366 x 84.731`), so no hand-tuned
`MODEL_PLACEMENTS` number moved; `glb-nodes.mjs` confirms node, mesh, attribute and material structure
unchanged.

One bug of my own, caught by measuring rather than by reasoning: **TANGENT.w is a handedness sign, not a
quantity.** Averaging +1 and −1 at a split gives 0, and a zero w is a zero bitangent, which kills normal
mapping on every triangle touching that vertex. `door.glb` has two edges that straddle a handedness flip
— `|w| < 0.5: 2, min |w| 0.0000`. Fixed by carrying the sign from one endpoint instead of blending it;
now `|w| < 0.5: 0, min |w| 1.0000`.

### Round 3 on device
Installed and walked. The user's verdict was "still not fixed", which is what sent round 4 and round 5
looking further — so round 3's risers are in and correct (the slot pixels are gone, measured above) but
they were not what the user was seeing. The two remaining spots after round 3 were both doorways:
"aur sab jagah ho gye solve bas ye 2 door ke paas bache hai".

### Round 4 — the upper flat's shell was undressed (fixed, measured)
Not a depth bug at all, and worth separating from the rest: some upper panels read as flat dark plaster
because the shell was drawn undressed there. `dressShell` now covers them.

Measured on the panel rectangle `--rect=1168,130,582,240`, headless Chrome on `dist/`: mean luma
**32.7 → 88.7**, and the share of pixels under 0.01 relative contrast **87.0% → 23.2%**. The floor
control rectangle moved ≤0.7 luma points, so the change is the panel and not an exposure shift.

### Round 5 — the eye gets inside a door leaf (fixed, measured)
The remaining two spots, and the one that matches the user's description exactly: a black shape that
changes outline as you turn. Same mechanism as round 1 — a triangle with a vertex at or behind the eye
plane has w→0, 1/w interpolation collapses, and its fragment depth lands metres away — but reached from
the other direction. Round 1's triangles were long enough to straddle the eye from across a room; these
are ordinary door slabs that the *eye walks into*. Ten of the twelve interior doors stand ajar in 0.9 m
openings, and the way through those doorways has always been *through* the leaf.

**The attempt that had to be abandoned, because the number is unarguable.** A collider on each ajar leaf
is the obvious fix and it cannot work here. The eye needs 0.10 m of clearance — the near plane, no more —
but a body needs 0.70 m of channel to get past anything solid (radius 0.35 m), and an ajar leaf in a
0.9 m opening does not leave that. `tools/_walk.js`, a flood fill over the real collider set on a
`(cell, floor-height)` graph, priced it: keep-outs on those twelve rows wall off **50.1 m² of the house
in 8 blobs, including the kitchen and the store entire at 21.2 m² each**. Sealing two rooms to stop a
flicker is not a fix.

**The fix that ships.** Stop *drawing* the leaf while the eye is inside it. A triangle that is never
submitted cannot straddle the near plane, and not drawing something costs no floor at all.
`ModelPlacement.leaf` changed meaning from a keep-out to a hide: `leafBoxes` still traces each leaf with
4 overlapping boxes, but the result is held on the `Placed` entry as `leafKeep` instead of being pushed
into `aabbs`, and the per-frame cull in `ModelProps.update` folds `insideAny(p.leafKeep, eye, LEAF_HIDE)`
into the `visible` it was already setting. Zero new per-frame work beyond 48 box tests, no new draw calls,
no geometry change. Only rows whose geometry is *all* leaf may use it — hiding a root that keeps its frame
would open a hole over the doorway — which is why the doc on `leaf` says so and why the two doors that
*swing* are excluded: opening one takes its leaf out of the walk path, so it can afford a real collider,
and it keeps its `trackLeaf` boxes.

`LEAF_HIDE = 0.2` was derived, not chosen. `tools/_hide.js` sweeps every collision-legal eye position
round all fourteen leaves, standing and crouched, on a 5 cm grid, and counts the positions that have a
leaf triangle inside the 0.10 m near plane *while the row is still drawn*:

```
threshold   0.10  0.12  0.15  0.18  0.20
positions     80    26     1     0     0
```

0.15 m leaves one, at the upper shrine door. 0.18 m is the first clean value; 0.20 m ships, 2 cm of
margin and deliberately not more, because every centimetre here is a centimetre earlier that a doorway
the player is walking through blinks. The two armed doors hold the eye off on their own: nearest approach
0.383 m and 0.400 m, 0 positions under 0.10 m.

Three axes, all measured:

```
eye clearance   80 -> 0 positions inside the near plane with the leaf drawn   (tools/_hide.js)
passability     reachable 29058 -> 29058 nodes, 290.6 -> 290.6 m2, lost 0.0 m2 in 0 blobs   (_walk.js)
the flicker     hit poses 13/12/10/2 -> 2/1/0/1, worst 929 -> 132 changed px   (_wedge2.js)
colliders       241 -> 193, exactly the 48 static leaf boxes removed
```

`_wedge2.js` exists because `tools/_wedge.js` forces every object visible before it sweeps and never runs
the cull, so under a cull-based fix it measures precisely the thing the fix leaves alone — the twelve
leaves are unchanged geometry and still wedge if you draw them from inside. `_wedge2.js` runs both passes
per stand: `forced`, the positive control that must still find the wedge, and `real`, the shipped cull.
Its own trap, found by reading source rather than guessing when the first run reported 28.4 m of eye
drift: `HouseScene.update` does not move the camera. `FPController.syncCamera` does, from the controller's
update, which the *loop* calls — so a probe must set `cam.position` itself.

**What is left, and why it is not the bug.** One pose still flips: the upper back door, 132 changed
pixels, repeatable to ±3 across runs at a fixed pose against a same-near control of 0. Its shape settles
it — the changed pixels occupy a bounding box of **1 × 141 px, fill 0.94**: a single-pixel-wide vertical
line, peak luma difference 21/255, and **0 pixels crossing the black threshold in either direction**. A
w→0 wedge is a solid black region that fills its box; this is one silhouette edge landing on the other
side of a pixel centre when the projection matrix moves by 0.1 mm, which is the instrument's own floor.
Nothing is within 0.30 m of the eye at that pose except the player's own hands at 0.099 m, which are
camera-parented and identical in both frames of the A/B. Every ground-floor door using the same
`door-inner.glb` — kitchen, store, bedroom, living, pooja — and the hall control all read **0**.

So the wedge is gone; what survives is a 1 px seam with no black transition, and it is not worth
geometry. Round 1's version of this was 494 solidly black flipped pixels.

Probes written for this round, to be deleted: `_hide.js`, `_walk.js`, `_wedge2.js`, `_blame.js`,
`_obj6.js`, `_zfight.js`, `_repeat.js`, `_ground.js`. Two of them were wrong in instructive ways and the
notes are in their docstrings: `_blame.js` descends into a single culprit, which is the wrong shape of
answer for a z-fight where hiding *either* partner stops it, and it blamed the player's hands; `_wedge.js`
cannot see a cull-based fix at all.

`tsc --noEmit` clean, `vite build` clean.

### Round 5 not verified on device
`adb devices` has been empty all session, so the APK has not been rebuilt or installed. One lap of the
upper storey through the flat's back door, plus a walk through the kitchen and store doorways to confirm
the hide is not visible as a blink, is what closes it.

### Round 6 — the brown band was two things stacked (fixed, measured)
The user stopped asking for a diagnosis and named the symptom: *"vo jo brown color ki patti hai, use hi
hata dete hai"*. There were two objects making it, one behind the other, and removing the first exposed
the second.

**6a — the three ajar upper-wing leaves.** `_patti2.js` rings each of `door-up-back|child|shrine` with
stands at radius 0.5/0.8/1.2/1.8 m x 12 angles x eye 4.10/4.04 x pitch -25/-40/-58, aims at the leaf's
measured world centre, and diffs the lower third of the frame against `root.visible = false` with the
real per-frame cull left in charge. Every one of the three owns **34-42%** of that band as a single
region — fill 0.68-0.87 of its own bounding box, mean rgb ~120,68,45 at r/b 2.3-3.2 — and `vis y` at
every such stand, because round 5's hide traces the slab's own diagonal and its four windows span
z -1.851..-1.029 while those stands are at z -0.7..-1.3, half a metre clear on every axis. A
1.07 x 2.15 m slab standing 57 degrees across a 1.4 m opening, seen from half a metre with the head
down, *is* a band; no keep-out radius short of a room can reach it. The three rows are out of
`ModelProps.ts`, with the numbers and the restore recipe in the comment that replaces them.
`door-inner.glb` is pure leaf, so `makeCasing()` still frames all three openings; the leaves carried no
collider and no interaction, and `_walk.js` reports `lost 0.0 m2`.

**6b — the flat's floor stood 6 cm below its own walls.** With the leaf gone, `_band.js` re-run at the
same pose blamed 5045 of 10944 rect pixels on `upper-patch-floor-0`, and the reason was its height.
`UPPER_PATCH.floorY` was `UP_Y - 0.06` = **2.340**, chosen on the premise that the imported flat's slab
under those rects sat at 2.35 and a level patch would z-fight it. Both halves were wrong:

- `_floor2.js` (exact downward rays, barycentric on the xz projection, since `Raycaster` cannot be
  imported into a page-evaluated expression) finds **this patch topmost** over most of the first room —
  the model brings nothing there, which is why the rect exists — and where the model does reach in, its
  boards read **2.371..2.397**, not 2.35. So 2.34 z-fought nothing; it was simply 6 cm low.
- Everything else on the storey is keyed to `UP_Y` = 2.400: `up-store-floor`, `up-child-floor`,
  `up-shrine-floor` all at 2.400, and `upper-walls` (2.400..5.290) and `upper-skirt` (2.400..2.540)
  whose geometry *begins* there.
- `_gap.js` fires horizontal rays out of the room: at 2.355, 2.375 and 2.395 they hit **nothing at all**
  and fly out of the house; at 2.425 they stop on the skirting 1.8-4.0 m away. Below 2.400 the walls did
  not exist. The room had a 6 cm see-through slot round its entire perimeter and a 6 cm drop off every
  threshold — hard-edged, and showing whatever lay beyond as the angle changed.

The fix is `floorY: UP_Y - 0.004` — 4 mm under the storey rather than 60. Not level with it, because
`_gap.js` section A lists what already occupies y 2.400 inside those rects: the back doorway's casing
threshold, **0.59 m2** of upward-facing sill at x 15.80..17.20, z -1.20..-0.78, plus 1.67 m2 of
`upper-walls` and 1.92 m2 of `upper-skirt` base caps from the interior partitions. Level would make the
patch exactly coplanar with all of it, which is the defect rounds 1-3 chased. 4 mm is roughly 130x the
depth buffer's resolution at this range, leaves the threshold reading correctly proud of the boards,
stays over `RISER_MIN` so `findRisers` still seals the z = -1.93 doorway line (4 mm now, not 60), and
puts the patch *above* the model's 2.371..2.397 boards instead of below them — which is what makes the
surface read as one floor instead of a patchwork.

After:

- `_floor2.js` reads **2.396 at all 40 grid points inside the rects**, against 2.400 in the rear wing.
  Before, the same grid alternated between `upper-patch-floor-0 @ 2.340` and `Object_10/15/24/29 @
  2.371..2.377` depending on where the model reached.
- `.thresh/p1c.png` at the reproduction pose (16.5, 4.04, -1.10) yaw 0 pitch -58: the boards now run to
  the bottom edge of the frame. `p1b.png` had the leaf's band gone but a grey wall-base strip at
  x 0..390 and a dark brown one at x 390..905, both with a hard top edge — the 6 cm slot and the 6 cm
  drop. Both are gone.
- `.thresh/p3c.png` and `p4c.png`, the child and shrine doorways from inside the store: framed opening,
  sill joined to both jambs, continuous boards beyond. Nothing detached.
- `_walk.js`: `reachable 290.6 -> 290.6 m2, lost 0.0 m2`, `shut out 0.0 m2`. Raising a collision floor
  5.6 cm costs nothing against a 0.35 m step-up.

`_band.js` still names `upper-patch-floor-0` for that rect, and that is now the correct answer rather
than a finding: at pitch -58 the bottom of the frame *is* floor. Ownership was the wrong instrument for
the second half of this and the picture was the right one. Note also that hue cannot discriminate on this
storey at all — the floor wears `floor-wood.webp` and reads r/b 2.27-2.36 by itself, so the "still brown,
therefore still the leaf" reading that r/b invited after 6a was wrong.

New probes, to be deleted with the rest: `_patti2.js`, `_verify.js`, `_floor.js`, `_floor2.js`, `_gap.js`,
and `_pose.js` which was written and abandoned. `_floor.js` is kept in the delete list rather than the
keep list for a reason worth recording: it tests bounding-box containment, and on this storey that cannot
tell a floor from a trim run whose box happens to span the room — it reported `Object_10` over the whole
flat. `_floor2.js` replaced it with real intersection.

`tsc --noEmit` clean, `vite build` clean.

### Round 7 — the sill's own thickness (fixed, measured)
Same doorway, same words: *"usme abhi bhi view glitch hai like angle change hone pe uska structure bhi
change ho jata hai, ek kaam karo brwon patti ko hi hata do"*. Round 6 removed two objects from in front
of the brown band and never touched the band itself. Round 6's own text names it and waves it through —
*"the back doorway's casing threshold, **0.59 m2** of upward-facing sill at x 15.80..17.20, z -1.20..-0.78"*
— on the premise that 4 mm of patch-floor clearance "leaves the threshold reading correctly proud of the
boards". It was never proud. It was in the plane.

`makeCasing()` draws the sill as a box **0.1 m tall centred at `y0 + 0.05`**, so its top face is at
`y0 + 0.1`. `HouseScene` passed `y0 = UP_Y - 0.1` under a comment claiming that "drops the sill flush into
the floor slab". Subtracting the sill's height puts its *top* face exactly where the floor is — an
off-by-one on the object's own thickness, and the whole defect. `_edge7.js`, micron precision, GLBs loaded,
player warped to (15.2, 4.10, 1.3) so `minEyeY: 1.9` stops culling the storey:

```
UP_CHILD  x18.60 z-4.00 : up-store-floor@2.40000, up-child-floor@2.40000, fixture:batch:0@2.40000  gaps 0um, 0um
UP_SHRINE x16.50 z-6.40 : up-store-floor@2.40000, up-shrine-floor@2.40000, fixture:batch:0@2.40000  gaps 0um, 0um
UP_BACK   x16.50 z-0.99 : fixture:batch:0@2.40000, upper-patch-floor-0@2.39600                     gap 4000um
```

Three coincident upward planes, 0 um and 0 um. No depth buffer can order coincident planes; which one
draws is decided by rasterisation round-off and re-decided every time the camera moves. That is the
user's sentence — *structure bhi change ho jata hai* — stated as a measurement rather than a hypothesis.

`UPPER_INNER`'s sill failed the other way and is the one actually in the screenshots. Its `y0` was
`UPPER_INNER.bottom - 0.1` = 2.320, top face **2.420**: a 2 cm brown lip standing on the boards across the
flat's inner doorway. `door-inner.glb` there is pure leaf and `makeCasing()` is its frame, which is why the
photograph shows dark wooden jambs left and right of a rust-red door — the strip lying across that
threshold is the frame's fourth side.

Fix: `sill?: boolean` on `CasingSpec` (defaulting to on, so the ground floor is untouched), and
`sill: false` with `y0: UP_Y` on all four upper casings — `UPPER_INNER`, `UP_BACK_DOOR`, `UP_CHILD_DOOR`,
`UP_SHRINE_DOOR`. A doorway that needs no step does not need a threshold board.

**7b — the threshold sandwich at the front door.** Independent of the sills, and the second thing an
angle change could reshuffle. Along the walk-in line z = 1.3 the topmost surface changed three times
inside 45 cm of x: the imported stair's top tread crowning at **2.4040**, the `upshaft-walls` east run
capped at **2.4000**, and `upper-patch-floor-0` at **2.3960**. An 11 mm sandwich, with a *sloped* tread
crossing both flat planes, so the crossing point moves with the camera. Two edits:

- `HouseRooms.ts` — the shaft's east run ended `y1: UP_Y`, which capped it with an upward face at exactly
  2.4000 across the whole of `UPPER_DOOR`, 4 mm above the flat's boards and wearing world-anchored UVs
  stretched along a 12 cm strip (the pale smeared band in the first screenshot). Now
  `y1: UPPER_PATCH.floorY - 0.008` = 2.388. `- 0.02` was tried first and tightened to `- 0.008`: that
  run's top face is what the shaft sees looking up at the landing, so every millimetre below the boards
  is a millimetre of visible slot.
- `ModelProps.ts` — `stair-wood.glb` from `y: -0.058` to `y: -0.068`, crown 2.4040 → **2.3940**, under
  both floors instead of 4 mm proud of one and 8 mm proud of the other. Collision does not move with it:
  `upStairFloors()` is analytic, 8 x 0.3 off y 0, top walkable y = 2.400.

After, live, 425 visible meshes:

```
13.90-14.25  wood_stairs_Base_0  2.38291 -> 2.39415   single surface, monotonic
14.30        tread 2.39415 | Object_2 2.35456         49 mm apart
14.35        tread 2.39415 | upshaft-walls 2.38800    cap now 6 mm BELOW the tread
14.40-14.50  upper-patch-floor-0 2.39600 | upshaft-walls 2.38800
14.55-14.60  upper-patch-floor-0 2.39600              single surface
```

`fixture:batch:0` is absent from all four upper doorway stacks. Minimum separation between upward
surfaces at the threshold is **6 mm**, against 0 um and 4 mm before.

**Withdrawn: the hole at (14.2, 1.3).** `_thresh7.js` reported `NOTHING` there and I had it written up as
a second defect. `_gap7.js`, stepping 5 cm instead of 20, finds `wood_stairs_Base_0 @ 2.4031`, and
`_edge7.js` finds continuous surface from x 13.90 to 14.45 at every z from 1.60 to 2.15. Cause of the
false negative: `_thresh7.js` keeps only triangles whose three vertices agree in y within 4 mm, which
rejects every sloped imported tread. The `NONE` cells at x 13.70-13.85 are the open stairwell, by design.

**Two 0 um pairs that are not defects.** `up-store-floor` vs `up-child-floor` at x 18.60 and
`up-store-floor` vs `up-shrine-floor` at z -6.40 both read 0 um, because sampling *on* a shared boundary
hits both quads by definition. `_seam7.js` steps off the line: (18.50, -4) and (18.55, -4) return
`up-store-floor` alone, (18.60, -4) returns NOTHING, (18.65, -4) and (18.70, -4) return `up-child-floor`
alone. They abut edge-to-edge. Neighbouring room slabs are supposed to.

**Why `tools/audit-coplanar.ts` said OK through all of this.** It printed "38 flat surfaces … OK — 0
coplanar overlap(s), all separated" while three upward faces sat at 2.40000 with nothing between them. Two
blind spots, both structural:

1. `if (box.max.y - box.min.y > FLAT) return;` with `FLAT = 0.03` — it only considers meshes flatter than
   3 cm, so no box's *top* face is ever tested, and `mergeStaticChildren` turns each door casing into one
   ~2.5 m mesh. The offending surface was inside a mesh the filter discards.
2. It calls `buildHouse(1)` under `tools/dom-shim.ts`, where no GLTF loader ever fires. Every imported
   mesh — the stair the player climbs, the shell they walk through — is simply absent.

`tools/coplanar-live.js` replaces it against the running scene: real world-space triangles of every
visible mesh, grouped by `name|y|facing`, and for each same-facing pair within 20 mm it measures **real**
overlap by rasterising both triangle sets' cell centres onto a 2 cm grid. Sampling centres rather than
boxes is the point — two quads sharing an edge claim disjoint cells, where a bbox test calls a shared
edge a 27 m2 collision. That artefact was live: `_thresh7.js` flagged `Object_10 @2.3707 up 61.28m2`
against `Object_15 @2.3707 up 2.25m2` as "27.26 m2 overlap"; the triangle-exact test puts their real
overlap under 0.02 m2 and the pair does not appear at all.

House-wide it now reports 323 pairs, but the list is noise-dominated: nearly all are **downward**-facing
base caps at y 0 and y 2.4, every wall run's underside against its skirting's underside, buried and
unseeable. The only upward 0 um remainders anywhere are `closet-old.glb:shadow` vs `bed-horror.glb:shadow`
@0.0120 (0.26 m2, two overlapping shadow decals in the ground-floor bedroom) and skirting tops @0.1400 and
@2.5400 at 0.1 m2 each, where two rooms' skirtings meet in a doorway corner. None is a band at a doorway.
Worth splitting the report so upward pairs lead and buried caps collapse to a count.

**Pictures**, `.r7/`, door leaves swung by hand (`upper-door.pivot`, `inner-door.pivot`) because a shut
leaf hides the threshold and the synthetic `KeyE` does not reach the interaction layer:

- `e-inner-inside`, `f-inner-graze`, `g-inner-side`, `k-inner-far` — `UPPER_INNER` from four angles
  including a 15-degree graze, the worst case for a depth tie. Boards run through the opening; no strip.
  `k-inner-far` is the reproduction of the second screenshot's framing.
- `h-child`, `i-shrine`, `j-back` — the three wing doorways from inside the store. Framed opening,
  continuous boards, no band at the seam the earlier probe called 0 um.
- `a-inside-down`, `b-inside-graze`, `d-from-stair` — the front threshold, in and out.

`tsc --noEmit` clean, `vite build` clean (`dist/assets/index-CnrdWtX6.js`, 782.43 kB, 59 modules).

**Probes.** `%TEMP%\_thresh7.js` (coarse, and the source of the withdrawn hole), `_gap7.js`, `_edge7.js`,
`_seam7.js`. Two headless instruments were written and **never run** — the workflow that was to run them
lost all six agents to `503 all upstream accounts are inactive` — so `tools/_faces7.ts` (triangle-exact
faces of the procedural house, clipping triangle against triangle) and `tools/_imported7.ts` (reproduces
ModelProps' `fitToHeight`/`fitToBox` arithmetic and measures the GLBs' real vertices) are unverified code
kept for the next round, not results. `tools/audit-coplanar.ts` now states its own blind spots and can no
longer print a bare "OK": it reports how many meshes the `FLAT` filter discarded, and points at
`coplanar-live.js`. Note `tools/_coplanar-live.js` from round 3 already had the right scope and the wrong
test — world bounding boxes — which is what the new file's header records.

### Round 7 not verified on device
`adb devices` is empty — no phone connected, so `tools/dev-build.ps1` cannot run and nothing here has been
seen on an Adreno. The two attached screenshots are stamped 00:49 and the installed APK was built at
06:07, so they predate even round 6's fix; they cannot show round 7's. Everything above is measured in the
live WebView via CDP at 425 visible meshes.

## 2026-09-06 — the six empty rooms get their furniture

Six GLBs went into the six rooms that were built as shells and never dressed: the rear wing's kitchen,
prayer room and store, and the upper wing's attic store, child's room and shrine. All six were already
optimized into `public/assets/models/`, so this round is placement only, and every number in the new
`MODEL_PLACEMENTS` rows comes off `tools/_measure.js` — world-space bbox per file and per mesh, the same
`getWorldMatrix()` walk `subdivide()` uses — rather than off the eye.

**Moved, not copied, where the house needed it distributed.** All four of the house's four hiding places
were in the ground-floor bedroom, within six metres of spawn. `closet-old.glb`, `bed-horror.glb` and
`bed-old.glb` therefore *left* that room — store, shrine and child's room respectively — and the bedroom
keeps `bed.glb`, which is itself an under-bed spot. None of the three carries an `id`: `Hiding.ts` matches
`BED_NAMES`/`WARDROBE_NAMES` against `p.id ?? p.name`, so an id would silently stop them being hiding
places at all. Reach checked per spot: closet 0.66 m approach against a reach of 1.535, bed-old 0.70
against 1.763, bed-horror 0.88 against 2.007.

`table.glb` and `painting-sus.glb` are copies instead (`clone: true`), because the living room's table row
owns the `living.ledger` clue and is the `on` target of `plate-ceramic.glb`, and the hallway keeps its
canvas. Sharing a cached root means sharing *materials*, so neither copy may carry `albedo` — `brighten()`
dedups per material and would double-apply to the original. For the painting that is moot anyway: the
file's `baseColorFactor` is 0,0,0 with no base texture, which is the whole reason it uses `lanternLit`
(emissiveMap → map), and `lanternLight()` is idempotent by construction — `if (!lam.emissiveMap || lam.map)
continue;` — so whichever of the two rows is placed first converts the shared material and the other's call
does nothing.

**`albedo: 5.0` on `gothic-chair.glb`, from measurement.** `tools/_mapmean.js` (per-material base-colour
factor × base-map pixel mean, sRGB→linear, plus a luma histogram) puts the chair's maps at means
28.4/50.0/29.0 against the next-darkest prop in the house at 41–68, which took 2.2. Its linear products are
0.0119/0.0215/0.0123 where `bed.glb` needs no lift at all at 0.221. At 5.0 the body lands at 0.061 and the
frame at 0.108, just under the plaster facing's 0.137 after its own 1.6; p95 is 40/98/40, so after the
multiply the frame tops out at 0.43 and the body at 0.11, and nothing clips.

The chair also faces the blank north wall at yaw 0 — cushion toward +z, carved back toward the door — so
what the player meets on entering the prayer room is the back of a chair someone left turned away.

### Three bugs found on the way, two of them in already-shipped rows

`painting-sus.glb` in the hallway hung *inside its own wall*. `HALLWAY_WALL_PANELS` puts the south-east
facing at z 0.11 by `PANEL_DEPTH` 0.1, so it occupies 0.06 .. 0.16 — 6 cm proud of a plaster inner face at
0.10 — and the canvas at z 0.12, 0.0376 thick once fitted, spanned 0.101 .. 0.139. Entirely buried. The
project's own guard already knew: `npx tsx tools/audit-facings.ts hallway-wall-` reports it as "0.010 m off
the panel centre", but the tool defaults to a prefix of `upper-wall-` and nobody had re-run it for this run.

The fix went to z 0.18 first, which clears the panel by 1.2 mm and *still* trips the audit, because the
audit flags anything within 4 cm in front of a facing on the reasoning that a prop that close is one tweak
to `PANEL_FACE_LIFT` or to a fit away from being buried again. A canvas is thin enough for that band to be a
false positive — but silencing a guard costs more than moving a painting 3 cm, and the tool could not
compute the exemption anyway, since it has `height` and not fitted depth. Both canvases therefore sit 3.1 cm
off their facings: hallway z 0.21, attic store x 14.61.

The third bug was the new row's own, and only the phone found it: **an omitted `yaw` on a `clone` row does
not mean zero.** Both apply steps read `if (p.yaw !== undefined) root.rotation.y = p.yaw`, so a row without
one keeps whatever the cached Group is already carrying — and the hallway painting is *not* a clone, so it
turned the shared original by -pi/2 in place before the attic copy was taken. Measured in the live WebView,
`painting-sus-store` came out 0.500 wide on x by 0.038 thick on z, spanning x 14.36 .. 14.86: a fin driven
through the west wall rather than a painting hung on it, and its own facing audit still said `none`, because
the audit reads declared row centres and not rendered boxes. The row now states `yaw: 0` explicitly.

Nothing else in the file is exposed, and the shape of the hazard is narrow enough to say why: a clone rotates
only its own copy, so the original can only have been turned by a row for the same file with no `clone` that
is placed earlier in the array. `wall-damaged.glb` has no un-cloned row at all, `table.glb`'s carries no yaw,
and both door files' un-cloned rows sit *after* their copies and set yaw on every row regardless. The
`clone` doc comment now records this.

Stale comments in three files described the world as it was before the move. `CatRoutes.ts:54` still had
`bed-horror` pinching the bedroom's north rail to 0.59 m; `HouseScene.ts:332` and `HouseProps.ts:245` both
put the wardrobe pocket at (-2.0, 9.75). All three rewritten. The cat's rail nodes are deliberately *not*
moved: the bed that pinched them is gone, so that gap only widened, and widening a gap cannot break a route
`checkRoutes()` already accepts — where moving the rail back to its pre-furniture -3.6 would be a second set
of numbers nobody has swept.

### Verified

`npx tsc --noEmit` clean. `npx vite build` clean — `dist/assets/index-B-wfg4iy.js`, 782.78 kB, 59 modules.

`tools/audit-facings.ts` reports `none` for all ten prefixes: `kitchen-`, `pooja-`, `store-`, `up-store-`,
`up-child-`, `up-shrine-`, `hallway-`, `living-`, `bedroom-` and `upper-wall-`.

`tools/reach.ts`: 25 anchors, 0 unreachable, 0 tight. `tools/connect.ts`: 58260 of 58602 standable cells
reached from spawn behind 100 colliders, 0 sealed rooms, and each of the six newly furnished rooms at 100% —
kitchen, pooja and store 2126 cells each, up-store 1390, up-child 1799, up-shrine 3402. (The landing,
`upper`, sits at 96% as it did before this round; the tool calls it ok.) `tools/audit-tones.ts`: every
storey one tone. Both throwaways, `tools/_measure.js` and `tools/_mapmean.js`, deleted.

### Not verified on device

`adb devices` was not run this round, so nothing here has been seen on an Adreno. The upper wing's three
rows carry `minEyeY: 1.9` like the facings around them, so a ground-floor eye never submits them — but that
is read off the row flag, not measured in a live WebView.

## 2026-09-06 — the held hand becomes a fist, by measurement rather than by eye

The right hand held the lantern as a black sleeve with four pale blobs on the end of it, against a reference
photo of a real closed fist. The ask was the finger curl. What it turned into was mostly a lesson about
scoring: five of the six things this round measured were measured wrongly first, and each wrong one produced
a confident, plausible, useless answer.

The shipped pose, put through the player's own camera rather than a convenience view, scored 0.121 on
broadside — one digit 88 per cent end on, which is the blob — and −4.7 mm on depth, meaning the middle
phalanges finished *behind* the knuckles so the back of the glove was drawn over them. Nearest-segment
clearance ran 2.3 mm between index and middle, on centre lines about 15 mm thick: those two were modelled
through each other. It now scores 0.960 and +14.9 mm, with the fingertips 8.6 mm deeper than the joints they
fold from and clearances of 13.7, 12.3 and 11.0 mm. `src/player/HeldLantern.ts` carries all forty-five finger
angles plus a three-axis `PALM_TURN` where it used to carry fifteen and a single roll.

The fan the reference does not have came from the rig, not from the pose: the knuckles' authored twist runs
−1.6, −30.6, −28.5 and −50.4 degrees from index to pinky, so each digit's 85 degrees of curl bends in a plane
up to 50 degrees from its neighbour's. A uniform delta cannot touch that — ±12 degrees on all four moved the
tightest gap by 1.8 mm — because what matters is the difference between digits. Solved instead by aligning
each digit's curl axis to the index's, measured as the angle between world local x on the child joints,
because the rig is authored and its axes cannot be assumed. Residuals 1.4 to 13 degrees.

### The five wrong objectives, since each cost a round trip

Gap in millimetres, as the thing to minimise, drove all three digits to the search limit for nothing. Centre
line to centre line cannot see a fan at all: it is dominated by the knuckle end, where even splayed fingers
are one pitch apart. Parallelism is the objective; distance is a constraint.

Clearance as a hard floor made the pinky infeasible. Aligning the curl planes swings its 50 degrees of
authored twist into the ring finger, and once the ring is placed there is no legal angle left — three runs
returned "kept" at 3.6 mm, about 8 mm of interpenetration. Priced rather than forbidden, and scored against
both neighbours over two passes, it settles at 11.0 mm.

Clearance as a floor *alone* then settled the four exactly parallel at one knuckle pitch: legal, and wrong,
because parallel lines never converge and the render showed daylight down every seam. Priced for being too
far apart as well as too close, they converge 9 to 10 degrees as a real fist does.

Broadside measured from joint 2 to joint 4 penalised the tuck it was supposed to reward — folding the
fingertip away shortens and turns that chord, so a properly closed fist scored *worse* than one presenting
its nails to the camera. Measured on joint 2 to joint 3, the bare middle phalanx, and taken as the worst of
the four rather than the mean: an average hides one finger aimed down the barrel, which is the artefact.

Tuck and depth as bonuses on the wrist score were affordable. The winning wrist gave the fingertip fold away
entirely, because a hundredth of broadside outbid a flat +0.3. As filters, 411 of 1755 orientations pass both,
and the ranking over those is honest.

Sixth, for completeness: the thumb's reach, maximised, produced a thumb standing 50 mm proud of the fist and
pointing at the camera. As targets — 13.8 mm off the nearest index segment, 8.6 mm nearer the eye, its last
segment crossing the fingers' direction rather than lying along it — it wraps.

Two smaller corrections. The note in `HeldLantern.ts` claiming −45 on a tip joint folds the distal phalanx
back through the middle one, and that this was what put nails in frame, had it backwards: the tips were
folded too *little*, at −16, so each pale segment read as a middle and a distal phalanx in one long finger
with a nail on the end. Depth turns over at about −50 and is clear by −70. And `tools/_live.mjs`'s documented
pose syntax was wrong — `{"wrist":[null,null,-20]}` sets nothing, because a one-joint chain still takes a
list of one triple.

### Verified

`npx tsc --noEmit` clean. `npx vite build` clean — `dist/assets/index-B_jdeNq6.js`, 783.04 kB, 59 modules.
`npx cap sync android` clean, `gradlew assembleDebug` BUILD SUCCESSFUL.

The pose was rendered through the running build's own camera at 2.14× — a `setViewOffset` crop of the very
same frustum, not a scaled hand and not a narrowed fov, both of which lie about a viewmodel parented to the
camera. Four bare middle phalanges read side on, stacked, curled and nearly touching, with the glove back
behind them and the forearm receding to the right. Against the reference two things are still visibly short:
the seams between digits are dark rather than closed, and the thumb tip and the pinky each still catch a
highlight on the nail.

### Not verified on device

The APK is built but not installed: this Redmi (23076PC4BI) refuses `adb install` with
`INSTALL_FAILED_USER_RESTRICTED`, and `pm install` from both `/sdcard/Download` and `/data/local/tmp` fails
the same way — MIUI's "Install via USB" is off. A copy is pushed to `/sdcard/Download/daayan-debug.apk` for
the file-manager route. So the numbers above were measured on the device's own Adreno through a live pose
override, and the *installed* build still writes the old fist until that APK is tapped.

The throwaways for this round are still on disk rather than deleted: `tools/_pose.js` is the solver that
produced the shipped numbers, `tools/_live.mjs` and `tools/_fwd.sh` the render harness, and `tools/_sweep.js`,
`tools/_gap.js`, `tools/_fing.js` and `tools/_align.js` the four superseded attempts, each of which says so in
its own header.

