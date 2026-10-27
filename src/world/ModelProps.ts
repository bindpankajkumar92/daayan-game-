/**
 * ModelProps — where each imported .glb stands, as data.
 *
 * Coordinates follow HouseRooms: +x east, +z north, y up, ground floor at y = 0 and the basement
 * wing at BASE_Y. Every position here was chosen against that floor plan and against what
 * HouseProps already puts in the room, so nothing lands inside a dressing table.
 *
 * Two things this file deliberately does not do:
 *
 * - **It does not hard-code scale factors.** `height` is the metres the longest axis should measure
 *   and ModelLoader works out the factor from the file's own bounding box. These assets disagree
 *   about units by three orders of magnitude, and a table of magic numbers would be wrong again the
 *   next time one is re-exported.
 * - **It does not give the daayan behaviour.** She stands in the ritual room playing her clip,
 *   which is a scare that needs no AI. When the Phase 4 FSM lands it drives this same object.
 *
 * Loading is asynchronous and deliberately off the critical path: the house is playable on the
 * first frame and models appear as they arrive. Colliders are pushed into the array the controller
 * already holds by reference, which is the same trick the gate blocker uses. Once placed, each model
 * is distance-culled — see CULL_RADIUS_SQ, and the paragraph there about there being no walls as far
 * as the frustum is concerned.
 */

import { Box3, Group, Mesh, Vector3, type AnimationClip, type AnimationMixer, type Camera, type MeshBasicMaterial, type MeshLambertMaterial, type Object3D, type Scene, type Texture, type WebGLRenderer } from 'three';
import { BASE_Y, HALF_T, WALL_H, expandRun, type Segment, type WallRun } from '@/world/HouseLayout';
import { BACK_DOOR_E, BACK_DOOR_W, BEDROOM, BEDROOM_DOOR, CELLAR_DOOR, GATE, HALLWAY, HALL_WALLS, HID_FLIGHT_X0, HID_STAIR_WELL, KITCHEN_DOOR, LIVING, LIVING_DOOR, POOJA_DOOR, RITUAL_DOOR, ROOMS, STAIR_DOOR, STORE_DOOR, UPPER, UPPER_DOOR, UPPER_INNER, UPPER_INNER_CUT, UP_HIDDEN_CUT, UP_HIDDEN_DOOR, UP_HIDDEN_H, UP_HIDDEN_Y, UP_Y } from '@/world/HouseRooms';
import type { AABB } from '@/player/FPController';
import { aabbOf, leafBoxes } from '@/world/Fixtures';
import { fitToBox, fitToHeight, playClip, type ModelLoader } from '@/world/ModelLoader';
import { carveBoxes, type CarveBox } from '@/world/CarveBox';
import { WALL_TILE_U, WALL_TILE_V, worldUv } from '@/world/HouseBuilder';
import { SHADOW_LIFT, SHADOW_SPREAD, shadowUnitQuad } from '@/world/ContactShadow';

export interface ModelPlacement {
  /** File name under MODEL_DIR. */
  name: string;
  /**
   * Name this placement answers to, where the file name is not unique. Defaults to `name`.
   *
   * Two rows can share a file — door_inner is both the upper flat's inner leaf and the ground floor
   * bedroom's — and `name` is what `on` looks up, what the object is called in the scene graph, and
   * what `onPlaced` dispatches on. Left as the file name, the second row would answer to the first
   * row's hooks: armInnerDoor() would hinge the bedroom door as if it stood upstairs.
   */
  id?: string;
  /**
   * Take a copy of the loaded model rather than the model itself.
   *
   * ModelLoader caches by file and hands every caller the same Group, which is what keeps the daayan
   * from being loaded twice. Two rows for one file therefore need a copy, or the second placement
   * simply moves the first. Opt-in rather than automatic because Object3D.clone() does not rebind a
   * skeleton, so the skinned files — the daayan, the cats — must never take this path. clone(true)
   * shares geometry and materials, so a copy costs no GPU memory; it also means `albedo` must match
   * the row it is copied from, since brighten() dedups on the material it lands on.
   *
   * A copy also inherits rotation, and inherits it silently. Both apply steps read `if (p.yaw !==
   * undefined)`, so an omitted yaw does not mean zero, it means keep — and what is kept is whatever the
   * cached Group is already carrying. A clone only ever rotates its own copy, so the Group can only have
   * been turned by a row for the same file that has no `clone` and is placed earlier in this array. That
   * makes the hazard exactly one shape: a source row with a yaw, then a copy without one. Only
   * painting-sus.glb has it, and painting-sus-store therefore states `yaw: 0` rather than leaving it off.
   */
  clone?: boolean;
  /** Metres the longest axis should measure once placed. Ignored when `fit` is present. */
  height: number;
  /**
   * Exact world-space dimensions for rigid panels whose source aspect ratio must not dictate the wall
   * run they cover. `depth` is optional; omit it to retain the model's own thickness after x/y fitting.
   * Never use on skinned art — see fitToBox.
   */
  fit?: { width: number; height: number; depth?: number };
  x: number;
  z: number;
  /**
   * Floor height to stand on. Omit for the ground floor. With `on`, it is instead an offset from
   * the supporting model's measured top — negative to reach a mattress under a headboard, since the
   * measurement is a bounding box and a bounding box only knows the highest thing in it.
   */
  y?: number;
  /** Radians about y, applied before measuring so a collider matches the turned footprint. */
  yaw?: number;
  /**
   * Radians about x, applied with `yaw` and before measuring, for the one thing yaw cannot do: lay a
   * model down. Every other asset in this file arrives standing the way it should stand, so this is a
   * single-purpose field — the skeleton is authored upright and has to go into the coffin on its back.
   *
   * It changes what `height` means, because fitToHeight() measures the box *after* the caller's
   * rotation and scales by whatever the longest axis then is. A -pi/2 pitch lays a figure's height
   * along world z, so `height` still reads as its head-to-heel length; it is the model's own depth
   * that becomes the vertical, and the y a row is given seats the lowest part of that.
   */
  pitch?: number;
  /** Stand on top of an earlier entry's box rather than on the floor. */
  on?: string;
  /** Block the player. Furniture yes; characters and small dressing no. */
  collide?: boolean;
  /**
   * Trace this row's door leaf with this many boxes and stop drawing the row while the eye is inside
   * them. See leafBoxes, which holds the measurements and the reason one box is not enough.
   *
   * A collider was the first attempt, and it cannot work on a leaf standing ajar in a 0.9 m opening.
   * The eye needs 0.10 m of clearance — the near plane, no more — but a body needs 0.70 m of channel
   * to get past anything solid, and the leaf does not leave that. Measured: keep-outs on these twelve
   * rows walled off 50.1 m2 of the house, including the kitchen and the store entire, 21.2 m2 each,
   * because the way through those two doorways was always *through* the ajar leaf — which is the
   * policy the note at door-bedroom sets out. Not drawing it costs no floor at all, and drawing is the
   * only thing that has to stop: a triangle that is never submitted cannot straddle the near plane.
   *
   * Only for rows whose geometry is *all* leaf. `door-inner.glb` is two slab meshes and nothing else,
   * and the two `door.glb` clones down here drop their frame, so all twelve are safe. A row that keeps
   * its frame must not use this — the frame is the part standing in the wall, and hiding it opens a
   * hole over the doorway. The two doors that swing are armed instead, and those do carry keep-outs:
   * opening one takes its leaf out of the walk path, so the 0.70 m is there to spend.
   */
  leaf?: number;
  /**
   * Delete these subtrees before anything is measured. Prefixes of node names.
   *
   * A downloaded room is not only a room. basement.glb ships its own shell, its own stairwell, a roof,
   * a 34 m pipe, and two rigged figures — one of them hanging a metre and a half below the floor. The
   * shell is the reason this exists rather than a nudge to the placement numbers: the house already has
   * a basement with two doorways cut in it, and the model's walls are unbroken, so keeping them would
   * seal the only way in *and* out. Dropping them leaves the part that is actually worth importing —
   * the clutter — to dress the room the floor plan already agrees on.
   *
   * Names are matched on letters and digits only, because GLTFLoader does not hand back the name the
   * file wrote: see tag().
   */
  drop?: string[];
  /**
   * Give these subtrees a collider each, from their own world box. Prefixes of node names, as `drop`.
   *
   * `collide` is one box round the whole model, which is right for a table and absurd for a room — it
   * would wall off the cellar it is meant to furnish. `walls` is the other extreme and only finds
   * things that are long and thin. A washing machine is neither, and walking through one is the single
   * most obvious way an imported room reads as wallpaper rather than as a place.
   */
  solids?: string[];
  /** Index into the file's animation list, for the three that carry clips. */
  clip?: number;
  /** Playback rate for `clip`. */
  speed?: number;
  /**
   * Hide unless the player's eye is above this height. A storey is a y band, and with no occlusion
   * culling a radius cannot tell "upstairs" from "one wall away": the upper room's box centre is
   * 10 m from the hallway, well inside CULL_RADIUS_SQ, and it is the heaviest model in the game.
   */
  minEyeY?: number;
  /**
   * The other end of the same band: hide once the eye is above this height.
   *
   * The basement wing is the mirror of the upstairs problem. Its box centre is 19 m from the hall in x
   * but only 3 m in y, so the radius test calls it near while the player is standing on the floor above
   * it, and a phone spends its triangle budget on a cellar behind a slab. There is no occlusion culling
   * here to notice the slab, so the storey has to be stated.
   */
  maxEyeY?: number;
  /**
   * Multiply this model's base colours by k, once, at load.
   *
   * For files whose albedo was authored for a lit scene. Lambert puts irradiance through
   * BRDF_Lambert, i.e. a factor of 1/PI, so a map that measures #7c7c7c — which is what every mesh in
   * the upper apartment measures — comes back at 0.02 linear under the fill this house runs: black on
   * a phone in a lit room. Doubling the albedo doubles what the lantern lands on it too, which is why
   * this is the right place to fix it rather than pouring in ambient and flattening the room.
   *
   * Per channel. Clamped at 1 only where there is no base colour map, because there the factor *is*
   * the colour and pushing it past white just hands the tone mapper something to pull back. Where a map
   * exists the factor is a multiplier on it, three of these files ship it at exactly 1, and clamping
   * made `albedo` a no-op on the stair, the upper door and the main gate — the three darkest maps in the
   * game, means 41 to 68 grey, all read at half a metre by lantern. Above 1 is legal in linear space
   * and it is the only lever that reaches a dark map.
   */
  albedo?: number;
  /**
   * Raise this model's base colours with c' = c^g, once, at load, instead of multiplying them.
   *
   * `albedo`'s clamped multiply is right for a small prop and wrong for a whole room. room-upper.glb's
   * baseColorFactors are greyscale and run from 0.095 to 0.777, so at the 3.3 it used to carry, every
   * material at or above 0.303 — five of them, a third of the room — landed on the same pure white,
   * and the room came back flat: one rust-coloured surface where the file has plaster, tile, wood and
   * paint. A power curve in linear space is monotonic and bounded by 1, so nothing the artist made
   * different comes out the same and nothing clips, and it lifts hardest exactly where it is needed.
   * At g = 0.28 the darkest material goes 0.095 -> 0.52 and the brightest 0.777 -> 0.93, i.e. every
   * one of them at or above what the clamped 3.3 gave, with the file's own ordering intact.
   */
  curve?: number;
  /**
   * Multiply this model's base colours by k *after* `curve` has run. Ignored without `curve`.
   *
   * The curve fixes the ordering of the baseColorFactors and cannot fix their product with the maps,
   * because a power of a number below 1 is still below 1 and the map is the other half of the albedo.
   * Measured on the shipped room-upper.glb, its albedo maps mean 23 to 76 in sRGB bytes — 2 to 8% in
   * linear, against the ~50% a plaster wall has — so after the curve the flat still rendered at a mean
   * luminance of 16 to 22 with a third of every frame under 8/255. That is the "lantern does not work
   * up here" the player reported, and it is albedo, not light: fog off changes nothing, and ambient and
   * hemisphere at x2 buy 3 to 5 points upstairs while adding 16 to the stair, which is the one surface
   * in the house already near white.
   *
   * At k = 3 the black fraction at the threshold falls from 36% to 1% and in the corridor from 12% to
   * 0%, nothing anywhere clips, and the stair and the hall are untouched by construction — this lands
   * on one model's materials. The flat still reads at 30 to 57 against the hall's 89, which is the
   * intended order: it is a dark flat, not an unlit one.
   */
  gain?: number;
  /**
   * Multiply k into the *one* mapped material whose albedo map is darkest, after `curve` and `gain`.
   * Ignored without `curve`, and a no-op unless the next darkest material's colour x map product is at
   * least a quarter above it — so it lifts a clear outlier or it lifts nothing.
   *
   * `gain` is uniform because it corrects a uniform mistake, and it left one region behind: the north
   * living area still read 27 to 34% of frame under 8/255 with no missing geometry. Isolating each
   * material by emissive-white pixel jump attributed 19 to 24% of those frames to a single material
   * (`auto1`, one 113-triangle plane at y 5.29 spanning the whole footprint — the flat's ceiling) that
   * measured a mean texel of 25 against 28, 35, 38, 38 for the next four, and rendered at a mean of 4
   * to 6 with 75 to 85% of its own pixels black. Its colour x map product is 0.0192, the lowest of the
   * model's eighteen mapped materials, where the next is 0.0298 and the brightest 2.14 — which is why
   * raising `gain` for it is the wrong lever: the materials it would drag along already sit at 2.14 to
   * 2.80 in base colour and render correctly. At k = 6 its product becomes 0.115, mid-pack rather than
   * bottom, so the lift restores the file's ordering instead of inverting it.
   *
   * The map has no highlights to blow (p50 23, p95 53, max 78), which is what makes a multiplier this
   * large safe. Swept at three eye positions in that room: k = 4 takes its own black fraction to 22 to
   * 32%, k = 6 to 10 to 18% at a mean of 31 to 39 — level with the sealed shell's 31 to 35, which is
   * where a ceiling belongs — and k = 9 takes it to 43 to 54, brighter than the walls under a lantern
   * that is below it. Frame black over the same sweep: 29/27/34% at k1, 16/15/17% at k6, 15/14/16% at
   * k9. Nothing clips anywhere, even at k = 13. Hence 6: the knee, not the maximum.
   */
  lift?: number;
  /**
   * Move this model's image out of the *emissive* slot and into the albedo slot, so the lantern lights
   * it instead of the material lighting itself.
   *
   * For a file authored to glow that is being used as an object in a room. painting-sus.glb is the case
   * and the only one: it carries its 64x64 canvas in `emissiveMap` at white x1 over a black base colour,
   * which means the material ignores every light in the house. Measured on the phone at eye height, two
   * boxes read from the same frames: the canvas came back at mean 110.2 at 1.4 m and 111.3 at 2.6 m —
   * flat, within noise — while the plaster a canvas-and-a-half to its side moved 80.3 -> 98.5 as the
   * lantern was carried past it. A picture on a wall that does not dim when the only light in the room
   * walks away is the whole of what the player was reporting as a glitch in that wall: a bright rectangle
   * that stays bright in a corridor that does not.
   *
   * `albedo` is the wrong lever for it, because the black base colour is what the map is multiplied by
   * and any multiple of black is black. The image has to change slots, and then `albedo` on the same
   * row is free to lift it if the map turns out dark — the two run in that order.
   *
   * Idempotent by construction, which matters because ModelLoader hands the same cached Group to every
   * caller: once the image is in `map` there is no `emissiveMap` left to move, so a second install and a
   * second row for the same file are both no-ops.
   */
  lanternLit?: boolean;
  /**
   * Make a fully transparent, un-mapped material under this model opaque at load.
   *
   * room-upper.glb ships its 16.7k-triangle outer shell as alphaMode BLEND with baseColorFactor
   * 0/0/0/0 — invisible by authoring. ModelLoader honours that faithfully, which leaves the apartment
   * with no exterior wall at all: from outside, the frustum runs straight through it into rooms whose
   * own walls are single-sided and face inward, and the same wall reads solid from inside because what
   * is being seen there is the interior. Sealing it is also worth 6.5 ms a frame at the far corner,
   * measured — depth-write-off blend geometry cannot early-Z reject the room behind it.
   */
  seal?: boolean;
  /**
   * Build colliders out of this model's own walls, instead of hand-authoring them alongside it.
   *
   * `seal` turned room-upper.glb's cutaway layer solid, and that exposed the real problem: the flat has
   * a floor plan and the game had colliders for a bare box. Measured on the phone, 276 of the 431
   * quarter-metre cells that hold a wall at chest height had nothing behind them, so two thirds of the
   * walls up there were scenery the player strolled through — the perimeter was airtight (walk test:
   * eight headings, no escapes) and every partition inside it was not.
   *
   * Hand-authoring twenty more collideOnly walls in HouseRooms would fix this file and then rot the
   * next time it is re-exported, and three more imported rooms are about to arrive. So the walls come
   * from the geometry: slice the model at chest height, keep the runs that are long and thin enough to
   * be wall rather than a 5 cm pipe, and merge them into a few dozen boxes. Doorways in the model
   * become gaps in the colliders for free, because there is nothing there to slice.
   *
   * Heights are metres above this model's own floor.
   */
  walls?: {
    /** Bottom of the slice. Above the skirting, so a moulding does not read as a wall. */
    y0: number;
    /** Top of the slice. Below the lintels, so the wall over a doorway does not close it. */
    y1: number;
    /** How far up the emitted boxes reach, so a wall cannot be stepped over. */
    top: number;
  };
  /**
   * Subtract these world-space boxes from the model's triangles before anything else reads them.
   *
   * For a downloaded room with a wall where the floor plan needs a doorway. The upper flat is the case:
   * the panel between the room its front door opens into and the corridor beyond is 3.45 x 2.92 m of
   * unbroken double-skinned wall, which sealed 43.8 m2 of a 59 m2 flat — every room past the first.
   *
   * A hand-placed gap in the collider set is the wrong tool, because `walls` above exists precisely so
   * that what stops the player is what is drawn; a gap without a hole is a wall the player walks
   * through. And dropping whole triangles is not enough either, since this file spans 2.5 m on a single
   * triangle where it is flat. So the geometry is really cut, by clipping; see CarveBox. Ordering
   * matters — the carve runs before `walls`, so the collider gap falls out of the hole for free.
   */
  carve?: CarveBox[];
  /**
   * Put a contact shadow under this model, at this fraction of its fitted footprint. See ContactShadow.
   *
   * Opt-in per row rather than inferred, and the three imported rooms are why. A shadow is sized from
   * the fitted bounding box, and basement.glb's box is 22 x 24 m — a rule clever enough to include the
   * beds would have put a single dark ellipse over the entire cellar floor, and any test that excludes a
   * room by size is a test that excludes the next large prop by accident. The rows that want one say so.
   *
   * The fraction is here because a bounding box is not a contact area. It is 1 for furniture, whose box
   * *is* roughly what meets the floor, and well under 1 for a figure: the daayan's box is her silhouette
   * with her arms out, and a shadow that size reads as a puddle she is standing in rather than as her.
   *
   * Not for anything off the floor. `y` is absolute for a row without `on`, so a painting at y 1.6 would
   * get a shadow hanging in mid-air at 1.6 — which is why the two paintings and the door leaves have no
   * entry here. Nor for a row whose `y` is *below* the floor it stands on: stair-wood.glb is seated at
   * -0.058 so its own bottom step meets the shaft floor, and a shadow SHADOW_LIFT above that seat is
   * 4.6 cm under the floor and draws nothing.
   *
   * And not for the two wall facings, for a reason that is about the shape rather than the height. Both
   * are long, thin and flush to a wall — wall-damaged is 0.37 x 3.0 on the floor — so one isotropic
   * falloff cannot be tight along the length and generous across the depth at the same time: at a
   * fraction wide enough to show in front of the stub, the quad runs 0.65 m past the hall's south wall
   * and out over the void beside the porch. They are also the rows that need it least, standing where
   * the wall already meets the floor and hiding their own contact line from the front.
   */
  shadow?: number;
  /**
   * Load this row before the rest, whatever order it is written in. For anything already in frame at
   * the moment the player gains control.
   *
   * The list below is authored in room order because that is the only order a human can check a floor
   * plan against, and the loop that consumes it is serial — one model at a time, so a 3 MB file is not
   * decoding while the next one downloads. Those two facts together are what the player saw: the main
   * gate is the last row in the file, directly ahead of the spawn, and it therefore faded in four or
   * five seconds after the game had started, out of an empty doorway the player was already looking at.
   *
   * Serial is worth keeping — it is what stops a phone parsing six meshes at once during the first
   * seconds — so this reprioritises rather than parallelises. See loadOrder: `first` rows are placed
   * ahead of everything else, and a row's `on` support is still guaranteed to come before it.
   *
   * Reach for it sparingly. Every row marked `first` delays every other `first` row, so it is for what
   * is visible from the spawn, not for what is important.
   */
  first?: boolean;
}

/**
 * A fitted damaged-wall facing, in millimetres, shared by every run in the house.
 *
 * REVEAL is the gap left at each jamb and corner, Y_REVEAL the one left at floor and ceiling: the
 * casing and the skirting cover both, and they stop art from crossing a walkable opening or standing
 * proud of the ceiling line. DEPTH is the facing's own thickness and FACE_LIFT how far in front of the
 * plaster it hangs, so a panel centred at HALF_T + FACE_LIFT occupies 0.06 .. 0.16 inward of the wall
 * centreline — 6 cm proud of an inner face at 0.10. That is what props near these walls have to clear.
 */
const PANEL_REVEAL = 0.05;
const PANEL_Y_REVEAL = 0.005;
const PANEL_DEPTH = 0.1;
const PANEL_FACE_LIFT = 0.01;

