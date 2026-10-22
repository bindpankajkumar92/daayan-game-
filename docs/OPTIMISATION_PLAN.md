# Daayan's House — Android Optimisation & Production Plan

## Context

Project: `D:\daayan game with optimsation\daayan - main` (Three.js 0.169 + TypeScript + Vite 5 + Capacitor 6, Android WebView).
Goal: smooth gameplay (≥30 fps sustained, 60 where possible) on 4 GB RAM Android phones (Adreno 610/613, Mali-G52 class, Android 10+), and a production-grade Play Store release. User is a beginner, so every phase says WHY in plain words.

Source: 5-area read-only audit (rendering, assets, world/draw calls, CPU/AI/UI, Android/build) + a skeptical lead-engineer review that corrected the draft.

Biggest problems found (verified in code / GLB parse):
1. Textures: 168 textures, nearly all 1024² WebP → ~616 MB uncompressed GPU memory, all kept resident by warm(). Decoded ImageBitmaps are never closed, so RAM holds a second copy. Main OOM/crash risk.
2. Quality tiers are fake: `textureMaxSize`, `maxRealTimeLights`, `shadowMapEnabled`, `fpsCap` have no consumers; tier detection puts Adreno 610 + 6 GB on "high" (QualityManager.ts:48-96).
3. GPU cost: 3 point lights per lit pixel (2 only for the hand, HeldLantern.ts:394-401), DPR cap 2.0 + 4x MSAA (Engine.ts:41,59), no fps cap (renders 90/120 Hz), two full-screen blend layers (FilmGrade + CSS vignette div main.ts:100-109).
4. No room culling: 50 m cull radius = whole house drawn (ModelProps.ts:2038-2047); 693k shipped triangles; fist-left.glb alone 98.6k tris drawn every frame; 0 InstancedMesh.
5. No pause/resume, no WebGL context-loss handling; debug-only Android build (v1/1.0, no signing, no R8).

Measured today (PROGRESS.md:548): Redmi test phone upper storey 1% low = 18.3 fps even at 0.65x auto-resolution; 116 draws, 100-172k tris in view.

Strengths to keep/reuse: Lambert/Phong conversion (ModelLoader.ts:99-151), no shadow maps + batched contact-shadow quads (ContactShadow.ts), single-quad FilmGrade, warm() precompile/upload, Batch.ts / HouseBuilder addMerged / Fixtures.mergeStaticChildren (Fixtures.ts:280-325), meshopt+quantisation on 49/50 GLBs, AI LOD tiers (DaayanConfig.ts:307-313), typed-array A*, DebugOverlay, tools/glb-report.mjs, shrink-textures.mjs, optimize-models.mjs, bake-floor.mjs, CDP probe scripts.

Labels: Impact H/M/L · Effort S (<1 day) M (1-4 days) L (1 week+) · [V] verified [I] inferred [A] assumption to confirm on device. Every phase ends with the Phase 0 perf walk on a real low-end phone with a freshly built APK.

**First step after approval:** copy this plan into the project as `docs/OPTIMISATION_PLAN.md`, then start Phase 0.

---

## Phase 0 — Baseline, bottleneck diagnosis, budgets
WHY: pata chale asli me kya slow hai (GPU fill, GPU vertex, CPU, GC ya memory) — bina measure kiye optimise karna andhere me teer hai.
- Fresh build → cap sync → install; har measurement se pehle installed APK `lastUpdateTime` vs source mtimes check (stale APK issue pehle ho chuka hai). Blocked-adb Redmi par Downloads-push workaround.
- DebugOverlay me add: `renderer.info.programs.length`, texture/geometry counts, custom VRAM estimator (w×h×bpp×1.33 per upload — `renderer.info.memory` sirf count deta hai), JS heap, render scale, tier, frame-time p50/p95/p99.
- Scripted CDP perf walk (adb forward + `Runtime.evaluate` via `window.__daayan`) on 5 views: upper storey, basement reveal, black-magic room, hallway sightline, daayan chase. Record fps, 1% low, p95, draws, tris, programs, VRAM est, heap, WebView PSS (`dumpsys meminfo`).
- Bottleneck tests: fixed camera at scale 0.5 vs 1.0 (fill-bound?), hand lights off, Chrome remote trace + allocation sampling during chase, EXT_disjoint_timer_query_webgl2 if exposed [A].
- Cold boot time, APK size, 20-min soak (fps drift, `dumpsys thermalservice`). Save to `perf/baseline-YYYYMMDD.json`.
Exit: baseline for ≥1 low-end device × 5 views, variance ≤10%, written verdict per view (fill/vertex/CPU/mixed). · H / S-M / risk L

