/**
 * HouseProps — the furniture and dressing, and the surfaces the clues lie on.
 *
 * Two jobs, and they are the same job. The brief (§8) forbids glowing puzzle objects and quest
 * markers, which means a readable note has to be findable *because of where it is* — left open on
 * the one table in the room, pinned beside the gate, nailed up next to the panel it
 * describes. So the furniture is not decoration that happens to be near the clues; the furniture
 * is what makes the clues discoverable at all, and the two get built together here.
 *
 * That cuts both ways, and the living room is where it showed first. Several rounds of "remove this" have
 * taken the fireplace, the ledger table, the dining table, the chair and the rugs out of this file, and
 * each removal was also the removal of a clue's reason for being where it was. None of the three living
 * room clues was dropped with its furniture: they were re-homed onto what is left — the east wall, the
 * imported side table, the north wall beside the window — and the arithmetic for each new spot is in the
 * comments at the site, because a note pinned 1 cm inside a wall facing is a note nobody can read.
 *
 * The last round took the rest of the hand-built furniture: every table, both chairs, the workbench and
 * its jars, the crates and the barrel, the coat rail and its coat, the stick stand and the standing lamp.
 * The same rule held. The diary page moved onto bed.glb's own side table, the draught note was pinned to
 * the wall the workbench stood against, and the strongbox — a puzzle, not furniture — came down onto the
 * floor under its clock. What this file builds now is wall dressing, marks, papers and candles, and the
 * two fixed pieces (the stair rail and the cellar post) that read as the house rather than things in it.
 *
 * Everything in this file is static and merged by material. Anything that moves is built by
 * Fixtures instead. Positions that both this file and the scene need — the strongbox and the clock
 * over it, the breaker panel and the diagram beside it — live in PLACE so they cannot drift apart.
 */

import { BoxGeometry, CylinderGeometry, Group, Mesh, Vector3, type BufferGeometry } from 'three';
import { Batch } from './Batch';
import { SHADOW_LIFT, shadowQuad } from './ContactShadow';
import { aabbOf, type FixtureMats } from './Fixtures';
import { BASE_Y } from './HouseLayout';
import type { AABB } from '@/player/FPController';

/** Shared placements. The scene puts fixtures here; this file builds what they stand on. */
export const PLACE = {
  /**
   * Bedroom strongbox — on the floor against the south wall, directly under the clock, front face toward +z.
   *
   * y 0, not the 0.76 it stood at. That was the top of a procedural dressing table, and the table has been
   * removed with the rest of the hand-built furniture. The box is Puzzle 2 and could not go with it, so it
   * came straight down onto the boards at the same x and z: still under the clock, and every anchor
   * makeCodeBox derives from this point moves with it. HouseScene's 'box.dial' reach was raised to cover the
   * extra drop from eye to dial — see the note there.
   */
  codeBox: { x: -7.4, y: 0, z: 3.0 },
  /**
   * Stopped clock, on the wall directly above the box.
   *
   * z 2.78, not the 2.72 it was hung at, and for the same reason `breaker` below sits 6 cm off its
   * wall: that south wall now wears a damaged-wall facing whose front is 6 cm proud of the plaster,
   * at z 2.76. `makeClock` builds a 0.06-deep case centred on this z, so at 2.72 the case spanned
   * 2.69..2.75 — entirely inside the facing — and the only parts of the clock left visible were the
   * hands at 2.766 and the hub, four thin bars and a brass dot floating on broken masonry with no
   * dial behind them. Moving it forward by exactly the facing's protrusion puts the case front at
   * 2.81 and restores the 5 cm of relief it was authored with. The clue anchor below is derived from
   * this z, so it follows.
   */
  clock: { x: -7.4, y: 1.92, z: 2.78 },
  /**
   * Basement breaker panel on the south wall; its hatch sits 0.95 m to the +x side.
   *
   * z -1.80, not the -1.86 it was built at. That wall now wears a damaged-wall facing whose front is
   * 6 cm proud of the plaster, at z -1.84, and the panel's own body is a 0.13 m box hung *behind* this
   * z: at -1.86 the whole body and the hatch's backplate sat inside the facing, leaving a face plate
   * flush with broken masonry and four rockers poking 1.5 cm out of it. Everything here is measured
   * from this one point, so moving it 6 cm — exactly the facing's protrusion — restores every
   * relationship the panel was authored with, including Fixtures' insistence that the hatch be mounted
   * *on* the wall rather than recessed into it, which is the only reason its key is findable.
   */
  breaker: { x: -19.5, y: -1.55, z: -1.8 },
  /** Sliding screen against the basement's west wall, standing over the ritual doorway. */
  doors: { x: -21.77, z: 2.3 },
  /** Altar, broadside to the door so all four symbols are visible on entering. */
  altar: { x: -26.8, z: 2.3 },
} as const;

export interface HouseProps {
  group: Group;
  aabbs: AABB[];
  /** Where each readable thing is, keyed by its id in CLUES. */
  anchors: Record<string, Vector3>;
  /**
   * The hidden room's gate key, as its own group so the pick-up can hide it.
   *
   * Not batched with the rest of the dressing, and that is the whole reason it is returned
   * separately: `Batch` merges every prop sharing a material into one mesh and says so in its own
   * header — "a batched prop cannot move". A key taken out of a wardrobe has to disappear, so it
   * is built from its own meshes parented to this group and nothing else.
   */
  hiddenKey: Group;
  /** Merged buffers, for the scene's dispose path. */
  geos: BufferGeometry[];
}