/**
 * Fit damaged-wall panels from the same solid segments the structural shell uses.
 *
 * `collide` is the interesting flag. With it the panel emits a `walls` slice and the run it came from
 * must carry `modelCollision`, so the scanned geometry owns collision and the shell only draws — that
 * is the hall. Without it the shell keeps collision and the panel is pure facing, which is what the
 * hallway has always done and what every run added since follows. The choice is not cosmetic:
 * wallColliders drops any run under WALL_MIN_RUN entirely, so `collide` on a wall with a short corner
 * stub beside a doorway would leave that stub with no collider at all and let the player walk through
 * it. Facings are the safe default; `collide` is for runs measured and known to be long.
 *
 * `minEyeY` passes straight through to the row's storey cull. It matters for a room on the upper floor:
 * the distance cull's 20 m radius reaches from the hallway to the flat, so without it the whole upper
 * wing's facings are submitted every frame the player spends downstairs, hidden behind a floor the
 * renderer knows nothing about.
 */
function wallPanels(
  prefix: string,
  run: WallRun,
  inwardX: number,
  inwardZ: number,
  yaw: number,
  floorY: number,
  ceilY: number,
  opts: { first?: boolean; collide?: boolean; minEyeY?: number } = {},
): ModelPlacement[] {
  const alongX = Math.abs(run.x2 - run.x1) > Math.abs(run.z2 - run.z1);
  const runA0 = alongX ? Math.min(run.x1, run.x2) : Math.min(run.z1, run.z2);
  const runA1 = alongX ? Math.max(run.x1, run.x2) : Math.max(run.z1, run.z2);
  return expandRun(run, floorY, ceilY).map((segment: Segment, index) => {
    const segA0 = alongX ? Math.min(segment.x1, segment.x2) : Math.min(segment.z1, segment.z2);
    const segA1 = alongX ? Math.max(segment.x1, segment.x2) : Math.max(segment.z1, segment.z2);
    // Reverse expandRun's collider padding, then leave a reveal at every jamb and corner.
    const a0 = Math.max(runA0, segA0 - HALF_T) + PANEL_REVEAL;
    const a1 = Math.min(runA1, segA1 + HALF_T) - PANEL_REVEAL;
    const height = segment.y1 - segment.y0 - PANEL_Y_REVEAL * 2;
    const sliceInset = height > 1 ? 0.2 : 0.05;
    const row: ModelPlacement = {
      name: 'wall-damaged.glb', id: `${prefix}-${index}`, clone: true,
      height, fit: { width: a1 - a0, height, depth: PANEL_DEPTH },
      x: alongX ? (a0 + a1) / 2 : run.x1 + inwardX * (HALF_T + PANEL_FACE_LIFT),
      y: segment.y0 + PANEL_Y_REVEAL,
      z: alongX ? run.z1 + inwardZ * (HALF_T + PANEL_FACE_LIFT) : (a0 + a1) / 2,
      yaw, albedo: 1.6,
    };
    if (opts.first === true) row.first = true;
    if (opts.minEyeY !== undefined) row.minEyeY = opts.minEyeY;
    if (opts.collide === true) row.walls = { y0: sliceInset, y1: height - sliceInset, top: height };
    return row;
  });
}

/**
 * Every solid run of one room, faced, with the inward direction worked out rather than written down.
 *
 * A run is a line, so which side of it the room is on is not in the run — but it is in the room: the
 * floor rect's centre is inside it by definition, so the sign from the wall's line to that centre is
 * the inward normal, and the yaw follows from it. The four cases match what the hall's panels were
 * given by hand, which is how this was checked: south (inward +z) yaw 0, west (+x) a quarter turn,
 * east (-x) a quarter turn back, north (-z) a half turn.
 *
 * `collideOnly` runs are skipped. Those exist exactly where an imported model already draws the wall,
 * and facing them would put two walls in the same place.
 */
function roomWallPanels(roomId: string, opts: { first?: boolean; collide?: boolean; minEyeY?: number } = {}): ModelPlacement[] {
  const room = ROOMS.find((r) => r.id === roomId);
  if (room === undefined) return [];
  const cx = (room.floor.x0 + room.floor.x1) / 2;
  const cz = (room.floor.z0 + room.floor.z1) / 2;
  const out: ModelPlacement[] = [];
  for (const [index, run] of room.walls.entries()) {
    if (run.collideOnly === true) continue;
    const alongX = Math.abs(run.x2 - run.x1) > Math.abs(run.z2 - run.z1);
    const inwardX = alongX ? 0 : Math.sign(cx - run.x1);
    const inwardZ = alongX ? Math.sign(cz - run.z1) : 0;
    const yaw = alongX ? (inwardZ > 0 ? 0 : Math.PI) : inwardX * (Math.PI / 2);
    out.push(
      ...wallPanels(`${roomId}-wall-${index}`, run, inwardX, inwardZ, yaw, room.floorY, room.floorY + room.height, opts),
    );
  }
  return out;
}

const HALL_WALL_PANELS: ModelPlacement[] = [
  ...wallPanels('hall-wall-south', HALL_WALLS.south, 0, 1, 0, 0, WALL_H, { first: true, collide: true }),
  ...wallPanels('hall-wall-west', HALL_WALLS.west, 1, 0, Math.PI / 2, 0, WALL_H, { first: true, collide: true }),
  ...wallPanels('hall-wall-east', HALL_WALLS.east, -1, 0, -Math.PI / 2, 0, WALL_H, { first: true, collide: true }),
  ...wallPanels('hall-wall-north', HALL_WALLS.north, 0, -1, Math.PI, 0, WALL_H, { first: true, collide: true }),
];

/**
 * The bedroom, the living room and the basement, faced with the same scan as the hall and the hallway.
 *
 * These are facings, not colliders — see wallPanels — so no run in HouseRooms needed `modelCollision`
 * and the procedural shell still stops the player 0.35 m from the plaster, i.e. 0.29 m from the panel
 * front. The hallway has shipped on that arrangement since it was built.
 *
 * The bedroom's are `first`, the other two rooms' are not. The player now wakes on the bedroom bed
 * facing its doorway, so those three runs are the first walls in frame and the intro waits for them;
 * the living room and the basement are behind a closed door and can arrive whenever they arrive. Each
 * row clones a file that is downloaded once, so a `first` row here costs a clone and a fit, not a
 * fetch — which is why the whole bedroom can go in the gate without pushing the gate out.
 *
 * The window on the bedroom's west wall and the doorway on the living room's north wall each split
 * their run into a sill and a header panel, both of them wider than tall. The scan is stretched
 * non-uniformly to fill them, exactly as the hall's archway header already is, and both sit behind
 * their casing where the aspect does not read.
 */
const BEDROOM_WALL_PANELS: ModelPlacement[] = roomWallPanels('bedroom', { first: true });

/**
 * The bedroom's south wall — the fourth side, which `roomWallPanels('bedroom')` cannot reach.
 *
 * The bedroom's `walls` array in HouseRooms has only three runs: west with the window, north, and east.
 * Its south side is not missing, it is *owned by the hallway* — one run along HALLWAY.z1 spanning the
 * corridor's full 18 m with both bedroom and living-room doorways punched in it, which is the right way
 * to author a shared partition (one wall, one collider, two openings) and the reason the bedroom loop
 * above finds nothing to face there. So the room's other three sides came up as damaged masonry and this
 * one stayed bare plaster, which is exactly the wall the player wakes up looking at: the clock, the
 * strongbox and the door to the corridor are all on it.
 *
 * Hence a run written here rather than read from a room. It is the same line from the bedroom's side:
 * z = BEDROOM.z0 = HALLWAY.z1, spanning only the 8 m the bedroom actually owns (x -9 .. -1, stopping at
 * the partition its own east facing covers), with the bedroom doorway's opening so the header above the
 * door is faced and the doorway itself is not. inward (0, +1) and yaw 0 — south wall seen from the
 * north, the same pair `hall-wall-south` uses. No `collide`: the hallway run has no `modelCollision` and
 * must not get one, since it is load-bearing for the corridor too.
 *
 * Three panels come out: x -7.4 and x -2.6 full height either side of the door, and a 1.5 x 0.89 header
 * at x -5.0. Panel centre z 2.71, front face 2.76 — 6 cm proud of the plaster, which is what moved
 * PLACE.clock 6 cm forward in HouseProps and is worth checking against anything else hung here.
 *
 * `first`, for the reason the other three runs are: it is the wall in frame when control is handed over.
 * The hallway's own facing of the far side of this same wall is hand-written further down, at z 2.49.
 */
const BEDROOM_SOUTH_WALL_PANELS: ModelPlacement[] = wallPanels(
  'bedroom-wall-south',
  {
    x1: BEDROOM.x0, z1: BEDROOM.z0, x2: BEDROOM.x1, z2: BEDROOM.z0,
    openings: [{ at: BEDROOM_DOOR.x, half: BEDROOM_DOOR.half, y1: BEDROOM_DOOR.top }],
  },
  0, 1, 0, 0, WALL_H,
  { first: true },
);
const LIVING_WALL_PANELS: ModelPlacement[] = roomWallPanels('living');
const LIVING_SOUTH_WALL_PANELS: ModelPlacement[] = wallPanels(
  'living-wall-south',
  {
    x1: LIVING.x0, z1: LIVING.z0, x2: LIVING.x1, z2: LIVING.z0,
    openings: [{ at: LIVING_DOOR.x, half: LIVING_DOOR.half, y1: LIVING_DOOR.top }],
  },
  0, 1, 0, 0, WALL_H,
);
const LIVING_WEST_WALL_PANELS: ModelPlacement[] = wallPanels(
  'living-wall-west',
  {
    x1: LIVING.x0, z1: LIVING.z0, x2: LIVING.x0, z2: LIVING.z1,
  },
  1, 0, Math.PI / 2, 0, WALL_H,
);

const HALLWAY_EXTENDED_PANELS: ModelPlacement[] = [
  { name: 'wall-damaged.glb', id: 'hallway-wall-south-arch-header', clone: true, height: 0.59, fit: { width: 3.1, height: 0.59, depth: 0.1 }, x: 0, y: 2.405, z: 0.11, albedo: 1.6 },
  { name: 'wall-damaged.glb', id: 'hallway-wall-north-bed-header', clone: true, height: 0.89, fit: { width: 1.5, height: 0.89, depth: 0.1 }, x: -5.0, y: 2.105, z: 2.49, albedo: 1.6 },
  { name: 'wall-damaged.glb', id: 'hallway-wall-north-living-header', clone: true, height: 0.89, fit: { width: 1.5, height: 0.89, depth: 0.1 }, x: 5.0, y: 2.105, z: 2.49, albedo: 1.6 },
  ...wallPanels('hallway-wall-west', { x1: HALLWAY.x0, z1: HALLWAY.z0, x2: HALLWAY.x0, z2: HALLWAY.z1, openings: [{ at: CELLAR_DOOR.z, half: CELLAR_DOOR.half, y1: CELLAR_DOOR.top }] }, 1, 0, Math.PI / 2, 0, WALL_H),
  ...wallPanels('hallway-wall-east', { x1: HALLWAY.x1, z1: HALLWAY.z0, x2: HALLWAY.x1, z2: HALLWAY.z1, openings: [{ at: STAIR_DOOR.z, half: STAIR_DOOR.half, y1: STAIR_DOOR.top }] }, -1, 0, -Math.PI / 2, 0, WALL_H),
];

const BASEMENT_WALL_PANELS: ModelPlacement[] = roomWallPanels('basement');

/**
 * The three procedural rooms that were still bare plaster: the cellar stair shaft, the ritual room,
 * and the upper stair shaft.
 *
 * These are facings, not colliders — same as the basement's — so no run needed `modelCollision` and
 * the shell keeps stopping the player. The two shafts are tall (5.4 and 4.6), so their side panels
 * stretch the scan further than a room-height wall does; that is the same non-uniform fit every other
 * panel uses and it reads as a long run of the same damaged plaster, which is the point. The shafts'
 * stair models sit between these walls, so the panels land behind them and only show above the treads
 * when looking down — a damaged wall going down a hole, not a wall through a stair.
 *
 * The ritual room's east side is not in its `walls` at all — that is the basement's west run carrying
 * RITUAL_DOOR, already faced by BASEMENT_WALL_PANELS — so this faces the three sides the room owns.
 */
const SHAFT_WALL_PANELS: ModelPlacement[] = roomWallPanels('shaft');
const RITUAL_WALL_PANELS: ModelPlacement[] = roomWallPanels('ritual');
const UPSHAFT_WALL_PANELS: ModelPlacement[] = roomWallPanels('upshaft');

/**
 * The two new wings — the ground floor's rear corridor with its three rooms, and the upper storey's own
 * three rooms south of the imported flat.
 *
 * Nothing here is hand-written, which is the point of roomWallPanels: each of these reads the same
 * `walls` array the structural shell and the colliders come from, so a doorway that moves in HouseRooms
 * moves its facing with it and cannot end up faced over. Same rule as everything since the hallway — no
 * `collide`, so the procedural shell keeps collision and these are pure facing.
 *
 * The upper three carry `minEyeY: 1.9`, the same threshold every other row on that storey uses. Without
 * it their panels sit inside the 20 m distance cull from most of the ground floor and would be drawn
 * through the floor all game; with it they exist only while the player's eye is above the hallway's head
 * height, which can only happen up the stair.
 *
 * The corridor's south side is missing from this list by design: it is the bedroom's and living room's
 * north runs, faced from the other side by BEDROOM_WALL_PANELS and LIVING_WALL_PANELS. Those two rooms
 * each grew a doorway in that wall, so the panels either side of it fall out of the same run and the
 * header over the door is faced with it.
 */
const BACKHALL_WALL_PANELS: ModelPlacement[] = roomWallPanels('backhall');
const KITCHEN_WALL_PANELS: ModelPlacement[] = roomWallPanels('kitchen');
const POOJA_WALL_PANELS: ModelPlacement[] = roomWallPanels('pooja');
const STORE_WALL_PANELS: ModelPlacement[] = roomWallPanels('store');
const UP_STORE_WALL_PANELS: ModelPlacement[] = roomWallPanels('up-store', { minEyeY: 1.9 });
const UP_CHILD_WALL_PANELS: ModelPlacement[] = roomWallPanels('up-child', { minEyeY: 1.9 });
const UP_SHRINE_WALL_PANELS: ModelPlacement[] = roomWallPanels('up-shrine', { minEyeY: 1.9 });

/**
 * The flat itself, whose four shell-drawn runs were the last bare plaster the player could walk up to.
 *
 * `upper` is `modelled: true`, and that is the whole reason this was missed: the imported cutaway draws
 * nearly every wall in the room with its own scanned masonry, so the room *looks* faced, and the runs in
 * its `walls` array read as the plumbing of a modelled room rather than as walls anyone would see. Four
 * of them are drawn all the same — the model is a diorama missing its west side over the stair's half of
 * the plan and both outside walls of the bathroom — and `upper` is cellar-toned, so those four came out
 * in the blue-grey `wallCool` plaster while everything they touch is warm scan. That is the fault in the
 * photographs: full-height plaster on both cheeks of the entrance door and of UP_BACK_DOOR, meeting the
 * model's own walls at a hard seam with the facing's 6 cm step exposed edge-on beside it.
 *
 * Nothing here has to know which runs those are. roomWallPanels skips `collideOnly`, and every wall the
 * model draws itself is already marked that way — it had to be, or the shell would have drawn a second
 * wall inside the first — so this faces exactly the four runs the shell draws and none of the seven it
 * only collides with. Eight panels, and the two doorway headers among them come out of expandRun with
 * the rest.
 *
 * `minEyeY: 1.9` for the reason the three rooms above it carry it, and here it also pays for itself: the
 * flat is 2.4 m up, so all eight are culled outright until the player is on the stair.
 *
 * Not the black magic room, which the same audit flags for the same shape of reason and where facing
 * would be the bug: its three shell runs stand *behind* an imported room that draws its own four walls,
 * so a facing there would put two walls in the same place. See the row at 'black-magic-room.glb'.
 */
const UPPER_WALL_PANELS: ModelPlacement[] = roomWallPanels('upper', { minEyeY: 0 });

/**
 * The hidden room, and it was the last bare plaster in the house.
 *
 * Every other room got a damaged-wall facing when the audit found them — the hall, the hallway, both
 * wings, the basement, the cellar shaft, the ritual room and the upper shaft. This one was missed for
 * the same reason the flat's four runs were: it is *under* another storey and behind a door, so it is
 * only ever seen by a player who has already found it, and it reads as "the room nobody has finished"
 * rather than as a wall anyone forgot. Looking down the stairwell from the nook you are looking
 * straight at these four runs, which is what the report was about.
 *
 * Its four runs are shell-drawn and none is `collideOnly`, so `roomWallPanels` faces all four — the
 * same contract as every other room in this list, and no run needed touching. Its doorway is in the
 * *nook's* west wall rather than in one of these, so there is no opening to fall out of the run and
 * nothing here has to know about the door.
 *
 * `minEyeY: 0`, not the 1.9 the other upper-storey rooms carry. This room's floor is at 0.2, not 2.4:
 * the player's eye is 1.9 while standing in it, so a 1.9 threshold would cull the panels away at
 * exactly the one vantage they exist for. The 20 m cull does reach them from the ground floor, but
 * unlike the flat's runs these are genuinely enclosed — the ground floor's own east wall stands
 * between — so there is nothing to draw through.
 */
const UP_HIDDEN_WALL_PANELS: ModelPlacement[] = roomWallPanels('up-hidden', { minEyeY: 0 });

/**
 * The stairwell's own two sides, faced — the runs `roomWallPanels('up-hidden')` cannot place well.
 *
 * `roomWallPanels` derives each run's inward direction from the *room's* centre, and that derivation is
 * only right for a run with room on one side and outside on the other. Both of these break it, and in
 * opposite ways: the north lip's plaster is toward the *entry room*, north of it, and the south lip's
 * well-facing side is north of it as well — both sit north of the room's centre line, so the derived
 * direction puts one panel inside the stair, over the flight, and gives the other run a second facing on
 * the room side, where `roomWallPanels` has already placed one.
 *
 * The other face of each run needs nothing here. The north lip's south face is inside the well, behind
 * the flight, which fills its column exactly; the south lip's south face is inside the room, where it is
 * the room's own wall facing continued over the lip line. That second one is also what stops the shaft
 * reading as unscanned plaster from below — the report that put the room's own four rows in this list.
 *
 * The runs are copied from HouseRooms' list rather than restated from measurements, and both rise 0.45
 * over `UP_Y`. `expandRun` picks a run's own y1 up in preference to the two arguments, so passing
 * `UP_HIDDEN_Y` as floorY is what keeps the facings running from the room's own floor — where the flight
 * and the room are — up to the top of the parapet.
 */
/** The imported flat's ceiling, 2.89 above its floor — see the `upper` room's `height`. */
const UPPER_CEIL = UP_Y + 2.89;

const UP_HIDDEN_STAIRWELL_PANELS: ModelPlacement[] = [
  // North lip, inward toward +z: the face the player sees across the well from the entry room.
  ...wallPanels(
    'up-hidden-kerb-north',
    { x1: HID_STAIR_WELL.x0, z1: HID_STAIR_WELL.z1 + HALF_T, x2: HID_STAIR_WELL.x1, z2: HID_STAIR_WELL.z1 + HALF_T, y1: UP_Y + 0.45 },
    0,
    1,
    0,
    UP_HIDDEN_Y,
    UP_Y + 0.45,
    { minEyeY: 0 },
  ),
  // West head wall, inward toward +x: the face the player sees looking down the stairwell.
  {
    name: 'wall-damaged.glb',
    id: 'up-hidden-head-west',
    clone: true,
    height: UPPER_CEIL - UP_Y,
    fit: {
      width: (HID_STAIR_WELL.z1 + HALF_T) - (HID_STAIR_WELL.z0 - HALF_T),
      height: UPPER_CEIL - UP_Y,
      depth: PANEL_DEPTH,
    },
    x: HID_STAIR_WELL.x0 + HALF_T + PANEL_FACE_LIFT,
    y: UP_Y + PANEL_Y_REVEAL,
    z: (HID_STAIR_WELL.z0 + HID_STAIR_WELL.z1) / 2,
    yaw: Math.PI / 2,
    albedo: 1.6,
    minEyeY: 0,
  },
];

/**
 * The nook, faced — the room the hidden door opens off, whose walls the model draws as bare boards.
 *
 * This is the one place in the house where `roomWallPanels` cannot be used, and the reason is worth
 * stating because it is invisible from the outside. Every run round the nook is `collideOnly`, because
 * `room-upper.glb` draws them itself, and `roomWallPanels` skips `collideOnly` by design — so the nook
 * was never faced and its walls still read as raw boards. Every other `collideOnly` run in the flat
 * *should* be skipped: the model gives them scanned masonry, and a facing there would put two walls in
 * the same place. The nook is the exception, because the boards the model draws for it are the one
 * thing in the flat that does not look finished. Reported as "where are the walls, where is the cover".
 *
 * Written out rather than derived, for a second reason: `roomWallPanels` takes its inward direction
 * from the *room's* centre, and the nook is a corner of a much larger flat — the flat's centre is north
 * of the nook's north wall, so the derived inward for that run points the wrong way and the panel would
 * hang on the far side of its own wall. Each run below states its inward vector explicitly.
 *
 * No `collide`: the model already stops the player and a facing that also collided would fight it. The
 * runs and their openings are copied from HouseRooms' list, so the hidden door's hole comes through as
 * a hole in the panel rather than being faced over.
 */
const NOOK = { x0: 18.4, x1: 21.3, z0: -0.99, z1: 0.49 };