## Phase 1 — Safety net
WHY: har change ko rollback kar sako aur breakage jaldi pakdo.
- Commit WIP (HouseBuilder/HouseLayout/HouseRooms), tag `pre-optimisation`, one branch per phase.
- Single scripted build: `npm run build` → `npx cap sync android` → gradle (`android:qa`, later `android:release`).
- `org.gradle.jvmargs=-Xmx4g` (hs_err log looks like Gradle OOM [I]).
- Flat `eslint.config.js` (ESLint 9), `tsc --noEmit` + lint green; pin exact dep versions; vitest for NavGrid/Memory/StateMachine/save; keep `check:ai`; pre-push/CI: typecheck, lint, check:ai, vitest, build.
- Cleanup of .chromeprof*, .dist-old*, tmp pngs, tmp-audit.mjs — ONLY after user confirmation (irreversible; archive if unsure).
Exit: one command builds a fresh APK, checks green, WIP committed. · M / S-M / L

## Phase 2 — Quick wins + resilience
WHY: chhote isolated changes jo zyada-tar wasted GPU kaam, garmi aur crash risk hata dete hain.
- 30 fps cap on low in GameLoop **together with** resolution-controller fix (QualityManager.ts:144-155): budget vs cap, input = real work time (perf.now around update+render), fixed steps 1.0/0.85/0.72/0.6, down after ~1 s over budget, up after 3-5 s under 70%. (Alag karoge to cap scale ko min par pin kar dega.) H
- Pixel budget instead of DPR cap: ~0.75 MP low, ~1.1 MP mid (Engine.ts:41, 96-126). Keep MSAA. H
- Remove hand PointLights flameLight/fillLight (HeldLantern.ts:394-401); arms/lantern via emissive / material-local term. warm() recompiles at boot. H
- Cull radius: read commit 852c6b3 for why 50 m; per-row radius (~20 m static props, larger for daayan/cat if AI needs). M-H
- Offline `gltf-transform resize`: 512 props, 256 tiny items, 1024 only daayan face, arms/lantern, hero walls → VRAM ~616 → ~150-180 MB. Visual check per room. H
- Fix pickInitialTier: Adreno 61x/62x low, 64x/65x mid, 66x+/7xx high; Mali-G52/G57 low; deviceMemory ≤4 → low; read GPU string from `engine.renderer.getContext()` (no second context, QualityManager.ts:21-31). M
- HUD: dirty checks in setters (Hud.ts:172-182, 225-233, 241-258), noise quantised to 1%, remove `backdrop-filter` (Hud.ts:88,138; DebugOverlay.ts:35), `transform: scaleX()` not `width`, CSS keyframe for max-noise pulse. H
- One full-screen layer: delete CSS vignette div (main.ts:100-109), fold into FilmGrade; grain off on low. M
- Menus/overlays open: render ~15 fps or freeze (main.ts:197-200). M
- Anisotropy 2/4 on floor/wall albedo only (ModelLoader.ts:69, HouseScene.ts:180). L
- Lifecycle: `@capacitor/app` (exact 6.x), pause/resume + visibilitychange in one Lifecycle service (absorb TouchControls.ts:481/498): pause → loop.stop, AudioContext.suspend (AudioManager.ts:69 only resumes), pause menu, flush save; resume → reset clock, continue on tap.
- Context loss: `webglcontextlost` preventDefault + stop + overlay; `webglcontextrestored` → re-run warm(), resume; fallback "Tap to reload" + restore save. Test 10× via WEBGL_lose_context.
- Spiral-of-death guard: accumulator = 0 when safetyBudget exhausted (GameLoop.ts:63).
Exit: 1% low ≥25 fps all 5 views, p95 ≤40 ms, VRAM est ≤200 MB, scale not pinned at min, <1 res change/min, context loss recovers 10/10, 5 min background = no audio, ~0% CPU, clean resume. · H / M (~4-6 days) / L-M