/** A sheet of paper lying flat, or pinned flat to a wall. */
function sheet(b: Batch, m: FixtureMats, x: number, y: number, z: number, w: number, h: number, wall: 'x' | 'z' | 'flat', ry = 0): void {
  if (wall === 'flat') b.box(m.paper, w, 0.008, h, x, y, z, ry);
  else if (wall === 'z') b.box(m.paper, w, h, 0.008, x, y, z);
  else b.box(m.paper, 0.008, h, w, x, y, z);
}

/** A framed picture on a wall. `nx` is which way it faces along the wall's normal axis. */
function frame(b: Batch, m: FixtureMats, x: number, y: number, z: number, w: number, h: number, axis: 'x' | 'z', nx: -1 | 1): void {
  if (axis === 'x') {
    b.box(m.wood, 0.03, h, w, x, y, z);
    b.box(m.paper, 0.012, h - 0.06, w - 0.06, x + nx * 0.02, y, z);
  } else {
    b.box(m.wood, w, h, 0.03, x, y, z);
    b.box(m.paper, w - 0.06, h - 0.06, 0.012, x, y, z + nx * 0.02);
  }
}

/** An unlit candle stub. There are a lot of these; none of them is ever a light source. */
function candle(b: Batch, m: FixtureMats, x: number, y: number, z: number, h = 0.14): void {
  b.cyl(m.paper, 0.022, 0.026, h, 6, x, y + h / 2, z);
  b.cyl(m.dark, 0.004, 0.004, 0.03, 4, x, y + h + 0.014, z);
}

type Ctx = {
  b: Batch;
  m: FixtureMats;
  aabbs: AABB[];
  at: Record<string, Vector3>;
  /** Group for props that must stay individually hideable — see `HouseProps.hiddenKey`. */
  key: Group;
};

// --- Hall ------------------------------------------------------------------------------------

/**
 * The hall. The gate is here, so this room's job is to be the place the player keeps coming back
 * to — which means it must stay legible in the dark and must not hide anything. Two clues, both
 * at eye height on the way in.
 */
function hall({ b, m, at }: Ctx): void {
  // The runner that lay here is gone with the other two — see living() for the one note covering all
  // three. What stays is the boot scuffs worn into the boards in front of the gate: not cloth, and the
  // only thing in this room that says eleven people walked in.
  b.ring(m.dark, 0.9, 1.35, 14, 0, 0.013, -6.0, Math.PI * 0.15, Math.PI * 0.7);

  /*
   * The pinned notice, beside the gate at the height of a face — and 4 cm further into the room than it
   * was hung, because it was inside the wall.
   *
   * Every wall in this room wears a damaged-wall facing (HALL_WALL_PANELS, all four runs), and a facing's
   * front stands 6 cm proud of the plaster it hides: the south wall is at z -7, so the panel is centred at
   * -6.89 and its front face is at -6.84. `sheet` builds 8 mm of paper, so the old z of -6.86 spanned
   * -6.864..-6.856 — the whole sheet behind the masonry, with only the pin's 2 cm cube at -6.83 poking out.
   * A prompt that says there is a note here, an iron stud on bare stone, and no note. -6.82 spans
   * -6.824..-6.816 and clears the facing by 1.6 cm; the pin follows to -6.80, keeping the same 6 mm
   * standoff from the paper's face it always had. Both numbers mirror living.list against its own facing.
   *
   * The anchor does not move with them. It stands 0.26 m into the room at -6.6, and the south wall's
   * standable band starts at -6.58, so the closest the player can stand is already effectively on it —
   * shifting it 4 cm would change nothing a player can feel.
   */
  sheet(b, m, 1.9, 1.45, -6.82, 0.3, 0.4, 'z');
  b.box(m.iron, 0.02, 0.02, 0.02, 1.9, 1.62, -6.8);
  at['hall.notice'] = new Vector3(1.9, 1.45, -6.6);

  /*
   * No coat rail, no coat, no side table and no stick stand. The rail with its four brass pegs and the one
   * good coat on them stood on the east wall at x 4.81; the side table with its dead oil lamp at (-4.6, -3.0)
   * and the stand of walking sticks at (-4.5, -1.3) were the west side's. All four were hand-built boxes and
   * cylinders and went with the rest of the procedural furniture. None of them published an anchor. The
   * table's collider went with it, and shadows() drops its contact quad without being told.
   *
   * The coat is still in the story — both photographs describe it — so the only text that had to change was
   * hall.photo's `sub` in Clues.ts, which used the pegs as its landmark.
   */

  // The photograph, moved off the plaster and onto the facing for the third time on this wall: 4.825 puts
  // the 3 cm frame box's back exactly on the panel front at 4.84 and its print 4.1 cm proud of the stone,
  // which is the construction living()'s four frames use against their own east facing at 8.825. At 4.87
  // the wood spanned 4.855..4.885 and the print 4.844..4.856, both of them behind it. The anchor stays at
  // 4.58, which is the innermost x the player can stand at anyway.
  frame(b, m, 4.825, 1.68, -3.6, 0.5, 0.62, 'x', -1);
  at['hall.photo'] = new Vector3(4.58, 1.68, -3.6);
}

// --- Hallway ---------------------------------------------------------------------------------