const NOOK_WALL_PANELS: ModelPlacement[] = [
  // South run, inward toward +z, with opening for hidden door swing so the leaf does not hide in the wall.
  ...wallPanels(
    'nook-wall-south',
    {
      x1: NOOK.x0,
      z1: NOOK.z0,
      x2: NOOK.x1,
      z2: NOOK.z0,
      openings: [{ at: 19.15, half: 0.75, y1: UP_HIDDEN_DOOR.top }],
    },
    0,
    1,
    0,
    UP_Y,
    UPPER_CEIL,
  ),
  // North run, inward toward -z. It carries the opening through to the corridor behind.
  ...wallPanels(
    'nook-wall-north',
    { x1: NOOK.x0, z1: NOOK.z1, x2: UPPER.x1, z2: NOOK.z1, openings: [{ at: 20.645, half: 0.825 }] },
    0,
    -1,
    Math.PI,
    UP_Y,
    UPPER_CEIL,
  ),
  // East run, inward toward -x.
  ...wallPanels('nook-wall-east', { x1: 21.12, z1: -1.1, x2: 21.12, z2: 3.9 }, -1, 0, -Math.PI / 2, UP_Y, UPPER_CEIL),
  // West run, inward toward +x — and the hidden door's own opening, so the panel stops at its jambs.
  ...wallPanels(
    'nook-wall-west',
    {
      x1: 18.61,
      z1: -2.0,
      x2: 18.61,
      z2: 0.6,
      openings: [{ at: UP_HIDDEN_DOOR.z, half: UP_HIDDEN_DOOR.half, y1: UP_HIDDEN_DOOR.top }],
    },
    1,
    0,
    Math.PI / 2,
    UP_Y,
    UPPER_CEIL,
  ),
];

/** Every faced run in the house, in one list, for the startup gate to filter. */
const WALL_PANELS: ModelPlacement[] = [
  ...HALL_WALL_PANELS,
  ...BEDROOM_WALL_PANELS,
  ...BEDROOM_SOUTH_WALL_PANELS,
  ...LIVING_WALL_PANELS,
  ...LIVING_SOUTH_WALL_PANELS,
  ...LIVING_WEST_WALL_PANELS,
  ...HALLWAY_EXTENDED_PANELS,
  ...BASEMENT_WALL_PANELS,
  ...SHAFT_WALL_PANELS,
  ...RITUAL_WALL_PANELS,
  ...UPSHAFT_WALL_PANELS,
  ...BACKHALL_WALL_PANELS,
  ...KITCHEN_WALL_PANELS,
  ...POOJA_WALL_PANELS,
  ...STORE_WALL_PANELS,
  ...UP_STORE_WALL_PANELS,
  ...UP_CHILD_WALL_PANELS,
  ...UP_SHRINE_WALL_PANELS,
  ...UPPER_WALL_PANELS,
  ...UP_HIDDEN_WALL_PANELS,
  ...UP_HIDDEN_STAIRWELL_PANELS,
  ...NOOK_WALL_PANELS,
];

/**
 * Read in room order: hall, hallway, bedroom, living room, then the basement wing. Entries that
 * stand on another must come after it.
 *
 * This is authoring order, not load order — `first` promotes a row to the front of the queue without
 * moving it out of the room it belongs to. See ModelPlacement.first and loadOrder.
 */