## Phase 3 — Minimal architecture the perf work needs
WHY: saare performance knobs ek jagah, asset lifetime control — bina risky big-bang refactor ke.
- **RenderProfile** read at boot by Engine, ModelLoader, HouseScene, HeldLantern, FilmGrade: pixelBudget, msaa, textureMaxSize, anisotropy, fpsCap, filmGrain, maxPointLights, cullRadius, fogDensity, logicHz, normalMapsOnProps, aiDecisionHz. Every field must have a consumer (grep check). Manual override persisted in Prefs.ts; MSAA change = "restart required".
- Runtime downgrade: scale at min >5 s → drop one tier (non-MSAA fields), persist.
- Frame/sim split: `simulate(fixedDt)` (player, collision, AI decisions, noise) vs `frameUpdate(frameDt, alpha)` (mixers, flicker, lerps, HUD, prompt). Prereq: Daayan mixer.update real dt (DaayanAI.ts:1004 hardcodes ~1/60).
- Lightweight asset refcount (acquire/release) on top of ModelLoader cache + per-asset VRAM estimate.
- EventBus copy-on-write listeners (EventBus.ts:33).
- Prod stripping: DebugOverlay + `window.__daayan` (main.ts:7,158,321-331) behind `DEV || VITE_QA_BUILD`; esbuild `drop:['debugger']`, `pure:['console.log','console.debug','console.info']`; CI grep fails if `__daayan` in release dist.
- Build flavours: dev / qa / release. Directory re-layout deferred.
Exit: every profile field consumed, tiers visibly differ, no DEV symbols in release dist, refcount test returns counts to baseline, no perf regression. · H / M / M

## Phase 4 — Texture memory (KTX2 + RAM copies)
WHY: 4 GB phone par texture memory hi OOM/crash ka sabse bada kaaran hai.
- gltf-transform KTX2: ETC1S albedo/emissive, UASTC normals + daayan hero. KTX2Loader (local transcoder, `detectSupport(renderer)`) next to MeshoptDecoder (ModelLoader.ts:187).
- Hair cards / alphaTest (ModelLoader.ts:129-145): keep WebP 512 if ETC1S alpha bands.
- Remaining WebP: explicitly decide `ImageBitmap.close()` after upload + re-fetch on context restore, OR keep and count in RAM budget. Document beside restore handler.
- Bake ProcTextures offline at 512 with 2-3 seeds (saves ~851 ms on device, ProcTextures.ts:25-31), like tools/bake-floor.mjs.
- Extend glb-report.mjs into budget gate (max tex size per class, VRAM per GLB, file size). Track download size separately (UASTC can grow files).
Exit: VRAM est ≤150 MB low, PSS ≤700 MB [A], warm() ≤1.2 s (from ~2.6 s), 0 context loss in 30-min soak, per-room screenshot sign-off, download growth ≤5 MB. · H / M / M

## Phase 5 — Mesh & asset pipeline
WHY: vertex kaam, skinning cost aur faltu bytes hatana.
- Offline `gltf-transform simplify`: fist-left 98.6k→5-8k, daayan 80.5k→15-25k (keep original for high, validate every clip), skeleton-mother-sitting 53.3k→8-10k, cat-still 34.2k→5-8k, bed 28.5k→5-8k, gate-main 21.7k→~8k, gothic-chair 37k→5-8k (if used).
- Bake unanimated skinned meshes to static: black-magic-room (13), basement (8), bottle (2).
- De-dup byte-identical pairs: stair-wood/stair-hidden, wardrobe-chateau/wardrobe-hidden (SkeletonUtils.clone + own mixer, ModelProps.ts:1756-1769) — ~32 MB VRAM.
- pbr_dark_diary.glb (3.3 MB PNG, 68 tris) → <200 KB.
- QA-build runtime load log → archive never-loaded assets (gothic-chair, hidden-room, wall-graffiti, skeleton-mother, necklace-heart, arms [I]) after confirmation.
- FrontSide default; DoubleSide allow-list (cards, cloth, hair, leaves) out of 129 doubleSided materials.
Exit: shipped tris ≤250k (from 693k), peak in-view ≤120k low, no skins in unanimated files, budget gate green. · H / M / M

## Phase 6 — Draw calls, batching, static transforms
WHY: CPU submission cost aur har frame scene-graph kaam kam karna.
- Offline join/flatten + per-room atlas: basement 61 prims→~8, hidden-room 68→~10, room-upper 22→~6 (keep animated/named nodes, ModelProps.ts:2673).
- daayan.glb 33 skinned prims → 2-4 sharing one skeleton + atlas.
- Runtime mergeStaticChildren (Fixtures.ts:280-325) on static GLB roots, after fit/carve/dressShell/wallColliders.
- Freeze static transforms: updateMatrixWorld(true) then `matrixAutoUpdate=false`, `matrixWorldAutoUpdate=false` (today only ModelProps.ts:2732).
- Instance repeats in a room (wall-damaged ×5, painting-sus ×2).
Exit: worst-view draws ≤90 low (from 116), programs reduced, updateMatrixWorld <0.5 ms/frame. · M-H / M / M

