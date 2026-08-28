# Daayan's House — Implementation Plan (v3 · Phase 3 spec integrated · awaiting Phase 4 AI prompt & Phase 5 cutscenes)

**Status:** Planning only. No game code has been written. v3 integrates the Environment & Puzzle Design Brief (PDF) into a concrete Phase 3 sub-plan. On approval, work starts at Phase 0 and stops at the feasibility gate for your explicit go/no-go before any house-building begins. Phase 4 (Daayan AI FSM) and Phase 5 (cutscenes) prompts are inbound later from the user.

---

## 1. Decision Summary

| Decision | Choice | One-line rationale |
|---|---|---|
| Perspective | First-person | No player-body model needed, strongest horror tension, cheapest to render, proven mobile control scheme |
| Renderer | Three.js (pinned latest stable) | Best documentation/example coverage → most reliable agent-written code; explicit low-level control for mobile perf tuning |
| Language | TypeScript, strict mode | Type errors = bugs caught before runtime; critical for agent-written code at scale |
| Bundler / dev server | Vite | Instant HMR during web dev; one config serves web dev and the Capacitor build |
| Android packaging | Capacitor 6 (downgraded from 7 due to JDK 17 vs 21 mismatch on user system) | Same API surface, JDK 17 friendly, modern Gradle chain, WebView remote debugging via chrome://inspect |
| Physics engine | None — custom controller | A house interior is boxes; a custom capsule/AABB controller is deterministic, ~0.1 ms, and avoids a 1–2 MB WASM dependency for zero gameplay benefit |
| Lighting | Baked AO + emissive props + hemisphere light + ≤1 dynamic light (low tier) | Real-time multi-light + shadow maps are the #1 mobile FPS killer |
| Textures | Size-capped WebP/PNG (KTX2/Basis as stretch goal) | Texture memory bandwidth is the #2 mobile killer |
| Model compression | meshopt (Draco fallback) via gltf-transform CLI | Fast decode on weak CPUs, small APK |
| Audio | WebAudio, OGG, ≤8 concurrent voices | Adequate on Android WebView, cheap |
| Target perf | 30–60 FPS steady on a **4 GB RAM** low-end device (45+ on mid-tier) | 60 FPS is not a promise on cheap hardware; a stable 30+ beats a stuttering 45 |
| Orientation | Landscape-only, fullscreen immersive | Standard for FPS touch controls |
| UI language | **English only** (per user) | No localization framework needed for v1 |
| Controls | **Virtual joystick** (left = move, right-side drag = look) + interact button + run toggle | Per user |
| Flashlight | **Player has a lantern** that the player always has; world ambient is darkness-tuned (lantern is the only dynamic light on low tier) | Per user |
| Death model | **Instant checkpoint respawn, 3 chances per checkpoint**, then full restart from initial spawn (per user) | Per user |
| Save model | **Auto checkpoints** only — no manual save (per user) | Per user |
| Lives/chances | 3 lives per checkpoint, then full restart | Per user |
| Inventory | 3 gate keys + lantern (utility) + puzzle items (Phase 3 spec) | — |
| Saves | Checkpoints via localStorage | Works in WebView, zero backend |

---

## 2. Hard Constraint: Low-End Android Performance

You stated this twice, so it is treated as a contract, not a preference. It is enforced in three ways: (a) a numeric budget table, (b) an automated quality-tier system, (c) an on-device pass/fail gate in Phase 0 and a budget re-check at every phase exit.

### 2.1 Target device definition ("low-end")
**4 GB RAM, Android 8.0+, Adreno 505/506 or Mali-G31 class GPU, 720p display, auto-updated Android System WebView.** Target FPS band: **30–60 FPS steady** on this device. Mid-tier hardware (4+ GB, modern Adreno 6xx / Mali-G57+) targets 60 FPS steady; high-tier (flagship GPUs) targets 120 FPS (capped to 60 unless a high-refresh setting is exposed).

### 2.2 Budgets (per frame, enforced per phase)

| Metric | Low tier | Mid tier | High tier |
|---|---|---|---|
| Frame time | ≤ 33 ms (30 FPS) | ≤ 22 ms | ≤ 16.6 ms |
| Draw calls | ≤ 60 | ≤ 90 | ≤ 120 |
| Visible triangles | ≤ 50 k | ≤ 80 k | ≤ 120 k |
| Real-time lights | 1 (player lantern) | ≤ 2 | ≤ 3 |
| Real-time shadows | off (blob shadows) | off | 1 light, 1024² map |
| Skinned meshes on screen | 1 (Daayan only) | 1 | 1 |
| Texture size cap | 512² | 1024² | 1024² |
| Internal resolution scale | 0.6–1.0× | 0.85–1.25× | 1.0–1.5× of DPR |

**Global caps:** APK < 150 MB (target < 100 MB) · cold start < 8 s on target device · JS heap < 300 MB · gameplay+AI logic ≤ 8 ms/frame.

### 2.3 Quality tiers & dynamic resolution
`QualityManager` picks the initial tier from a heuristic (`navigator.hardwareConcurrency`, `navigator.deviceMemory`, GPU renderer string, screen size), with a user override in Settings. The heuristic treats 4 GB RAM devices as low-tier by default and steps up only with strong evidence (8+ cores + Adreno 6xx+ / Mali-G77+).

**Dynamic resolution scaler (all tiers):** tracks an EMA of frame time; sustained > 34 ms → step render scale down 10% (floor 0.6×); sustained < 22 ms → step back up. This is the single biggest mobile perf lever and it protects the 30 FPS promise automatically.