/** The corridor. Deliberately bare: it is a junction, and a junction with clues in it is a maze. */
function hallway({ b, m }: Ctx): void {
  /*
   * Barer than it was built, on request. Three things left this room: the runner down its length, the
   * bench under the north wall at (0, 2.28), and the two crates stacked at the east end at (7.9, 2.15).
   *
   * All three were safe to take out, and it is worth writing down why, because it is not true of every
   * room in this file. None of them published an anchor — hallway() is the one room function that never
   * touched `at`, which is the "junction with clues in it is a maze" rule above, held to. None of them
   * held a way shut: the crates were moved against the north wall precisely so they would stop being a
   * thing the player had to squeeze past. And their two aabbs went out with their boxes, so shadows()
   * drops the contact quads that were under them without being told — it reads that same list.
   *
   * What is left is the pair of cold sconces, which are the one piece of dressing here doing a job.
   *
   * z 2.40 and 2.36, not 2.46 and 2.42. This corridor's north wall is faced by three hand-written rows in
   * ModelProps (hallway-wall-north-*) centred at z 2.49, so the visible surface is at 2.44 and the corridor
   * is the side with smaller z. An 8 cm bracket at 2.46 spanned 2.42..2.50: 6 of its 8 cm inside the wall,
   * showing a 2 cm iron nub with a candle cup apparently growing out of the masonry above it. 2.40 puts the
   * bracket's back exactly on 2.44 and the cup keeps the 4 cm standoff it was drawn with.
   */
  for (const sx of [-2.8, 2.8]) {
    b.box(m.iron, 0.1, 0.16, 0.08, sx, 2.0, 2.4);
    b.cyl(m.dark, 0.05, 0.03, 0.12, 6, sx, 2.14, 2.36);
  }
}

// --- Bedroom ---------------------------------------------------------------------------------

/**
 * The bedroom, and Puzzle 2's clue chain.
 *
 * The strongbox stands on the floor against the south wall with the stopped clock hung on the wall
 * directly above it, so the puzzle and the number it wants are in one glance — that is §9's "minimal
 * backtracking" taken literally. The diary that explains the connection is deliberately *not* beside
 * them: it is across the room on the bed's own side table, where somebody would actually have written
 * it. The player has to walk the room once. That is exploration; making them walk to another floor for
 * it would be backtracking.
 *
 * Nothing is spread further than one room, and nothing readable is put next to the box: two things that
 * close would fight each other for the interaction pick, and the box must always win at the box.
 */
function bedroom({ b, m, at }: Ctx): void {
  // The clock's anchor. The clock itself is a Fixture, because it has hands, and so is the strongbox under
  // it — on the floor at PLACE.codeBox now that the dressing table it stood on is gone. That table took a
  // collider and a candle with it, and nothing else.
  at['bedroom.clock'] = new Vector3(PLACE.clock.x, PLACE.clock.y, PLACE.clock.z + 0.1);

  /*
   * The made bed and the wardrobe that stood here are both gone, and neither left a gap in the room.
   *
   * The bed was six boxes at (-6.2, 8.3) and bed.glb now stands in its place — see ModelProps, whose row
   * has since turned it length-along-x against the west wall. Two beds a metre apart was the reason this
   * one was procedural and that one was against the wall; with one bed the procedural one is gone, and
   * the spawn mattress the player wakes on is the imported bed's.
   *
   * The wardrobe was a 0.62 x 2.05 x 1.5 box with two doors at (-1.45, 6.6), against the east wall.
   * closet-old.glb replaced it and has since left the room altogether, for the store room at (4.4, 16.65)
   * — the hiding pocket the box was registered for in HouseScene survives as that model's, which Hiding
   * picks up through WARDROBE_NAMES wherever it stands. What this room keeps is bed.glb, itself an
   * under-bed spot; it is no longer the house's whole supply of them.
   */

  /*
   * The diary page, on bed.glb's own side table — the one on the room side of the bed.
   *
   * It lay on a hand-built bedside table at (-4.7, 9.3), 0.56 high with a candle burned down beside it,
   * and that table and candle went with the rest of the procedural furniture. bed.glb ships a side table
   * either side of its headboard, so the page did not have to go far or change its story: Clues.ts still
   * says "folded on the table beside the bed", and now it is.
   *
   * Measured off the placed model rather than guessed: BedSideTable_SideTableMat_0 is both tables in one
   * mesh, and split at x -7.8 the east one spans x -7.286 .. -6.866 by z 9.279 .. 9.579 with its top at
   * y 0.378. The mattress's own box reaches x -7.235, so the top that is clear to lie on is x -7.235 ..
   * -6.866. A 0.26 x 0.20 sheet skewed -0.12 rad covers 0.282 x 0.230 m, which centred at (-7.05, 9.43)
   * is x -7.191 .. -6.909 by z 9.315 .. 9.545: inside on both axes, 3 cm or more clear of every edge.
   * y 0.383 lays its 8 mm on the top with the 1 mm of lift the sill photograph below uses.
   *
   * This is the second sheet in this file standing on imported geometry — living.ledger on table.glb is
   * the first — and it has the same weakness: retuning bed.glb's row (its height, x or z) moves this table
   * and strands the page. The row carries a note saying so.
   *
   * The anchor is 8 cm above the page, as it was on the old table. The bed's base collider (HouseScene) is
   * inset by the capsule radius, so a player can walk right up to the bed's east edge at x -6.75: the eye
   * is then about 1.3 m from the anchor against a reach of 2.0, and still only 1.6 m from the foot of the bed.
   */
  // REMOVED at the user's request, along with bed.glb: the diary page is no longer placed. With no anchor
  // published, HouseScene skips the 'bedroom.diary' clue entirely (it registers only anchored clues).
  // sheet(b, m, -7.05, 0.005, 9.43, 0.26, 0.2, 'flat', -0.12);
  // at['bedroom.diary'] = new Vector3(-7.05, 0.085, 9.43);

  /*
   * The window seat. A photograph left face down on the sill, which is a thing people do — and it is now
   * actually on the sill rather than inside it.
   *
   * y 1.105, not 1.035. makeCasing draws a sill for any opening whose y0 is off the floor, and for this
   * window (HouseScene's casings: x -9, half 0.8, y0 1.0, thickness WALL_T) that sill is a board spanning
   * y 1.00..1.10 and x -9.21..-8.79. `sheet` builds 8 mm of paper, so 1.035 put the photograph at
   * 1.031..1.039 — 6 cm *below* the sill's top face, inside the wood, with only the 3 cm that overhung the
   * board's inner edge at -8.79 left showing as a floating paper lip. 1.105 lays it on the board with 1 mm
   * of lift, which is enough to win the depth test without being visible at a grazing angle.
   *
   * x -8.95 rather than -8.82 for the same reason: at -8.82 a 0.2 m sheet skewed 0.1 rad reaches -8.7075,
   * so a fifth of it hung off the sill into the room. -8.95 spans -9.0625..-8.8375 and sits wholly on the
   * board. Nothing here meets a wall facing — the run at x -9 is faced, front at -8.84, but wallPanels
   * omits the panel across an opening's width and this is inside the window's, so the sill and everything
   * on it stand in a gap in the facing. The anchor stays at -8.72: it is 0.23 m in from the new centre and
   * the player reads the photograph from the room side either way.
   */
  sheet(b, m, -8.95, 1.105, 6.0, 0.2, 0.26, 'flat', 0.1);
  at['bedroom.photo'] = new Vector3(-8.72, 1.1, 6.0);

  // The chair that stood pulled out at an angle under this window, at (-8.1, 5.4), was hand-built and went
  // with the rest of the procedural furniture. The photograph on the sill never depended on it.
}