export const MODEL_PLACEMENTS: ModelPlacement[] = [
  // --- Main hall ---
  // Bounds, openings and collision all come from HouseRooms' authoritative wall runs.
  ...HALL_WALL_PANELS,

  // lantern.glb is not here: the player carries it. See HeldLantern, and note that ModelLoader
  // hands the same Group to every caller, so a row here would fight the viewmodel for it.
  //
  // The first of the four touchable noise props (see NoiseProps), lying 3.6 m from where the player
  // wakes and inside the view they wake facing. The first one has to be unmissable, because these
  // carry no prompt at all — they are floor dressing that clatters when kicked, so the only thing that
  // teaches the player they react is walking into one.
  //
  // bottle.glb is authored Z-up — 0.414 : 0.414 : 1 with z longest and x = y, i.e. a cylinder whose
  // axis is z, which in a Y-up world is a bottle already lying down. `height` fits the longest axis,
  // so 0.32 is its length and it comes out 13.3 cm across. Yawed off the room's axes so it reads as
  // dropped rather than set down, and clear of the coat pegs that hung at x 4.8. It was also placed clear of
  // the hall's runner (x -1 .. 1); both have since been removed, and x 3.2 is kept because a prop that has
  // to be unmissable from the spawn should not be moved on a whim.
  { name: 'bottle.glb', height: 0.32, x: 3.2, z: -5.2, yaw: 0.7, shadow: 1 },

  // --- Hallway ---
  // The live cat, in the middle of the corridor where it cannot be missed on the way through.
  //
  // Back on the floor, at y 0. It sat at y 0.021 for as long as there was a runner under it: the
  // corridor's runner was a 20 mm box centred at 0.011, so a cat seated at y 0 stood 21 mm inside the
  // cloth — invisible until it got a shadow, because at y 0 the quad landed at SHADOW_LIFT = 12 mm,
  // beneath the runner, and was clipped away entirely. The runner has since been removed from
  // HouseProps.hallway along with the other two, so 0.021 is now a cat hovering 2 cm over floorboards
  // with its shadow 3.3 cm below its paws. Both of those numbers go back to zero with the cloth.
  //
  // 0.75 on the shadow: it is a figure, so its box is the pose's outline rather than what touches the
  // floor. It plays a clip, and the shadow does not — a cat shifting inside a still shadow is what an
  // animal on a floor looks like from two metres away, and the alternative is re-fitting a box per frame.
  { name: 'cat.glb', height: 0.6, x: 2.0, z: 1.3, yaw: -1.9, clip: 0, speed: 0.8, shadow: 0.75 },
  // South wall, east of the archway. It used to hang on the east end wall, which is now the door
  // to the upper stair — a 1.6 m opening in a 2.6 m wall leaves nothing to hang a painting on.
  // Both paintings are authored facing +x/+z, i.e. into the wall they are hung on, so this one is
  // turned a quarter turn to face north up the hallway.
  //
  // `lanternLit` is the fix for what the player photographed and called a glitch in the wall. This file
  // ships its canvas in the *emissive* slot over a black base colour, so it lit itself: measured on the
  // phone, the canvas held mean 110.2 at 1.4 m and 111.3 at 2.6 m while the plaster beside it tracked the
  // lantern 80.3 -> 98.5. The other half of the same report was the hard 64x64 texel edges swimming as the
  // sample point moved, which was anisotropy 8 being spent on an unmipmapped sampler; ModelLoader now
  // guarantees a mipmapped minFilter. Magnification is left at Nearest on purpose — the file is deliberate
  // Minecraft pixel art and blurring it is a decision about the art, not a fix.
  //
  // z 0.21, not the 0.12 it hung at, and for the reason the living room's canvas hangs at 9.97: this run
  // wears a facing whose front is 6 cm proud of the plaster. HALLWAY_WALL_PANELS puts the south-east panel
  // at z 0.11 by 0.1 deep, so it occupies 0.06 .. 0.16, and the canvas — 0.0376 thick once fitted, centred
  // on its own z — spanned 0.101 .. 0.139: a painting entirely inside a wall, which is what
  // `npx tsx tools/audit-facings.ts hallway-wall-` reported as "0.010 m off the panel centre". 0.21 puts
  // its back at 0.191, 3.1 cm in front of the facing, and leaves every other number on the row alone.
  //
  // Not 0.18, which was the first fix. It clears the panel too, by 1.2 mm, but the audit lists anything
  // within 4 cm in front of a facing on the reasoning that a prop that close is one tweak to
  // PANEL_FACE_LIFT or to a fit away from being buried again. A canvas is thin enough that the band is a
  // false positive for it, and the cheap way to keep a guard worth reading is to stay out of it rather
  // than teach it about a thickness it cannot measure — the tool has `height`, not the fitted depth. So
  // 0.21, the first hundredth outside the band, which is also where every other painting in the house
  // already sits: `audit-facings.ts living-wall-` reports none.
  { name: 'painting-sus.glb', height: 0.9, x: 6.4, y: 1.6, z: 0.21, yaw: -Math.PI / 2, lanternLit: true },
  // The imported masonry stub, as geometry standing against the plaster rather than as a map swapped
  // into it. Its sister file, horror_wall_clean, is placed in the basement instead -- see the row after
  // bed-hospital.glb for why it could not stay on this storey.
  //
  // The swap was the plan and the pixels killed it. mats.wallWarm is the single material every one of
  // the four ground floor rooms uses, so re-pointing its map would have re-skinned the whole storey for
  // no extra draw call and no extra triangle. But both of these files carry a UV *atlas*, not a tileable
  // sheet: tiled 2x2, horror_wall_clean shows a white ground with a CAUTION sign, a red and a blue pipe
  // and a striped fan, and damaged_wall the same family of patches. HouseBuilder bakes world-anchored UVs
  // at WALL_TILE = 2.4 m, so that map on that material paints a road sign every 2.4 m across the hall,
  // the hallway, the bedroom and the living room. Only their own meshes' UVs make sense of them, which
  // means their own meshes are the only way to use them.
  //
  // Neither piece is laid *across* a wall run — a panel spanning one would draw over the archway and the
  // four doorways while their collider gaps stayed open, i.e. a wall the player walks through.
  //
  // damaged_wall is 1 : 0.41 : 0.12, so at any width tall enough to reach a 2.6 m ceiling it would also be
  // three quarters of a metre thick. At 3 m wide it is 1.23 tall and 0.37 deep, which is a collapsed stub
  // and is placed and collided as one -- but not on this hallway run. It first went on the free length at
  // x -9 .. -5, z = 0, in front of the facing that used to be there, and the render showed why that was
  // wrong twice over: the stub stands 1.23 m against the facing's 1.45 m and hid all but a 22 cm strip of
  // it, and the two together read as a concrete parapet rather than as a wall. It moves to the hall's west
  // face instead, which is the first thing the player sees on spawn, so a collapsed chunk lands the
  // derelict read immediately.
  //
  // Yawed a quarter turn to stand along z, its box is x -4.904 .. -4.536 by z -7.0 .. -4.0. HALL's west
  // wall is the line x = -5, so with WALL_T = 0.2 its inner face is at -4.9 and the stub is set 4 mm into
  // the plaster: an overlap rather than a gap, so no seam shows along the join and the chunk reads as
  // having come out of that wall. Clear of the console table (x -4.86 .. -4.34, z -3.76 .. -2.24) on z,
  // clear of the stand at (-4.5, -1.3), and clear of every casing on the run.
  //
  // albedo 1.6, not the 3.0 it was first given. Its map means 86,83,76 -- linear 0.086 against the
  // plaster's 0.40 -- which argues for a lift on the scale the stair and the gate get, but 3.0 rendered
  // it *brighter* than the plaster behind it and the grime washed out entirely. 1.6 keeps it reading as
  // dirty masonry beside a lit wall instead of as a hole in one.
  // The requested damaged-wall scan on every solid hallway run, replacing the graffiti facing. Each
  // fitted panel stays 5 cm inside its authoritative HouseRooms span: the south pair stop before the
  // central arch, while the north three stop at the bedroom and living-room jambs. That small reveal is
  // hidden by the casing/trim but prevents art from crossing a walkable opening. The procedural wall
  // remains 1 cm behind these 10 cm facings and continues to own collision.
  { name: 'wall-damaged.glb', id: 'hallway-wall-south-west', clone: true, height: 2.99, fit: { width: 7.3, height: 2.99, depth: 0.1 }, x: -5.3, y: 0.005, z: 0.11, albedo: 1.6 },
  { name: 'wall-damaged.glb', id: 'hallway-wall-south-east', clone: true, height: 2.99, fit: { width: 7.3, height: 2.99, depth: 0.1 }, x: 5.3, y: 0.005, z: 0.11, albedo: 1.6 },
  { name: 'wall-damaged.glb', id: 'hallway-wall-north-west', clone: true, height: 2.99, fit: { width: 3.1, height: 2.99, depth: 0.1 }, x: -7.4, y: 0.005, z: 2.49, albedo: 1.6 },
  { name: 'wall-damaged.glb', id: 'hallway-wall-north-middle', clone: true, height: 2.99, fit: { width: 8.3, height: 2.99, depth: 0.1 }, x: 0, y: 0.005, z: 2.49, albedo: 1.6 },
  { name: 'wall-damaged.glb', id: 'hallway-wall-north-east', clone: true, height: 2.99, fit: { width: 3.1, height: 2.99, depth: 0.1 }, x: 7.4, y: 0.005, z: 2.49, albedo: 1.6 },
  ...HALLWAY_EXTENDED_PANELS,

  // Noise prop two, standing on the corridor's north side 30 cm off the wall face, 3 m west of the
  // archway, so it is passed on every trip between the hall and the two rooms. beer_bottle is the one
  // upright file of the four: 0.269 : 1 : 0.269 with y longest, so 0.26 is its height and it is 7 cm
  // across.
  //
  // Placed off the corridor runner (z 0.75 .. 1.85) rather than on it, because `y` here is absolute and
  // the runner's top was 2 cm above the floor: standing on it, the bottle would have been 2 cm sunk into
  // the cloth. The runner is gone now, so z 2.2 is a free choice rather than a forced one — kept, because
  // it is also the 30 cm off the wall face that the first paragraph wanted.
  //
  // And deliberately not at the corridor's west end, which is where it first went. There it measured
  // 0.98 m from CELLAR_DOOR's grab point, and inside TOUCH_RANGE the picker ignores facing entirely —
  // so a bottle there would have fought the one door in this corridor the puzzle chain needs.
  { name: 'bottle-beer.glb', height: 0.26, x: -3.0, z: 2.2, shadow: 1 },

  // --- Bedroom (window on the west wall at z = 6.0) ---
  // Its three runs, faced. See roomWallPanels for why these carry no collider, and BEDROOM_WALL_PANELS
  // for why this is the one room's worth that the startup gate waits for.
  ...BEDROOM_WALL_PANELS,
  // And the fourth side, the south wall with the doorway, which the room does not own and the loop above
  // therefore skips. See BEDROOM_SOUTH_WALL_PANELS.
  ...BEDROOM_SOUTH_WALL_PANELS,
  // The one bed in this room, standing where HouseProps used to build a procedural one at (-6.2, 8.3).
  // It lay mid-floor with its length along z (headboard at the north wall) while HouseProps also built a
  // procedural bed beside it; the procedural one is gone. Now it is turned length-along-x against the
  // WEST wall so it reads as a bed made up along the wall rather than dropped in the middle of the floor.
  // yaw PI puts the headboard at -x; the first attempt had it at yaw 0, which put the head at +x facing
  // into the room instead of at the wall — hence the half-turn. Only x moves: z 9.0 is what the cat's
  // placement, the spawn mattress's z0/z1 and SPAWN.z are all tuned against, and the fitted footprint is
  // 2.1 x 1.0 m (length x width) at either yaw, so at x -7.8 it spans -8.85 .. -6.75 across z 8.5 .. 9.5
  // — the headboard 5 cm off the west inner face at -8.9, the same clearance its head had at the north
  // wall.
  //
  // That 5 cm is 5 cm to the plaster and -1 cm to the damaged-wall facing hung in front of it. Left as it
  // is: a centimetre of headboard inside the frontmost relief of a rough scan is not visible, the facing
  // carries no collider for it to fight, and buying the clearance back would mean moving x, which the cat's
  // row and SPAWN.x are now measured from. The closet 3 m east did get moved — see its row for why that one
  // could not be waved off.
  //
  // Startup-visible: the player wakes on this mattress. HouseScene registers a low base collider plus a
  // walkable mattress once the measured box exists; a full `collide` box would trap a capsule whose feet
  // are already on top of it. `first` puts it immediately after the gate in load order.
  //
  // bedroom.diary lies on this model's east side table (HouseProps.bedroom, measured top y 0.378 at
  // x -7.286 .. -6.866, z 9.279 .. 9.579), so retuning `height`, `x` or `z` here strands that page.
  // REMOVED: bed.glb was taken out of the bedroom at the user's request. The player now wakes standing on
  // the floor (SPAWN), the diary page lies on the floor where the side table was, and the cat below lies on
  // the boards instead of the mattress.
  // { name: 'bed.glb', height: 2.1, x: -7.8, z: 9.0, yaw: Math.PI, first: true, shadow: 1 },
  // Curled on the mattress. `on` reads the bed's measured top, which is the headboard rail at 0.66,
  // so y drops to the bedding at 0.47; retuning the bed still carries the cat with it. The bed turned
  // length-along-x against the west wall with its head at -x, so the foot end is +x and the cat's old
  // offset — 0.1 m off the bed's centre toward the foot, centred across the width — is x -7.7, z 9.0.
  // yaw -PI/2, exactly as it stood in the yaw-0 build: the bed's half-turn was the fix, and the cat
  // reads right where it is, so it does not turn with the bed.
  //
  // Its shadow lands on the bedding rather than on the floor, which is what `on` buys and is the whole
  // reason it is worth having here: a cat on a mattress with a shadow on the boards below would read as
  // hovering twice over. 0.8, and its 0.36 x 0.24 m quad stays well inside the 2.1 x 1.0 m bed.
  // REMOVED at the user's request, along with bed.glb.
  // { name: 'cat-still.glb', height: 0.45, x: -7.7, z: 9.0, yaw: -Math.PI / 2, shadow: 0.8 },
  // The three imported sleepers that stood in this room -- closet-old, bed-horror, bed-old -- are placed in
  // the rear and upper wings now. Their rows travelled whole and nothing about them was re-measured, because
  // each `height` is a fit rather than a rescale (the closet is 1.317 x 2.118 x 0.692 with y longest,
  // horror_bed 2.224 x 0.840 x 1.149 with x longest once its floor plane is gone, old_bed 0.786 x 0.682 x
  // 1.756 with z longest) and a fit does not care which room it stands in. See the store room in the rear
  // wing for the closet, and the two upper back rooms for the beds.
  //
  // Hiding is why they went. armHiding() arms every bed and wardrobe it is handed and recognises them by
  // file name -- BED_NAMES, WARDROBE_NAMES -- so with all four in here, four of the house's four hiding
  // places were inside six metres of the spawn and every other room had none. The three that left carry no
  // `id` for exactly that reason: `onPlaced` dispatches on `p.id ?? p.name`, and an id would have made them
  // ordinary furniture wherever they landed. This room keeps bed.glb, which is a BED_NAMES spot itself, so
  // the player still wakes beside somewhere to hide.
  //
  // What is left is the room the clue trail needs and nothing more: the spawn bed and its cat, with the
  // diary page on the bed's own side table; the code box on the floor with the stopped clock over it; and
  // the window seat with the photograph. (The dressing table the box stood on and the bedside table the
  // diary lay on were HouseProps' procedural furniture, and both are gone.) The north-east and south-east
  // bands HouseProps leaves empty -- x -4.1 .. -1.2
  // by z 8.0 .. 10.1 and x -4.1 .. -1.2 by z 2.7 .. 5.7 -- are now empty in fact as well as by intention,
  // which matters at CatRoutes' north rail: that rail was pinched to 0.59 m by bed-horror's west face and is
  // pinched by nothing now. Its nodes stay where they were measured rather than moving back, since widening
  // a gap cannot break a route.
  //
  // Bedroom vanity dresser with animated sliding drawer.
  // Placed along the bedroom's north wall, east of the back corridor door.
  //
  // `drop: ['Group009']` removes the lamp's white cone shade (Cylinder002) and the small socket inside it
  // (Object023), at the user's request. The lamp body, Cylinder001, ships with a fully transparent material
  // and was never visible, which is why the shade looked like it was floating; it stays because it is not
  // seen. `drop` runs before the fit, and the shade was the model's tallest point: source y -0.084 .. 2.807
  // (2.891) with the shade, -0.084 .. 2.306 (2.390) without. So `height` goes from 1.4 to 1.4 * 2.390 / 2.891
  // = 1.157, which keeps the dresser at the same scale it had before. x/z centre and the floor are unchanged.
  {
    name: 'dresser-bedroom.glb',
    id: 'dresser-bedroom',
    drop: ['Group009'],
    height: 1.157,
    x: -2.8,
    z: 9.5,
    yaw: Math.PI,
    collide: true,
    shadow: 1,
  },
  // The bedroom's own door leaf, replacing the procedural one -- see the doorLeaves array in HouseScene,
  // from which BEDROOM_DOOR's entry is gone so the two do not stand in the same opening.
  //
  // Same file as the upper flat's inner leaf, which is why this row is the reason `id` and `clone` exist:
  // the loader caches by file name, so without the copy this placement would simply move the upstairs door
  // out of its frame, and without the id armInnerDoor() -- which hooks on the placed name and hard-codes
  // UPPER_INNER -- would hinge this one as though it stood one storey up. albedo has to match the row it is
  // copied from: clone(true) shares materials and brighten() dedups per material, so the first of the two
  // to be placed sets the factor for both.
  //
  // Ajar rather than shut, and with no blocker, which is this house's policy for interior leaves: a shut
  // door needs an open/close tap on every threshold and buys nothing. yaw -1.0 rad swings the leaf 57 deg
  // into the room off a notional hinge at the west jamb -- at 2.15 tall it is 1.074 wide, and centred at
  // (-5.51, 3.05) its hinge edge lands on (-5.80, 2.60), which is BEDROOM_DOOR's west jamb exactly, and its
  // free edge on (-5.22, 3.50), clear of the strongbox on the floor at x <= -7.18. (It was also placed clear of a
  // bedroom rug at z >= 4.8, since removed; nothing was moved for that.) That leaves 1.02 m of the 1.6 m
  // opening to walk through. The leaf being narrower than the opening is invisible on an ajar door, which
  // is why BEDROOM_DOOR.half stays at 0.8 and the casing is untouched.
  //
  // Untouched, too, by the south wall's new facing. BEDROOM_SOUTH_WALL_PANELS fronts at z 2.76 and the
  // leaf's hinge edge stands at z 2.60, so the leaf does cross that plane — but the two full-height panels
  // stop at x -5.85 and restart at x -4.25, and the leaf lives between them at x -5.80 .. -5.22. All that
  // is left is the header, at y 2.1 .. 3.0, and the leaf is 2.15 tall: a 5 cm sliver of its top corner,
  // above head height, inside a doorway, on the hinge side. Not worth a millimetre of anything.
  { name: 'door-inner.glb', id: 'door-bedroom', clone: true, height: 2.15, x: -5.51, z: 3.05, yaw: -1.0, leaf: 4, albedo: 2.0 },

  // The living-room leaf uses the same clean imported door as the bedroom. Both openings are 1.6 x
  // 2.1 m, so the bedroom's measured west-jamb placement carries across exactly: at 2.15 m tall the
  // leaf is 1.074 m wide, yaw -1.0 puts its hinge on x = 4.20 / z = 2.60, and leaves 1.02 m clear to
  // walk through. Its distinct id prevents the upper-flat interaction arm from treating it as that door.
  { name: 'door-inner.glb', id: 'door-living', clone: true, height: 2.15, x: LIVING_DOOR.x - 0.51, z: LIVING_DOOR.z + 0.45, yaw: -1.0, leaf: 4, albedo: 2.0 },

  /**
   * The rear wing's five leaves. Until now those doorways were holes: the wall runs cut the openings
   * and the colliders left the gaps, so the player could walk through, but there was no frame and no
   * door — see HouseScene's casings array for the frames that landed with these.
   *
   * All five reuse the bedroom row's measured arithmetic rather than inventing any. At height 2.15 the
   * leaf is 1.074 wide, and for a hinge at jamb H on an east-west wall, a swing of 1.0 rad (57 deg) off
   * the wall puts the leaf's centre 0.29 along the wall from H and 0.45 off it — which is exactly the
   * `- 0.51` / `+ 0.45` the living row spells out with the 0.8 half folded in. So the offsets below read
   * as (half - 0.29) along the wall and 0.45 across it, and the sign of each says which jamb and which
   * way. Every one swings into the space the player is walking into, not the one they came from:
   *
   * - The two off the front of the house swing north into the back corridor, hinged on their west jambs.
   *   Both openings are BEDROOM_DOOR's 1.6 x 2.1, so both keep its 1.02 m of clear walking width, and
   *   both free edges land at z 11.10 — well inside a corridor 2 m deep, and clear of the three
   *   doorways in its far wall at z 12.2.
   * - The three off the corridor into the rooms behind swing north as well. Their openings are 1.4 m,
   *   so the same 57 deg covers 1.074 x cos(1.0) = 0.58 of it and leaves 0.82 m to walk through.
   * - The prayer room's hinges on its *east* jamb instead, which is the same numbers mirrored: yaw
   *   1.0 - pi is 57 deg off the wall the other way. Three identical doors down one corridor wall is
   *   the one thing that would read as generated rather than built.
   *
   * Ajar, no blocker, no interaction: this house's policy for interior leaves. The distinct ids are
   * load-bearing — `door-inner.glb` is the name armInnerDoor() answers to in HouseScene, and it
   * hard-codes the upper flat's geometry, so an id-less clone here would be hinged one storey up.
   * albedo matches the two rows above for the reason those match each other: clone(true) shares
   * materials and brighten() dedups per material, so whichever is placed first sets the factor for all.
   */
  { name: 'door-inner.glb', id: 'door-back-w', clone: true, height: 2.15, x: BACK_DOOR_W.x - 0.51, z: BACK_DOOR_W.z + 0.45, yaw: -1.0, leaf: 4, albedo: 2.0 },
  { name: 'door-inner.glb', id: 'door-back-e', clone: true, height: 2.15, x: BACK_DOOR_E.x - 0.51, z: BACK_DOOR_E.z + 0.45, yaw: -1.0, leaf: 4, albedo: 2.0 },
  { name: 'door-inner.glb', id: 'door-kitchen', clone: true, height: 2.15, x: KITCHEN_DOOR.x - 0.41, z: KITCHEN_DOOR.z + 0.45, yaw: -1.0, leaf: 4, albedo: 2.0 },
  { name: 'door-inner.glb', id: 'door-pooja', clone: true, height: 2.15, x: POOJA_DOOR.x + 0.41, z: POOJA_DOOR.z + 0.45, yaw: 1.0 - Math.PI, leaf: 4, albedo: 2.0 },
  { name: 'door-inner.glb', id: 'door-store', clone: true, height: 2.15, x: STORE_DOOR.x - 0.41, z: STORE_DOOR.z + 0.45, yaw: -1.0, leaf: 4, albedo: 2.0 },

  /**
   * The cellar and basement leaves, replacing the last two procedural ones — HouseScene's doorLeaves
   * array is empty now, and makeDoorLeaf is gone with it.
   *
   * `drop: ['frame']` is what makes this file usable in an opening that is not the upper flat's. door.glb
   * ships a frame *and* a leaf as sibling nodes, and the whole thing is 0.5715 : 1 : 0.1353 — so lapping
   * CELLAR_DOOR's 1.6 m clear width with the frame on would demand a height of 2.905 m, standing 0.8 m of
   * frame above a 2.1 m lintel in a 3.0 m room. Both these openings already have a makeCasing() frame in
   * them, which is the same reason door-inner.glb needs none, so what is wanted here is that file's leaf
   * and nothing else. prune() matches node-name prefixes, and `frame` reaches only the frame subtree; the
   * handle stays, being a child of `door`.
   *
   * Leaf alone the file measures 96.35 x 205.09 x 23.36, y longest, so height 2.15 — the same as the
   * bedroom and living leaves, in openings of the same 2.1 m — gives 1.010 wide and 0.245 across the
   * handle (the slab itself is 0.107; the handle stands 5 cm off each face). The handle sits on the local
   * -x side, so unlike door-inner.glb the *hinge* edge is local +x, and the arithmetic below is the
   * bedroom row's with that sign flipped: for a hinge at H and a swing of `a` radians off the wall,
   * yaw = pi/2 +- a and the centre is H minus half the width along the leaf's own +x.
   *
   * Both hinge on the low-z jamb, and both swing into the room the player is walking into rather than the
   * one they came from:
   *
   * - The cellar door swings east into the hallway, because west of it is the stair's top landing and a
   *   leaf hung there would stand over the first two steps. a = 1.0 rad (57 deg) off the wall from the
   *   jamb at z 0.5 puts its free edge at (-8.15, 1.046), so it covers z 0.5..1.046 of a 0.5..2.1
   *   opening and leaves 1.054 m to walk through — the bedroom door's 1.02 m, in the same 1.6 m opening.
   * - The basement door swings west into the cellar, away from the same stair at the other end. Its
   *   opening is 2.0 m, so a shallower a = 0.6 rad still leaves 1.166 m clear while keeping the leaf only
   *   0.57 m off the wall plane — which matters here and not in the hallway, because basement.glb's one
   *   piece of geometry that reaches past its own wall is a water pipe 5 cm shy of this wall's inner face.
   *   z 0.3..1.134 is in the cellar's documented-clear south strip, so the walkable lane from the stair to
   *   the ritual door (z 1.0..2.6) keeps its full width.
   *
   * Ajar with no blocker, no interaction and no arm, which is this house's policy for interior leaves.
   * The distinct ids are load-bearing twice over: they keep the loader from moving the upper flat's front
   * door out of its frame instead of copying it, and they keep armUpperDoor() — which hooks on the placed
   * id and hard-codes UPPER_DOOR — from hinging a leaf that stands two storeys below it. albedo matches
   * that row for the reason door-bedroom's matches its own: clone(true) shares materials.
   */
  { name: 'door.glb', id: 'door-cellar', clone: true, drop: ['frame'], height: 2.15, x: -8.5751, z: 0.7729, yaw: Math.PI / 2 + 1.0, leaf: 4, albedo: 2.0 },
  { name: 'door.glb', id: 'door-basement', clone: true, drop: ['frame'], height: 2.15, x: -14.0851, y: BASE_Y, z: 0.7168, yaw: Math.PI / 2 - 0.6, leaf: 4, albedo: 2.0 },

  // Noise prop three, on the bare boards between the room's centre and the east wall — the one
  // clear stretch of this floor, since the beds, a closet, two tables and a chair have the rest of it.
  // 3.0 m from the door leaf above and 3.1 from the diary, so it competes with neither for the prompt.
  // A 24 cm dinner plate 3.2 cm tall (1 : 0.132 : 1, x longest).
  { name: 'plate.glb', height: 0.24, x: -3.2, z: 6.5, shadow: 1 },

  // --- Living room (window on the north wall at x = 4.0) ---
  // Its two runs, faced: north, and east at x 9.
  //
  // Its other two sides are unfaced, and it is the same gap the bedroom's south wall had — see
  // BEDROOM_SOUTH_WALL_PANELS. This room's south side is the hallway's north run (faced only on the
  // corridor side, at z 2.49) and its west side is the bedroom's east run (faced only on the bedroom
  // side), so both read as bare plaster from in here. Left as found: neither was asked for, and both are
  // clear floor with nothing hung or stood against them, so a facing on either is a pair of draw calls
  // for a wall the player walks past rather than looks at. The two walls this room's clues are on — north
  // for the list, east for the photographs — are both faced, and both were measured against the facing.
  ...LIVING_WALL_PANELS,
  ...LIVING_SOUTH_WALL_PANELS,
  ...LIVING_WEST_WALL_PANELS,
  // The one table in this room, and now the only thing in it a player can put a hand on. The armchair it
  // used to stand beside and the fireplace it used to stand next to are both gone, along with the dining
  // table and chair and the rug — see HouseProps.living, which was emptied down to wall dressing and a
  // lamp — so this row inherited the living room's reading surface: the ledger clue is a sheet on its top
  // at (7.79, 5.56), 10 degrees off square, and the anchor `living.ledger` sits on it.
  //
  // `shadow: 1`, which this row spent a long time without. The reason it had none was the rug: it spanned
  // x 4.8 .. 7.6 and this table's centre is x 7.6 exactly, so the table straddled the cloth's east edge
  // and half of any quad here would have been under 21 mm of rug and clipped away, leaving a shadow that
  // stopped dead on a straight line. The rug did that half of the grounding instead. With the cloth gone
  // the quad has bare floorboards under all of it, and the grounding has to come from somewhere — a
  // 0.75 x 0.65 table on an empty floor with four thin legs and no contact shadow floats.
  { name: 'table.glb', height: 0.75, x: 7.6, z: 5.4, collide: true, shadow: 1 },
  // The sword is not here: the daayan holds it. See DaayanSword, and note that a row here would
  // fight the hand attachment for the cached Group exactly as a lantern row would fight HeldLantern.
  // North wall, west of the window. Turned for the same reason as the other painting; this one is
  // double-sided, so hung unturned it showed the wood backing of the canvas.
  //
  // z 9.97 rather than the 10.03 it hung at, for the same reason the closet moved: the facing's front is
  // at 10.04, and a canvas hung at 10.03 would have been a painting inside a wall.
  //
  // x 0.45, not the 7.0 it hung at. BACK_DOOR_E was cut in this wall at x 7, so the canvas -- 0.80 wide
  // by 0.65 tall, spanning 6.60..7.40 by 1.50..2.15 -- was left hanging in the middle of a 1.6 m doorway
  // with 1.5 m of air under it and its top edge 5 cm above the lintel. The facing is cut to the same
  // holes and so reports what is left to hang on: x -0.95..2.85 west of the window, 5.15..6.15 between
  // window and door, 7.85..8.95 east of it. Only the first is wider than a canvas and two margins, and
  // living.list has 1.87..2.13 of it for the shopping list pinned beside the window -- so 0.45 centres
  // the canvas in the 2.82 m that are left, a metre off the west corner and a metre off the list.
  { name: 'painting-sun.glb', height: 0.8, x: 0.45, y: 1.5, z: 9.97, yaw: Math.PI },
  // Noise prop four, and the only one of them off the floor. `on` reads the side table's measured top
  // rather than restating it — 0.689, its 0.588 x 0.540 x 0.509 fitted to 0.75 on x — so retuning the
  // table carries the plate up with it. Set 12 cm west and 10 cm south of the table's centre, which
  // keeps its 25.6 x 26 cm footprint (0.983 : 0.244 : 1, z longest) inside the 75 x 65 cm top.
  //
  // It now shares that top with the ledger, which moved here when the fireplace and the ledger table were
  // removed. The two do not touch: the plate occupies x 7.352 .. 7.608 by z 5.17 .. 5.43 and the ledger's
  // rotated sheet x 7.618 .. 7.962 by z 5.415 .. 5.705, so the gap is 1 cm on x. Worth keeping, because
  // the interaction anchor for the ledger is 8 cm above this top and a plate through the page would be
  // the first thing the prompt drew the player's eye to. This row must stay after table.glb's.
  { name: 'plate-ceramic.glb', height: 0.26, x: 7.48, z: 5.3, on: 'table.glb', shadow: 1 },
  // The ornate French chateau wardrobe, with animated swinging doors and sliding drawer.
  // Placed against the living room's west wall, facing east into the spacious living area.
  {
    name: 'wardrobe-chateau.glb',
    id: 'wardrobe-chateau',
    height: 2.5,
    x: -0.3,
    z: 5.5,
    yaw: Math.PI / 2,
    collide: true,
    shadow: 1,
  },
  // Summer cafe table and folding chairs, full realistic scale in the large living room.
  {
    name: 'caffe-set.glb',
    id: 'caffe-set',
    height: 2.35,
    x: 5.6,
    z: 6.6,
    collide: true,
    shadow: 1,
  },

  // --- Rear wing (back corridor, kitchen, prayer room, store) ---
  // The wing's faced runs, so the four rooms wear the same damaged masonry as the rest of the house
  // instead of the bare plaster they were built with. Every row comes from roomWallPanels over the same
  // `walls` array the shell and the colliders read — see the block above BACKHALL_WALL_PANELS for why
  // these are facings without `collide`, and why the corridor's south side is not in the list.
  //
  // Placed here rather than appended so the file still reads in ROOMS order: the corridor and its three
  // rooms sit between the living room and the basement, which is where they are on the floor plan. The
  // three doorway leaves off the corridor are up in the bedroom block with the rest of the rear wing's
  // five, which is where that set of numbers is explained.
  ...BACKHALL_WALL_PANELS,
  ...KITCHEN_WALL_PANELS,
  ...POOJA_WALL_PANELS,
  ...STORE_WALL_PANELS,

  // The three rooms off the corridor were built empty and stayed empty through every dressing pass. One
  // piece each, in ROOMS order, and each one measured against its room's faced fronts rather than its
  // room's nominal walls -- a facing hangs 6 cm proud of the plaster, so the front a prop has to clear is
  // the run's line plus 0.16 inward, and a run this room does not own is bare plaster at 0.10 instead.
  //
  // A second table.glb for the kitchen, as a work table rather than a side table. The living room's row is
  // the same file and has to stay where it is -- living.ledger is a sheet on its measured top and
  // plate-ceramic.glb stands `on` it -- so this is a copy, and a copy of this file is free: clone(true)
  // shares geometry and materials, and the loader has the Group cached from the living room already.
  //
  // No `albedo`, which is a constraint rather than a choice. brighten() dedups on the material it lands on
  // and both rows point at the same one, so whichever were placed first would set the factor for both; the
  // living row carries none, so neither can. The map is dark for it -- mean 83.8,48.8,24.4, linear colour x
  // map products 0.088,0.030,0.009 -- and it has read correctly in the living room since it was placed,
  // which is the measurement that says to leave it alone.
  //
  // `height` 0.8167 where the living room's is 0.75, and it is the only number that differs. The file is
  // 0.588 x 0.540 x 0.509 with x longest, so a fit to h puts the top at 0.918h: 0.75 gives the 0.689 the
  // plate's row is measured against, and 0.8167 gives 0.750 exactly, which is a height to stand and work
  // at. The footprint follows to 0.817 x 0.707.
  //
  // Against the north wall, whose facing fronts at z 17.04, so z 16.65 leaves the top's back edge at 17.004
  // and 3.6 cm of air. x -4.6 keeps it out of two things: the east facing's front at -3.16 is 1.03 m from
  // its edge at -4.192, and door-kitchen's leaf -- 1.074 x 0.230 turned -1.0 rad, so a footprint of
  // Complete wooden kitchen counter & cupboard suite, fitted with clearance from the kitchen's north wall.
  {
    name: 'kitchen-counter.glb',
    id: 'kitchen-counter',
    height: 2.2,
    x: -5.8,
    z: 15.7,
    yaw: Math.PI,
    collide: true,
    shadow: 1,
  },
  // Antique round carved pedestal table for the prayer room.
  {
    name: 'table-antique.glb',
    id: 'table-antique',
    height: 1.1,
    x: 0,
    z: 15.0,
    collide: true,
    shadow: 1,
  },
  // closet-old.glb for the store room, from the bedroom. Scale 1.0 at height 2.1179 -- the fit is the file's
  // own y -- so it is 1.317 wide by 0.692 deep, and the doors are at -z: the single mesh's box runs
  // z -0.346 .. +0.346, and which face is which was settled by the bedroom row standing it against a north
  // wall at yaw 0. This room's north wall is the one it wants, so the row keeps yaw 0 and only x and z move.
  //
  // z 16.65 is the bedroom row's clearance carried across rather than re-derived. STORE's north run is at
  // 17.2 and the store owns it, so the facing fronts at 17.04 and the closet's back reaches 16.996 -- the
  // same 4.4 cm of air the bedroom row was retuned to. That margin is not cosmetic here: this is the
  // WARDROBE_NAMES pocket, so the camera goes inside the box, and a back edge past the facing would have it
  // looking out through the wall.
  //
  // x 4.4 spans 3.741 .. 5.059, west of the door line and clear of the west face at 3.1, which is bare
  // plaster on this side because the prayer room owns x 3. It leaves the run from STORE_DOOR to the north
  // wall open and the whole east half of the room free, and door-store's leaf at x 5.203 .. 5.977 by
  // z 12.136 .. 13.164 is three and a half metres away on z. Reachable: the collider's south face is at
  // 16.344, so a 0.35 m player gets their centre to 15.994 and the interaction point is 0.66 m from there
  // against a reach of 1.535.
  //
  // No `id`, so WARDROBE_NAMES still matches and this is a hiding place. albedo 1.6 as it always was.
  { name: 'closet-old.glb', height: 2.1179, x: 4.4, z: 16.65, collide: true, albedo: 1.6, shadow: 1 },

  // --- Basement ---
  // Its five runs, faced. Two of them touch basement.glb's own dressing by a centimetre: the water pipe
  // at x -13.95 against the east panels' front at -13.96, and the shelving at z 6.45 against the north
  // panel's front at 6.44. Both are a rough scan's frontmost relief brushing the back of a prop that no
  // collider and no camera can get behind, so they are left alone rather than paid for by moving a room's
  // worth of dressing 2 cm south.
  ...BASEMENT_WALL_PANELS,
  // cat-walk.glb is not here: it is the roaming cat, and it walks the whole house rather than one
  // spot in the basement. See CatRoamer, and note that a row here would fight it for the cached
  // Group and would also freeze its cull centre at whatever this row said.
  //
  // The cellar's dressing, and the one imported room that is used as furniture rather than as a room.
  // basement.glb is a 20 x 15.8 x 34.6 unit hall in units of its own, and the two numbers that decide
  // everything here are that its floor plane sits at y -0.0183 and its ceiling plane at 9.9725, so its
  // interior is 9.9908 units tall. Setting that to BASE_CEIL_H fixes the scale at 0.28025 — and at that
  // scale every prop in the file measures like the thing it depicts: the washing machine 0.75 x 1.04,
  // the shelf 1.62 x 1.42, the arcade cabinet 0.61 x 1.41, a food can 0.13 tall. The file is a normal
  // basement drawn at 3.57 units to the metre, which is why no other scale was worth trying.
  //
  // `drop` takes the shell with it, and that is the whole design of this row rather than a detail of it:
  // the model's perimeter is unbroken at chest height, measured, and the house's cellar has two doorways
  // cut in it — BASEMENT_DOOR at the stair and the hidden RITUAL_DOOR behind the screen. Keeping the
  // model's walls would seal both, visibly and in the colliders, and reshaping the house to the model
  // would move the whole ritual wing and every puzzle anchor in it. So HouseRooms keeps the room and the
  // model brings the clutter. Also dropped: its own stairwell and stair (the house has stair-wood.glb
  // and a shaft on x1), the roof planes and the two roof beams that lie over the model's empty north
  // half, a 34.6-unit pipe that would have run the length of a room a third that long, the four pipe
  // panels that overhang the shell and so would have skewed the fit's centring, and both rigged
  // figures — one is above the model's own ceiling, the other hangs 1.51 units through its floor.
  //
  // What is left is 22.2993 x 10.643 x 24.5287, z longest, so height = 24.5287 x 0.28025 = 6.8742, and
  // the placement is arithmetic from there. fitToHeight centres the bbox, so x -17.075 stands the
  // content's +x edge — a water pipe, the one thing in the file that reaches past its own wall — 5 cm
  // shy of the east wall's inner face at -13.9, and leaves 1.70 m clear at the west end for the ritual
  // doorway and the screen that hides it; yaw pi first, which sends the model's cluttered end to the
  // north wall and its empty end to the stair, so the player comes down the steps into open floor and
  // faces the shelving across the room. z 3.013 stands the shelf 5 cm off the north wall's inner face.
  // The content then occupies x -20.20..-13.95 and z -0.42..6.45 inside a room of -21.9..-13.9 by
  // -1.9..6.5, which leaves a walkable lane from the stair to the ritual door at z 1.0..2.6 and the
  // whole south strip — PLACE.breaker included — untouched. Checked, not eyeballed: see place-check.
  //
  // y is not BASE_Y: the fit seats the bbox, whose lowest geometry is a pipe 0.459 units below the floor
  // plane, so BASE_Y - 0.459 x 0.28025 is what puts the floor the props stand on at BASE_Y. The ceiling
  // joists then land 2.52 m up, 28 cm below a 2.8 m ceiling, with their top 5 cm inside it.
  {
    name: 'basement.glb',
    height: 6.8742,
    x: -17.075,
    y: BASE_Y - 0.1286,
    z: 3.013,
    yaw: Math.PI,
    maxEyeY: -0.2,
    albedo: 1.5,
    drop: [
      'body', 'rouf164', 'rouf003', 'staris', 'stairs', 'metarig', 'doorbulp',
      'bigpipe', 'smallpipe2', 'smallpipe4', 'smallpipe70',
      // The barrel, the crate and the carton stacked on it, which between them stood at
      // x -16.43 .. -15.63, z 2.86 .. 4.38 — eight centimetres west of BLACK_DOOR's west jamb and two
      // metres south of it. That is the worst place in the file to leave anything. The player collides
      // as a 0.70 m *square* (FPController radius 0.35, box against box, and no depenetration), so the
      // walkable band between their east face and the east wall was x -15.28 .. -14.25 of centre
      // positions, the doorway's own band is -15.35 .. -15.05, and the overlap the player had to arrive
      // inside was 23 cm. A 1.06 m doorway that only opens to a 23 cm approach lane reads as furniture
      // blocking the way, which is exactly how it was reported. Gone, the free band on the way to that
      // doorway is 4.70 m at z 4.1, 3.60 m at z 5.5 and 1.70 m where it meets the wall.
      //
      // Dropping into `drop` rather than out of `solids` on purpose, twice over: a visible crate with no
      // collider is the walk-through-the-wall bug from the other end, and prune() runs before the fit, so
      // these three have to be things fitToHeight will not miss. None of them is the extreme on any axis
      // — the arcade is lower, the mid pipe taller, the shelving further west, the tally wall further
      // east — so the measured box, the scale and the seat all come out where they were. Checked against
      // the surviving colliders' world coordinates, not assumed.
      'barrel2', 'box1', 'cartonbox',
    ],
    // 'barrel', 'box1' and 'cartonbox' left with it: prune() runs before propColliders(), so a dropped
    // subtree emits no collider anyway, and a key that can never match is worse than no key.
    solids: ['shelf', 'washingmachine', 'vaccum', 'arcade', 'midpipe'],
  },

  // --- Cellar stair shaft ---
  // Its runs, faced. The stair model below stands between these walls, so the panels only show where
  // the treads do not — above the flight, looking down.
  ...SHAFT_WALL_PANELS,

  // The cellar stair, and the same stair-wood.glb the upper storey climbs — a second row for one file,
  // hence `clone` (the loader hands every caller the same cached Group) and a distinct `id`.
  //
  // Squashed, and that is the deal rather than a detail. The model is a grand eight-tread stair: 9.24 m
  // long, 7.43 m wide, 5.93 m tall, each tread rising 0.75 m. The shaft is 4.8 x 2.6 x 3.0, and a 0.75 m
  // rise is more than double the controller's 0.35 m step-up, so the authored geometry fits neither the
  // room nor the player. fitToBox therefore pulls each axis to the shaft's own box — the one place the
  // non-uniform fit is honest about it: this is a static visual, and the walkable path stays the
  // procedural stairFloors() rects (fifteen 0.2 m steps), which the player actually climbs. The model
  // is what the steps look like, not what they are.
  //
  // `drop` takes the balustrade, and the fit depends on it: the rail's top stands 2.68 m above the
  // model's highest tread, so kept, the combined 8.64 m bbox would be squashed to 3.0 and the treads
  // would end two thirds up the shaft, floating below the landing. Base only, the bbox is 5.93 m, and
  // the top tread lands at the seat plus 3.0 — the landing floor.
  //
  // yaw pi flips the climb: the model rises toward -x as authored, and the shaft's landing is at its
  // east end (x -9), the basement at its west (-13.8). x/z centre the turned box on the shaft; y seats
  // the bbox bottom on the basement floor, which is where the bottom tread stands. No `collide` — the
  // shaft is the walkway, and a box round the stair walls it off. No `shadow` — the stair is the floor
  // here, and the multiply quad would only darken its own first tread. No `albedo`: clone(true) shares
  // the upper stair's materials, and brighten() dedups on the material, so the 2.2 the upper row applied
  // lands on this one too — re-stating it here would be a no-op at best.
  {
    id: 'stair-cellar.glb',
    name: 'stair-wood.glb',
    clone: true,
    height: 3.936,
    fit: { width: 4.6, height: 3.0, depth: 2.6 },
    x: -11.4,
    y: BASE_Y,
    z: 1.3,
    yaw: Math.PI,
    drop: ['012woodstairsrail'],
  },

  // The sliding screen over RITUAL_DOOR, where a procedural shelf used to stand. It is armed rather
  // than animated from here — see RitualDoors, which owns the blocker, the prompt and the mixer, and
  // which is also where the measurements behind these three fit numbers are written down.
  //
  // No `clip`: that path loops the action forever and only ticks its mixer while the model is inside
  // CULL_RADIUS_SQ, and this is a one-shot the player triggers. `drop` takes the fixed full-width panel
  // the two leaves slide across, without which opening them would reveal more paper instead of a hole.
  //
  // The pruned source is 9.565 thick x 202.603 tall x 161.173 wide in its own units, so the fit reads
  // straight off those axes with no yaw, and 2.0 m of width covers the 1.8 m opening with 10 cm of
  // overlap at each jamb. x -21.77 stands the leaves' 10 cm thickness at -21.82..-21.72: 2 cm off the
  // damaged-wall facing's front at -21.84, 5 cm inside the ritual casing's jambs at -21.87, and 1.70 m
  // clear of basement.glb's content, which stops at -20.20. height 2.1 seats them on BASE_Y with their
  // top exactly at RITUAL_DOOR.top, meeting the header panel and clearing the lintel by 5 cm.
  //
  // One albedo for two maps that disagree. The frames measure linear 0.0278 and want the 2.0 every
  // other dark import in this house gets; the leaves' paper measures 0.8251, the brightest map in the
  // game, and wants none. 1.8 is what a single multiplier can do for both: the frames land at 0.050,
  // which reads as wood in lantern light instead of as a silhouette, and the paper's 1.49 sits in
  // ACESFilmic's shoulder at exposure 1.35 rather than clipping to a flat white rectangle. A paper
  // screen catching the lantern is the point of it being here, so erring bright is erring the right way.
  {
    name: 'doors-sliding.glb',
    id: 'doors-ritual',
    height: 2.1,
    fit: { width: 0.1, height: 2.1, depth: 2.0 },
    x: -21.77,
    y: BASE_Y,
    z: RITUAL_DOOR.z,
    albedo: 1.8,
    drop: ['Plane011'],
  },
  // Heavy industrial metal mechanical table for the basement workshop.
  {
    name: 'table-mechanical.glb',
    id: 'table-mechanical',
    height: 1.8,
    x: -18.5,
    y: BASE_Y,
    z: 3.5,
    yaw: 0,
    maxEyeY: -0.2,
    collide: true,
    shadow: 1,
  },

  // --- Black magic room (through the basement's north wall, see HouseRooms.BLACK) ---
  // The mirror of the basement's problem. basement.glb was a room worth importing for its clutter, so
  // the shell went and the clutter stayed. This one has no clutter at all — four walls, a floor, a
  // ceiling, two door leaves, a radiator, a bricked window, a light switch, two plug sockets and a
  // ceiling fan — so the shell is the entire reason it is here, and BLACK was cut to fit it rather than
  // the other way round.
  //
  // A Sketchfab FBX export, which matters three times. Every part is a joint of a skinned mesh with the
  // dequantization scale in the inverse bind matrices, so node-walking measures the whole file as a 2 cm
  // speck and only SkinnedMesh.boundingBox has the true size — which fitToHeight gets for free, because
  // Box3.setFromObject prefers it. And the meshes are grouped by *material*, not by part, so
  // `drop` has to name Object_N: there is no mesh called `fan_blades` to remove, and removing the joint
  // of that name would leave its vertices exactly where its last matrixWorld put them.
  //
  // The third thing is a trap, so read it before believing any Box3 taken of this room. That cached
  // boundingBox was baked with the bones already posed, so it *already carries yaw* below.
  // Box3.setFromObject then multiplies it by matrixWorld, which carries the same yaw again, and reports
  // the room turned 180 deg — x and z swapped, the radiator against the north wall, the window in a wall
  // that has none. The renderer does not: these meshes are bindMode 'attached' with an identity
  // bindMatrix, so matrixWorld cancels against bindMatrixInverse in the skinning matrix and the vertices
  // are driven by the bones alone, one yaw. Measured through the transform it actually draws with,
  //   x_live = -16.74443 - 0.882910 * z_model,  z_live = 8.82645 + 0.882910 * x_model,
  // the room lands at x -19.1020 .. -14.3001, z 6.5997 .. 10.8941, radiator and window on the east wall,
  // switch on the south beside the door — as designed. `height` survives the bug because swapping two
  // axes of a box does not change its longest one, but nothing *directional* read off that box is usable,
  // which is why this row has no `solids` (see below) and why HouseRooms.BLACK is measured from the
  // skinned triangles instead (tools/wall-holes.mjs).
  //
  // What goes, and why it is 83% of the triangles:
  //   Object_5 + Object_6  the ceiling fan, 25376 tri of the 40970 in the file. A fan is not what a
  //                        cellar shrine needs, and no prop in this game is worth a third of a frame.
  //   Object_8 + Object_9  both door leaves and 8188 tri of knob and hinge hardware. Dropping them is
  //                        what turns the two modelled doors into two open doorways; the south one is
  //                        the way in, and the north one is sealed by BLACK's own north wall 1.8 cm
  //                        behind it, which reads as a bricked-up door rather than as a hole.
  //   Object_14            the window glass: BLEND, mean rgb 10, and behind it is 3 m of soil. The
  //                        frame stays, so it reads as boarded over.
  //
  // height is the *longest* axis, which after the prune is z at 5.4388 units; 4.802 is that axis at the
  // scale that makes the walls 2.8004 m, the storey height the rest of the basement wing uses. y is
  // BASE_Y + 0.01 so the model's own floor lands 1.07 cm above the procedural one instead of coplanar
  // with it, which at this size is a step nobody feels and a z-fight nobody has to look at.
  //
  // yaw is -pi/2, not +pi/2. Ry(-pi/2) sends x' = -z and z' = +x, which puts the model's *west* wall on
  // the south side facing the basement, and its light switch beside the door where a light switch goes.
  // The mirrored choice looks identical in the bounding box and puts the entrance in the wrong wall.
  {
    name: 'black-magic-room.glb',
    height: 4.802,
    x: -16.66,
    y: BASE_Y + 0.01,
    z: 8.87,
    yaw: -Math.PI / 2,
    maxEyeY: -0.2,
    // Walls mean rgb 62, floor 85, ceiling 93, and every material ships baseColorFactor 1 — so this is
    // one of the files the clamp in brighten() used to make a no-op. Unlit it is a black box.
    albedo: 1.8,
    drop: ['Object_5', 'Object_6', 'Object_8', 'Object_9', 'Object_14'],
    // No `solids`. The radiator is the one part standing off a wall far enough to be worth a collider —
    // 0.10 x 0.52 x 0.76 m, drawn against the east wall at x -14.62 .. -14.45, z 8.38 .. 9.20 — but
    // propColliders boxes it with Box3, which for this file is turned 180 deg (above), so the collider it
    // emitted stood against the *north* wall at x -17.09 .. -16.33, z 10.99 .. 11.09: an invisible slab
    // in the middle of the walkable floor, and nothing at all where the radiator is. At 16 cm deep and
    // flush to a wall that BLACK already walls off, the radiator is not worth a hand-written box.
  },
  // The hospital bed goes in here rather than in the bedroom upstairs, which already has four. A gurney in
  // the room where the lady works her black magic says what the room is for; a fifth bed in a bedroom just
  // says the bedroom is full.
  //
  // 186 x 127 x 123 in file units with x longest, so height 2.0 makes it a 2 m gurney, 1.37 tall and 1.32
  // wide, spanning x -18.4 .. -16.4 and z 7.94 .. 9.26 -- inside BLACK's x -19.18 .. -14.14, z 6.6 .. 11.01,
  // clear of BLACK_DOOR at x -15.7 .. -14.7 and of the radiator on the east wall. y is BASE_Y + 0.02 for the
  // same reason the room itself is BASE_Y + 0.01: the model's own floor stands a centimetre over the
  // procedural slab, and a gurney floating over it or sunk into it both read as a bug.
  //
  // No albedo, unlike everything else down here. Its two materials are a sheet at 193,193,193 -- linear
  // 0.536, the brightest imported map in the game and brighter than the plaster upstairs -- and a frame at
  // 120,115,108 for 0.172, which is the level bed.glb ships at unlifted. A uniform multiply large enough to
  // matter to the frame takes the sheet to within a few percent of clipping, and the one white surface in a
  // black room is the last thing to flatten.
  { name: 'bed-hospital.glb', height: 2.0, x: -17.4, y: BASE_Y + 0.02, z: 8.6, maxEyeY: -0.2, collide: true, shadow: 1 },
  // horror_wall_clean, and it is down here rather than on the ground floor because of what is painted on
  // it. The file name says horror; the texture says laboratory. Rendered at 4 m on the hallway's south
  // wall it came back as a white clinical corridor panel with a red and a blue directional stripe, a
  // hazard-striped door, a red arrow labelled "Main Lab" and a notice reading "AUTHORIZED PERSONNEL ONLY".
  // On a warm plastered wall between a bedroom and a living room that does not read as a derelict house,
  // it reads as a different game. So it goes in the one room that is already clinical: the black magic
  // room, on the wall behind the gurney above. A too-clean lab wall at the back of a black magic room in
  // a basement is the horror the asset can actually carry.
  //
  // 1 : 0.36 : 0.02 and 74 triangles, so at 4 m wide it is 1.45 tall and 8.8 cm deep -- a facing over the
  // lower third of a wall, with the room's own surface above it. The room is an imported model, so its
  // walls are not on layout lines and HALF_T does not apply; these numbers come off the room's shell
  // colliders instead. Its north wall fills z 10.91 .. 11.11, so z = 10.86 puts the panel's back face 6 mm
  // clear of the inner face at 10.91, and x -16.66 centres its 4 m inside the interior span x -19.08 ..
  // -14.24. It stands 1.45 m of a 2.82 m wall, and the gurney (z 7.94 .. 9.26) is 1.6 m in front of it, so
  // the two read together from the door at x -15.2.
  //
  // No `collide`: it is flush to a wall that already stops the player, and a collider 4 cm inside an 8.8 cm
  // slab would only catch someone brushing past. No `albedo` either -- at 197,195,193 for linear 0.546 this
  // is the brightest imported map in the house, and the whole point of it here is that it is brighter than
  // the room it is in. maxEyeY matches the gurney's: the storey cull has to hide it from the ground floor.
  { name: 'wall-horror.glb', height: 4.0, x: -16.66, y: BASE_Y + 0.01, z: 10.86, maxEyeY: -0.2 },

  // --- Ritual room (altar at x = -26.8, z = 2.3) ---
  // Its three runs, faced. The fourth side is the basement's west wall carrying RITUAL_DOOR, already
  // faced above.
  ...RITUAL_WALL_PANELS,
  // The coffin the plinth used to be. `height` fits its longest axis — the file's z, 6.743 of its
  // units — so 2.4 is the length along z, and the body comes out 1.10 wide and 0.44 high. It lies
  // head-to-foot across the room's z, exactly as the plinth did, and the four symbol stubs makeAltar
  // builds stand in a line 0.40 m off its east face.
  //
  // No `clip`: the lid must not play on load — Coffin.ts arms it paused and HouseScene releases it
  // on puzzle-solve. No `clone` either: the two meshes share the animated `coffin_top` node, and a
  // clone would not rebind it. `collide` is the closed footprint only; the lid's swing is animation,
  // not geometry the player can lean on.
  {
    name: 'coffin.glb',
    id: 'coffin-ritual',
    height: 2.4,
    x: -26.8,
    y: BASE_Y,
    z: 2.3,
    collide: true,
    albedo: 2,
    shadow: 1,
  },
  /**
   * What is in the coffin. It is the payoff of the whole ritual-room puzzle: the lid swings open on
   * solve (see Coffin.ts, and the toast HouseScene fires with it) and until now it exposed an empty box
   * with a key sitting in it.
   *
   * The cavity was measured rather than guessed, because a bounding box cannot see into a hollow model
   * — the coffin's sides are single quads with no vertices between rim and base, so `.cavity.mjs` finds
   * nothing there and `.ray.mjs` had to shoot through it. In the source file the interior floor is at
   * y 12.31 and the rim at 65.07, and the row above seats the file's own min y (-5.02) on BASE_Y at
   * 2.4/674.618 = 0.003557 m per unit. That puts the cavity floor at world y -2.9383, the rim at
   * -2.7507, and gives it a working depth of just 18.8 cm. In plan it runs z 1.145 .. 3.454 and is a
   * toe-pincher: 0.93 m across at the shoulders, tapering to 0.49 m at the foot end, head at low z.
   *
   * `pitch` exists for this row and nothing else. The file is a standing figure, 1.232 x 3.362 x 0.483
   * with y longest and +z its front — the toes and the rib cage both face that way. A -pi/2 pitch sends
   * local +y to world -z, which lays the head toward the cavity's head end, and local +z to world +y,
   * which puts it on its back looking up. The longest axis is then world z, so `height: 1.75` still
   * reads as a 1.75 m person, laid down the length of the box with 28 cm to spare at either end. Its
   * width lands inside the taper at every point that matters: hands at x +-0.32 where the cavity gives
   * 0.36, elbows +-0.32 against 0.38, feet +-0.13 against 0.27.
   *
   * The one number that had to be chosen rather than measured is y. Laid flat this skeleton is 20.8 cm
   * from shoulder blade to sternum and the cavity is 18.8 cm deep, so resting it on the interior floor
   * would stand the rib cage 2 cm proud of the rim. `BASE_Y + 0.03` seats it 3 cm *below* that floor,
   * which reads as a body settled into the box: the ribs clear the rim by 1.1 cm and the skull by 1.5,
   * while the buried half stays inside a base slab 6.2 cm thick, so nothing shows through underneath.
   * The feet are the exception and are left alone — authored standing, their toes point at the ceiling
   * and reach 3.2 cm above the rim, which the closed lid's 18.7 cm shell swallows whole and the open
   * one turns into feet in a shallow coffin.
   *
   * No `collide`: it is dressing inside a container, and its footprint is the coffin's, which already
   * collides. No `shadow`: the contact quad would be drawn inside the coffin's base. No `clip` either —
   * the pipeline drops this file's animations. And no `albedo`, alone among its neighbours here: that
   * multiplier is for maps authored for a lit room, and this one already means 198,183,160 sRGB, linear
   * 0.57 — two orders of magnitude brighter than the 0.086 the doorframes needed it for. Doubling it
   * would clamp to white and turn bone into paper.
   */
  { name: 'skeleton.glb', height: 1.75, x: -26.8, y: BASE_Y + 0.03, z: 2.3, pitch: -Math.PI / 2 },
  // Far corner, turned toward the altar rather than toward the door: the player should find her
  // already occupied, not waiting for them. 1.85 rather than a human 1.7 so she reads as taller than
  // the player the moment she is seen; the ritual room's ceiling is 2.8 above BASE_Y, and her
  // footprint at this height stays clear of the west wall at x = -30. The sword in her hand is
  // measured in her own bone units, so it grows with her — see DaayanSword.
  //
  // 0.45 on the shadow, the smallest fraction in the file, because her box is the widest overstatement
  // of a contact area here: it is her silhouette with both arms out and a sword held away from her body,
  // and at 1 that is a 1.2 m puddle around a figure standing on two feet. At 0.45 it is a patch a little
  // wider than her stance, which is what a lantern two metres away actually casts.
  { name: 'daayan.glb', height: 1.85, x: -28.4, y: BASE_Y, z: 4.3, yaw: 2.41, clip: 0, speed: 0.6, shadow: 0.45 },
  // arms.glb is not here either — it is the player's own arm now, on the camera. See HeldLantern.

  // --- Upper storey (see UP_SHAFT and UPPER in HouseRooms) ---
  // The stairwell's runs, faced — the same treatment the cellar shaft got, and for the same reason:
  // looking down it from the landing, the plaster should be the damaged kind.
  ...UPSHAFT_WALL_PANELS,
  // Neither of these rows is a free choice. fitToHeight normalises the longest axis and centres the
  // bbox on x/z, so every number here is back-figured from the file's own bounding box.
  //
  // The stair: 3.936 is its longest axis (9.4849) x 0.41497, the one scale at which its 0.7229 m
  // tread rise becomes 0.300 — inside the controller's 0.35 m step-up — and its eighth tread lands
  // exactly on UP_Y. y drops it 0.068 so its own bottom step meets the shaft floor at 0 rather than
  // floating above it, the bbox bottom being that much lower than the step. Turned to climb east,
  // on the stairwell's centre line; x puts the top tread's edge on the upper room's floor edge.
  // upStairFloors() is what the player actually walks on, and it is analytic — 8 x 0.3 off y 0 — so
  // it does not move with this row.
  //
  // The last 0.01 of that drop is the other half of the threshold band. At -0.058 the top tread
  // crowned at 2.4040: 4 mm proud of the flat's own floor slab, which the apartment row below seats
  // on UP_Y, and 8 mm proud of UPPER_PATCH.floorY at 2.3960. Walking in through UPPER_DOOR you
  // crossed an 11 mm sandwich of ridged imported tread, patch floorboards and shaft-wall cap inside
  // 45 cm of x, all three near enough coplanar to trade places as the view moved. Ten more
  // millimetres puts the crown at 2.3940, under both floors, so the flat's boards own the threshold
  // outright and the tread is only ever seen going down. Collision does not move, so the player still
  // stands on 2.400 with the boards a hair under their feet.
  //
  // albedo, not curve: the treads are one warm wood material seen from half a metre with the lantern
  // in hand, so there is no tonal range for a clamped multiply to flatten, and the shaft is below eye
  // 1.9 where HouseScene's `up` fill never fires. Checked at the stair foot — warm, not clipped.
  { name: 'stair-wood.glb', height: 3.936, x: 12.43, y: -0.068, z: 1.3, yaw: Math.PI, albedo: 2.2 },
  // The apartment, at its authored size: 11.2077 *is* its longest axis, so the scale is 1 and its
  // rooms stay life-sized. Unrotated, because the side its shell leaves open already faces west, at
  // the stair. y seats its floor slab on UP_Y — the slab is 0.0592 above the model's lowest
  // geometry, so seating the bbox itself would sink the floor into the stair's top tread.
  //
  // The file's own material table is the brief here, and it says two things. Its twenty textured
  // materials carry greyscale baseColorFactors from 0.095 to 0.777 — an authored tonal range, not a
  // uniform grey — so they are raised with a curve rather than a clamped multiply; see `curve`. And
  // material #1, the 16.7k-triangle outer shell on Object_16/Object_17, is authored alphaMode BLEND
  // at alpha 0, i.e. there is no exterior wall in the file at all; see `seal`.
  //
  // `carve` is the third thing the file gets wrong and the largest: it is a cutaway diorama, so the
  // partition between the room the stair lands in and the corridor is sealed, and 43.8 of its 59 m2
  // were unreachable. See UPPER_INNER for the measurements and CarveBox for the cut.
  //
  // `gain` is the fourth: the curve lifts the factors and cannot lift the maps they multiply, and the
  // maps are what left this flat reading black at the threshold. See `gain` for the measurements.
  // `lift` is the fifth, for the ceiling the uniform gain could not reach. See `lift`.
  { name: 'room-upper.glb', height: 11.2077, x: 19.41, y: UP_Y - 0.0592, z: 3.676, minEyeY: 0.5, curve: 0.28, gain: 3.0, lift: 6, seal: true, carve: [UPPER_INNER_CUT, UP_HIDDEN_CUT], walls: { y0: 0.2, y1: 1.7, top: 2.6 } },
  // Directly after the model, because these face the sides the model does not have. It is a cutaway, and
  // the four runs the shell puts back were the last cellar-toned plaster the player could stand in front
  // of — two cheeks either side of the front door below, two either side of UP_BACK_DOOR, and the two
  // sealed bathroom corners. See UPPER_WALL_PANELS for why the room reads as already faced and how the
  // eleven walls the model *does* draw stay out of this.
  ...UPPER_WALL_PANELS,
  // The hidden room's four runs, faced like every other room. Last in the upper group because it is
  // the last room on that storey to be reached, and the only one that is *under* it. See
  // UP_HIDDEN_WALL_PANELS for why this was missed and why its cull threshold is not the 1.9 the rest
  // of the upper rooms use.
  ...UP_HIDDEN_WALL_PANELS,
  // The stairwell's own faces, the two of them that `roomWallPanels` cannot derive. See
  // UP_HIDDEN_STAIRWELL_PANELS, and the four runs in HouseRooms they stand on.
  ...UP_HIDDEN_STAIRWELL_PANELS,
  // The nook's four runs, written out by hand because every one of them is `collideOnly`. See
  // NOOK_WALL_PANELS for why this is the one room where roomWallPanels cannot be used.
  ...NOOK_WALL_PANELS,
  // The flat's own front door, filling that opening. Measured from the file: its axes are
  // 0.5715 : 1 : 0.1353, so height 2.56 makes it 1.463 wide x 0.346 thick and the frame's head lands
  // 6 cm above the opening's 4.9 header — the overlap is the point, at 2.5 the two would have met on a
  // line and shown a hairline of the void. Turned a quarter turn because the door's width runs along
  // its own x and this doorway's runs along world z. albedo, like the stair below it: the base map
  // means 57,57,47, which is the same mid-dark Lambert takes to nothing at lantern range.
  //
  // It only hangs here; the swing is armUpperDoor()'s, from the placement hook.
  /**
   * The hidden door's leaf, and **its position in this array against the front door's row below is
   * load-bearing**.
   *
   * Both are `door.glb`. The loader caches by file and hands copies to `clone` rows, and `onPlaced`
   * fires after a row is placed — so a clone taken *after* the front door has been armed would copy a
   * tree that `armUpperDoor` has already re-parented, arriving with an `upper-door.pivot` and the leaf
   * hung under it. This row is the first `door.glb` row that is a clone and it comes before the
   * non-clone one, so it copies clean.
   *
   * `drop: ['frame']` — the model's own doorway already has its surround, exactly as the cellar and
   * basement rows drop it. The file's axes are 0.5715 : 1 : 0.1353, so 2.15 makes it 1.229 wide and
   * 0.291 thick, which fills the 1.24 m carve without lapping the jambs. It only hangs here; the swing
   * and the red lock are armHiddenDoor()'s.
   *
   * The 1.229 is the *frame's* width, and the leaf inside it is 1.01: `armHiddenDoor` builds the leaf's
   * collider out of the placed model's own box, and forcing `fit.width` to 1.229 widened that collider
   * into two 6.8 m bars at 2.42 .. 4.57 either side of the door — the flat cut in half, the nook sealed
   * off, and the west strip blocked at z -1.42 by a wall nobody can see. The reveal in HouseScene lines
   * the 11.5 cm of slot either side of the leaf down to 7.5 cm, and that is what covers the rest.
   */
  {
    name: 'door.glb',
    id: 'hidden-door',
    clone: true,
    drop: ['frame'],
    height: 2.15,
    x: UP_HIDDEN_DOOR.x,
    y: UP_Y + 0.02,
    z: UP_HIDDEN_DOOR.z,
    yaw: Math.PI / 2,
    minEyeY: 0.5,
    albedo: 2.0,
  },
  /**
   * The hidden stair, inside the door's own column — the geometry behind `hiddenStairFloors()`.
   *
   * The user asked for this by name: the flight had collision and no model, so from the side it read as
   * floating boards with gaps between them rather than as steps. Both other stairs in the house are
   * `stair-wood.glb` and so is this one, as a third row on one file — `clone`, hence the distinct id.
   *
   * Fitted, not authored. The file is a grand eight-tread stair — 9.24 m long, 5.93 m tall, 7.43 m wide,
   * treads rising 0.75 m — and this well is 2.4 x 2.2 x 1.24 with a 0.275 m rise, so `fit` pulls each axis
   * to the well's own box. Same bargain the cellar stair strikes (see its row above): the walkable path is
   * `hiddenStairFloors()`' eight 0.275 m rects, and the model is what those steps *look* like. A 0.75 m
   * authored rise is over double the controller's 0.35 m step-up, so the geometry could not be the path
   * even if it fit.
   *
   * The rail is **kept**, unlike the cellar row which drops it. There the shaft is 3.0 m and the rail's
   * 2.68 m would have squashed the treads two thirds up it; here the flight is short and steep, and a rail
   * is what sells a descent into a wall this narrow as a stair rather than a ramp. It costs 0.94 m of
   * bbox depth, which the 1.24 m well absorbs.
   *
   * yaw pi: this flight's top is at the door end of the well (east). yaw 0 was tried on the reasoning
   * that the model rises toward -x as authored, but in play the flight showed up reversed, with its low
   * end at the door. See the `yaw` field.
   * x/z centre it on the well, taken from `HID_STAIR_WELL` rather than restated so the two cannot drift;
   * y seats it on the room floor, which is where its bottom tread stands and where the top tread lands at
   * `UP_HIDDEN_Y` + 2.2, flush with `UP_Y`.
   *
   * No `shadow`: this stair *is* the floor of its own well, and the multiply quad would darken its own
   * first tread — the cellar row's reasoning. No `collide`: the well walls it in and a box round the
   * flight would wall off the walkway. No `albedo`: `clone(true)` shares the upper stair's materials and
   * `brighten()` dedups on the material, so the 2.2 those rows applied already lands here.
   *
   * Placed before the front-door row for the same load-bearing reason the hidden door is: it is a clone
   * of a file whose earlier row gets re-parented by a placement hook.
   */
  {
    id: 'hidden-stair.glb',
    name: 'stair-hidden.glb',
    height: UP_HIDDEN_H,
    fit: {
      // The flight's span, not the well's: the well runs HID_HEADROOM further west for head clearance.
      width: HID_STAIR_WELL.x1 - HID_FLIGHT_X0,
      height: UP_HIDDEN_H,
      depth: HID_STAIR_WELL.z1 - HID_STAIR_WELL.z0,
    },
    x: (HID_FLIGHT_X0 + HID_STAIR_WELL.x1) / 2,
    y: UP_HIDDEN_Y,
    z: (HID_STAIR_WELL.z0 + HID_STAIR_WELL.z1) / 2,
    drop: ['012woodstairsrail'],
    // Rotated 180° per playtest: at yaw 0 the flight read as rising away from the door (west) — the
    // top tread must sit at the door end (east), flush with UP_Y, where hiddenStairFloors() starts.
    yaw: Math.PI,
    albedo: 2.2,
  },
  /**
   * What is *in* the hidden room. Until now the room was four walls, a floor and a stair down to it.
   *
   * Everything here carries `minEyeY`, and all of it for the same reason the room does not exist to a
   * player on the storey above: the room sits at 0.2 with its ceiling at 2.4, so while the eye is up at
   * 4.0 the whole room is one wall's thickness below the boards. With no occlusion culling, the radius
   * test calls all of this near — the room's centre is about 3 m from the doorway — and would draw a
   * wardrobe and a body through a solid floor. `minEyeY: 1.2` puts the band below the storey's own eye
   * height, so the contents appear on the stair, which is the first place the room can be seen at all.
   *
   * All three sit clear of the stair's column (`x 16.21..18.61`, `z -1.08..0.16`): nothing may stand in
   * the well, or the flight's own treads would pass through it.
   */
  /**
   * The wardrobe, against the room's south wall, facing north into it.
   *
   * **The three numbers below are in the file's axes, not the world's, and the smallest one is the
   * one called `width`.** That reads like a mistake and is not; this row cost three attempts and the
   * reason is worth keeping.
   *
   * Two facts compound. First, `fitToBox` scales in *source* orientation and applies `yaw` afterwards,
   * so a `fit` written in world terms lands on the wrong two axes as soon as there is a yaw (see its
   * comment). Second, `glb-bounds` reports this file as `1.0000 : 0.9591 : 0.5119` with x longest —
   * but that is **not** the box that renders. Fourteen primitives on rotated wrappers, and the box the
   * renderer actually submits is `0.284 : 2.513 : 8.05`: hair-thin in x, tall in y, and *eight times*
   * long in z. Scaling per the reported ratios produced a wardrobe 2.93 m deep and 0.39 m wide, lying
   * crosswise through the room, which is a convincing thing to see in a screenshot and completely
   * wrong. The live proportions were read off the placed object (`tools/probe-fit.mjs`) rather than
   * taken from the file-level tool, and the two disagree by a factor of 16 on x.
   *
   * **This row loads `wardrobe-hidden.glb`, a byte-identical copy of `wardrobe-chateau.glb`, and that
   * copy is the fix rather than a tidiness preference.**
   *
   * The living room already places `wardrobe-chateau.glb` and the loader caches by **file**, handing
   * every caller the same `gltf.scene` Group. Two rows on one file therefore do not place two
   * objects — they re-fit one, in sequence. This row was written that way first and cost four
   * attempts: it silently inherited the living room's `yaw: pi/2` and its `height: 2.5` scale, and
   * every measurement came back `0.394 x 1.44 x 2.93` no matter which numbers were written here,
   * through HMR and through cold reloads with the cache disabled. The numbers were never the problem.
   *
   * `clone: true` is the documented remedy and did not settle it either: measured after switching to
   * it, the box came back `2.93 x 1.44 x 0.394` — the axes had swapped but neither the 1.5 nor the
   * 0.77 was honoured, because a clone taken *after* an earlier row has fitted the group inherits that
   * fit and `fitToBox` then scales on top of it. The clone caveat in `ModelPlacement` says as much:
   * "a source row with a yaw, then a copy without one" is the hazard, and this is that shape.
   *
   * So the model gets its own file. A second cache entry cannot collide with the first, the row needs
   * no `clone`, and the numbers below are finally world axes and mean what they say: 1.5 wide,
   * 1.44 tall, 0.77 deep. The 382 KB duplicate is the honest price of two differently-sized wardrobes
   * from one download, and it is cheaper than a placement that is only correct after a reload.
   *
   * It stands at z -5.7, against the wall furthest from the doorway, spanning x 16.55..18.05. That
   * clears the stairwell column (x 16.21..18.61, z -1.08..0.16) entirely — the two overlap in x and
   * not in z. Deliberate: the player comes down the stair looking west, and the wardrobe is what the
   * lantern finds first.
   *
   * `collide` — it is the one thing in here a body should not walk through, and the room is 6 x 6.6 m
   * with nothing else competing for the floor. No `shadow`: the room is a sealed box under the storey
   * with one stairwell for light, and a contact quad under a wardrobe 11 m from the doorway would be a
   * bright patch in the dark.
   */
  {
    name: 'wardrobe-hidden.glb',
    id: 'hidden-wardrobe.glb',
    height: 2.18,
    x: 17.3,
    y: UP_HIDDEN_Y,
    z: -5.62,
    collide: true,
    albedo: 1.4,
    minEyeY: 1.2,
  },
  /**
   * The mother, seated inside the wardrobe in a deep crouch / huddled sitting position in the right corner.
   *
   * Placed inside the right bay of `hidden-wardrobe.glb` on its floor boards. The seated model
   * (`skeleton-mother-sitting.glb`) is posed in a deep squat/crouch with knees drawn up high to the chest,
   * arms folded across the knees, hands draped down, and head resting forward — matching the reference posture.
   * Placed on the wardrobe shelf at y = UP_HIDDEN_Y + 0.46 (= 0.66 m), centered in the right bay (x = 17.52, z = -5.68).
   */
  {
    name: 'skeleton-mother-sitting.glb',
    id: 'hidden-mother.glb',
    height: 1.05,
    x: 17.52,
    y: UP_HIDDEN_Y + 0.46,
    z: -5.68,
    yaw: -0.15,
    minEyeY: 1.2,
  },
  /**
   * Her necklace, worn: an Egyptian collar round the base of her neck (it replaced the heart pendant).
   *
   * The collar is a ring that drapes — high at the clasp (model -z), low at the front (+z) — so with
   * her yaw its front lies on her upper chest, facing the wardrobe door. `height` is its longest axis,
   * the width across: 0.24 m, about half again the neck's 0.15, so it reads as jewellery from the
   * doorway rather than a thread. x/z are the neck's own vertex centre (17.559, -5.854) measured on the
   * fitted skeleton (1.05 tall, base 0.66); y 1.38 and z -5.864 came out of a sweep over size, height
   * and depth as the pose where no collar vertex is within 4 mm of bone (no clipping) and the most sit
   * within 1.5 cm of it (resting on her, not floating).
   */
  {
    name: 'necklace-egyptian.glb',
    id: 'hidden-necklace.glb',
    height: 0.24,
    x: 17.559,
    y: 1.38,
    z: -5.864,
    yaw: -0.15,
    minEyeY: 1.2,
  },
  /**
   * The father's diary, placed inside the hidden room's wardrobe on its internal shelf in the left bay.
   */
  {
    name: 'pbr_dark_diary.glb',
    id: 'hidden-diary.glb',
    height: 0.28,
    x: 17.05,
    y: UP_HIDDEN_Y + 0.46,
    z: -5.62,
    yaw: 0.18,
    albedo: 1.3,
    minEyeY: 1.2,
  },
  { name: 'door.glb', height: 2.56, x: UPPER.x0, y: UP_Y, z: UPPER_DOOR.z, yaw: Math.PI / 2, albedo: 2.0 },
  // The leaf for the doorway carved through the flat's east partition. Like the main gate and unlike
  // door.glb, the whole file is the leaf — two meshes on one material, no frame and no jambs — so
  // makeCasing() is the frame here. No `drop`: the source ships a Lamp and a Camera, and the pipeline's
  // own prune already takes both because neither carries a mesh.
  //
  // Its axes are 0.4997 : 1 : 0.1068, and y is the tallest, so `height` is read as the leaf's height
  // and the other two follow: 2.15 makes it 1.074 wide x 0.230 thick. Both numbers are the opening's,
  // not the file's. The clear span between the casing's jambs is 1.05, so 1.074 laps each jamb by
  // 1.2 cm rather than leaving a slot of open wall down the side; and standing on the threshold at
  // `bottom` its head reaches 4.57, which is 9 cm into the lintel's 4.48..4.60.
  //
  // Turned a quarter turn for the same reason door.glb is: the leaf's width runs along its own x and
  // this doorway's runs along world z. It only hangs here; the swing is armInnerDoor()'s.
  { name: 'door-inner.glb', height: 2.15, x: UPPER_INNER.x, y: UPPER_INNER.bottom, z: UPPER_INNER.z, yaw: Math.PI / 2, minEyeY: 0.5, albedo: 2.0 },
  /**
   * The upper wing's three leaves stood here — the flat's south door into the attic store, the store's
   * east door into the child's room, the store's south door into the shrine — hung the way the rear
   * wing's five downstairs still are. They are gone. Those three openings are casing and no leaf now.
   *
   * They were the "view glitch" reported on this storey over and over, and the fifth and last round of
   * it. The four rounds before this one each found a real bug; this one is not a renderer bug at all. A
   * leaf is 1.074 x 2.15 m standing 57 degrees across a 1.4 m opening, and a doorway is the one place in
   * the house where the player walks *into* geometry rather than up to it. From a stand half a metre off
   * the slab with the head tipped 25 degrees down, the leaf owns 34-42% of the lower third of the frame
   * as one solid region: measured on all three, fill 0.68-0.87, mean rgb about 120,68,45 at r/b 2.3-3.2.
   * That is the brown band across the bottom of the screenshots, and blame-searching the band one child
   * at a time lands on `door-up-back`'s slab, 3266 of the 10944 pixels in it.
   *
   * Why LEAF_HIDE below does not cover it, and cannot: leafBoxes traces the slab's own diagonal, so
   * `door-up-back`'s four windows span z -1.851..-1.029 while those stands are at z -0.7..-1.3 — half a
   * metre clear of the slab on every axis. A keep-out inflated that far is not a keep-out, it is a room,
   * and at half a metre a door is legitimately in view. The leaf standing there *is* the artefact, so
   * the leaf is what goes.
   *
   * Nothing else went with them. This file is all leaf — see the row above — so makeCasing() still frames
   * all three openings, and these leaves carried no collider and no interaction ("ajar, no blocker, no
   * interaction"), so no walk path changes. If they are ever wanted back: same 2.15 height and the same
   * (half - 0.29) along the wall / 0.45 across it as the rear wing's five, y: UP_Y, minEyeY: 1.9, and
   * yaw 1.0 / 1.0 - pi/2 / pi - 1.0 for back / child / shrine respectively — the middle one quarter-turned
   * because that opening's width runs along world z and the leaf's along its own x.
   */
  // The upper wing's three rooms, faced with the same scan, for the same reason the rear wing downstairs
  // now is: they were the last plaster left in the house. Built by roomWallPanels off each room's own
  // `walls`, so the store's two partitions carry their doorways' reveals and the child's room's north run
  // stops at x 20.97 where the flat's own south wall takes over — both already true in HouseRooms, and
  // neither restated here.
  //
  // The `minEyeY: 1.9` these were built with is the point of putting them in one place: without it the
  // 20 m radius cull reaches this wing from most of the ground floor and submits a storey of panels
  // through a floor the renderer knows nothing about. See the block above UP_STORE_WALL_PANELS.
  //
  // The shrine's north side is faced from the store's side of that partition and left bare on its own,
  // which is what every shared wall in the house does — one run, one collider, faced from the room that
  // owns it.
  ...UP_STORE_WALL_PANELS,
  ...UP_CHILD_WALL_PANELS,
  ...UP_SHRINE_WALL_PANELS,
  // The upper wing's three rooms were built empty too, and take the same one piece each, in ROOMS order.
  // Every row here needs `y: UP_Y` for the storey it stands on and `minEyeY: 1.9` for the reason the facings
  // above carry it — without it the 20 m radius cull reaches this wing from most of the ground floor and
  // submits a storey of furniture through a floor the renderer knows nothing about.
  //
  // A second painting-sus.glb for the attic store, on the one unbroken run it has: the east partition
  // carries UP_CHILD_DOOR, the south one UP_SHRINE_DOOR, and the north side is the way in, so the west wall
  // is the only wall in the room with nothing cut through it. A copy rather than a move — the hallway keeps
  // its painting — and free for the same reason the kitchen table is.
  //
  // `lanternLit` on a shared material, which is safe because lanternLight() is idempotent by construction:
  // it skips any material that already carries a `map`, and the move it performs sets one. Whichever of the
  // two rows is placed first converts the material and the other's call does nothing. No `albedo` on either,
  // which is the brighten() dedup constraint the kitchen table is under — and here it is moot anyway, since
  // the file's baseColorFactor is 0,0,0 with no base texture at all and any multiple of black is black. That
  // is the whole reason `lanternLit` exists; see its doc.
  //
  // `yaw: 0` written out, not left off, and this row is the one place in the file where that matters. The
  // apply step is `if (p.yaw !== undefined) root.rotation.y = p.yaw`, and the copy is taken from the cached
  // Group the hallway row above has already turned by -pi/2 in place — that row is not a clone, so it
  // rotated the shared original rather than a copy of it. Omitting yaw here would not have meant zero, it
  // would have meant keep: measured in the live WebView it came out 0.500 wide on x by 0.038 thick on z,
  // spanning x 14.36 .. 14.86, a fin driven through the west wall instead of a painting hung on it. No
  // other file is exposed. wall-damaged.glb has no un-cloned row at all, table.glb's carries no yaw, and
  // the two door files' un-cloned rows are placed after their copies and set yaw on every row regardless.
  //
  // Zero is what the wall wants. The canvas's face normal is local +x — the hallway row turns -pi/2 to aim
  // that at world +z, north up the hallway — so unrotated it looks +x, into the room off a west wall. The
  // fit at height 0.9 is then 0.501 wide on z by 0.0376 thick on x, so x 14.61 puts its back at 14.591,
  // 3.1 cm in front of the west facing at 14.56: the same standoff the hallway row is cut to, and for the
  // same reason, which is that audit-facings.ts calls anything within 4 cm of a facing a burial waiting to
  // happen. z -4.135 centres it on the room's usable depth, square on the sightline from UP_CHILD_DOOR,
  // which is at z -4.0 in the wall directly opposite.
  //
  // y UP_Y + 1.25 rather than the hallway row's 1.6. This storey's rooms are 2.7 tall against the ground
  // floor's 3.0, and at 1.6 a 0.9 m canvas would leave 0.2 m to the ceiling; 1.25 centres it 1.70 above the
  // floor, which is eye height, so the player meets it head on and it still clears the ceiling by 0.55.
  { name: 'painting-sus.glb', id: 'painting-sus-store', clone: true, height: 0.9, x: 14.61, y: UP_Y + 1.25, z: -4.135, yaw: 0, minEyeY: 1.9, lanternLit: true },
  // Vintage ornate iron key prop, placed in the attic store.
  {
    name: 'key-iron.glb',
    id: 'key-iron',
    height: 0.18,
    x: 16.5,
    y: UP_Y + 0.85,
    z: -4.2,
    yaw: 0.4,
    minEyeY: 1.9,
    shadow: 1,
  },
  // bed-old.glb for the child's room, out of the bedroom. Scale 1.0 at height 1.7557 — the fit is the file's
  // own longest axis — so it is 0.786 wide by 1.756 long and 0.682 tall: a single bed, which is what put it
  // in this room rather than the shrine. One mesh, so the file offers no headboard cue either way and the
  // row keeps the bedroom's yaw 0, length along z.
  //
  // In the south-east corner, against the two walls this room owns. x 23.86 spans 23.467 .. 24.253 against
  // the east facing's front at 24.29, and z -5.32 spans -6.198 .. -4.442 against the south facing's front at
  // -6.24 — 3.7 and 4.2 cm of air, the same clearance every other wall-hugging row in the house is cut to.
  // The west side is bare plaster at 18.7, because the attic store owns x 18.6 and faces that run from its
  // own side; UP_CHILD_DOOR is cut through it at z -3.3 .. -4.7, so the bed stands five metres from the way
  // in with nothing between. Reachable as a hiding place, which is the point of moving it: the collider's
  // west face is at 23.507, a 0.35 m player gets their centre to 23.157, and that is 0.70 m from the
  // interaction point against a reach of 1.763.
  { name: 'bed-old.glb', height: 1.7557, x: 23.86, y: UP_Y, z: -5.32, minEyeY: 1.9, collide: true, albedo: 1.8, shadow: 1 },
  // Bedside cabinet with animated door and drawer in the upper child's room.
  {
    name: 'cabinet-animated.glb',
    id: 'cabinet-animated',
    height: 0.85,
    x: 22.8,
    y: UP_Y,
    z: -3.8,
    yaw: -Math.PI / 2,
    minEyeY: 1.9,
    collide: true,
    shadow: 1,
  },
  // bed-horror.glb for the shrine, also out of the bedroom, and the double goes in the largest of the three
  // rooms: 9.73 x 4.34 of usable floor against the child's room's 5.59 x 4.15.
  //
  // `drop` takes the 4.44 x 4.44 m ground plane the file ships under the bed, exactly as it did downstairs.
  // It is the longest axis in the file, so left in it would set the scale for everything — the bed would
  // come out half size — and it would z-fight this room's floor across a third of it. What is left measures
  // 2.224 x 0.840 x 1.149 with x longest, so height 2.224 is scale 1.0 and the row is the bedroom's number.
  //
  // Along the south wall, long side out. z -10.22 spans -10.795 .. -9.646 against the south facing's front
  // at -10.84, and x 17.0 spans 15.888 .. 18.112, 1.33 m clear of the west facing at 14.56. UP_SHRINE_DOOR
  // is at x 16.5 in the north wall, which the attic store owns and faces from its own side, so from in here
  // that run is plaster at -6.5 and the bed is the first thing the room shows — a little over three metres
  // ahead and slightly to the left, with 3.15 m of open floor between it and the doorway.
  //
  // Reachable too: the collider's north face is at -9.686, the player's centre comes to -9.336, and that is
  // 0.88 m from the interaction point against a reach of 2.007. Neither bed takes an `id`, which is what
  // keeps them hiding places at all — Hiding.ts matches BED_NAMES against the resolved id, and an id would
  // resolve to something that is not a file name in that set.
  { name: 'bed-horror.glb', drop: ['Floor'], height: 2.224, x: 17.0, y: UP_Y, z: -10.22, minEyeY: 1.9, collide: true, albedo: 1.8, shadow: 1 },
  // The main gate's leaf. Four meshes, no frame and no jambs in the file — which is why it can stand in
  // for the two barred leaves without disturbing anything: makeCasing() is still the frame and the three
  // locks are still procedural, on the wall's centre line where the puzzle needs them.
  //
  // It arrives at metre scale already, 1.6402 x 2.4964 x 0.1322, so height 2.5 is barely a scale at all
  // (x1.0014) and is chosen to sit 5 cm above GATE.top rather than to make some round number: the head
  // has to overlap the casing's, and the opening was cut to this slab instead of the reverse — see GATE.
  // No yaw: the leaf's width already runs along world x, the way the hall's south wall does.
  //
  // z is 3 cm behind the wall's centre line so the lock plates, drawn at z + 0.06, land on the leaf's
  // outward face and read as bolted through it. That keeps every hardware number in makeGate() as it
  // was. albedo 2.0 for the measured 70,51,36 base map, the same mid-dark the stair needed.
  //
  // Hung only; hingeMainGate() does the swing, driven from openGate() in HouseScene.
  //
  // `first` because of where it is rather than what it is: this row is the last line of the file and
  // the gate stands directly in front of the spawn, so in authoring order it was the twenty-eighth
  // model to load and appeared out of an empty doorway several seconds in. See ModelPlacement.first.
  { name: 'gate-main.glb', height: 2.5, x: GATE.x, z: GATE.z - 0.03, albedo: 2.0, first: true },
];