## Phase 7 — Room/portal visibility (PVS)
WHY: deewar ke peeche wale kamre draw karna band; basement reveal spike khatam.
- Hand-authored PVS for 18 HouseRooms ids; player room from HouseLayout AABBs.
- Tag MODEL_PLACEMENTS rows with roomId; bucket Batch.flush by (roomId, material) (Batch.ts:110-124).
- Toggle `visible` on room shells, batches, rows; adjacent rooms only if portal rect in frustum; closed doors (InnerDoor, UpperDoor, HiddenDoor, RitualDoors) trim set. Hide, never dispose; AI/audio must not read `visible`.
- Daayan mixer skip outside PVS/~25 m, accumulate time.
- QA overlay (room, visible/culled set) + scripted doorway screenshot walk; fog tied to cull distance on low.
Exit: worst-view draws ≤70, tris ≤90k low, basement reveal no +49 draws spike, no holes. · H / M-L / M

## Phase 8 — Lighting, materials, post per tier
WHY: har pixel ka kharcha kam, horror mood bacha ke.
- Low: lantern PointLight + hemi + ambient; fold moon DirectionalLight (HouseScene.ts:244) into hemi tint + emissive window patches.
- Low: Lambert without normal maps for small/distant props; Phong+normals on big near surfaces (ModelLoader.ts:99-103).
- Remove avoidable `renderer.info.programs` variants; FilmGrade low = vignette only, mediump.
- MSAA on both GPU families; A/B off only if still fill-bound.
Exit: low-tier GPU time ≥15% lower than Phase 7, programs ≤30, look sign-off per room. · M / S-M / M

## Phase 9 — CPU, AI, collision, garbage
WHY: slow cores par spikes aur GC jhatke hatana.
- Player collision: 2 m uniform grid reusing ObstacleGrid (Perception.ts:175), 3×3 query into preallocated array + dynamic list; same for groundYAt (FPController.ts:153-161, 421-458).
- A*: persistent typed MinHeap/neighbour buffers (NavGrid.ts:580,586), node cap ~4000 + time-slicing (exhausted = "pending", not "no route", NavGrid.ts:562-566), path cache + unreachable cache ~1 s (DaayanAI.ts:833-878, 955-960), forward-greedy segmentClear.
- AI allocations: scratch vectors (DaayanAI.ts:661, 747-748), `loco.eye(out)` (Locomotion.ts:252-255), reused directives (States.ts:65), array-free Memory.recompute (Memory.ts:95-124); respect aliasing notes (DaayanAI.ts:157-163).
- AI decisions 15-20 Hz; optional logicHz 30 on low with camera alpha interpolation (main.ts:285).
- Perception: Int32Array stamp dedupe, 2D DDA, reused results (Perception.ts:245-254, 307, 350-366).
- Interaction picking 10-15 Hz + squared-distance prefilter (Interaction.ts:92-120).
- DebugOverlay Float32Array ring, text 2-4 Hz (DebugOverlay.ts:69-88).
- Rule: no new/clone/spread/closures in per-frame code.
Exit: main-thread JS p95 ≤8 ms in chase, worst A* tick <1 ms, garbage <50 KB/s, no GC frame >50 ms in 5-min trace, check:ai + patrol tests pass, chase playtested. · H spikes / M / M

## Phase 10 — Loading & (conditional) streaming
WHY: jaldi boot; aur agar Phase 4 kaafi na ho to memory headroom.
- Build-time asset manifest (id, zone, hash, bytes, VRAM est) → real progress bar.
- Code split: three.js vendor chunk, lazy DebugOverlay/dev code; target es2020 [A].
- Splash `launchAutoHide:false`, hide on startupReady; Android 12 splash icon; recheck boot timeouts (main.ts:36-39).
- Audio: stream >20 s tracks via MediaElementAudioSourceNode, cap PositionalAudio ~8 voices.
- ONLY if PSS/soak still fails: zone streaming (ground, upper, basement wing, gated rooms) via refcount, prefetch at stairs/doors, sliced warm, keep startupPending/LOOKAHEAD=2 (ModelProps.ts:2590-2672).
Exit: cold boot → title ≤5 s, → playable ≤10 s low; no >50 ms frame at zone boundary. · M-H / M (L with streaming) / M-H