// --- Living room -----------------------------------------------------------------------------

/**
 * The living room. The brief asks this one to "primarily build curiosity", so nothing here is a
 * puzzle and nothing here is a key — it is three documents that each say something is wrong with
 * the arithmetic of this house.
 *
 * Every piece of furniture those three documents used to lie on has now been taken out at the player's
 * request: the fireplace and its mantelpiece, the little table the ledger was open on, the dining table
 * with its one chair, and the rug. The documents are the room, so they did not go with it — each one
 * moved to the nearest surface that survived, and the three moves are the substance of this function:
 *
 * - the four photographs come off the mantel shelf and hang on the east wall, which is what a house
 *   does with photographs when there is no shelf;
 * - the ledger moves onto table.glb, the imported side table in ModelProps that is now the only
 *   horizontal surface left in the room;
 * - the shopping list is pinned to the north wall beside the window instead of being weighted down with
 *   a cup on a table that no longer exists.
 *
 * Clues.ts's `sub` lines for all three were reworded to match, because those strings are read to the
 * player as where the thing was found and a stale one is a lie about the room they are standing in.
 */
function living({ b, m, at }: Ctx): void {
  /*
   * The four photographs, off the shelf and onto the east wall.
   *
   * x 8.825 is a facing measurement, not a wall measurement. LIVING.x1 is 9 and the plaster's inner face
   * is 8.9, but this wall wears a damaged-wall panel hung 6 cm proud of that — front at 8.84, see
   * ModelProps' PANEL_* constants — so a frame hung on the plaster would be buried in masonry. 8.825
   * puts the 3 cm frame box's back exactly on 8.84 and its photograph 1.1 cm proud of the wood, which is
   * the same relief the mantel versions had.
   *
   * Same four z positions and the same four sizes as on the shelf, so the clue text still reads left to
   * right in the order it describes, and all four centred on one line at 1.5 — picture height, matching
   * painting-sun.glb on the north wall — which leaves their tops uneven because the frames are four
   * different heights. That is what four things hung by hand over forty years looks like.
   */
  const frames: Array<[number, number, number]> = [[5.12, 0.24, 0.3], [5.68, 0.22, 0.27], [6.32, 0.26, 0.32], [6.88, 0.2, 0.25]];
  for (const [fz, fw, fh] of frames) frame(b, m, 8.825, 1.5, fz, fw, fh, 'x', -1);
  at['living.mantel'] = new Vector3(8.55, 1.5, 6.0);

  /*
   * The ledger, now open on table.glb rather than on a table of its own.
   *
   * Those numbers are read off that row and its neighbour rather than guessed at, because this is the
   * one place in this file that stands something on a piece of imported geometry: table.glb is fitted to
   * height 0.75 at (7.6, 5.4), which measures out as a 0.75 x 0.65 m top at y 0.689, and plate-ceramic
   * already occupies x 7.352 .. 7.608 / z 5.17 .. 5.43 of it. At (7.79, 5.56) with a 10-degree skew the
   * board's rotated footprint is x 7.618 .. 7.962 / z 5.415 .. 5.705 — inside the top on both axes, and
   * 1 cm clear of the plate in x. Retuning that row's `height` moves the top and would strand this; the
   * comment on the row says as much for the plate, and it now holds for two things.
   */
  b.box(m.door, 0.32, 0.045, 0.26, 7.79, 0.7115, 5.56, 0.1);
  sheet(b, m, 7.79, 0.738, 5.56, 0.3, 0.24, 'flat', 0.1);
  at['living.ledger'] = new Vector3(7.79, 0.8, 5.56);

  /*
   * The shopping list, pinned to the north wall instead of weighted down with a cup, at the same eye
   * height as the hall notice and pinned the same way. z 10.02 for the same reason the frames are at
   * 8.825: the facing on this wall fronts at 10.04, and `sheet` builds 8 mm of paper, so a sheet centred
   * here spans 10.016..10.024 and clears the facing by 1.6 cm. The pin's 2 cm cube at 10.0 then stands
   * clear of the paper's own front face as well, which is what makes it read as pinning it rather than as
   * a stud in the wall beside it.
   *
   * x 2.0 is where the dining table's copy of it was, and it is 0.9 m west of the window's west jamb at
   * 2.9 — so it is still the west end of the room, and it is beside the window, which is where a list of
   * things to buy actually gets pinned. The anchor stands 0.26 m into the room, the offset hall.notice
   * uses, and the north wall's standable band reaches z 9.78, so the player can put their face on it.
   */
  sheet(b, m, 2.0, 1.45, 10.02, 0.26, 0.32, 'z');
  b.box(m.iron, 0.02, 0.02, 0.02, 2.0, 1.62, 10.0);
  at['living.list'] = new Vector3(2.0, 1.45, 9.76);

  /*
   * No rug. It went with the hall's and the hallway's runners, all three on the same request, and it is
   * the one of the three that took a note with it: the comment on table.glb's row explains that the row
   * carries no `shadow` *because* this rug ran under half of it and would have clipped the quad along a
   * straight line. With the cloth gone that reason is gone, so the row has been given `shadow: 1`.
   *
   * Nothing here published cloth into an aabb, so the rugs cost no collider and no contact quad on the
   * way out. Nor did the standing lamp that stood in the north-east corner at (8.2, 8.8), an iron pole
   * under a cloth shade, which went with the last of the procedural furniture. `m.cloth` survives both on
   * the ritual room's rag and hangings, and Batch only emits a mesh for a material that still has geometry,
   * so the last user of a material leaving would cost nothing either — m.brass is that case now.
   */
}

