# Daayan's House — PROGRESS

**Living doc.** Updated after every meaningful chunk of work. Each new session starts by reading this file.

---

## Status snapshot (latest at top)

- **2026-08-28** — Phase 0 BUILD COMPLETE. Awaiting on-device test.
  - Stack: Three.js 0.169, TypeScript 5.6 strict, Vite 5.4, **Capacitor 6** (downgraded from 7 — JDK 17 vs 21)
  - Engine skeleton: Engine (renderer + camera + resize + pooled vec3), GameLoop (fixed-timestep), EventBus (typed), DebugOverlay v1, QualityManager (tier + dynamic resolution scaler)
  - FPController: walk / run / crouch, capsule-AABB collision, stair step-up, footstep noise:emitted events
  - TouchControls: virtual joystick (left), look-drag (right), action buttons (interact, run, crouch, lantern); desktop WASD + pointer-lock
  - Feasibility scene: 2-room textured shell, hemisphere + point light, procedural chair, 3-bone skinned creature (validates SkinnedMesh + Skeleton pipeline)
  - Capacitor Android: added, landscape lock + status-bar hide wired in `main.ts`
  - Dev build: 509 KB / 131 KB gzipped. Typecheck: 0 errors.
  - **APK built: `android/app/build/outputs/apk/debug/app-debug.apk` (3.92 MB) — 8m 57s build time.**
  - **Next:** user installs APK on their 4 GB test device and reports FPS, 1%-lows, cold start, heap, and 10-min stability.

---

## Module status

| Module | Status | Notes |
|---|---|---|
| `core/types.ts` | ✅ done | `GameEventMap`, `QualitySettings`, `EntityId` |
| `core/EventBus.ts` | ✅ done | typed pub/sub + globalBus singleton |
| `core/GameLoop.ts` | ✅ done | fixed-timestep accumulator, dt clamp 0.1s, RAF-driven render |
| `core/Engine.ts` | ✅ done | renderer, scene, camera, resize, pooled Vec3 |
| `core/DebugOverlay.ts` | ✅ done | FPS avg + 1% lows + draws + tris + tier + scale |
| `core/QualityManager.ts` | ✅ done | device hint heuristic, dynamic resolution scaler, 0.6×-1.5× clamp |
| `player/FPController.ts` | ✅ done | walk/run/crouch, AABB collision, stair step-up, footstep noise events |
| `player/TouchControls.ts` | ✅ done | joystick + look-drag + 4 buttons; desktop WASD + pointer-lock |
| `scenes/dev/feasibility.ts` | ✅ done | 2-room shell + chair + skinned creature; CC0 GLBs arrive Phase 1 |
| `world/*` | ⏳ Phase 1 | layout data, HouseBuilder, registry, nav grid |
| `interaction/*` | ⏳ Phase 2 | Interactable, InteractionSystem, Inventory, HideSpots |
| `puzzles/*` | ⏳ Phase 3 | PuzzleBase, PuzzleManager, 8 concrete puzzles |
| `daayan/*` | 🟡 Phase 3 stub | static scripted patrol only; FSM in Phase 4 |
| `lives/*` | ⏳ Phase 1 | LivesSystem (3 chances per checkpoint) |
| `ui/*` | ⏳ Phase 3 | HUD, PromptUI, LoadingScreen, Menus, Subtitles |
| `core/AssetManager.ts` | ⏳ Phase 2 | load queue + meshopt/Draco + dispose registry |
| `core/SaveSystem.ts` | ⏳ Phase 3 | localStorage + 15-trigger listener |
| `core/StorySystem.ts` | ⏳ Phase 3 | 5 beats, subtitle rendering |
| `tools/audit-assets.ts` | ⏳ Phase 2 | poly/texture/animation report per GLB |

---

## Decisions log

- **2026-08-28** — QualityManager `low` tier default for 4 GB RAM devices (per user requirement)
- **2026-08-28** — `noUncheckedIndexedAccess: true` in tsconfig — extra safety, costs 1-2 extra type guards per file
- **2026-08-28** — `exactOptionalPropertyTypes: true` — strict on `?` semantics
- **2026-08-28** — Procedural meshes (chair + skinned cube) in feasibility scene; CC0 GLBs replace these in Phase 1
- **2026-08-28** — Skinned cube uses single-bone skin (all vertices to root bone) — minimal complexity, still exercises SkinnedMesh code path
- **2026-08-28** — TouchControls: triple-tap top-left (mobile) and backtick (desktop) toggle debug overlay
- **2026-08-28** — **Capacitor downgraded 7 → 6** because user has JDK 17 installed and Capacitor 7 requires JDK 21. Same API surface, same APK output, no functional difference for the game. PLAN.md tech-stack table to be updated to reflect this.

---

## Known issues / bugs

_None yet — feasibility scene hasn't been run on a real device._

---

## Asset gaps (CC0 sources needed)