## Phase 11 — Android, Capacitor, release build
WHY: Play Store ko signed, current-API bundle chahiye, aur game native jaisa feel ho.
- Release signingConfigs from gitignored keystore.properties; 2 offline keystore backups; Play App Signing.
- minifyEnabled + shrinkResources + Capacitor ProGuard rules; smoke-test every plugin.
- bundleRelease AAB + QA APK; versionCode/Name from package.json.
- Target API per current Play policy [A: verify, likely 35/36]; Capacitor 6→7 (or 8) on a separate branch, pinned.
- minSdk 26-29; MainActivity sticky immersive (WindowInsetsControllerCompat) + FLAG_KEEP_SCREEN_ON during play (today only StatusBar.hide, main.ts:72).
- allowBackup=false or rules; INTERNET only if crash/analytics need it; WebView version check + update prompt [A]; android assets = fresh dist only.
Exit: signed AAB ≤35 MB download, launches on ≥3 devices without R8 breakage, immersive survives app switch, meets target-API policy. · H / S-M / M

## Phase 12 — Device matrix & automated perf regression
WHY: Adreno aur Mali alag behave karte hain, aur naye features dheere-dheere optimisation bigaad dete hain.
- Matrix: Mali-G52 4 GB (low), Adreno 610/613 4 GB (low), Adreno 619/642L / Mali-G57/G68 6 GB (low/mid), Adreno 7xx 8 GB+ (high), Android 10 old WebView 3-4 GB (low). Two Redmi phones + device farm.
- Automated perf walk on QA build (adb + CDP, JSON export); gate fails on >10% regression in p95 / draws / VRAM; static gates (GLB budgets, chunk size, dist size).
- 30-min soak on floor devices; RC smoke test (new game, all puzzles, chase, death/respawn, save/load, pause/resume, 10 min background); bug template (device, GPU, tier, build, overlay screenshot).
Exit: both floor devices meet low budget in 5 views + soak; gate blocked ≥1 deliberate regression. · H / M / L

## Phase 13 — Production launch
WHY: crash dikhe, settings hon, policy compliance ho, aur release process repeatable ho.
- Crash reporting (Sentry Capacitor / Crashlytics) from makeErrorSink (main.ts:148-150) + device, GPU, tier, fps percentiles, last 200 log lines.
- Opt-in analytics + consent + privacy policy + matching Play Data Safety form.
- Settings (Prefs.ts): graphics Auto/Low/Mid/High, fps 30/60, brightness, sensitivity, volume, subtitles, vibration.
- Accessibility basics (subtitles for audio cues, text size, colour-safe noise meter); full compliance needs manual testing with assistive tech.
- Versioned save schema + migration; save on pause and checkpoints.
- Release: internal → closed testing (12 testers / 14 days for new personal accounts [A]) → staged 10/50/100%. Store min spec: 4 GB RAM, Android 10+.
- Post-launch Android vitals (ANR/crash thresholds [A]) + weekly crash review.
Exit: zero reproducible crashes/ANRs in closed test on floor devices, settings persist, policy forms approved, staged rollout started. · H / M / L-M

---

## Performance budget table (worst perf-walk view)

| Metric | Low (4 GB) | Mid (6 GB) | High (8 GB+) | Today (low device) |
|---|---|---|---|---|
| fps cap | 30 | 60 (30 fallback) | 60 | uncapped |
| 1% low | ≥27 | ≥50 | ≥55 | 18.3 [V] |
| Frame p95 | ≤36 ms | ≤18 ms | ≤17 ms | not recorded |
| Main-thread JS p95 | ≤8 ms | ≤6 ms | ≤5 ms | not recorded |
| Longest gameplay frame | ≤50 ms | ≤33 ms | ≤33 ms | stair/basement spikes |
| Draw calls | ≤70 (≤90 pre-PVS) | ≤110 | ≤150 | 116 [V] |
| Triangles in view | ≤90k | ≤200k | ≤350k | 100-172k [V] |
| Shader programs | ≤30 | ≤35 | ≤40 | not recorded |
| Lights per fragment | 1 point + hemi + ambient | 1 point + 1 dir | 1 point + 1 dir | 3 point + 1 dir [V] |
| Full-screen blend layers | 1 | 1 | 1 | 2 [V] |
| Render buffer | ≤0.75 MP (MSAA) | ≤1.1 MP | ≤2.0 MP | 1.27 MP + 4x MSAA [V] |
| Texture VRAM (estimator) | ≤150 MB | ≤250 MB | ≤400 MB | ~616 MB [V] |
| Max texture size | 512 (1024 hero) | 1024 | 1024 | 1024 everywhere [V] |
| JS heap | ≤150 MB | ≤200 MB | ≤300 MB | not recorded |
| WebView PSS | ≤700 MB [A] | ≤1 GB | n/a | not recorded |
| Steady garbage | <50 KB/s | <100 KB/s | <100 KB/s | 600-900 obj/s AI [I] |
| Cold boot title / playable | ≤5 s / ≤10 s | ≤4 / ≤8 s | ≤3 / ≤6 s | up to 25 s timeout |
| Play download | ≤35 MB | same | same | 29.5 MB debug APK |
| Main JS chunk | ≤700 KB [A] | same | same | 860 KB [V] |
| Shipped GLB tris | ≤250k | same | same | 693k [V] |
| 30-min soak | no ctx loss, drift ≤10%, thermal ≤LIGHT | same | same | not recorded |