// --- Stair shaft -----------------------------------------------------------------------------

/** The stair down. A handrail, because a 3 m drop with no rail reads as a hole, not a stair. */
function shaft({ b, m }: Ctx): void {
  // 5 m of rail is the house's longest bare edge; Batch.add merges as-is, so the triangle bound has
  // to be applied here — the same SLAB_SEG reason as everywhere else, sqrt(2) for the quad diagonal.
  const rail = new BoxGeometry(5.0, 0.05, 0.05, 8, 1, 1);
  rail.rotateZ(0.6435);
  rail.translate(-11.7, -0.65, 2.34);
  b.add(m.wood, rail);
  for (const [px, py] of [[-9.85, 0.42], [-11.75, -0.66], [-13.55, -1.74]] as Array<[number, number]>) {
    b.box(m.wood, 0.06, 0.9, 0.06, px, py, 2.34);
  }
  // Bulb on a flex, dead. It is the circuit the diagram calls STAIR LAMP.
  b.cyl(m.dark, 0.004, 0.004, 0.6, 4, -11.4, 1.9, 1.3);
  b.cyl(m.paper, 0.045, 0.035, 0.09, 6, -11.4, 1.56, 1.3);
}

// --- Basement --------------------------------------------------------------------------------

/**
 * The basement. Puzzle 3's panel and diagram are on the south wall, together, because §9 wants
 * interpretation rather than trial-and-error and that only works if the damaged sheet is in the
 * player's eye line while they are looking at the rockers.
 *
 * The screen against the west wall is the other thing this room does, and the only help it gets is
 * geometry and a mark on the floor.
 */
