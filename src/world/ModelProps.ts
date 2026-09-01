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

import { Box3, Group, Mesh, Vector3, type AnimationClip, type AnimationMixer, type Camera, type MeshBasicMaterial, type MeshLambertMaterial, type Object3D, type Scene } from 'three';
import { BASE_Y, HALF_T, WALL_H, expandRun, type Segment, type WallRun } from '@/world/HouseLayout';
import { GATE, HALL_WALLS, LIVING_DOOR, RITUAL_DOOR, ROOMS, UPPER, UPPER_DOOR, UPPER_INNER, UPPER_INNER_CUT, UP_Y } from '@/world/HouseRooms';
import type { AABB } from '@/player/FPController';
import { aabbOf } from '@/world/Fixtures';
import { fitToBox, fitToHeight, playClip, type ModelLoader } from '@/world/ModelLoader';
import { carveBoxes, type CarveBox } from '@/world/CarveBox';
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
  /** Stand on top of an earlier entry's box rather than on the floor. */
  on?: string;
  /** Block the player. Furniture yes; characters and small dressing no. */
  collide?: boolean;
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
 */
function wallPanels(
  prefix: string,
  run: WallRun,
  inwardX: number,
  inwardZ: number,
  yaw: number,
  floorY: number,
  ceilY: number,
  opts: { first?: boolean; collide?: boolean } = {},
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
function roomWallPanels(roomId: string, opts: { first?: boolean; collide?: boolean } = {}): ModelPlacement[] {
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
const LIVING_WALL_PANELS: ModelPlacement[] = roomWallPanels('living');
const BASEMENT_WALL_PANELS: ModelPlacement[] = roomWallPanels('basement');

/** Every faced run in the house, in one list, for the startup gate to filter. */
const WALL_PANELS: ModelPlacement[] = [
  ...HALL_WALL_PANELS,
  ...BEDROOM_WALL_PANELS,
  ...LIVING_WALL_PANELS,
  ...BASEMENT_WALL_PANELS,
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
  // dropped rather than set down, and clear of the runner (x -1 .. 1) and the coat pegs (x 4.8).
  { name: 'bottle.glb', height: 0.32, x: 3.2, z: -5.2, yaw: 0.7, shadow: 1 },

  // --- Hallway ---
  // The live cat, in the middle of the corridor where it cannot be missed on the way through.
  //
  // y 0.021 is the runner's top, not a nudge: the corridor's runner is a 20 mm box centred at 0.011
  // (see HouseProps.hallway), and a cat seated at y 0 stands 21 mm inside the cloth. It went unnoticed
  // for as long as nothing was drawn under the cat, and the shadow is what makes it matter — at y 0 the
  // quad lands at SHADOW_LIFT = 12 mm, which is beneath the runner and clipped away entirely. On the
  // cloth the shadow is 12 mm above it and the paws are on top of the thing they are standing on.
  //
  // 0.75 on the shadow: it is a figure, so its box is the pose's outline rather than what touches the
  // floor. It plays a clip, and the shadow does not — a cat shifting inside a still shadow is what an
  // animal on a floor looks like from two metres away, and the alternative is re-fitting a box per frame.
  { name: 'cat.glb', height: 0.6, x: 2.0, y: 0.021, z: 1.3, yaw: -1.9, clip: 0, speed: 0.8, shadow: 0.75 },
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
  { name: 'painting-sus.glb', height: 0.9, x: 6.4, y: 1.6, z: 0.12, yaw: -Math.PI / 2, lanternLit: true },
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

  // Noise prop two, standing on the corridor's north side 30 cm off the wall face, 3 m west of the
  // archway, so it is passed on every trip between the hall and the two rooms. beer_bottle is the one
  // upright file of the four: 0.269 : 1 : 0.269 with y longest, so 0.26 is its height and it is 7 cm
  // across.
  //
  // Off the runner (z 0.75 .. 1.85) rather than on it, because `y` here is absolute and the runner's
  // top is 2 cm above the floor: standing on it, the bottle would be 2 cm sunk into the cloth.
  //
  // And deliberately not at the corridor's west end, which is where it first went. There it measured
  // 0.98 m from CELLAR_DOOR's grab point, and inside TOUCH_RANGE the picker ignores facing entirely —
  // so a bottle there would have fought the one door in this corridor the puzzle chain needs.
  { name: 'bottle-beer.glb', height: 0.26, x: -3.0, z: 2.2, shadow: 1 },

  // --- Bedroom (window on the west wall at z = 6.0) ---
  // Its three runs, faced. See roomWallPanels for why these carry no collider, and BEDROOM_WALL_PANELS
  // for why this is the one room's worth that the startup gate waits for.
  ...BEDROOM_WALL_PANELS,
  // The one bed in this room, standing where HouseProps used to build a procedural one at (-6.2, 8.3).
  // It was against the west wall at x -8.26 because two beds a metre apart looked like a mistake rather
  // than a shared room; with the procedural one gone the compromise goes too, and the bed the player
  // wakes on is the one in the middle of the floor. Only x moves: z 9.0 is what the cat's placement, the
  // spawn mattress's z0/z1 and SPAWN.z are all tuned against, and the fitted footprint is 1.0 x 2.1 m, so
  // at x -6.2 it spans -6.7 .. -5.7 with 0.77 m between its east edge and the bedside table at -4.7 and
  // 5 cm between its head and the north wall's inner face at 10.1 — the same clearance it had.
  //
  // That 5 cm is now 5 cm to the plaster and -1 cm to the damaged-wall facing hung in front of it, whose
  // front is at 10.04. Left as it is: a centimetre of headboard inside the frontmost relief of a rough
  // scan is not visible, the facing carries no collider for it to fight, and buying the clearance back
  // would mean moving z, which SPAWN.z, the cat's row and HouseScene's spawn mattress are all measured
  // from. The closet 3 m east did get moved — see its row for why that one could not be waved off.
  //
  // Startup-visible: the player wakes on this mattress. HouseScene registers a low base collider plus a
  // walkable mattress once the measured box exists; a full `collide` box would trap a capsule whose feet
  // are already on top of it. `first` puts it immediately after the gate in load order.
  { name: 'bed.glb', height: 2.1, x: -6.2, z: 9.0, yaw: Math.PI / 2, first: true, shadow: 1 },
  // Curled on the mattress. `on` reads the bed's measured top, which is the headboard rail at 0.66,
  // so y drops to the bedding at 0.47; retuning the bed still carries the cat with it. x follows the bed
  // west-to-centre: this is the bed the cat was already on, so keeping the two together is what leaves the
  // room with one bed and the cat still on it.
  //
  // Its shadow lands on the bedding rather than on the floor, which is what `on` buys and is the whole
  // reason it is worth having here: a cat on a mattress with a shadow on the boards below would read as
  // hovering twice over. 0.8, and its 0.36 x 0.24 m quad stays well inside the 1 x 2.1 m bed.
  { name: 'cat-still.glb', height: 0.45, x: -6.2, y: -0.19, z: 8.9, on: 'bed.glb', shadow: 0.8 },
  // Three more sleepers for a room that reads as a place people were kept rather than a bedroom. Each one
  // arrives at metre scale already, so `height` is the file's own longest axis to four places and is a fit,
  // not a rescale: the closet is 1.317 x 2.118 x 0.692 with y longest, horror_bed 2.224 x 0.742 x 1.146
  // with x longest once its floor plane is gone, old_bed 0.786 x 0.682 x 1.756 with z longest.
  //
  // All three go along the north and east walls, in the two bands HouseProps leaves empty -- north-east
  // x -4.1 .. -1.2, z 8.0 .. 10.1 and south-east x -4.1 .. -1.2, z 2.7 .. 5.7. bed.glb and the cat hold the
  // middle of the floor, the dressing table and its code box the south-west corner, and the rug is floor.
  // The east wall's own band is wider than those numbers now — the procedural wardrobe that stood at
  // (-1.45, 6.6) is gone — but nothing here was moved into the space, because the closet is the wardrobe
  // in this room and putting a fourth sleeper against that wall is what the empty bands are avoiding.
  //
  // albedo on the two dark ones, none on the closet's near neighbours: their maps mean 106,88,69 and
  // 98,76,63, i.e. linear 0.105 and 0.081, against the 0.222 of the bed.glb standing beside them that
  // needs no lift at all. 1.6 and 1.8 put them just under it rather than level with the plaster.
  //
  // The closet stands at z 9.65, not the 9.75 it had against bare plaster. It is 0.692 deep, so it used
  // to reach z 10.096 against an inner face at 10.1 — 4 mm, which was the point. The damaged-wall facing
  // now hangs 6 cm in front of that face, ending at 10.04, and this is the one prop in the room where a
  // 5.6 cm interpenetration would actually be seen: it is a WARDROBE_NAMES hiding spot, so the camera
  // goes inside it and would have looked out through the back of the wall. 10 cm south restores the same
  // 4 cm of air, to the facing this time, and keeps it a third of a metre clear of horror_bed.
  { name: 'closet-old.glb', height: 2.1179, x: -2.0, z: 9.65, collide: true, albedo: 1.6, shadow: 1 },
  // `drop` takes the 4.44 x 4.44 m ground plane the file ships under the bed (Floor_Floor_0, 2 triangles).
  // It is the longest axis in the file, so left in it would set the scale for everything -- the bed would
  // come out half size -- and it would z-fight the bedroom floor across a fifth of the room.
  { name: 'bed-horror.glb', drop: ['Floor'], height: 2.224, x: -2.8, z: 8.4, collide: true, albedo: 1.8, shadow: 1 },
  { name: 'bed-old.glb', height: 1.7557, x: -1.6, z: 4.3, collide: true, albedo: 1.8, shadow: 1 },
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
  // free edge on (-5.22, 3.50), clear of the dressing table at x <= -6.64 and the rug at z >= 4.8. That
  // leaves 1.02 m of the 1.6 m opening to walk through. The leaf being narrower than the opening is
  // invisible on an ajar door, which is why BEDROOM_DOOR.half stays at 0.8 and the casing is untouched.
  { name: 'door-inner.glb', id: 'door-bedroom', clone: true, height: 2.15, x: -5.51, z: 3.05, yaw: -1.0, albedo: 2.0 },

  // The living-room leaf uses the same clean imported door as the bedroom. Both openings are 1.6 x
  // 2.1 m, so the bedroom's measured west-jamb placement carries across exactly: at 2.15 m tall the
  // leaf is 1.074 m wide, yaw -1.0 puts its hinge on x = 4.20 / z = 2.60, and leaves 1.02 m clear to
  // walk through. Its distinct id prevents the upper-flat interaction arm from treating it as that door.
  { name: 'door-inner.glb', id: 'door-living', clone: true, height: 2.15, x: LIVING_DOOR.x - 0.51, z: LIVING_DOOR.z + 0.45, yaw: -1.0, albedo: 2.0 },

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
  { name: 'door.glb', id: 'door-cellar', clone: true, drop: ['frame'], height: 2.15, x: -8.5751, z: 0.7729, yaw: Math.PI / 2 + 1.0, albedo: 2.0 },
  { name: 'door.glb', id: 'door-basement', clone: true, drop: ['frame'], height: 2.15, x: -14.0851, y: BASE_Y, z: 0.7168, yaw: Math.PI / 2 - 0.6, albedo: 2.0 },

  // Noise prop three, on the bare boards between the rug (x -6.2 .. -3.8) and the east wall — the one
  // clear stretch of this floor, since the beds, a closet, two tables and a chair have the rest of it.
  // 3.0 m from the door leaf above and 3.1 from the diary, so it competes with neither for the prompt.
  // A 24 cm dinner plate 3.2 cm tall (1 : 0.132 : 1, x longest).
  { name: 'plate.glb', height: 0.24, x: -3.2, z: 6.5, shadow: 1 },

  // --- Living room (window on the north wall at x = 4.0) ---
  // Its two runs, faced. The other two sides of this room are the hallway's north wall and the shared
  // wall with the bedroom, both of which belong to their own room's list.
  ...LIVING_WALL_PANELS,
  // A side table between the armchair (6.7, 4.7) and the fire, rather than standing alone in the
  // middle of the floor where it both blocked the walk through and duplicated the dining table.
  //
  // No `shadow`, and the rug is why. The living room's rug spans x 4.8 .. 7.6 and this table's centre
  // is x 7.6 exactly, so it straddles the rug's east edge: half of any quad here would be under 21 mm
  // of cloth and clipped away, leaving a shadow that stops dead on a straight line. The rug is doing
  // that half of the grounding anyway. Its plate, standing on the top, gets one — see the row below.
  { name: 'table.glb', height: 0.75, x: 7.6, z: 5.4, collide: true },
  // knife.glb is not here: the daayan holds it. See DaayanKnife, and note that a row here would
  // fight the hand attachment for the cached Group exactly as a lantern row would fight HeldLantern.
  // North wall, east of the window. Turned for the same reason as the other painting; this one is
  // double-sided, so hung unturned it showed the wood backing of the canvas.
  //
  // z 9.97 rather than the 10.03 it hung at, for the same reason the closet moved: the facing's front is
  // at 10.04, and a canvas hung at 10.03 would have been a painting inside a wall.
  { name: 'painting-sun.glb', height: 0.8, x: 7.0, y: 1.5, z: 9.97, yaw: Math.PI },
  // Noise prop four, and the only one of them off the floor. `on` reads the side table's measured top
  // rather than restating it — 0.689, its 0.588 x 0.540 x 0.509 fitted to 0.75 on x — so retuning the
  // table carries the plate up with it. Set 12 cm west and 10 cm south of the table's centre, which
  // keeps its 25.6 x 26 cm footprint (0.983 : 0.244 : 1, z longest) inside the 75 x 65 cm top and puts
  // 1.27 m between it and the mantel's four photographs. This row must stay after table.glb's.
  { name: 'plate-ceramic.glb', height: 0.26, x: 7.48, z: 5.3, on: 'table.glb', shadow: 1 },

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
  // Far corner, turned toward the altar rather than toward the door: the player should find her
  // already occupied, not waiting for them. 1.85 rather than a human 1.7 so she reads as taller than
  // the player the moment she is seen; the ritual room's ceiling is 2.8 above BASE_Y, and her
  // footprint at this height stays clear of the west wall at x = -30. The knife in her hand is
  // measured in her own bone units, so it grows with her — see DaayanKnife.
  //
  // 0.45 on the shadow, the smallest fraction in the file, because her box is the widest overstatement
  // of a contact area here: it is her silhouette with both arms out and a knife held away from her body,
  // and at 1 that is a 1.2 m puddle around a figure standing on two feet. At 0.45 it is a patch a little
  // wider than her stance, which is what a lantern two metres away actually casts.
  { name: 'daayan.glb', height: 1.85, x: -28.4, y: BASE_Y, z: 4.3, yaw: 2.41, clip: 0, speed: 0.6, shadow: 0.45 },
  // arms.glb is not here either — it is the player's own arm now, on the camera. See HeldLantern.

  // --- Upper storey (see UP_SHAFT and UPPER in HouseRooms) ---
  // Neither of these rows is a free choice. fitToHeight normalises the longest axis and centres the
  // bbox on x/z, so every number here is back-figured from the file's own bounding box.
  //
  // The stair: 3.936 is its longest axis (9.4849) x 0.41497, the one scale at which its 0.7229 m
  // tread rise becomes 0.300 — inside the controller's 0.35 m step-up — and its eighth tread lands
  // exactly on UP_Y. y drops it 0.058 so its own bottom step meets the shaft floor at 0 rather than
  // floating above it, the bbox bottom being that much lower than the step. Turned to climb east,
  // on the stairwell's centre line; x puts the top tread's edge on the upper room's floor edge.
  // upStairFloors() is what the player actually walks on.
  //
  // albedo, not curve: the treads are one warm wood material seen from half a metre with the lantern
  // in hand, so there is no tonal range for a clamped multiply to flatten, and the shaft is below eye
  // 1.9 where HouseScene's `up` fill never fires. Checked at the stair foot — warm, not clipped.
  { name: 'stair-wood.glb', height: 3.936, x: 12.43, y: -0.058, z: 1.3, yaw: Math.PI, albedo: 2.2 },
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
  { name: 'room-upper.glb', height: 11.2077, x: 19.41, y: UP_Y - 0.0592, z: 3.676, minEyeY: 1.9, curve: 0.28, gain: 3.0, lift: 6, seal: true, carve: [UPPER_INNER_CUT], walls: { y0: 0.2, y1: 1.7, top: 2.6 } },
  // The flat's own front door, filling that opening. Measured from the file: its axes are
  // 0.5715 : 1 : 0.1353, so height 2.56 makes it 1.463 wide x 0.346 thick and the frame's head lands
  // 6 cm above the opening's 4.9 header — the overlap is the point, at 2.5 the two would have met on a
  // line and shown a hairline of the void. Turned a quarter turn because the door's width runs along
  // its own x and this doorway's runs along world z. albedo, like the stair below it: the base map
  // means 57,57,47, which is the same mid-dark Lambert takes to nothing at lantern range.
  //
  // It only hangs here; the swing is armUpperDoor()'s, from the placement hook.
  { name: 'door.glb', height: 2.56, x: UPPER.x0, y: UP_Y, z: UPPER_DOOR.z, yaw: Math.PI / 2, minEyeY: 1.9, albedo: 2.0 },
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
  { name: 'door-inner.glb', height: 2.15, x: UPPER_INNER.x, y: UPPER_INNER.bottom, z: UPPER_INNER.z, yaw: Math.PI / 2, minEyeY: 1.9, albedo: 2.0 },
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
const CULL_RADIUS_SQ = 20 * 20;

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
 * See ModelPlacement.seal. Slate rather than black, so the sealed wall reads as a wall.
 *
 * Measured rather than picked. This material is 16.7k triangles with no map, and the flat's shell is
 * authored inward-facing, so it is not scenery seen from outside — it is the wall the player is looking
 * at: 37% of the frame at the flat's threshold and 57% two metres in, and nothing at all once past the
 * partition. At the 0x26262c it used to be, that is a third of the first two frames of the flat under
 * 8/255, which is the black the player reported, and no amount of albedo gain on the other twenty
 * materials touches it. At 0x4a4a52 the same frames read 31 and 35 mean with 1 to 2% black, in line
 * with the 30 to 57 the mapped materials come back at, and still well under the hall's 89.
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
 */
export function installModels(
  loader: ModelLoader,
  scene: Scene,
  eye: Camera,
  aabbs: AABB[],
  shadowMat: MeshBasicMaterial,
  onError: (err: unknown, where: string) => void,
  onPlaced?: (name: string, root: Object3D, clips: AnimationClip[]) => void,
): ModelPropsHandles {
  const group = new Group();
  group.name = 'models';
  scene.add(group);
  const placed: Placed[] = [];
  /** Measured top of each placed model, for entries that stand on one. */
  const tops = new Map<string, number>();
  // Every panel the gate waits for, taken from the one flag that decides it rather than from a second
  // list that could disagree with the first. The hall's four sides and the bedroom's three runs are
  // `first`; the living room's and the basement's are not, and adding a room to the gate later means
  // marking it `first` in one place.
  const startupPending = new Set([
    'gate-main.glb',
    'bed.glb',
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
        const entry: Placed = { root, centre: new Vector3(p.x, floor + box.height / 2, p.z) };
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
    update: (dt) => {
      for (const p of placed) {
        const near =
          p.centre.distanceToSquared(eye.position) < CULL_RADIUS_SQ &&
          (p.minEyeY === undefined || eye.position.y > p.minEyeY) &&
          (p.maxEyeY === undefined || eye.position.y < p.maxEyeY);
        p.root.visible = near;
        if (p.shadow !== undefined) p.shadow.visible = near;
        // A clip nobody can see is 100-odd channels of interpolation for nothing. It resumes where
        // it stopped, which for a looping idle nobody was watching is the same as having run.
        if (near) p.mixer?.update(dt);
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