export interface ModelPropsHandles {
  /** Gate and spawn bed have each either been placed or reported failed. */
  startupReady: Promise<void>;
  /** Every placement has either landed or reported its own failure. */
  allReady: Promise<void>;
  /**
   * Pay every placed model's first-draw cost now, behind the title screen, instead of at the moment
   * the player walks into it. See the comment on the implementation for what that cost is and why the
   * cellar stair is where it used to land.
   */
  warm: (renderer: WebGLRenderer) => Promise<void>;
  update: (dt: number) => void;
  dispose: () => void;
}

/**
 * Distance past which a model stops being drawn and its clip stops being evaluated.
 *
 * There is no occlusion culling here — the frustum runs straight through walls — so measured from
 * the bedroom the renderer was still drawing the daayan, the severed hand and the basement cat two
 * rooms and a storey away: 43k triangles and 33 draw calls for pixels that never reach the screen.
 * 20 m covers the longest sightline in the house, the 18 m hallway, and drops everything that is on
 * the far side of the map.
 */
const CULL_RADIUS_SQ = 50 * 50;

/**
 * How near a `leaf` row's slab the eye may come before the row stops being drawn.
 *
 * The near plane is at 0.10 m, so a triangle closer than that is one the rasteriser will cut, and
 * cutting a slab the eye is inside is the flicker. The rest is margin: the boxes trace the leaf's own
 * diagonal in `leaf` steps, so between two steps they stand a centimetre or two off the slab, and the
 * test below inflates a box rather than measuring a true distance. Both err toward hiding early, which
 * is the safe direction.
 *
 * Measured over every collision-legal eye position round all fourteen leaves, standing and crouched, on
 * a 5 cm grid: 0.18 m is where the count of positions that are inside the near plane with the leaf still
 * drawn reaches nought. 0.15 m leaves one, at the upper shrine door; 0.10 m leaves eighty. This is that
 * plus 2 cm, and it is deliberately not more — every centimetre here is a centimetre earlier that a
 * doorway the player is walking through blinks.
 */