function basement({ b, m, aabbs, at }: Ctx): void {
  const P = PLACE.breaker;

  // The diagram, nailed to the wall an arm's length from the panel. Its z moves with the panel's, and
  // for the same reason: the facing's front is at -1.84, and a 8 mm sheet at -1.88 was a sheet of paper
  // inside a wall. -1.82 hangs it 2 cm in front of the masonry, as it always was.
  sheet(b, m, -20.62, P.y - 0.05, -1.82, 0.44, 0.54, 'z');
  for (const dx of [-0.18, 0.18]) b.box(m.iron, 0.018, 0.018, 0.018, -20.62 + dx, P.y + 0.19, -1.79);
  at['basement.diagram'] = new Vector3(-20.62, P.y - 0.05, -1.6);

  /*
   * The note about the draught, pinned to the wall the workbench stood against.
   *
   * It lay on that bench weighted under a jar, and the bench, its six jars and its tool were hand-built
   * and have gone with the rest of the procedural furniture. Pinned rather than dropped on the boards,
   * because a note on the floor of an unlit cellar is a note nobody finds; and pinned the way hall.notice
   * and living.list are, with the diagram's own facing arithmetic: the facing fronts at -1.84, so 8 mm of
   * paper at -1.82 clears it by 1.6 cm and the pin's 2 cm cube at -1.80 stands proud of the paper's face.
   *
   * x -16.4 is the bench's old centre, which leaves 1.8 m of bare wall between the note and the hatch at
   * -18.55, and y is the panel's own height, so the four things on this wall — diagram, panel, hatch and
   * note — read along one line from the doorway. Its anchor stands 0.22 m into the room, as the diagram's
   * does. Clues.ts's title and `sub` for it were reworded to match: there is no jar and no bench.
   */
  sheet(b, m, -16.4, P.y, -1.82, 0.26, 0.3, 'z');
  b.box(m.iron, 0.02, 0.02, 0.02, -16.4, P.y + 0.115, -1.8);
  at['basement.draught'] = new Vector3(-16.4, P.y, -1.6);

  /*
   * The tally, cut into the wall beside the door at the height of someone sitting down. Ten groups of
   * five in two rows, then the fifty-first mark on its own.
   *
   * x = -13.963, and the reasoning is worth keeping because it has now been paid for three times. The
   * wall these are scratched into is centred on BASEMENT.x1 = -13.8 and 0.2 thick, and the basement is on
   * its west side, so the plaster face was at -13.900 and "proud" means *more* negative than that. A 14 mm
   * mark centred at -13.890 spans -13.897..-13.883, i.e. 3 mm behind the face: fifty-one marks that are
   * the whole point of the room, invisible except where the depth test went the other way.
   *
   * Then the face moved. A damaged-wall facing hangs on this run with its front at -13.960, which put the
   * -13.895 that had been tuned against plaster 5.8 cm behind the visible wall — the same bug at ten times
   * the size — and it was corrected to -13.955.
   *
   * Both of those corrections moved the centre by 5 mm and both were described as giving 5 mm of relief.
   * Neither did: a 14 mm mark centred 5 mm from a face still has 7 mm of itself on the wall side, so
   * -13.895 stood 2 mm proud of plaster and -13.955 stands 2 mm proud of the facing. The geometry was
   * consistent across the change; only the number in the prose was ever wrong.
   *
   * -13.963 is the first value here that means what the comment says. Its face is at -13.970, a clean
   * centimetre proud, and its back at -13.956 is buried in the panel. The extra relief over the old 2 mm
   * is not pedantry: 2 mm was enough against flat plaster and is not enough against a *scan*, whose
   * surface has centimetres of its own relief to swallow a mark that barely breaks the plane.
   *
   * z starts at 2.70 rather than 2.45 for a different reason on the same wall. BASEMENT's east side is
   * faced by two runs, z -2..0 and z 2.6..6.6, with nothing between them — that gap is the shaft doorway,
   * and the wall across it belongs to SHAFT and is faced from the shaft side only. At 2.45 the first group
   * of each row put three of its five marks at z 2.444..2.606, in front of no panel at all, floating 6 cm
   * off the plaster with daylight behind them. The panel's own span is 2.65..6.55 after wallPanels' 5 cm
   * corner reveal, so 2.70 is the first origin that seats every mark of every group on scanned wall, and
   * the fifty-first moves with them to keep the gap that makes it read as separate.
   */
  for (let g = 0; g < 10; g++) {
    const gy = BASE_Y + 0.62 - Math.floor(g / 5) * 0.26;
    const gz = 2.7 + (g % 5) * 0.46;
    for (let k = 0; k < 5; k++) b.box(m.dark, 0.014, 0.19, 0.012, -13.963, gy, gz + k * 0.075);
  }
  b.box(m.dark, 0.016, 0.2, 0.014, -13.962, BASE_Y + 0.36, 5.03);
  at['basement.tally'] = new Vector3(-14.16, BASE_Y + 0.55, 3.6);

  // Wear along the screen's track, where the leaves have been slid back and forth. Mentioned in the
  // note; not marked. It was an arc while a shelf stood here, which was right for something dragged on
  // one corner and wrong for two leaves on a rail — so it is a straight streak now, 3.2 m of it centred
  // on the doorway, which is the span the leaves actually cover between shut and fully open.
  b.box(m.dark, 0.10, 0.008, 3.2, -21.66, BASE_Y + 0.012, PLACE.doors.z);

  // Support post and coal. The post is the one piece of hand-built furniture-scale left in this room, and
  // it stays because it reads as the house's own structure holding up the floor above, not as something
  // stood in the cellar.
  b.cyl(m.wood, 0.16, 0.16, 2.8, 8, -18.0, BASE_Y + 1.4, 2.3);
  aabbs.push(aabbOf(-18.0, BASE_Y, 2.3, 0.17, 0.17, BASE_Y + 2.8));
  /*
   * No crates and no barrel any more. The two stacked inside the door at (-14.42, -1.5), the one west of
   * the diagram at (-21.35, -1.45) and the barrel at (-20.4, 5.5) were hand-built boxes and a cylinder, and
   * they went with the workbench. Their three colliders went with them, which can only widen what the
   * NavGrid and CatRoutes see — the bs_n_w-bs_n_e rail they were once moved off was already clear — and
   * shadows() drops their quads without being told. basement.glb's own clutter along the north wall is
   * what makes the room look used now.
   *
   * The coal keeps its old scatter exactly. Its positions come off the little LCG below, which the
   * workbench's six jars used to advance first: six steps of (s * 41 + 13) % 89 from 5 land on 8, so
   * seeding it at 8 directly leaves every lump where it lay.
   */
  let s = 8;
  for (let i = 0; i < 9; i++) {
    s = (s * 29 + 7) % 83;
    b.box(m.dark, 0.16, 0.13, 0.16, -21.2 + (s % 7) * 0.16, BASE_Y + 0.07, 3.9 + (s % 5) * 0.19, s * 0.2);
  }
  b.cyl(m.dark, 0.004, 0.004, 0.5, 4, -17.8, BASE_Y + 2.5, 3.0);
  b.cyl(m.paper, 0.045, 0.035, 0.09, 6, -17.8, BASE_Y + 2.2, 3.0);
}

// --- Ritual room -----------------------------------------------------------------------------

/**
 * The ritual room — §2's "most disturbing space", and the only room whose dressing is the point.
 *
 * The records wall does the work. Eleven columns of pinned photographs with a name and a room
 * under each is the ledger from the living room and the tally from the basement finally agreeing
 * with one another, and the twelfth column — one nail, no photograph, the word Hall already
 * written underneath — is the last thing the player needs told to them.
 */