**30 / 60 FPS cap in Settings** for battery/thermal comfort (capped to 60 on mid/high tier to avoid wasting battery on hardware that can't sustain it).

### 2.4 Core techniques (used from Phase 0/1 onward, not bolted on later)
- **Static geometry merging** — walls/floors/ceilings merged per room-cluster per material (`BufferGeometryUtils`), keeping draw calls in double digits.
- **Lighting strategy** — hemisphere ambient + baked AO (vertex colors / lightmap on the static shell) + emissive materials for candles, lamps, glowing windows (free light sources) + one dynamic lantern light on low tier. Horror darkness is simultaneously the aesthetic and the perf optimization (fog + darkness hides detail cheaply).
- **No shadow maps on low tier** — blob shadows (dark transparent discs) under Daayan and dynamic props.
- **Cheap materials** — `MeshLambertMaterial` / `MeshPhongMaterial` for most surfaces; normal maps only on mid/high tiers. (Your Section 3 "well-textured surfaces" rule still holds fully — diffuse + normal + AO textures are used; the shading model is tiered for perf.)
- **Zero per-frame allocations in the hot loop** (pooled Vector3 temporaries) — GC pauses are real stutters on cheap devices.
- **Throttled logic ticks** — AI perception/pathfinding at 5–10 Hz, interaction raycasts ~10 Hz, UI event-driven. Nothing non-visual runs per-frame.
- **Fixed-timestep simulation** (accumulator, delta clamped ≤ 0.1 s) so collision/controls stay stable at any framerate.
- **Texture discipline** — sizes capped per tier; KTX2/Basis compression as a stretch goal.
- **meshopt-compressed GLBs** for small APK and fast decode.
- **Audio budget** — predecoded buffers, ≤ 8 voices, `AudioContext` unlocked on first touch (mobile autoplay policy).
- **Dispose discipline** — every asset handle is tracked and explicitly disposed on teardown; verified with Chrome memory profiler (leaks across scene reloads are a classic agent-codebase bug).
- **Visibility by design** — dense corridors, fog, and darkness naturally limit the rendered set; room-level visibility groups available if profiling demands.

### 2.5 Where performance is validated
- **Phase 0 gate (on a real low-end device)** — see Section 4. This is the go/no-go for the whole stack.
- **Every phase exit** includes an on-device budget re-check via the debug overlay before the next phase starts.

---

## 3. Tech Stack — Confirmation & Justification

### 3.1 Three.js (chosen) vs Babylon.js
Both are code-first, glTF-native, and browser-debuggable — your non-negotiables. I choose Three.js:
- **Documentation & example depth** — vastly more tutorials, answers, and reference. For agent-written code this directly translates to fewer hallucinated APIs and faster, more reliable debugging. **This is the deciding factor.**
- **Size** — smaller core + clean tree-shaking → faster WebView boot on weak devices.
- **Explicitness** — lower-level control. We control every light, material, and draw call, which is exactly what low-end tuning requires. Babylon's auto `SceneOptimizer` mostly hides decisions we'd rather make deliberately.
- **First-class glTF** — `GLTFLoader`, `AnimationMixer` (handles the animated Daayan model), meshopt/Draco/KTX2 support — everything the asset pipeline needs.
- **Honest note:** both libraries render through the same WebGL, so the raw performance ceiling is similar. The choice is about code reliability and control, not raw speed. We rebuild Babylon's quality auto-tuner explicitly as `QualityManager` — ~200 lines, tailored to our exact budget table, fully testable.

### 3.2 TypeScript (strict) + Vite
`strict: true`, `noUncheckedIndexedAccess`, no implicit any; lint rules block `any` and floating promises. Type errors are treated as real bugs, fixed immediately. Vite gives instant reload during web development; the production build is minified and served by Capacitor unchanged. Dev loop is web-first (desktop Chrome + device toolbar for fast iteration), with device builds only when on-device validation is needed.

### 3.3 Capacitor (not Cordova)
**v6 used (downgraded from v7 because user system has JDK 17, not 21).** Actively maintained, modern Android toolchain, simple plugins: screen-orientation lock (landscape), splash screen, keep-awake, back-button → pause menu, immersive fullscreen. WebView remote debugging over USB (`chrome://inspect`) gives real breakpoints, console, and performance profiling on the actual device.

### 3.4 No physics engine — custom character controller
A house interior is axis-aligned boxes. Custom controller: capsule/AABB collision, axis-separated move-and-slide, gravity, 0.35 m stair step-up, ground-snap raycast, crouch height. Deterministic, tiny, and interaction raycasts share the same math. Rapier/cannon would add 1–2 MB WASM, CPU cost, and tuning burden for zero gameplay benefit.

### 3.5 First-person — decision and justification
- **Asset logic:** no player character model — building one from primitives would violate your asset-quality rules. First-person eliminates the problem.
- **Horror logic:** limited view cone, sound-led tension, hide mechanic that stays perfectly coherent.
- **Perf logic:** exactly one skinned animated mesh ever on screen — the Daayan.
- **Mobile logic:** joystick + drag-look is the proven, simplest-to-get-right FPS touch scheme.
- **Third-person rejected:** needs a full player model, camera-collision handling, more rendering cost — and gains nothing for horror.

### 3.6 Asset policy (operationalized)
- Your `.glb` files are the primary quality source. The pipeline (Phase 2) handles loading, meshopt/Draco decode, scale/pivot/rotation normalization via manifest, material handling, and `AnimationMixer` playback with semantic name-mapping for the Daayan model.
- Missing architecture (doors, stair units, basement fixtures): source **CC0 first** — Kenney.nl (CC0), Quaternius (CC0), Poly Haven (CC0), Poly Pizza (license varies per model — verified individually). If I can't fetch in-session, you get an exact shopping list (item, URL, license) to drop into the agreed folders.
- Primitives are a last resort — only wall slabs, floor panels, door blanks — always with real textures (ambientCG / Poly Haven, CC0), AO baked into the static shell.
- **Never a silent placeholder.** Any gap gets an explicit `ASSET-GAP` entry in `PROGRESS.md` plus a direct message to you.

---

## 4. Phase 0 — Feasibility Gate & Project Scaffold

Your spec placed the feasibility test inside Phase 1; I'm pulling it into a dedicated Phase 0 so the stack go/no-go decision happens before a single wall exists. It doubles as the project scaffold.

### 4.1 Steps
1. `git init`; verify the project folder is empty/new (assumption A1).
2. Scaffold Vite + TS (strict) + ESLint + Prettier; first commit.
3. Engine skeleton: renderer / camera / resize / fixed-timestep loop + `DebugOverlay` v1 (FPS, frame-time split, draw calls, triangles, resolution scale).
4. Feasibility scene: a 2-room shell (~12×10 m) with textured walls/floor, 1 hemisphere + 1 point light, one furnished CC0 `.glb` and one rigged/animated CC0 `.glb` (validates `GLTFLoader` + `AnimationMixer` end-to-end), first-person controller with touch joystick.
5. Capacitor: add Android platform, landscape lock, placeholder icon/splash, debug APK build; document the exact deploy loop (`npm run build` → `npx cap sync` → `assembleDebug` → `adb install`).
6. Measure on-device: in-game overlay + `chrome://inspect` WebView profiling.

### 4.2 Test matrix & pass criteria

| Test | Role |
|---|---|
| Chrome desktop, 6× CPU throttle, low-end GPU emulation | Smoke test / regression tool only — not the gate |
| Real low-end Android device (4 GB RAM) | **The gate.** Emulator GPUs are unrepresentative; only used if no device exists (caveat recorded) |

**Pass =** ≥ 30 FPS average, ≥ 24 FPS 1%-lows in the scene · cold start < 8 s · heap < 300 MB · 10-minute session with no thermal spiral or crash · GLB loads and animation plays on device.

### 4.3 Decision gate & fallback ladder
1. **Tune and retest (most likely outcome):** fully baked lighting, lower resolution floor, lighter textures.
2. **Babylon.js parity spike (≤ 2 days)** — only worth trying for driver-specific quirks; raw ceiling is the same.
3. **Design pivot to pre-rendered 2.5D horror** (fixed camera nodes, high-quality stills + transitions) — preserves the horror experience, transforms scope; requires your explicit sign-off.
4. **Findings + numbers recorded in `PROGRESS.md`** before Phase 1 begins.

---

## 5. Project Structure

```
daayans-house/
├── PLAN.md                    ← this file
├── PROGRESS.md                ← living doc: module status, decisions, bugs, ASSET-GAPs
├── package.json / tsconfig.json / vite.config.ts
├── capacitor.config.ts
├── index.html
├── public/assets/             ← ALL game assets (bundled locally, no runtime internet)
│   ├── models/
│   │   ├── daayan/            ← Daayan.glb goes here
│   │   ├── furniture/         ← chairs, tables, … (your drops)
│   │   ├── props/             ← wall paintings, decor (your drops)
│   │   └── architecture/      ← doors, stairs, fixtures (CC0-sourced)
│   ├── textures/              ← walls/ floors/ props/ (diffuse, normal, AO)
│   └── audio/                 ← sfx/ ambience/ voice/
├── src/
│   ├── main.ts                ← bootstrap + game loop wiring
│   ├── core/                  ← Engine, GameLoop, EventBus, AssetManager,
│   │                            QualityManager, DebugOverlay, SaveSystem
│   ├── world/
│   │   ├── HouseBuilder.ts    ← turns layout data into meshes + colliders + nav + registry
│   │   ├── registry.ts        ← stable string IDs for every entity
│   │   ├── data/              ← floor1.layout.ts · floor2.layout.ts · basement.layout.ts
│   │   ├── modules/           ← WallBuilder · FloorBuilder · StairsBuilder · DoorBuilder
│   │   └── navgrid.ts         ← 0.5 m grid + stair nav-links (built Ph1, consumed Ph4)
│   ├── player/                ← Player · FPController · TouchControls (joystick) ·
│   │                            KeyboardControls (dev) · Lantern · NoiseEmitter
│   ├── interaction/           ← Interactable · InteractionSystem · Inventory · HideSpots
│   ├── puzzles/               ← PuzzleBase · PuzzleManager · [Ph3 puzzles — spec from you]
│   ├── daayan/                ← DaayanController (stub until Ph4) · perception hooks
│   ├── lives/                 ← LivesSystem (3 chances per checkpoint) · RespawnFlow
│   ├── ui/                    ← HUD · PromptUI · LoadingScreen · Menus · Subtitles
│   ├── scenes/dev/            ← throwaway isolation scenes for bug repro
│   └── assets/manifest.ts     ← typed asset manifest
├── tools/audit-assets.ts      ← poly/texture/animation report per GLB
└── android/                   ← generated by Capacitor; never hand-edited
```

### 5.1 Data-driven world (key architectural decision)
The house is defined as typed layout data (wall segments with door/window openings, room definitions, door states, stair definitions, prop placements). Builders consume that data to produce, from one source of truth: render meshes, collision AABBs, the AI nav grid, and the ID registry. Benefits: cheap iteration, guaranteed AI-navigable geometry from day one (Phase 4 forward-compatibility), and stable IDs your future prompts can reference directly.

### 5.2 Stable ID registry
Every entity registers at creation: `room:ground_hall`, `room:basement`, `door:ground_hall_main`, `prop:painting_hall_01`, `gate:main`, `key:basement_rust`, `hideword:wardrobe_master`, `checkpoint:f1_top_of_stairs`, … Your Phase 3/4/5 prompts can bind to these IDs without touching builder code.

### 5.3 Asset drop workflow

| You provide | Drop into | I then |
|---|---|---|
| Furniture/prop `.glb` | `public/assets/models/furniture/` or `.../props/` | add one manifest line, run `npm run audit-assets`, place via layout data |
| Daayan `.glb` | `public/assets/models/daayan/` | add manifest line incl. semantic animation mapping |
| Textures (diffuse/normal/AO) | `public/assets/textures/{walls,floors,props}/` | reference in manifest, sized to tier |
| Audio (OGG) | `public/assets/audio/{sfx,ambience,voice}/` | reference in `AudioManifest` |

**Manifest entry shape (illustrative):**
```ts
'daayan': {
  url: 'models/daayan/daayan.glb',
  scale: 1.0, rotY: 0, yOff: 0,
  anims: { idle: 'Idle', walk: 'Walk', run: 'Run', attack: 'Attack' }
  // names confirmed on import
}
```
**Rule:** drop file → add manifest line → it appears in-game, with the audit script verifying it against the Section 2 budget table.

---

## 6. Integration Contracts (built early so your later prompts plug in cleanly)

**Typed `EventBus`** — decoupled systems messaging. Sketch:
```ts
type GameEvents = {
  'noise:emitted':     { pos: Vec3; radius: number; kind: 'footstep'|'door'|'object'|'impact' };
  'item:collected':    { id: string; kind: 'key'|'item' };
  'door:state':        { id: string; state: 'locked'|'unlocked'|'open'|'closed'|'slam' };
  'puzzle:solved':     { id: string };
  'gate:progress':     { locksRemaining: number };
  'player:hidden':     { hidden: boolean; spotId: string };
  'player:lives':      { remaining: number; atCheckpoint: string };  // 3 lives system
  'checkpoint:saved':  { id: string };
  'daayan:state':      { state: string };               // Phase 4
  'game:caught' | 'game:escaped': void;                 // death / win flow
  'story:beat':        { id: string };                  // Phase 5 cutscene triggers
};
```

- **`NoiseEmitter`** — on the player (footstep loudness differs for walk/run/crouch) and on noisy props/doors; Phase 4 perception simply subscribes.
- **`InteractionSystem`** — center-screen raycast, per-item range, prompt UI, one contextual action button. Interactable kinds: `examine | pickup | door | hide | lock | puzzle`.
- **`PuzzleBase` / `PuzzleManager` + `Inventory`** — 3 gate keys + lantern + utility items; your Phase 3 spec fills `puzzles/`.
- **`LivesSystem`** — 3 lives per checkpoint; on `game:caught`, decrement and respawn at last checkpoint; on reaching 0, full restart from initial spawn. Wired from Phase 1, surfaced in HUD from Phase 1.
- **Hide spots** (wardrobe, under bed) set `player:hidden` state; Phase 4 vision consults it.
- **`DaayanController` stub** — `spawn / setState / hearNoise(pos, radius, kind) / update` exists from Phase 1 as an interface; Phase 4 replaces internals without touching other systems.
- **Catch → lives flow + escape → win flows** defined as events now; screens/cinematics arrive in Phase 5.

---

## 7. Phase Plan (Detailed)

### Phase 1 — Core House Shell (2 floors) + Movement + Touch Controls + Lives

**Build:**
- Layout data schema + data for the structural shell: floor plates, exterior/interior walls with door and window openings, main staircase. Ground-floor room subdivision is finalized in Phase 3, so Phase 1 builds the ground-floor envelope + central hall — partitions remain pure data edits.
- Staircase geometry with collision (step-up traversal).
- 3–4 CC0 tiling texture sets (plaster wall, wood floor, concrete, ceiling) — static shell merged per room-cluster, AO baked.
- **`FPController`:** walk / run / crouch (run already emits louder `noise:emitted` events — AI hook live from day one).
- **`TouchControls`:** left virtual joystick (move), right-side drag (look), contextual interact button, run toggle. Desktop WASD + pointer-lock mouse kept for fast dev iteration.
- **`LivesSystem`:** 3 lives per checkpoint, `game:caught` respawn, full restart at 0. Initial checkpoint = `checkpoint:spawn_initial`.
- **HUD shell:** lives counter (3 hearts/dots), interaction prompt placeholder, lantern fuel placeholder.
- **Lantern:** player has it from spawn; world ambient is darkness-tuned; lantern is the only dynamic light on low tier.
- Mid-phase on-device perf check (budgets + overlay).
- **Exit criteria:** full walk of both floors on the target device at ≥ 30 FPS within budgets; overlay live; lives system functional (trigger test death → respawn → second death → full restart); tagged `phase-1`.

### Phase 2 — Asset Pipeline & Props (your `.glb` files)

**Build:**
- **`AssetManager`:** load queue with progress UI, GLTF + meshopt/Draco, texture size caps, dispose registry (leak-proof).
- **Manifest-driven normalization:** scale / pivot / rotation corrections per asset; shared-material remapping to keep material count low.
- Place your furniture/props per room via layout data.
- **`InteractionSystem` v1:** examine paintings, open drawers/doors as simple animated transforms — no deep puzzle logic yet.
- **Animated-GLB verification:** if your Daayan `.glb` exists by now, validate it directly; otherwise a CC0 rigged model is used purely as a pipeline test (explicitly flagged, never shipped in-game).
- Prop blob shadows; LODs only if the audit shows heavy assets; `npm run audit-assets` report.
- **Exit criteria:** fully furnished, walkable house within budget on device; manifest documented so you can drop future assets yourself; tagged `phase-2`.

### Phase 3 — Ground-Floor Rooms, Basement & Puzzle System + Static Daayan Patrol

**Source spec:** `Daayan's House Environment & Puzzle Design Brief` (PDF, provided by user). All room IDs, key IDs, patrol waypoints, save triggers, and story beats in this section are taken directly from that spec and treated as contract.

This phase delivers two things in one go: **(a)** the 6 ground-floor rooms + basement + first floor + staircase fully built and walkable, and **(b)** the static scripted Daayan patrol (waypoints, 5-second room stops, footstep audio gating, "skip Drawing Room after 3rd key" override) — **NOT** the full AI FSM (vision cone, dynamic chase, sound-based detection). The FSM is a Phase 4 contract on top of the patrol foundation laid here.

#### 7.3.1 House layout — full room map (typed `LayoutData`)

| Floor | Room ID | Approx. size | Door ID → connects to | Purpose / notes |
|---|---|---|---|---|
| Ground | `room:main_hall` | 8×10 m | (entry from main gate) | Central hub, 6 doors fan out |
| Ground | `room:living_room` | 6×8 m | `door:hall_living` | Ambience, candles, sofa, paintings (CC0 props) |
| Ground | `room:kitchen` | 5×6 m | `door:hall_kitchen` | **Hidden room** — only revealed after puzzle; contains mummy + basement key |
| Ground | `room:study` | 4×5 m | `door:hall_study` | Bookshelf puzzle; reveals Hidden Switch → kitchen |
| Ground | `room:lobby` | 5×6 m | `door:hall_lobby` | Daayan's spawn point; under-staircase store |
| Ground | `room:washroom` | 3×3 m | `door:hall_washroom` | Sink, candle, mirror (no puzzle, ambience) |
| Ground | `room:store` | 3×4 m | `door:hall_store` | Locked closet; opens with `key:basement_rust` post-basement; small loot |
| Ground | `room:basement_entry` | 3×3 m | `door:kitchen_basement` (locked) | Stair down; locked until `key:basement_rust` |
| B1 | `room:basement` | 8×10 m | (from `room:basement_entry`) | Ritual scene (CC0 mummy/altar/incense); no puzzles, ambience + Daayan presence flag |
| 1st | `room:f1_hall` | 6×8 m | (staircase up from main hall) | Connects to 2 rooms + stair landing |
| 1st | `room:master_bedroom` | 6×7 m | `door:f1hall_master` (locked initially) | Photo clue + pillar-hidden `key:bedroom_pillar` |
| 1st | `room:drawing_room` | 5×6 m | `door:f1hall_drawing` | Painting of Daayan → face-reveal clue; first-entry scripted scare |
| All | `room:staircase` | (linking) | ground ↔ 1st | Two flights, step-up collision |

**Entity IDs registered at build time** (all unique, stable, referenced by Phase 4/5 prompts):
- Rooms: 12 IDs above
- Doors: 8 IDs (each `door:<from>_<to>`)
- Keys: 3 IDs (`key:basement_rust`, `key:master_drawing`, `key:bedroom_pillar`)
- Gate: 1 ID (`gate:main`)
- Hide spots: 4 IDs (`hide:living_wardrobe`, `hide:study_desk`, `hide:master_wardrobe`, `hide:kitchen_cupboard`)
- Checkpoints: per §7.3.5 trigger table
- Daayan: 1 spawn (`daayan:spawn_lobby`)

#### 7.3.2 The 3 keys — placements, unlocks, narrative anchors

| Key ID | Room | Where in room | What clue points to it | What it unlocks | Narrative beat |
|---|---|---|---|---|---|
| `key:basement_rust` | `room:kitchen` | Inside a drawer (animate open) | Ritual scene in basement ("looks like a real body"), fire-like candle arrangement | `door:kitchen_basement` (allows entry) | Beat 3: first Kitchen entry reveals hidden room |
| `key:master_drawing` | `room:drawing_room` | Held in the painting of Daayan (interact painting → key falls out) | Photo in `room:master_bedroom` of a man next to a woman with same crescent bindi → "main hi hoon" | `door:f1hall_master` | Beat 4: photo reveal makes player realise she's the killer |
| `key:bedroom_pillar` | `room:master_bedroom` | Behind a pillar (small gap, requires crouch to see, or interact while crouched) | Already in Master Bedroom from `key:master_drawing` | `door:f1hall_drawing` (return path) | Beat 5: "she doesn't know you came back" |

**Gate binding:** `gate:main` has 3 lock slots, one per key ID. All 3 in `Inventory` → "Use Gate" interaction prompts → on confirm, fire `game:escaped` event + `story:beat:5` (escape cinematic). Main gate is in the outdoor courtyard area outside `room:main_hall`; player walks up to it from inside the house.

**Inventory rules:**
- Pickup: tap "Take" on the held item → key added to `Inventory`, `item:collected` event fires, auto-checkpoint triggers.
- Drop: not in v1 (keys are quest items, can't drop).
- Use: contextual — only `gate:main` consumes keys; everything else is "examine."
- HUD: 3 key slots visible top-right; `key:basement_rust` slot fills when collected, etc.

#### 7.3.3 Puzzles (8 total) — IDs, mechanics, room binding

| # | Puzzle ID | Room | Mechanic | Reward / next step |
|---|---|---|---|---|
| 1 | `puzzle:study_bookshelf` | `room:study` | Slide 3 books in correct order (clue: a scribbled note on the desk; sequence is in a CC0 book's "diary" texture, or a hint note in the room) | Reveals **Hidden Switch** on bookshelf back wall |
| 2 | `puzzle:hidden_switch` | `room:study` | Interact Hidden Switch → bookshelf slides → reveals passage to `room:kitchen` (which had no visible door before) | `door:hall_kitchen` (newly accessible) |
| 3 | `puzzle:kitchen_drawer` | `room:kitchen` | Open drawer (no mini-game) — first time only, find the mummy + the rust key | `key:basement_rust` |
| 4 | `puzzle:basement_altar` | `room:basement` | Examine-only (no interaction needed) — sets the "rituals" lore + Daayan presence flag | Unlocks `door:kitchen_basement` (exit back up) — wait, door is already unlocked by key, this is just the visual reveal beat |
| 5 | `puzzle:drawing_painting` | `room:drawing_room` | Interact painting (Daayan's face) → it animates open / cracks / `key:master_drawing` falls out | `key:master_drawing` |
| 6 | `puzzle:bedroom_photo` | `room:master_bedroom` | Examine photo on wall (examine-only, sets `story:beat:4` flag) | Narrative beat 4 (no key) |
| 7 | `puzzle:bedroom_pillar` | `room:master_bedroom` | Crouch + interact with pillar gap → reach inside → `key:bedroom_pillar` | `key:bedroom_pillar` |
| 8 | `puzzle:main_gate` | `gate:main` (outdoor) | Insert 3 keys (one by one; gate animates per insertion) → final unlock anim → `game:escaped` | Win |

**Puzzle states** in `PuzzleBase`: `locked | available | inProgress | solved | failed`. Only `inProgress` and `solved` are saveable; `available` re-derives on load.

**Sequence dependency graph (one valid path):**
```
spawn → main_hall (lobby has Daayan)
  → study (puzzle 1 → puzzle 2 → kitchen revealed)
  → kitchen (puzzle 3 → key:basement_rust)
  → basement (puzzle 4, examine only)
  → back up via kitchen_basement door
  → staircase up to f1_hall
  → drawing_room (puzzle 5 → key:master_drawing)
  → back to f1_hall
  → master_bedroom (puzzle 6 + puzzle 7 → key:bedroom_pillar)
  → f1_hall → staircase down → main_hall
  → gate:main (puzzle 8 with all 3 keys → escaped)
```

**Player can deviate** (e.g. try Drawing Room before kitchen) — `door:f1hall_master` is locked until `key:master_drawing` is held, so the chain is enforced at the door level. `door:f1hall_drawing` is unlocked the whole time (per spec, first entry into Drawing Room is a scripted scare — Daayan is already there).

#### 7.3.4 Static Daayan patrol (Phase 3 scope — FSM in Phase 4)

**Per spec, the patrol loop is fully deterministic. No vision cone, no pathfinding around dynamic obstacles, no chase — those arrive in Phase 4.** The patrol foundation in Phase 3 is what Phase 4 will layer FSM behaviors on top of.

**Patrol waypoints (typed `Waypoint[]` in `DaayanController`):**
```
1. room:lobby          (spawn; idle 2s)
2. room:main_hall      (walk through; no stop)
3. room:staircase      (walk up; ~6s on stairs, walk anim)
4. room:f1_hall        (walk through; no stop)
5. room:master_bedroom (5s stay → continue)
6. room:f1_hall        (walk through; no stop)
7. room:drawing_room   (5s stay → continue)
8. room:f1_hall        (walk through; no stop)
9. room:staircase      (walk down; ~6s, walk anim)
10. room:main_hall     (walk through; no stop)
→ LOOP back to 1
```

**Implementation:**
- Waypoints are world-space `Vector3` + room ID + optional "stay duration" + animation override (`idle | walk | run`).
- Daayan follows the waypoint list in order using the existing `NavGrid` from Phase 1 (no dynamic obstacle avoidance yet — straight `seek(waypoint)` with `moveAndSlide`).
- Speed per segment: `walk = 1.2 m/s`, `run = 2.4 m/s` (only used in Phase 4 chase; Phase 3 patrol is always `walk`).
- At each waypoint with `stay > 0`: play `sneak_idle` animation for `stay` seconds, then resume `walk` to next.
- Daayan **always faces the camera** when farther than 1.5 m from the player; **follows the player (head-look + slow turn)** when within 1.5 m. This is a skeletal look-at (the model's head bone targets the camera) — implemented in Phase 3 because it's visual polish with no AI logic, fits scope.
- **View radius when far: 0.6 m** (per spec). This is a "physical eye position radius" for the look-at math, not a vision-cone range (that arrives in Phase 4).

**Footstep audio gating (critical gameplay rule from spec):**
- `sneak_idle` animation → emit `noise:emitted` (footstep, radius: 1.5 m) every 0.5 s
- `walk` animation → emit `noise:emitted` (footstep, radius: 4 m) every 0.6 s
- `run` animation → **NO** footstep audio (silent — Phase 4 chase-state design implication: player learns "if she's running, freeze" as a stealth rule)
- These bindings are driven by animation name → audio profile mapping in `daayan/audioProfiles.ts`; Phase 4 will extend the profile set (e.g. `attack` → loud impact noise).

**3rd-key override (the "she skips Drawing Room" rule):**
- Trigger: `item:collected` where `id === 'key:bedroom_pillar'` → set internal flag `daayan:skipDrawingRoom = true`.
- Patrol loop changes: waypoint 7 (`room:drawing_room`) is **skipped** on all subsequent laps. Daayan goes from `room:f1_hall` (after Master Bedroom) → `room:staircase` (down) directly.
- Flag is one-way (no toggle back). Persists in save.
- **Why this is gameplay-critical:** the player needs to physically return from Master Bedroom to Ground Floor and exit via the main gate. If Daayan still visits Drawing Room on her normal lap, the path `f1_hall → staircase → main_hall → gate` intersects her movement and a catch is very likely. This override is the game's "fairness rule" — it makes the escape reachable without the player having to wait for a precise timing window.
- This override is **Phase 3 implementation** because it's a patrol-path change, not an AI decision. Phase 4 may add additional intelligence (e.g. "if she sees you running back, give chase") but the base path change is here.

**First-entry scripted scare (Drawing Room):**
- Trigger: first `puzzle:drawing_painting` available (i.e. first time the room is entered).
- Behavior: Daayan is **already in `room:drawing_room`** at the start of the room entry (patrol waypoint reached early, she waits there beyond normal 5s until the player enters the room or 10s pass, whichever is first). On player entry → "she turns to face you" cinematic (1.5s camera-zoom on her, sound sting) → she resumes her normal patrol. After this happens once, normal patrol resumes.
- This is a `story:beat` hook (Beat 3 in the beat table §7.3.6), implemented as a scripted event in Phase 3, not Phase 4 AI.

**First-entry encounter (Master Bedroom — no scare):**
- Per spec, when player first enters `room:master_bedroom`, Daayan is **not** in the room. The scripted gap is: she's in `room:drawing_room` or `room:f1_hall` at that moment. The patrol timing makes this deterministic (player comes from Drawing Room, so Daayan is one waypoint behind). Phase 3 just runs the static patrol — this gap emerges naturally.
- No special code needed; the patrol timing IS the design.

**Respawn reset:**
- On `game:caught` → `LivesSystem.decrement()` → if lives remain, respawn at last checkpoint → **`DaayanController.resetToSpawn()`** → teleport Daayan to `room:lobby` spawn point, resume patrol from waypoint 1.
- On full restart (0 lives) → same reset, plus full game state reset.

#### 7.3.5 Save trigger table (15 conditions, from PDF §7.3.5 + this design)

`SaveSystem` listens to events; when a trigger fires, it writes a checkpoint record to `localStorage` with: `{ id, timestamp, playerPos, playerRot, inventory, puzzlesSolved, daayanState, currentLapIndex, skipDrawingRoomFlag, livesRemaining, currentCheckpointId }`.

| # | Trigger | Checkpoint ID | Notes |
|---|---|---|---|
| 1 | Player first enters `room:main_hall` (after spawn) | `checkpoint:hall_entry` | First save |
| 2 | `puzzle:study_bookshelf` solved | `checkpoint:study_solved` | Pre-kitchen reveal |
| 3 | Hidden Switch activated, `room:kitchen` first entered | `checkpoint:kitchen_revealed` | Pre-mummy |
| 4 | `key:basement_rust` collected | `checkpoint:basement_key` | Pre-basement |
| 5 | `room:basement` first entered | `checkpoint:basement_entry` | Mid-game checkpoint |
| 6 | `room:basement` first exited (back to kitchen) | `checkpoint:basement_exit` | Post-ritual |
| 7 | `room:f1_hall` first entered (staircase up) | `checkpoint:f1_hall_entry` | Pre-painting scare |
| 8 | `room:drawing_room` first entered (scripted scare) | `checkpoint:drawing_room_entry` | **Auto-save BEFORE the scare triggers** (per spec) |
| 9 | `puzzle:drawing_painting` solved, `key:master_drawing` collected | `checkpoint:drawing_room_done` | Pre-bedroom |
| 10 | `door:f1hall_master` unlocked (by `key:master_drawing`) | `checkpoint:master_unlocked` | Pre-photo |
| 11 | `room:master_bedroom` first entered | `checkpoint:master_bedroom_entry` | Per spec: **this is when `key:bedroom_pillar` is findable, and Daayan is NOT in the room** |
| 12 | `puzzle:bedroom_photo` examined (Beat 4 trigger) | `checkpoint:photo_reveal` | Pre-escape |
| 13 | `key:bedroom_pillar` collected | `checkpoint:bedroom_key` | Last key — also sets `daayan:skipDrawingRoom = true` |
| 14 | `room:main_hall` re-entered after all 3 keys | `checkpoint:final_hall` | Pre-gate |
| 15 | `gate:main` interacted with (any key count) | `checkpoint:gate_interacted` | Pre-escape — guarantees one save right before win |

**Save model rules (from spec):**
- Player respawn position is always the **trigger point of the most recent saved checkpoint** (not the current player position when caught).
- Checkpoint writes are **debounced 500 ms** so rapid-fire triggers (e.g. collecting a key + entering a room back-to-back) collapse to one save.
- `localStorage` key: `daayan_save_v1`. Save versioned for future migrations.
- On full restart (0 lives): save is **not** cleared — the player can manually restart from main menu (deletes save) or continue from last checkpoint (re-runs the 3-lives loop at that checkpoint).
- **No manual save UI** (per user Q8).

**Lives system interaction with saves:**
- `LivesSystem.lives = 3` is per-checkpoint, NOT persisted (resets to 3 on every checkpoint load). Rationale: 3 lives gives the player a small reprieve at each save point; persisting lives across saves would make the early game too punishing if the player dies a lot in the basement and then loses more lives on the first floor.
- Full restart (0 lives) → save is **not** cleared automatically; the restart is a soft "from initial spawn" event that the `LivesSystem` emits (`game:full_restart`) → `SaveSystem` resets to `checkpoint:hall_entry` (the first save) and clears all keys/puzzles/daayan-skip flag.

#### 7.3.6 Story beats (5 total, from PDF §7.4)

Tracked in `StorySystem`; each beat has `{ id, trigger, onTrigger, fireOn: 'enter' | 'interact' | 'collect' }`.

| # | Beat ID | Trigger | What happens | Auto-save? |
|---|---|---|---|---|
| 1 | `story:beat:1` | Game start (after intro cinematic, Phase 5) | Player at `checkpoint:spawn_initial` (gate area, just before main_hall) | Yes (`checkpoint:hall_entry` is checkpoint #1) |
| 2 | `story:beat:2` | Player first enters `room:main_hall` (and Daayan is visible in `room:lobby` via open door) | Subtitle: "She's here. Be careful." | Yes |
| 3 | `story:beat:3` | First entry into `room:drawing_room` | Scripted scare (Daayan turns, 1.5s zoom, sound sting); subtitle: "She doesn't want you here." | Yes (`checkpoint:drawing_room_entry`) |
| 4 | `story:beat:4` | `puzzle:bedroom_photo` examined | Photo close-up cinematic, subtitle reveals it's Daayan with the man; "She's the one who'll kill you." | Yes (`checkpoint:photo_reveal`) |
| 5 | `story:beat:5` | `game:escaped` fired by gate unlock | Escape cinematic (player runs out, gate closes behind, screen fades); subtitle: "You escaped. For now." | Yes (final save) |

All beats are auto-save moments — guarantees the player can always come back to a narrative milestone.

#### 7.3.7 Phase 3 build order (one-pass plan)

1. **Layout data for ground floor** — write `src/world/data/groundFloor.layout.ts` with all 7 rooms (main_hall + 6 around it), wall segments, door openings, basement stair entry, main gate exterior.
2. **Layout data for basement** — `basement.layout.ts`, single room, ritual props placement.
3. **Layout data for first floor** — `firstFloor.layout.ts`, f1_hall + master_bedroom + drawing_room + staircase landing.
4. **Door system** — implement `DoorState` FSM in `src/world/modules/DoorBuilder.ts`; each door is one of 4 states; open/close animation, lock/unlock visual, slam event.
5. **Registry + nav grid rebuild** — Phase 1 nav grid extended to basement + first floor; nav-links across all 3 floor boundaries (staircases).
6. **Puzzle framework** — `PuzzleBase` + `PuzzleManager` + 8 concrete puzzle subclasses (one per row in §7.3.3).
7. **Inventory + HUD** — 3 key slots top-right, contextual "Take/Use" prompt, item pickup animation.
8. **Save system** — `SaveSystem` with the 15-trigger listener, `localStorage` persistence, debounced writes, version field.
9. **Lives system** — 3-lives counter, respawn flow, full-restart flow, HUD hearts/dots.
10. **Lantern tuning** — darkness profile, lantern as the one dynamic light, lantern flicker animation, "battery" placeholder (infinite in Phase 3, mechanic in Phase 4 if needed).
11. **Hide spots** — 4 spot registrations, hide/unhide state, animation/UI for the player entering/exiting a wardrobe.
12. **Story system** — `StorySystem` with 5 beats, subtitle rendering, beat → save trigger binding.
13. **Static Daayan patrol** — `DaayanController` with waypoint list, `step(dt)` method, animation transitions via `AnimationMixer` (already validated in Phase 2), look-at-camera-when-far / follow-when-near skeletal behavior.
14. **Footstep audio gating** — animation-name → audio-profile mapping, `noise:emitted` events.
15. **3rd-key skip override** — flag + patrol path mutation.
16. **First-entry Drawing Room scripted scare** — one-shot event, camera takeover (1.5s), sound sting, resume patrol.
17. **Main gate mechanism** — 3-lock binding, per-key insertion animation, `game:escaped` event on full unlock.
18. **Dev-mode debug commands** — `?key=basement_rust` (spawn), `?tp=room:drawing_room` (teleport), `?unlockall` (unlock all puzzles/keys), `?godmode` (no catch), `?lap=N` (jump patrol to lap N), `?time=HH:MM` (force time of day if we add a day/night cycle later).
19. **Full loop playtest on device** — start → all 3 keys → escape, measured at ≥ 30 FPS within budgets.
20. **Phase 3 tag** — `phase-3`, `PROGRESS.md` updated with module status table, known bugs, ASSET-GAPs (e.g. "mummy model — CC0 source TBD", "altar props — CC0 source TBD").

#### 7.3.8 Phase 3 exit criteria

- [ ] Full house (ground + basement + first floor) walkable on the target device at ≥ 30 FPS within Section 2 budgets.
- [ ] All 8 puzzles implemented and testable via dev commands.
- [ ] All 3 keys collectible in the documented order; door locks enforced.
- [ ] Main gate unlocks only with all 3 keys; escape cinematic-ready event fires (visual arrives Phase 5).
- [ ] Static Daayan patrol runs the full loop deterministically; 3rd-key skip-Drawing-Room rule works.
- [ ] First-entry Drawing Room scripted scare plays once and only once.
- [ ] Footstep audio gating: `sneak_idle` and `walk` emit noise, `run` is silent.
- [ ] Save system writes on all 15 triggers; load on respawn returns player to checkpoint trigger point.
- [ ] Lives system: caught → respawn at last checkpoint, 3 chances, 4th catch → full restart.
- [ ] Story system: all 5 beats fire in the right order with subtitles.
- [ ] Debug overlay shows: current lap index, skip-Drawing-Room flag, lives remaining, active checkpoint ID, active story beat.
- [ ] `tools/audit-assets.ts` passes on all dropped assets.
- [ ] `PROGRESS.md` updated; git tag `phase-3` set.

#### 7.3.9 Phase 3 → Phase 4 hand-off contract

Phase 4 (Daayan AI FSM, per user's dedicated PDF) will layer on top of the Phase 3 patrol foundation. The hand-off contract:
- `DaayanController` already exposes: `spawn(waypoint)`, `step(dt)`, `setState(name)`, `hearNoise(pos, radius, kind)`, `resetToSpawn()`, `getCurrentWaypointIndex()`, `isPatrolling()`, `getPosition()`, `getFacing()`.
- Phase 4 adds (without changing these signatures): vision cone query against `NavGrid` + player position, dynamic chase state, sound-based alert state, attack state, look-at-player override during chase.
- The static waypoint patrol becomes the "patrol state" inside the new FSM; transition rules are defined by the Phase 4 prompt.
- `LivesSystem`, `SaveSystem`, and `StorySystem` are unchanged; Phase 4 only fires `game:caught` (lives decrement) and `puzzle:master_bedroom` (or wherever Phase 4 puts the kill moment) — both are already wired.

### Phase 4 — Daayan AI (patrol, chase, detection)

⚠️ **You will hand me your dedicated, fully detailed AI prompt (FSM states, pathfinding, vision cone, sound detection) at the start of this phase.** I will not design its internals now.

**Already waiting for it (forward-compat guaranteed by Phases 1–3):**
- `NavGrid` baked from layout data — 0.5 m cells per floor, nav-links at staircases (Phase 1).
- `NoiseEmitter` → `noise:emitted` events from footsteps/doors/impacts (Phase 1).
- `player:hidden` state from hide spots (Phase 2/3).
- `DaayanController` stub interface (Phase 1).
- Animation name-mapping via manifest for the Daayan `.glb` (Phase 2 pipeline).
- Catch → lives flow (3 chances → respawn → 0 → full restart) + `game:caught` event flow; quality-tier handling for the single skinned mesh (LOD, blob shadow, frustum).
- Lives decrement wired to AI catch; respawn returns player to last checkpoint and resets Daayan's AI state to "patrol at last heard-noise area or scripted waypoint."

### Phase 5 — Cutscenes & Final Polish

⚠️ **Your prepared cutscene content arrives at the start of this phase.**

**Already waiting:** `story:beat` events, subtitle system, camera-takeover API plan, death ("She found you.") / escape screens, lives-aware restart screen.

**Build:** intro cinematic (bike breakdown → entering the house) and ending per your content — skippable, letterboxed; final performance pass (full profile, budget re-check, tier tuning); settings screen (quality tier / joystick sensitivity / invert-Y / subtitles / volume / FPS cap); release APK: keystore signing, versioning, minified bundle, sideload-ready build (Play-ready on request).

---

## 8. Process: Debugging & Living Documentation

- **One system per file/folder** — the tree in Section 5 encodes this; no monoliths.
- **TS strict, no `any`, no floating promises** — type errors fixed immediately as real bugs.
- **`PROGRESS.md` (living doc)** — updated after every meaningful chunk: module status table, decisions log, known bugs, next-up, ASSET-GAP list. Any new session starts by reading it.
- **Git discipline** — conventional commits (`feat:` / `fix:` / `perf:` / `chore:`), tagged phase gates (`phase-1`, `phase-2`, …), risky work on short-lived branches.
- **Debug overlay** (toggle: back-tick on desktop / triple-tap corner on device): FPS + 1%-lows, logic vs render time split, draw calls/triangles (`renderer.info`), player position + floor, current interactable, quality tier + resolution scale, memory, lives remaining + active checkpoint ID, and (Phase 4+) Daayan state + active puzzle states.
- **On-device profiling** via `chrome://inspect` WebView debugging over USB.
- **Isolation protocol** — when something breaks: reproduce in smallest possible scope inside `src/scenes/dev/`; report findings before applying any non-obvious fix.
- **Phase gates = stabilization checkpoints** — clean build, regression pass on prior phases, budget check — before the next phase starts.

---

## 9. Top Risks

| Risk | Mitigation |
|---|---|
| WebView GPU driver variance across cheap devices | Dynamic resolution + quality tiers + Phase 0 gate on real hardware |
| 4 GB RAM phones with weak GPUs still under-shoot 30 FPS in dense rooms | QualityManager dynamic resolution + room visibility groups + per-tier draw-call budgets (50/80/120) |
| Your Daayan `.glb` may be heavy (high poly / big textures) | Audit script flags it at drop time; LOD + single-skinned-mesh budget already reserved |
| Memory leaks across scene reloads | Dispose discipline from Phase 2 + Chrome memory profiler checks |
| Emulator perf ≠ device perf | Phase 0 gate requires a real device |
| KTX2 toolchain friction | Capped WebP/PNG is the guaranteed baseline; KTX2 is a stretch goal |
| 3-lives + respawn may be rage-inducing if checkpoints are sparse | Checkpoint placement is part of Phase 3 layout review; user can adjust density |

---

## 10. Assumptions

- **A1.** The project folder is empty/new (verified as Phase 0 step 1).
- **A2.** Landscape-only, fullscreen.
- **A3.** English UI only (per user).
- **A4.** 30–60 FPS is the low-end target band on 4 GB RAM devices; 60 FPS steady is the mid-tier target.
- **A5.** No physics engine (custom controller).
- **A6.** All assets bundled locally; no runtime internet required.
- **A7.** One skinned character (Daayan); no visible player body.
- **A8.** Checkpoint saves via `localStorage`; no cloud save.
- **A9.** No monetization/ads.
- **A10.** Node 18+ and Android Studio/SDK available for APK builds.
- **A11.** "Low-end device" = 4 GB RAM Android 8+, Adreno 505/506 or Mali-G31, 720p. (User confirmed "4GB phone pe thik se chalna chahiye, 30-60 FPS minimum.")
- **A12.** 3 lives per checkpoint, full restart on 0 lives.

---

## 11. Confirmed answers from user (Q1–Q8)

| # | Question | Answer |
|---|---|---|
| 1 | Test device | "4 GB phone pe thik se chalna chahiye, 30–60 FPS minimum" → 4 GB RAM low-end, 30–60 FPS target band |
| 2 | UI language | English only (for now) |
| 3 | Upper floor room program | TBD with Phase 3 spec (placeholder: bedrooms + bathroom + study, to be confirmed) |
| 4 | Controls | Virtual joystick (left = move, right-side drag = look) |
| 5 | Flashlight | Always-tuned darkness; player has a lantern (only dynamic light on low tier) |
| 6 | Death model | Instant checkpoint respawn with 3 chances; on 0, full restart from initial spawn |
| 7 | Daayan animation names | Will be auto-listed on `.glb` import; user confirms mapping in Phase 2 |
| 8 | Save model | Checkpoints only (no manual save) |

### Still open (will confirm with Phase 3 spec):
- Q3. Upper-floor room program
- Q7. Daayan `.glb` animation name mapping (resolved in Phase 2 when asset is dropped)

---

## 12. Specs You Will Hand Me Directly (on record)

| When | You provide | What I do |
|---|---|---|
| **Phase 3 start** | Detailed environment/puzzle interconnection reference (PDF you just shared) | Design the 6–7 rooms, basement, and puzzle internals to your spec, wired into the `PuzzleBase` / `Inventory` / gate framework |
| **Phase 4 start** | Dedicated Daayan AI prompt (FSM, pathfinding, vision cone, sound detection) | Implement the AI on top of the waiting `NavGrid` / noise events / hidden-state / controller-stub contracts |
| **Phase 5 start** | Prepared cutscene content | Implement intro/ending cinematics and final polish |

Plain-text or markdown prompts are the ideal format; the env/puzzle spec is a PDF which I will read and extract structured requirements from.

---

## 13. Plan-status ledger

- **v1** — Initial draft, awaiting user review.
- **v2** — User answers to Q1–Q8 baked in: 4 GB target, English-only, joystick controls, lantern, 3-lives respawn, auto-checkpoints. Phase 3 env/puzzle spec (PDF) acknowledged as inbound.
- **v3** — Phase 3 sub-plan fully integrated from the Environment & Puzzle Design Brief PDF:
  - 12 rooms with stable IDs, 8 doors, 3 keys, 1 main gate, 4 hide spots
  - 8 puzzles with mechanics + room binding + sequence graph
  - **Static Daayan patrol** (Phase 3 scope) — full waypoint loop, 5-second room stops, footstep audio gating, "skip Drawing Room on 3rd key" override, first-entry Drawing Room scripted scare
  - 15-trigger save table with respawn rules and lives interaction
  - 5 story beats with subtitle + auto-save bindings
  - One-pass Phase 3 build order, exit criteria, Phase 4 hand-off contract
  - **Current state — ready for Phase 0 (scaffold + feasibility gate) on user approval.**

---

## 14. Phase 0 next steps (when you say "go")

Once you give the go, Phase 0 starts immediately. No more planning; the plan is the contract.

1. `git init` in the project root; verify folder is empty (already verified — empty).
2. Scaffold Vite + TypeScript (strict) + ESLint + Prettier.
3. Install Three.js (pinned), Capacitor 7, gltf-transform CLI (dev dep).
4. Engine skeleton: `Engine`, `GameLoop`, `EventBus`, `DebugOverlay` v1.
5. Feasibility scene: 2-room textured shell, 1 furnished CC0 `.glb`, 1 rigged CC0 `.glb`, FP controller with joystick.
6. Capacitor Android init: landscape lock, splash, debug APK build.
7. On-device gate: install on your 4 GB test device, measure FPS, 1%-lows, cold start, heap, 10-min stability.
8. **Stop.** Report go/no-go with numbers in `PROGRESS.md`. Wait for your explicit "Phase 1" approval.

If you have any test-device info right now (exact model, GPU, RAM), share it so I can pre-tune QualityManager defaults; otherwise defaults will treat the device as low-tier (30 FPS cap, 0.6× render scale floor, blob shadows, 1 dynamic light).

PLAN.md is the contract. Awaiting "go" for Phase 0.