## Risk register

| # | Risk | Phase | Mitigation |
|---|---|---|---|
| R1 | Measuring a stale APK | all | lastUpdateTime check; single build script |
| R2 | Irreversible cleanup deletion | 1, 5 | Tag first; user confirmation; archive; runtime load log |
| R3 | 30 fps cap pins dynamic res at min | 2 | Cap + controller fix in one change |
| R4 | Cull radius revert breaks AI/cat | 2 | Read commit 852c6b3; per-row radius; chase playtest |
| R5 | Visual quality loss | 2, 4, 8 | Per-room screenshots; hero allow-list; tiers |
| R6 | MSAA not switchable at runtime | 3 | Renderer from profile at boot; "restart required" |
| R7 | Context restore fails after freeing ImageBitmaps | 2, 4 | Explicit re-fetch path or keep bitmaps; forced-loss ×10 |
| R8 | ETC1S artefacts / UASTC size growth | 4 | Per-class quality; WebP for hair; download budget |
| R9 | Frame/sim split breaks timing | 3, 9 | Fix mixer dt first; keep order; tests |
| R10 | Shared clone resources disposed | 3, 10 | Refcount; unit tests; QA assert |
| R11 | Merges break colliders/carve/name lookups | 5, 6 | Merge after fit/carve/colliders; keep named nodes |
| R12 | Daayan skin/anim artefacts after decimate/merge | 5, 6 | Validate every clip; original as high LOD |
| R13 | PVS holes / popping | 7 | Debug view; doorway walk; fog |
| R14 | A* slicing false "no route" | 9 | Exhausted = pending; keep old path; patrol tests |
| R15 | Streaming re-adds hitches | 10 | Only if needed; early triggers; sliced warm |
| R16 | R8 strips plugins / Capacitor upgrade regressions | 11 | ProGuard rules; separate branch; 3-device smoke |
| R17 | Lost keystore | 11 | Two offline backups; Play App Signing |
| R18 | Mali vs Adreno differences | 8, 12 | Both families in floor matrix; per-GPU overrides |
| R19 | Tier misclassification | 2, 3 | ≤4 GB = low; manual override; runtime downgrade |
| R20 | Assumed budgets wrong | 0 | Re-baseline and adjust table before Phase 2 |

## Verification (how each phase is proven)
- Phase 0 perf walk script (CDP + adb) re-run after every phase on the same low-end Redmi, with stale-APK check first; numbers compared against the budget table and `perf/baseline-*.json`.
- `npm run typecheck`, lint, `npm run check:ai`, vitest, `npm run build` green before every APK.
- Per-room screenshot comparison (existing CDP screenshot scripts) for any visual-affecting change.
- 30-min soak + forced context loss ×10 + background/resume test for memory/lifecycle phases.

## Assumptions to confirm on device
- [A] WebView memory ceiling on 4 GB phones ~500-800 MB (`dumpsys meminfo`).
- [A] GPU tier mapping (Adreno 61x/62x, Mali-G52/G57 = low).
- [A] EXT_disjoint_timer_query_webgl2 availability.
- [A] Current Play target-API, closed-testing and vitals thresholds; required Capacitor major.
- [I] Phase 0 verdict (fill/vertex/CPU-bound) decides weight of Phases 2, 5, 7, 9.
- [I] Dead-asset status needs runtime load log before removal.