function ritual({ b, m, at }: Ctx): void {
  const A = PLACE.altar;

  // Chalk. Two rings, the outer one gone over more than once.
  b.ring(m.paper, 1.72, 1.79, 40, A.x, BASE_Y + 0.012, A.z);
  b.ring(m.paper, 1.5, 1.53, 36, A.x, BASE_Y + 0.011, A.z);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.4;
    candle(b, m, A.x + Math.cos(a) * 1.62, BASE_Y, A.z + Math.sin(a) * 1.62, 0.16 + (i % 3) * 0.04);
  }

  /*
   * Her records, the whole of the west wall. Eleven columns, and a twelfth begun.
   *
   * x -29.82 for the paper and -29.80 for the nails, not the -29.88 / -29.85 they were pinned at. This
   * room's west wall is at x -30 and wears a damaged-wall facing whose front stands 6 cm proud of the
   * plaster, at -29.84. `sheet` is 8 mm thick, so -29.88 spanned -29.884..-29.876: forty-four pieces of
   * paper entirely inside the wall, with twenty-two nail heads whose front faces landed exactly on -29.84
   * and so presented no relief at all, only something for the depth buffer to argue with. The wall the
   * header calls "the last thing the player needs told to them" was telling them nothing.
   *
   * -29.82 clears the facing by 1.6 cm and -29.80 puts the heads 6 mm in front of the paper's own face,
   * which is the pair living.list and hall.notice use against their facings. Every paper x on this wall
   * moves together — the two photographs, the name strip, the room strip, and the twelfth column's lone
   * strip below — because they are one flat collage and a 6 cm step inside it would read as a shelf.
   */
  for (let c = 0; c < 11; c++) {
    const cz = 0.2 + c * 0.4;
    sheet(b, m, -29.82, BASE_Y + 1.72, cz, 0.3, 0.36, 'x');
    sheet(b, m, -29.82, BASE_Y + 1.3, cz, 0.3, 0.36, 'x');
    b.box(m.paper, 0.006, 0.07, 0.3, -29.82, BASE_Y + 1.02, cz);
    b.box(m.paper, 0.006, 0.05, 0.24, -29.82, BASE_Y + 0.9, cz);
    for (const py of [1.9, 1.48]) b.box(m.iron, 0.02, 0.016, 0.016, -29.8, BASE_Y + py, cz);
  }
  // The twelfth column: one nail, no photograph, the word Hall already written underneath. This nail is
  // 3 cm deep where the other twenty-two are 2, so it stands 1 cm further out of the wall than any nail
  // that has something hanging on it — nothing depends on that, but it is why the number differs.
  b.box(m.iron, 0.03, 0.018, 0.018, -29.8, BASE_Y + 1.9, 4.6);
  b.box(m.paper, 0.006, 0.05, 0.22, -29.82, BASE_Y + 0.9, 4.6);
  at['ritual.records'] = new Vector3(-29.55, BASE_Y + 1.4, 2.3);

  // The rite, pinned at eye height on the wall by the door — the last thing read, first obeyed. Same
  // correction as the records wall, on the south run this time: z -1 is the wall, -0.84 is the facing's
  // front, and the sheet was at -0.88 with its pin's face flush on -0.84. -0.82 and -0.80 restore it.
  sheet(b, m, -25.4, BASE_Y + 1.52, -0.82, 0.36, 0.46, 'z');
  b.box(m.iron, 0.02, 0.02, 0.02, -25.4, BASE_Y + 1.72, -0.8);
  at['ritual.rite'] = new Vector3(-25.4, BASE_Y + 1.52, -0.6);

  // The chair with straps on its arms that stood well back from the circle, at (-24.2, 4.3), was hand-built
  // and has gone with the rest of that furniture. It published no anchor; its collider and contact quad
  // went with it, and the rag and the hangings below are what still keep m.cloth in this file.

  // A bowl and a cloth, both used. Nothing in this room has been cleaned, only rinsed.
  b.cyl(m.dark, 0.2, 0.15, 0.14, 12, -28.9, BASE_Y + 0.07, 4.7);
  b.box(m.cloth, 0.3, 0.03, 0.24, -28.6, BASE_Y + 0.015, 4.4, 0.6);
  for (let i = 0; i < 5; i++) {
    b.cyl(m.bone, 0.022, 0.026, 0.2 + i * 0.03, 5, -28.7 + i * 0.14, BASE_Y + 0.026, 1.1 + i * 0.09, 'x');
  }

  // Cloth hung from the joists. It is the only thing in the house that moves in a draught.
  for (const [hx, hz, hh] of [[-29.0, 0.0, 1.1], [-23.2, 5.0, 0.9], [-28.4, 5.2, 1.3]] as Array<[number, number, number]>) {
    b.box(m.cloth, 0.02, hh, 0.34, hx, BASE_Y + 2.8 - hh / 2, hz);
  }
}

/**
 * The hidden room behind the red-box door — the father's book, and the first gate key with it.
 *
 * This is the room's *only* interactive content and it is deliberately tiny: the room is three metres
 * under a storey the player has already walked, and what it has to deliver is one document and one
 * key. Everything else in here is atmosphere and is imported (the wardrobe, the body, the necklace —
 * see ModelProps); this function adds the two things that have to be *placed into* the wardrobe
 * rather than stood beside it, and the anchor that makes the book readable.
 *
 * The wardrobe's box is x 16.55..18.05, y 0.2..1.64, z -6.085..-5.315, with its front toward +z, so
 * "inside the wardrobe" means sitting the book and the key in the shallow band in front of the doors
 * at about z -5.5. The doors are closed, which is the point: the book is *found*, not displayed, and
 * a player who has read the note that sends them here is looking for exactly this.
 *
 * Both sit at the wardrobe floor rather than on a shelf, because the imported model has no shelf to
 * measure and inventing one would put a floating plank in a $2 model. On the floor of a wardrobe is
 * where a man hides the two things he does not want found together or apart.
 */