const LEAF_HIDE = 0.2;

/** Is `q` inside any of `boxes`, each grown by `m`? See LEAF_HIDE. */
function insideAny(boxes: AABB[], q: Vector3, m: number): boolean {
  for (const b of boxes) {
    if (
      q.x > b.minX - m && q.x < b.maxX + m &&
      q.y > b.minY - m && q.y < b.maxY + m &&
      q.z > b.minZ - m && q.z < b.maxZ + m
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The material slots warm() uploads. Written out rather than discovered by scanning every key on the
 * material: `Object.values(mat)` would also hand back the render targets three keeps on some materials,
 * and initTexture on one of those is not a no-op.
 */
const TEXTURE_SLOTS = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap',
  'alphaMap', 'bumpMap', 'displacementMap', 'specularMap', 'envMap', 'lightMap',
] as const;

/**
 * Textures uploaded between yields. 16 keeps each slice near a frame's worth of work at the ~20 ms per
 * texture a mid-range phone manages, so the title screen behind this keeps animating.
 */
const TEX_PER_SLICE = 16;

/** Every distinct texture on every material under `root`, deduped — one material is shared by many meshes. */
function collectTextures(root: Object3D): Texture[] {
  const seen = new Set<Texture>();
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (mesh.material === undefined) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const slots = m as unknown as Record<string, unknown>;
      for (const k of TEXTURE_SLOTS) {
        const t = slots[k];
        if (t !== null && t !== undefined && (t as Texture).isTexture === true) seen.add(t as Texture);
      }
    }
  });
  return [...seen];
}