| Item | Planned for | Source target | Status |
|---|---|---|---|
| Wood floor texture | Phase 1 | ambientCG / Poly Haven | TBD |
| Plaster wall texture | Phase 1 | ambientCG / Poly Haven | TBD |
| Chair GLB (CC0) | Phase 1 | Kenney / Quaternius | TBD — using procedural for now |
| Table GLB (CC0) | Phase 1 | Kenney / Quaternius | TBD |
| Door GLB (CC0) | Phase 1 | Kenney | TBD — door frame built procedurally in Phase 1 |
| Stair unit GLB (CC0) | Phase 1 | Kenney | TBD |
| Mummy/altar GLB (CC0) | Phase 3 | Quaternius / Poly Pizza | TBD |
| Daayan GLB (animated) | Phase 2 | user-supplied | TBD |

---

## Open questions

- **Q1 (test device):** Confirmed "4 GB phone" target. Exact model still TBD — user can run APK on their device.
- **Q3 (upper-floor rooms):** TBD with Phase 3 spec — placeholder is bedrooms + bathroom + study.
- **Q7 (Daayan animation names):** TBD on asset drop (Phase 2).

---

## Phase gate status

- [x] **Phase 0 scaffold** — code complete, awaiting APK build + on-device test
- [ ] **Phase 0 on-device gate** — needs user to install APK and report numbers
- [ ] Phase 1 — Core house shell + movement
- [ ] Phase 2 — Asset pipeline + props
- [ ] Phase 3 — Rooms + basement + puzzles + static Daayan patrol
- [ ] Phase 4 — Daayan AI FSM (waiting on user's dedicated PDF)
- [ ] Phase 5 — Cutscenes + polish (waiting on user's cutscene content)

---

## Build / deploy quick reference

```bash
# Dev (web)
npm run dev
# → http://localhost:5173

# Build
npm run build
# → outputs to dist/

# Type check
npm run typecheck

# Sync to Android
npm run cap:sync
# equivalent to: npm run build && npx cap sync android

# Open in Android Studio
npm run cap:open

# Build debug APK (from project root)
cd android && ./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk

# Install on connected device
npm run cap:install
# equivalent to: adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

On-device WebView debugging: USB → enable developer options → enable USB debugging → `chrome://inspect/#devices` in desktop Chrome. Open the WebView entry; full breakpoints + performance profiler on real hardware.

---

## Phase 0 on-device gate — what to test, what to report

This is the go/no-go gate before any house-building begins (per PLAN.md §4.2).

### How to install
1. Enable Developer Options on your phone: Settings → About phone → tap "Build number" 7 times.
2. Enable USB debugging: Settings → Developer options → USB debugging ON.
3. Connect via USB. First time: phone shows "Allow USB debugging" — tap Allow.
4. On PC, install the APK:
   ```bash
   adb install -r "C:\Users\TIMOTHY\OneDrive\Desktop\daayan - main\android\app\build\outputs\apk\debug\app-debug.apk"
   ```
5. Open "Daayan's House" from the app drawer.
6. The app should boot into landscape, fullscreen, showing the 2-room shell.

### What to do in the app
- Use the **left joystick** to walk; **right-side drag** to look.
- Try the **Interact / Run / Crouch / Lantern** buttons (right side).
- **Triple-tap top-left corner** to toggle the debug overlay (shows FPS, draw calls, tris, render scale).
- Walk between the two rooms through the doorway.
- Watch the **skinned creature** in the middle — it should be wiggling its arms (proves the AnimationMixer + SkinnedMesh pipeline works on device).

### What to report back (numbers please)
Fill these in and reply to me with the values:

| Metric | How to read | Target (low tier) |
|---|---|---|
| FPS average | Debug overlay, top number | ≥ 30 |
| FPS 1% low | Debug overlay, second number | ≥ 24 |
| Draw calls | Debug overlay | ≤ 60 |
| Triangles (k) | Debug overlay | ≤ 50k |
| Resolution scale | Debug overlay | 0.6×-1.0× |
| Cold start | Time from app icon tap to playable scene | < 8 s |
| Heap usage | `chrome://inspect` → Memory tab on the WebView entry | < 300 MB |
| 10-min stability | Keep app open, walk around, no crashes, no thermal throttling | Pass |
| Animation works | The skinned creature wiggles its arms | Yes/No |

### If you can also run the desktop dev server
```bash
cd "C:\Users\TIMOTHY\OneDrive\Desktop\daayan - main"
npm run dev
# → http://localhost:5173
```
Open in Chrome, press `~` to toggle the debug overlay, and you can see the same numbers in real time. This helps separate "WebView-specific driver issues" from "general perf issues" — the on-device numbers are the gate, but the desktop numbers are useful diagnostic context.

### Pass / fail per PLAN.md §4.2
**Pass =** ≥ 30 FPS avg, ≥ 24 FPS 1%-lows, cold start < 8 s, heap < 300 MB, 10-min stable, animation plays.

If all pass → I proceed to **Phase 1** (core house shell + stairs + full movement).
If FPS is borderline (25-29 avg) → I tune QualityManager defaults down (lower render scale floor, smaller textures, no post-processing) and retest.
If FPS is unacceptable (< 20 avg) → I consider the fallback ladder in PLAN.md §4.3 (Babylon.js parity spike, then 2.5D pivot as last resort).