function hiddenRoom({ m, at, key }: Ctx): void {
  // The wardrobe's own floor, and the front band its doors hang over.
  // The wardrobe model sits on decorative feet that raise its internal floor ~0.46 m above the room floor (0.2 + 0.46 = 0.66).
  const WARDROBE_FLOOR_Y = 0.2 + 0.46;
  const facingZ = -5.62;
  const midX = 17.3;

  /*
   * The clue anchor for the father's diary (`pbr_dark_diary.glb`).
   *
   * `HouseScene` walks `CLUES` and registers an interaction for every id that has an anchor here, so
   * publishing `hidden.book` is the *entire* wiring for the prompt, the diary overlay, the toast and
   * the tension raise. The 3D model itself is placed in ModelProps (`pbr_dark_diary.glb` at x = 17.05,
   * y = 0.66, z = -5.62).
   *
   * The anchor stands 0.35 m into the room at z -5.27 rather than on the book itself. A reach of 2.0
   * from inside the doors would otherwise put the prompt up while the player is still on the stair,
   * a metre and a half behind a closed wardrobe door — the same mistake the hall's notice documents,
   * where the anchor was left far enough out to be reachable from the wall it was pinned to.
   */
  at['hidden.book'] = new Vector3(midX - 0.25, WARDROBE_FLOOR_Y + 0.05, facingZ + 0.35);

  /*
   * The first gate key, beside the book — `key-iron.glb`'s shape at a third of the size it is placed
   * at in the attic store, because there it is a wall-hung ornament and here it is the thing the
   * player is looking for.
   *
   * Built from primitives for the same reason the book is: this file owns the colliders and the
   * contact shadows, and ModelProps already has a `key-iron` row. A second row on that file would
   * collide with the first in exactly the way the hidden wardrobe just did (see its note in
   * ModelProps), so a small iron shape here is both simpler and safer.
   *
   * Unlike everything else in this file it does *not* go through `Batch`. It has to be takeable, and
   * a batched prop cannot be hidden — `Batch` merges each material's geometry into one mesh, so
   * toggling visibility on it would take the whole iron dressing of the house with it. These four
   * meshes therefore live in their own group (`Ctx.key`), which `HouseScene` hides on pick-up.
   *
   * The bow, the shaft and two teeth, laid flat on the wardrobe floor. No collider: it is 18 cm of
   * dressing and the wardrobe's own box is already a wall.
   */
  const keyY = WARDROBE_FLOOR_Y + 0.012;
  const part = (geo: BufferGeometry): void => {
    const mesh = new Mesh(geo, m.iron);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    key.add(mesh);
  };
  // Authored around the origin, then the group is moved as one — so the hand-off can reposition the
  // whole key by moving `key.position`, and the four parts never fall out of register with each other.
  {
    const shaft = new BoxGeometry(0.02, 0.012, 0.14);
    shaft.rotateY(Math.PI * 0.25);
    shaft.translate(-0.03, 0, 0);
    part(shaft);
    const bow = new CylinderGeometry(0.035, 0.035, 0.012, 8);
    bow.translate(0.045, 0, 0.045);
    part(bow);
    // Two teeth, so it reads as a key and not as a nail the moment the lantern finds it.
    const t1 = new BoxGeometry(0.035, 0.012, 0.012);
    t1.rotateY(Math.PI * 0.25);
    t1.translate(-0.105, 0, -0.055);
    part(t1);
    const t2 = new BoxGeometry(0.022, 0.012, 0.012);
    t2.rotateY(Math.PI * 0.25);
    t2.translate(-0.09, 0, -0.085);
    part(t2);
  }
  key.position.set(midX - 0.08, keyY, facingZ);
  key.name = 'hidden-key';
}

// --- Assembly --------------------------------------------------------------------------------
/**
 * A contact shadow under every collider this file emitted. See ContactShadow for what they are.
 *
 * Driven off the colliders rather than off a second hand-written list of positions, and that is the
 * whole reason this is eight lines instead of sixty: `aabbs` here is exactly the furniture — every entry
 * a thing standing on a floor, since walls and casings come from HouseRooms and never pass through this
 * file. So the footprint and the floor are both already known and correct, and a table that gets nudged
 * 20 cm in a later edit takes its shadow with it. A table that gets *deleted* takes it with it too,
 * which is what the several rounds of furniture removal this file has been through cost here: nothing.
 * The last of them left a single entry, the cellar post, and this loop did not need to know that either.
 * Sharing one material means Batch merges however many there are into a single draw call.
 *
 * `minY` is the floor and not an assumption about it: every push in this file seats its box on the
 * storey it belongs to, which is why the cellar post's comes out at BASE_Y without this knowing that
 * BASE_Y exists.
 */
function shadows({ b, m, aabbs }: Ctx): void {
  for (const a of aabbs) {
    b.add(
      m.shadow,
      shadowQuad(
        (a.minX + a.maxX) / 2,
        a.minY + SHADOW_LIFT,
        (a.minZ + a.maxZ) / 2,
        a.maxX - a.minX,
        a.maxZ - a.minZ,
      ),
      'shadow',
    );
  }
}

export function buildProps(mats: FixtureMats): HouseProps {
  const group = new Group();
  group.name = 'props';
  // The one prop that has to stay movable, so it is parented to `group` for transform inheritance
  // but never enters the Batch. See `HouseProps.hiddenKey`.
  const hiddenKey = new Group();
  group.add(hiddenKey);
  const ctx: Ctx = { b: new Batch(), m: mats, aabbs: [], at: {}, key: hiddenKey };
  hall(ctx);
  hallway(ctx);
  bedroom(ctx);
  living(ctx);
  shaft(ctx);
  basement(ctx);
  ritual(ctx);
  hiddenRoom(ctx);
  // Last, so it sees every collider the rooms pushed.
  shadows(ctx);
  const geos = ctx.b.flush(group, 'props');
  return { group, aabbs: ctx.aabbs, anchors: ctx.at, hiddenKey, geos };
}