/**
 * Multiply every base colour under `root` by k, once per distinct material. See ModelPlacement.albedo.
 *
 * The dedup and the flag are both load-bearing rather than tidiness: ModelLoader's conform() shares
 * one material instance across every mesh that asked for the same source material, so multiplying per
 * mesh would raise a colour by k to the power of the mesh count, and the loader hands that same cached
 * Group to any later caller — a second install would compound it again.
 */
function brighten(root: Object3D, k: number): void {
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const lam = m as MeshLambertMaterial;
      if (lam.userData['albedoScaled'] === true) continue;
      lam.userData['albedoScaled'] = true;
      // See ModelPlacement.albedo for the asymmetry: with a map the factor modulates it and may exceed
      // 1; without one it is the surface colour and white is the ceiling.
      const cap = lam.map ? Infinity : 1;
      lam.color.setRGB(
        Math.min(cap, lam.color.r * k),
        Math.min(cap, lam.color.g * k),
        Math.min(cap, lam.color.b * k),
      );
    }
  });
}

/**
 * Move every image this model keeps in the *emissive* slot into the albedo slot, so the lantern lights
 * it. Returns how many materials moved, for the caller to sanity-check against. See
 * ModelPlacement.lanternLit.
 *
 * Only a material that has an emissive map and no base colour map is touched, which is both what makes
 * this idempotent — after the move there is nothing left in the slot to move, and ModelLoader hands the
 * same cached Group to every caller — and what keeps it off a material that legitimately glows *and* has
 * an albedo, where the emissive is a highlight rather than the picture.
 *
 * The base colour goes white because it is now a multiplier on the image rather than the surface's own
 * colour, and it was authored black precisely so the emissive would be all anyone saw.
 */
function lanternLight(root: Object3D): number {
  let moved = 0;
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const lam = m as MeshLambertMaterial;
      if (!lam.emissiveMap || lam.map) continue;
      lam.map = lam.emissiveMap;
      lam.emissiveMap = null;
      lam.emissive.setHex(0x000000);
      lam.color.setRGB(1, 1, 1);
      lam.needsUpdate = true;
      moved++;
    }
  });
  return moved;
}

/**
 * See ModelPlacement.seal. The undertone the sealed shell is tinted with, under the plaster map that
 * dressShell puts on it.
 *
 * History, because it is the reason this file has a `seal` at all. `room-upper.glb` declares its
 * 16.7k-triangle shell fully transparent with no map, so it arrives invisible; the flat is authored
 * inward-facing, so that shell is not scenery seen from outside — it is the wall the player is looking
 * at, 37% of the frame at the flat's threshold and 57% two metres in, and nothing at all once past the
 * partition. Sealed opaque at the 0x26262c first chosen, a third of the first two frames of the flat sat
 * under 8/255, which is the black the player reported. 0x4a4a52 took those frames to 31 and 35 mean with
 * 1 to 2% black, in line with the 30 to 57 the mapped materials come back at.
 *
 * That fixed the brightness and left the defect: 276 m2 of vertical wall with no texture on it, beside
 * the procedural plaster the rest of the storey wears. Which is why the flat colour is now a tint under
 * a map rather than the surface itself — see dressShell. White, so the plaster reads at exactly the
 * value HouseBuilder's own walls read at; the constant stays as the fallback for a shell whose geometry
 * cannot take world UVs, and as the record of what was measured.
 */
const SHELL_COLOUR = 0x4a4a52;

/**
 * A node name reduced to letters and digits, lower case, for matching `drop` and `solids` against.
 *
 * The file says `big pipe_68` and `rouf.001_165`; three.js hands back `big_pipe_68` and `rouf001_165`,
 * because GLTFLoader runs every node name through PropertyBinding.sanitizeNodeName, which turns
 * whitespace into underscores and deletes `.`, `:`, `/` and brackets. Matching on the raw name works
 * until the first name with a space in it, which in this file is the fourth one. Stripping both sides
 * to alphanumerics means the placement data can be written from what the file says.
 */
const tag = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/** See ModelPlacement.drop. Returns how many subtrees went, for the caller to sanity-check against. */
function prune(root: Object3D, drop: string[]): number {
  const keys = drop.map(tag);
  const doomed: Object3D[] = [];
  root.traverse((o) => {
    if (keys.some((k) => tag(o.name).startsWith(k))) doomed.push(o);
  });
  // Detached, not disposed: ModelLoader hands the same Group to every caller, so freeing geometry here
  // would break the next install. A node that is never in the graph is never uploaded either way.
  for (const o of doomed) o.removeFromParent();
  return doomed.length;
}

/** Inset on each side of a prop collider, so brushing past furniture does not catch on air. */
const SOLID_INSET = 0.03;

/**
 * See ModelPlacement.solids. Must run after the model is in the scene graph and after the fit, because
 * every box here is read in world space.
 */
function propColliders(root: Object3D, names: string[], out: AABB[]): number {
  const keys = names.map(tag);
  const box = new Box3();
  let n = 0;
  root.updateWorldMatrix(true, true);
  root.traverse((o) => {
    if (!keys.some((k) => tag(o.name).startsWith(k))) return;
    box.setFromObject(o);
    if (box.isEmpty()) return;
    // Floor to top of the object rather than to the ceiling: these are things to walk around, and a
    // couple of them are low enough that the player should see over.
    out.push({
      minX: box.min.x + SOLID_INSET, maxX: box.max.x - SOLID_INSET,
      minY: box.min.y, maxY: box.max.y,
      minZ: box.min.z + SOLID_INSET, maxZ: box.max.z - SOLID_INSET,
    });
    n++;
  });
  return n;
}

/**
 * Raise every base colour under `root` to the power g, apply `gain`, lift the darkest map, and seal
 * the shell on the way past, once per distinct material. See ModelPlacement.curve, ModelPlacement.gain,
 * ModelPlacement.lift and ModelPlacement.seal.
 *
 * The dedup and the flag are load-bearing here for the same reason they are in brighten(): one material
 * instance is shared across meshes, and the loader hands the same cached Group to any later caller, so
 * an unguarded pass would apply the curve g^(mesh count) times and again on a second install.
 *
 * Colours are read in the renderer's linear working space, which is where GLTFLoader puts
 * baseColorFactor, so the exponent lands on the file's own numbers rather than on sRGB.
 */
function curveAlbedo(root: Object3D, g: number, seal: boolean, gain = 1, lift = 1): void {
  const mapped: MeshLambertMaterial[] = [];
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const lam = m as MeshLambertMaterial;
      if (lam.userData['albedoScaled'] === true) continue;
      lam.userData['albedoScaled'] = true;
      // The shell is matched on what it is rather than on its name — fully transparent, with neither
      // a map nor an alpha map for that opacity to have been reserved for — so this keeps working if
      // the file is re-exported with different material names.
      if (seal && lam.transparent && !lam.map && !lam.alphaMap && lam.opacity < 0.02) {
        lam.transparent = false;
        lam.depthWrite = true;
        lam.opacity = 1;
        lam.color.setHex(SHELL_COLOUR);
        lam.needsUpdate = true;
        // Found here, dressed after the add: the map wants world-space UVs and this runs while the
        // model is still outside the scene graph. dressShell reads this flag rather than repeating the
        // four-part test, so there is one definition of "this is the shell".
        lam.userData['sealed'] = true;
        continue;
      }
      // Past the `continue` above, so the gain never lands on the sealed shell: that one is a flat
      // slate colour standing in for an exterior wall, and it is lit from outside, not by the lantern.
      lam.color.setRGB(
        Math.pow(lam.color.r, g) * gain,
        Math.pow(lam.color.g, g) * gain,
        Math.pow(lam.color.b, g) * gain,
      );
      if (lam.map) mapped.push(lam);
    }
  });
  // Only the materials this call actually touched are candidates, so a second install — where every
  // one of them is already flagged and `mapped` comes back empty — cannot compound the lift.
  if (lift > 1) liftDarkestMap(mapped, lift);
}

/**
 * Give the sealed shell the same wall scan the rest of the storey wears, tiled from where it stands
 * in the world.
 *
 * This is the fix for the last of the reported "view glitches" upstairs, and the only one of the four
 * that was never a renderer artefact. Measured on the device: the shell is 276.3 m2 of vertical wall
 * over 9,221 triangles — a third of the frame at the flat's threshold — carrying `attrs
 * [normal,position]`, no `uv` at all, and therefore no texture it could ever have worn. Round 2 gave
 * the procedural walls brick-patched plaster and skirting, which is why this is the thing the player
 * ended up pointing at: it did not get worse, everything beside it got better.
 *
 * Wearing HouseBuilder's own wallWarm map at the same WALL_TILE_U/V through the same world-space UV
 * convention is what makes the seam disappear rather than merely be textured on both sides: a
 * procedural wall and the .glb's wall that meet at a corner sample the same texel at the same point in
 * the world, so the pattern runs straight through the join. Sharing the Texture and not the Material
 * keeps the shell on the imported rung of the depth ladder — see HouseBuilder's bias() — so which
 * surface wins a coplanar tie does not change, and it costs neither a draw call nor a second 1024
 * canvas.
 *
 * Must run after `group.add(root)`, for the reason wallColliders documents: the UV is computed from the
 * world position and before the add there is no world. The vertices stay where the fit put them —
 * worldUv takes the matrix and throws the transformed position away, because the fit's 5.604 is what
 * the colliders and the clips are measured in.
 *
 * Idempotent per geometry and per material: ModelLoader hands the same cached Group to a second install
 * and a second pass would be a second setAttribute on live buffers.
 */
function dressShell(root: Object3D, wallMap: Texture | null): number {
  if (!wallMap) return 0;
  let dressed = 0;
  root.updateWorldMatrix(true, true);
  // DRESS_SHELL_BODY
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const sealed = mats.filter((m) => (m as MeshLambertMaterial).userData['sealed'] === true);
    // All-or-nothing, and normals required. A mesh that mixes the shell with a mapped material shares
    // one uv attribute between them, so rewriting it would move the mapped half's texture; a mesh with
    // no normals has no facing to choose a projection axis from. Either way it keeps SHELL_COLOUR and
    // stays flat, which is the state this function improves on rather than depends on.
    if (sealed.length === 0 || sealed.length !== mats.length) return;
    if (!mesh.geometry.getAttribute('normal')) return;
    if (mesh.geometry.userData['worldUv'] !== true) {
      mesh.geometry.userData['worldUv'] = true;
      worldUv(mesh.geometry, WALL_TILE_U, WALL_TILE_V, mesh.matrixWorld);
      dressed++;
    }
    for (const m of sealed) {
      const lam = m as MeshLambertMaterial;
      if (lam.map === wallMap) continue;
      lam.map = wallMap;
      // White under the map, so the plaster reads at exactly the value HouseBuilder's walls read at.
      lam.color.setHex(0xffffff);
      lam.needsUpdate = true;
    }
  });
  return dressed;
}

/**
 * See ModelPlacement.lift. Multiplies k into the darkest-mapped material of `mats`, and only if it
 * really is the darkest by a margin: the next one up must be at least a quarter brighter.
 *
 * The map is measured rather than trusted because the number that matters is the product of the base
 * colour with it, and only one of the two is in the file as a number. A 48x48 draw is enough for a mean
 * over a texture whose whole point here is that it is flat.
 *
 * Measured over room-upper.glb's eighteen mapped materials, products run 0.0192 (auto1, the ceiling) and
 * 0.0298 for the next, to 2.14 for the brightest — a ratio of 1.55 at the bottom, which is why the
 * margin is a quarter and not the half a first pass guessed at. A re-export that flattens the bottom of
 * that spread turns this into a no-op rather than into a lift landing on an arbitrary material.
 */
function liftDarkestMap(mats: MeshLambertMaterial[], k: number): void {
  const products: { m: MeshLambertMaterial; p: number }[] = [];
  for (const m of mats) {
    const mean = mapMeanLinear(m);
    if (mean === null) continue;
    products.push({ m, p: (0.2126 * m.color.r + 0.7152 * m.color.g + 0.0722 * m.color.b) * mean });
  }
  if (products.length < 2) return;
  products.sort((a, b) => a.p - b.p);
  const [lo, next] = products as [{ m: MeshLambertMaterial; p: number }, { m: MeshLambertMaterial; p: number }];
  if (lo.p * 1.25 >= next.p) return;
  lo.m.color.multiplyScalar(k);
}

/**
 * Mean luminance of a material's albedo map in linear space, or null if the image cannot be drawn —
 * a compressed or cross-origin texture, which is a reason to skip the material, not to throw.
 */
function mapMeanLinear(m: MeshLambertMaterial): number | null {
  const im = m.map?.image as (HTMLImageElement | ImageBitmap | HTMLCanvasElement | undefined);
  if (!im) return null;
  const w = Math.min(48, (im as { width?: number }).width ?? 0);
  const h = Math.min(48, (im as { height?: number }).height ?? 0);
  if (w < 1 || h < 1) return null;
  try {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(im as CanvasImageSource, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    let s = 0;
    // sRGB bytes to linear one channel at a time, because the transfer function is not linear and a
    // mean taken before it would read a dark texture as brighter than the shader will.
    for (let i = 0; i < d.length; i += 4) {
      s += 0.2126 * srgbToLinear(d[i]!) + 0.7152 * srgbToLinear(d[i + 1]!) + 0.0722 * srgbToLinear(d[i + 2]!);
    }
    return s / (d.length / 4);
  } catch {
    return null;
  }
}

/** One sRGB byte to linear, the same transfer function the renderer applies to an sRGB texture. */
function srgbToLinear(b: number): number {
  const v = b / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** See ModelPlacement.walls. Finest cell the slice uses, so a 0.9 m doorway is not pinched shut. */
const WALL_CELL = 0.05;
/** Shortest run that counts as wall. Under this it is a pipe, a chair leg, a skirting return. */
const WALL_MIN_RUN = 0.7;
/** Thickest a run may be and still be wall. Over this it is furniture with a footprint. */
const WALL_MAX_THICK = 0.4;

/**
 * Slice `root` at chest height and push a collider for every wall it finds. See ModelPlacement.walls.
 *
 * Walls are found by projection, not by name or by material, so this works on a file nobody has read.
 * A wall is vertical, so its triangles project to *lines* in plan rather than to areas — which is why
 * the three edges are walked cell by cell instead of the triangle's bounding box being filled. A
 * diagonal wall's bounding box is a large empty square, and filling those is what first read as "the
 * whole flat is solid" when this was measured on the phone.
 *
 * Near-horizontal triangles are dropped or the floor slab and the ceiling would each stamp the entire
 * footprint. What survives is merged into maximal rectangles, so the controller gets a few dozen boxes
 * out of six and a half thousand triangles.
 */
function wallColliders(
  root: Object3D,
  floor: number,
  band: NonNullable<ModelPlacement['walls']>,
  out: AABB[],
): void {
  root.updateWorldMatrix(true, true);
  const yLo = floor + band.y0;
  const yHi = floor + band.y1;
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  const e1 = new Vector3(), e2 = new Vector3(), n = new Vector3();
  /** Wall edges projected to plan, x z x z per entry, with the bounds they span. */
  const segs: number[] = [];
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const edge = (px: number, pz: number, qx: number, qz: number): void => {
    segs.push(px, pz, qx, qz);
    x0 = Math.min(x0, px, qx); x1 = Math.max(x1, px, qx);
    z0 = Math.min(z0, pz, qz); z1 = Math.max(z1, pz, qz);
  };
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const pos = mesh.geometry.getAttribute('position');
    const idx = mesh.geometry.getIndex();
    const count = idx ? idx.count : pos.count;
    const at = (t: number, k: number): number => (idx ? idx.getX(t + k) : t + k);
    for (let t = 0; t + 2 < count; t += 3) {
      a.fromBufferAttribute(pos, at(t, 0)).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(pos, at(t, 1)).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(pos, at(t, 2)).applyMatrix4(mesh.matrixWorld);
      if (Math.max(a.y, b.y, c.y) < yLo || Math.min(a.y, b.y, c.y) > yHi) continue;
      e1.subVectors(b, a); e2.subVectors(c, a);
      n.crossVectors(e1, e2);
      if (n.lengthSq() < 1e-12) continue;
      if (Math.abs(n.normalize().y) > 0.5) continue;
      edge(a.x, a.z, b.x, b.z); edge(b.x, b.z, c.x, c.z); edge(c.x, c.z, a.x, a.z);
    }
  });
  if (segs.length === 0) return;
  // Cells are WALL_CELL unless the model is big enough that that would cost megabytes, in which case
  // they grow to hold the grid inside four million of them — a metre or two of extra slop on a
  // warehouse is cheaper than the allocation.
  const cell = Math.max(WALL_CELL, Math.sqrt(((x1 - x0) * (z1 - z0)) / 4e6));
  const nx = Math.ceil((x1 - x0) / cell) + 1;
  const nz = Math.ceil((z1 - z0) / cell) + 1;
  const grid = new Uint8Array(nx * nz);
  for (let i = 0; i < segs.length; i += 4) {
    const px = segs[i] ?? 0, pz = segs[i + 1] ?? 0, qx = segs[i + 2] ?? 0, qz = segs[i + 3] ?? 0;
    // Half-cell steps, so a segment cannot skip over a cell it passes through.
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(qx - px), Math.abs(qz - pz)) / (cell * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const ix = Math.floor((px + (qx - px) * t - x0) / cell);
      const iz = Math.floor((pz + (qz - pz) * t - z0) / cell);
      if (ix >= 0 && ix < nx && iz >= 0 && iz < nz) grid[ix * nz + iz] = 1;
    }
  }
  // Greedy maximal rectangles: widen along x first, then deepen while the whole width holds. A wall
  // running either way comes out as one box, which is what keeps the count in the dozens.
  const taken = new Uint8Array(nx * nz);
  const top = floor + band.top;
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      if (grid[ix * nz + iz] !== 1 || taken[ix * nz + iz] === 1) continue;
      let w = 1;
      while (ix + w < nx && grid[(ix + w) * nz + iz] === 1 && taken[(ix + w) * nz + iz] === 0) w++;
      let h = 1;
      for (;;) {
        const jz = iz + h;
        if (jz >= nz) break;
        let whole = true;
        for (let k = 0; k < w && whole; k++) {
          whole = grid[(ix + k) * nz + jz] === 1 && taken[(ix + k) * nz + jz] === 0;
        }
        if (!whole) break;
        h++;
      }
      for (let k = 0; k < w; k++) for (let j = 0; j < h; j++) taken[(ix + k) * nz + iz + j] = 1;
      const dx = w * cell, dz = h * cell;
      if (Math.max(dx, dz) < WALL_MIN_RUN || Math.min(dx, dz) > WALL_MAX_THICK) continue;
      out.push(aabbOf(x0 + (ix + w / 2) * cell, floor, z0 + (iz + h / 2) * cell, dx / 2, dz / 2, top));
    }
  }
}

interface Placed {
  root: Object3D;
  /** Centre of the placed box, not the origin — fitToHeight sits models *on* the floor. */
  centre: Vector3;
  /** See ModelPlacement.minEyeY. */
  minEyeY?: number;
  /** See ModelPlacement.maxEyeY. */
  maxEyeY?: number;
  /**
   * The boxes tracing a `leaf` row's slab, world space, measured once here because nothing moves these
   * leaves. The cull below stops drawing the row while the eye is inside them.
   */
  leafKeep?: AABB[];
  mixer?: AnimationMixer;
  /**
   * This model's contact shadow, for rows that asked for one. Held here only so the cull below can
   * hide it with its model — a shadow left behind by a culled prop is a stain on an empty floor.
   */
  shadow?: Mesh;
}

/**
 * The order MODEL_PLACEMENTS is actually loaded in: `first` rows, then the rest, each group otherwise
 * in the order it was written.
 *
 * The one invariant this has to preserve is that a row standing `on` another is placed after it, since
 * `on` is resolved through a map of measured tops that only has an entry once the support is down. A
 * plain partition would break that the moment someone marks a row `first` that happens to stand on
 * something, so the support is pulled forward with it instead — which is also why this walks the list
 * through `emit` rather than sorting: a comparator cannot express "and bring its support along".
 *
 * `seen` is added before the recursion, so a support cycle (a row `on` something that is `on` it)
 * terminates rather than overflowing. Such a pair would come out in authoring order and the later one
 * would find no top and fall back to its absolute `y`, which is the same thing that happens today for
 * a typo in `on` — wrong, visibly, in one place, instead of hanging the load of the whole house.
 */
function loadOrder(rows: readonly ModelPlacement[]): ModelPlacement[] {
  const byId = new Map<string, ModelPlacement>();
  for (const r of rows) byId.set(r.id ?? r.name, r);

  const out: ModelPlacement[] = [];
  const seen = new Set<ModelPlacement>();
  const emit = (r: ModelPlacement): void => {
    if (seen.has(r)) return;
    seen.add(r);
    const support = r.on !== undefined ? byId.get(r.on) : undefined;
    if (support !== undefined) emit(support);
    out.push(r);
  };

  for (const r of rows) if (r.first === true) emit(r);
  for (const r of rows) emit(r);
  return out;
}

/**
 * How many files ahead of the one being placed to start fetching.
 *
 * The placement loop stays strictly serial — see ModelPlacement.first for why — but there is no reason
 * for the network to be idle while a mesh is being decoded and fitted. ModelLoader caches the *promise*
 * per file name, so the loop's own `await loader.load(...)` joins whatever a prefetch already started
 * instead of fetching the file twice.
 *
 * Two, not all of them. The point is to keep one download in flight at all times, not to have twenty-
 * eight arriving at once and competing for the same decode: at that width the phone spends the first
 * seconds parsing meshes for rooms the player has not reached, which is the pop-in this is meant to fix.
 */
const LOOKAHEAD = 2;

/**
 * Load and place everything in MODEL_PLACEMENTS. Resolves once every model has either been placed
 * or failed; the caller need not await it, and a failure is reported rather than thrown so one bad
 * file cannot cost the player the other ten.
 *
 * `onPlaced` fires per model, after its fit and after it is in the scene — which is the only moment
 * at which something may be hung off one of its bones, since the fit writes the root's own scale and
 * everything measured in bone units depends on it. It is handed the file's clips as well, for the one
 * thing `clip` cannot do: a one-shot the player triggers, which has to be built where the trigger is.
 * See RitualDoors.
 *
 * `shadowMat` is the house's one contact-shadow material, from FixtureMats — passed in rather than
 * made here because the procedural dressing merges its shadows through the same instance, and two
 * instances of the same material is two draw calls for no reason. See ContactShadow.
 *
 * `wallMap` is HouseBuilder's warm plaster, for the one imported model that has to pass for part of the
 * house rather than for something standing in it. See dressShell. Null disables that pass, which leaves
 * the shell flat but correct.
 */
export function installModels(
  loader: ModelLoader,
  scene: Scene,
  eye: Camera,
  aabbs: AABB[],
  shadowMat: MeshBasicMaterial,
  wallMap: Texture | null,
  onError: (err: unknown, where: string) => void,
  onPlaced?: (name: string, root: Object3D, clips: AnimationClip[]) => void,
): ModelPropsHandles {
  const group = new Group();
  group.name = 'models';
  scene.add(group);
  const placed: Placed[] = [];
  /** True only inside warm(), which needs the cull to stop fighting it. See there. */
  let warming = false;
  /** Measured top of each placed model, for entries that stand on one. */
  const tops = new Map<string, number>();
  // Every panel the gate waits for, taken from the one flag that decides it rather than from a second
  // list that could disagree with the first. The hall's four sides and the bedroom's three runs are
  // `first`; the living room's and the basement's are not, and adding a room to the gate later means
  // marking it `first` in one place.
  const startupPending = new Set([
    'gate-main.glb',
    ...WALL_PANELS.filter((p) => p.first === true).map((p) => p.id ?? p.name),
  ]);
  let resolveStartup!: () => void;
  const startupReady = new Promise<void>((resolve) => {
    resolveStartup = resolve;
  });
  const markStartupSettled = (id: string): void => {
    if (!startupPending.delete(id)) return;
    if (startupPending.size === 0) resolveStartup();
  };
  /**
   * One quad for every shadow under an imported model. They cannot be merged the way the procedural
   * ones are — these arrive over the following several seconds and are culled individually — but they
   * can at least share the four vertices, so the footprint lives in each mesh's scale.
   */
  const shadowGeo = shadowUnitQuad();

  const allReady = (async () => {
    const queue = loadOrder(MODEL_PLACEMENTS);
    for (const [i, p] of queue.entries()) {
      const id = p.id ?? p.name;
      // Start the next file or two downloading while this one is placed. Rejection is swallowed here
      // and here only: the placing `await` below asks for the same cached promise, gets the same
      // rejection, and reports it once through the catch — so this must not report it as well, and
      // must not be left unhandled either.
      for (let k = 1; k <= LOOKAHEAD; k++) {
        const ahead = queue[i + k];
        if (ahead !== undefined) {
          void loader.load(ahead.name).catch(() => {});
        }
      }
      try {
        const loaded = await loader.load(p.name);
        const clips = loaded.clips;
        // The loader's cache is per file, so a second row for the same file has to copy or it would
        // just move the first one. See ModelPlacement.clone.
        const root = p.clone === true ? loaded.root.clone(true) : loaded.root;
        if (p.drop !== undefined) prune(root, p.drop);
        // With `on`, y is a nudge from the supporting box's top rather than an absolute height.
        const support = p.on !== undefined ? tops.get(p.on) : undefined;
        const floor = support !== undefined ? support + (p.y ?? 0) : (p.y ?? 0);

        // Uniform-fit art takes its yaw before measurement, as it always has. Exact-fit panels size in
        // source axes first and apply yaw inside fitToBox — otherwise a quarter-turn swaps their length
        // and thickness while scale.x/scale.z remain local. See fitToBox.
        let box: { width: number; depth: number; height: number };
        if (p.fit !== undefined) {
          box = fitToBox(root, p.fit.width, p.fit.height, p.x, floor, p.z, p.fit.depth, p.yaw);
        } else {
          if (p.yaw !== undefined) root.rotation.y = p.yaw;
          // After yaw, and both before the fit, which measures the box the two of them leave.
          if (p.pitch !== undefined) root.rotation.x = p.pitch;
          box = fitToHeight(root, p.height, p.x, floor, p.z);
        }
        tops.set(id, floor + box.height);
        root.name = id;
        // Before `albedo`, so a row may do both: the move puts the image in the slot a multiplier can
        // reach, and any multiple of the black base colour it replaces would have stayed black.
        if (p.lanternLit === true) lanternLight(root);
        if (p.albedo !== undefined) brighten(root, p.albedo);
        if (p.curve !== undefined) curveAlbedo(root, p.curve, p.seal === true, p.gain, p.lift);
        group.add(root);
        // After the add, so the UV reads world space rather than the fit's local space — the same
        // reason wallColliders is here and not above. Before the carve, so a doorway cut out of the
        // shell removes triangles that are already anchored rather than leaving a strip that is not.
        if (p.seal === true) dressShell(root, wallMap);
        // Before the slice, so a doorway cut into the model is a gap in its colliders for free.
        if (p.carve !== undefined) carveBoxes(root, p.carve);
        // After the add, so the slice reads world space rather than the fit's local space.
        if (p.walls !== undefined) wallColliders(root, floor, p.walls, aabbs);
        if (p.solids !== undefined) propColliders(root, p.solids, aabbs);

        if (p.collide === true) {
          // Slightly inset: a collider flush with the visible edge makes a player who brushes past
          // furniture feel like they caught on air.
          aabbs.push(aabbOf(p.x, floor, p.z, box.width / 2 - 0.04, box.depth / 2 - 0.04, floor + box.height));
        }
        // After the add and the fit, for the same reason as the two above: it reads matrixWorld. Over
        // the whole root, since a `leaf` row is all leaf — and held, not pushed into `aabbs`, because
        // this is a keep-out for the eye alone. See ModelPlacement.leaf.
        const keep = p.leaf !== undefined ? leafBoxes([root], p.leaf) : undefined;
        const entry: Placed = { root, centre: new Vector3(p.x, floor + box.height / 2, p.z) };
        if (keep !== undefined) entry.leafKeep = keep;
        if (p.shadow !== undefined) {
          const s = new Mesh(shadowGeo, shadowMat);
          s.name = `${id}:shadow`;
          // `floor` is the surface this model was seated on, whether that is a storey or the top of
          // whatever it stands `on` — so a plate on a side table gets its shadow on the table.
          s.position.set(p.x, floor + SHADOW_LIFT, p.z);
          // No yaw, deliberately. fitToHeight measures the box *after* p.yaw is on the root, so
          // box.width and box.depth are already the turned footprint's extents on world x and z;
          // turning the quad as well would rotate the same yaw twice.
          const k = p.shadow * SHADOW_SPREAD;
          s.scale.set(box.width * k, 1, box.depth * k);
          // Static: nothing moves it after this, so there is no reason for the traversal to rebuild
          // its matrix every frame. `visible` is not part of the matrix, so the cull below still works.
          s.matrixAutoUpdate = false;
          s.updateMatrix();
          group.add(s);
          entry.shadow = s;
        }
        if (p.minEyeY !== undefined) entry.minEyeY = p.minEyeY;
        if (p.maxEyeY !== undefined) entry.maxEyeY = p.maxEyeY;
        const clip = p.clip !== undefined ? clips[p.clip] : undefined;
        if (clip) entry.mixer = playClip(root, clip, p.speed ?? 1);
        placed.push(entry);
        onPlaced?.(id, root, clips);
      } catch (err) {
        onError(err, `model:${id}`);
      } finally {
        markStartupSettled(id);
      }
    }
  })();

  return {
    startupReady,
    allReady,
    /**
     * Link every shader and upload every texture once, before the player can move.
     *
     * The cull below is not free the first time it says yes: a model that has never been drawn owns
     * shaders that have not been linked and maps that have not been uploaded, and both bills come due
     * inside the single frame on which `visible` first goes true. Walking the cellar stair, that was two
     * stalls of about 4x the frame budget, at exactly the two places they were reported — stepping off
     * the landing at x -9.0, and two thirds of the way down at eye y -0.3, where `maxEyeY: -0.2` lets
     * the whole basement wing in at once (five rows, +49 draw calls, +12k triangles, one frame).
     *
     * Both halves are needed, and measuring them separately is the only reason that is known. Revealing
     * the set and calling compileAsync took the linked-program count from 21-at-spawn/24-after-the-stair
     * to 29 before the player moves — and **moved neither spike**. The cost was the maps: uploading all
     * 128 of them by hand dropped those same two samples from 4.1x and 4.2x the median frame to 1.7x and
     * 1.3x, which is into the noise of every other step on the stair. compileAsync links a program
     * without binding a map, and a render only binds what is inside the frustum it is given, so neither
     * one covers this on its own.
     *
     * Sliced with a frame between batches because the upload is ~2.6 s of serial work on a software
     * rasteriser: the title screen this hides behind is still animating, and a single blocking call
     * there would be a visible hang instead of an invisible one.
     *
     * `warming` switches `update` off for the duration — it is awaited across frames, and the loop would
     * otherwise put every root straight back to hidden between the reveal and the upload.
     */
    warm: async (renderer) => {
      warming = true;
      const was = placed.map((p) => p.root.visible);
      try {
        for (const p of placed) {
          p.root.visible = true;
          if (p.shadow !== undefined) p.shadow.visible = true;
        }
        await renderer.compileAsync(scene, eye);
        const maps = collectTextures(scene);
        for (let i = 0; i < maps.length; i++) {
          renderer.initTexture(maps[i] as Texture);
          if ((i + 1) % TEX_PER_SLICE === 0) {
            await new Promise<void>((r) => {
              requestAnimationFrame(() => r());
            });
          }
        }
        renderer.render(scene, eye);
      } finally {
        placed.forEach((p, i) => {
          p.root.visible = was[i] ?? false;
          if (p.shadow !== undefined) p.shadow.visible = was[i] ?? false;
        });
        warming = false;
      }
    },
    update: (dt) => {
      // Held off while warm() has the set revealed on purpose; see there.
      if (warming) return;
      for (const p of placed) {
        const near =
          p.centre.distanceToSquared(eye.position) < CULL_RADIUS_SQ &&
          (p.minEyeY === undefined || eye.position.y > p.minEyeY) &&
          (p.maxEyeY === undefined || eye.position.y < p.maxEyeY);
        // And not standing inside a door leaf: see ModelPlacement.leaf and LEAF_HIDE. The player walks
        // through these, so this fires for a step or two as they cross a doorway, and the leaf is the
        // whole of the view at that moment — which is the point. It is the only way the eye can be kept
        // out of a slab that has to stay walkable.
        const show = near && !(p.leafKeep !== undefined && insideAny(p.leafKeep, eye.position, LEAF_HIDE));
        p.root.visible = show;
        if (p.shadow !== undefined) p.shadow.visible = show;
        // A clip nobody can see is 100-odd channels of interpolation for nothing. It resumes where
        // it stopped, which for a looping idle nobody was watching is the same as having run.
        if (show) p.mixer?.update(dt);
      }
    },
    dispose: () => {
      for (const p of placed) p.mixer?.stopAllAction();
      placed.length = 0;
      // Ours, unlike the material and its map — those are FixtureMats' and are tracked there.
      shadowGeo.dispose();
      scene.remove(group);
      group.clear();
    },
  };
}
