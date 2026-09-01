/**
 * HouseRooms — the concrete floor plan. Coordinates in metres; +x east, +z north, y up.
 *
 *                                z
 *   BEDROOM         LIVING ROOM  ^      ground floor, y = 0
 *   (window W)      (window N)   |
 *   ------[door]---[door]------- z = 2.6
 *          HALLWAY               z = 0 .. 2.6, x = -9 .. 9
 *   [cellar door at x = -9]
 *   ------[archway]------------- z = 0
 *          MAIN HALL             z = -7 .. 0, x = -5 .. 5
 *   ======[GATE, 3 locks]======= z = -7
 *
 *   STAIR SHAFT  x = -13.8 .. -9   descends to y = -3
 *   BASEMENT     x = -22 .. -13.8  y = -3
 *   RITUAL ROOM  x = -30 .. -22    y = -3, behind a movable shelf
 *   BLACK MAGIC  x = -19.18 .. -14.14, z = 6.6 .. 11.012  y = -3, through the basement's north wall
 *
 *   UPPER STAIR  x = 9 .. 14.4     climbs to y = 2.4, through a door in the hallway's east wall
 *   UPPER ROOM   x = 14.4 .. 24.45 y = 2.4, an imported apartment (room-upper.glb)
 *
 * The basement wing extends west rather than sitting under the ground floor, and the upper storey
 * extends east rather than sitting on top of it: no floor needs a hole and no two levels share a
 * footprint. Nobody can tell from inside, because every route between levels is an enclosed stair.
 */

import { BASE_CEIL_H, BASE_Y, HALF_T, WALL_H, type FloorRect, type RoomSpec, type WallRun } from './HouseLayout';

// --- Ground floor ---
export const HALL = { x0: -5, x1: 5, z0: -7, z1: 0 };
export const HALLWAY = { x0: -9, x1: 9, z0: 0, z1: 2.6 };
export const BEDROOM = { x0: -9, x1: -1, z0: 2.6, z1: 10.2 };
export const LIVING = { x0: -1, x1: 9, z0: 2.6, z1: 10.2 };

/**
 * Main gate: centred on the hall's south wall.
 *
 * 1.6 m clear and 2.45 tall because the gate is gate-main.glb now, not six welded cylinders, and an
 * imported leaf cannot be told to be 2.4 m wide — it measures 1.640 x 2.496 and stretching it to the
 * old 2.4 m opening would have made it 3.65 m tall, through the hall ceiling. So the hole is cut to
 * the leaf instead: 8 cm narrower and 5 cm shorter than the slab, all round, which is the overlap that
 * keeps the porch from showing in a slot down each side.
 */
export const GATE = { x: 0, z: -7, half: 0.8, top: 2.45 };
/** Archway from hall into hallway. */
export const ARCH = { x: 0, half: 1.6, top: 2.4 };

/** Main Hall boundaries shared with the fitted damaged-wall panels in ModelProps. */
export const HALL_WALLS = {
  south: { x1: HALL.x0, z1: HALL.z0, x2: HALL.x1, z2: HALL.z0, openings: [{ at: GATE.x, half: GATE.half, y1: GATE.top }], modelCollision: true },
  west: { x1: HALL.x0, z1: HALL.z0, x2: HALL.x0, z2: HALL.z1, modelCollision: true },
  east: { x1: HALL.x1, z1: HALL.z0, x2: HALL.x1, z2: HALL.z1, modelCollision: true },
  north: { x1: HALL.x0, z1: HALLWAY.z0, x2: HALL.x1, z2: HALLWAY.z0, openings: [{ at: ARCH.x, half: ARCH.half, y1: ARCH.top }], modelCollision: true },
} satisfies Record<'south' | 'west' | 'east' | 'north', WallRun>;

export const BEDROOM_DOOR = { x: -5, z: 2.6, half: 0.8, top: 2.1 };
export const LIVING_DOOR = { x: 5, z: 2.6, half: 0.8, top: 2.1 };
export const CELLAR_DOOR = { x: -9, z: 1.3, half: 0.8, top: 2.1 };

// --- Basement wing ---
export const SHAFT = { x0: -13.8, x1: -9, z0: 0, z1: 2.6 };
export const BASEMENT = { x0: -22, x1: -13.8, z0: -2, z1: 6.6 };
export const RITUAL = { x0: -30, x1: -22, z0: -1, z1: 5.6 };
/** Doorway at the bottom of the stairs, into the basement. */
export const BASEMENT_DOOR = { x: -13.8, z: 1.3, half: 1.0, bottom: BASE_Y, top: BASE_Y + 2.1 };
/** Hidden opening behind the movable shelf on the basement's far wall. */
export const RITUAL_DOOR = { x: -22, z: 2.3, half: 0.9, bottom: BASE_Y, top: BASE_Y + 2.1 };

/**
 * The daayan's black magic room, north of the basement — black-magic-room.glb's own four walls, floor
 * and ceiling, with this rectangle standing just outside them.
 *
 * Sized by the model rather than chosen. Measured off the model's skinned triangles, not off
 * Box3.setFromObject: that file's meshes are bound with bindMode 'attached' and a cached boundingBox
 * that already carries the root yaw, so three.js reports the room rotated twice and hands back a
 * footprint with x and z swapped. The room the renderer actually draws is 4.8019 x 2.8000 x 4.2944, its
 * walls at x -19.1020 and -14.3001 and z 6.5997 and 10.8941.
 *
 * Every face here stands outside the face the model puts there, and that direction is the whole point.
 * The procedural shell exists to stop the player and to seal the second doorway the model ships in its
 * north wall, and if any of its slabs landed on the other side it would stand in front of the textured
 * wall instead of behind it — the player would be looking at flat cellar tone in a room imported
 * entirely for its walls. z1 is the tight one: at 11.14 it sat 17 cm behind the model's north wall, and
 * the doorway in that wall framed the gap as a lit recess of flat tone. 11.012 puts its inner face
 * 1.8 cm behind the wall, so the same doorway reads as bricked up.
 *
 * Unlike the ritual room this is not hidden: it opens straight off the basement, so the cellar reads as
 * a wing with somewhere to go rather than a dead end with a secret. The altar stays where it is, behind
 * the shelf, because the ritual room is 8 x 6.6 and this model cannot be stretched to cover it without
 * a 4.7 m ceiling.
 */
export const BLACK = { x0: -19.18, x1: -14.14, z0: 6.6, z1: 11.012 };
/**
 * Doorway from the basement into it, in the basement's north wall.
 *
 * Deliberately narrower and shorter than the model's own opening on every side, so the procedural wall
 * covers the model's jambs and lintel. The other way round leaves strips of 8 cm-thick wall with no
 * collider behind them, which is exactly the walk-through-the-wall the upper storey had. The model's
 * south doorway lands at x -15.8007 .. -14.7412; this opening is x -15.7 .. -14.7 inside it, so x is
 * where that doorway is, not a free choice.
 */
export const BLACK_DOOR = { x: -15.2, z: BASEMENT.z1, half: 0.5, bottom: BASE_Y, top: BASE_Y + 1.9 };

// --- Upper storey: an imported apartment (room-upper.glb) up an imported stair (stair-wood.glb) ---
/**
 * Floor level of the upper room. Not a free choice: it is where the stair model's eighth tread
 * lands once that model is scaled to keep its rise under the controller's 0.35 m step-up. See the
 * two rows at the end of MODEL_PLACEMENTS, which are where the arithmetic lives.
 */
export const UP_Y = 2.4;
/**
 * Stairwell east of the hallway. Exactly as wide as the stair model is, so there is no strip of
 * floor beside the treads for the player to walk off.
 */
export const UP_SHAFT = { x0: 9, x1: 14.4, z0: -0.24, z1: 2.84 };
/**
 * The imported room's floor slab as one walkable rectangle. Its south-west corner (x < 18.6,
 * z < -0.99) is outside the model, but a wall stands on that line, so nobody reaches it.
 */
export const UPPER = { x0: 14.4, x1: 24.45, z0: -1.93, z1: 9.28 };
/** Door at the foot of the upper stair, in the hallway's east wall. Mirrors CELLAR_DOOR. */
export const STAIR_DOOR = { x: HALLWAY.x1, z: 1.3, half: 0.8, top: 2.1 };
/**
 * Door at the top of it, cut into the one side the imported room leaves open.
 *
 * 2.5 above the floor rather than the 2.1 every other door in the house uses, because this one
 * stands where the stair's step-up fires. FPController's fall branch tests a sphere of the player's
 * radius about the *eye*, so a lift of stepUpHeight onto tread 8 puts that sphere's top at 4.75; a
 * header at 4.5 catches it, and being caught while falling reads as landing — the player hovers in
 * the doorway on nothing. At 4.9 the sphere clears it, and 0.39 m of header still remains under the
 * imported room's 5.29 ceiling, so the way in still reads as a door rather than a missing wall.
 *
 * `half` is 0.7 rather than the 0.8 the other doors use because there is a real door in this one now:
 * door.glb's frame measures 1.463 m across at the height it is placed (see MODEL_PLACEMENTS), so at
 * 0.8 it would have left an 8.6 cm slot of open wall down each side. 0.7 lets the jambs overlap the
 * wall by 3 cm instead. The header stays at 4.9 — the frame's own head is drawn 6 cm above it and has
 * no collider, so what catches the player while the step-up fires is still this number.
 */
export const UPPER_DOOR = { x: UPPER.x0, z: 1.3, half: 0.7, top: UP_Y + 2.5 };

/**
 * Doorway cut through the flat's east partition, from the room its front door opens into to the
 * corridor and every other room beyond.
 *
 * Measured, not chosen: room-upper.glb arrives as a cutaway diorama and that partition is sealed. Its
 * faces run z 0.26..3.71 at x 19.775..19.936, 20.1 m2 over a 3.45 x 2.92 m panel — twice the panel's
 * area, i.e. drawn on both sides with no opening anywhere along it. A walk of the live scene put 43.8
 * of the flat's 59 m2 behind it, including every room the player was meant to enter and all of the
 * floor the model actually draws: the room the stair lands in is 15 m2 with no slab under it.
 *
 * Why this line rather than the partition at z 3.7: that one is 0.6 m thick with 36.8 m2 of faces and
 * only 70% of a ceiling behind it, while this one is a clean 0.16 m panel with floor and ceiling both
 * at 100% beyond. And why this z: the two remaining wall runs either side have to stay longer than
 * WALL_MIN_RUN or the slice drops them and the geometry that is still drawn stops having a collider.
 * Carrying the cut from 1.15 leaves 0.83 m to the south and 1.36 m to the north; centring it on the
 * front door's 1.3 instead would have left 0.68 m and quietly opened a hole in a wall.
 *
 * `bottom` is 2 cm above the walk plane on purpose. Both of the model's horizontal levels are at or
 * below UP_Y, so starting there cannot punch the floor slab, and the 5 cm of wall left standing under
 * it is covered by the casing's sill — see the entry in HouseScene, which pulls its y0 down by exactly
 * the sill's height so the threshold lands on the stub rather than above it.
 */
export const UPPER_INNER = { x: 19.855, z: 1.75, half: 0.6, bottom: UP_Y + 0.02, top: UP_Y + 2.2 };
/**
 * The same opening as a world box for CarveBox to subtract. 0.15 either side of the panel's centre, so
 * the 0.16 m panel and any skirting or trim against it go with it.
 */
export const UPPER_INNER_CUT = {
  x0: UPPER_INNER.x - 0.15,
  x1: UPPER_INNER.x + 0.15,
  y0: UPPER_INNER.bottom,
  y1: UPPER_INNER.top,
  z0: UPPER_INNER.z - UPPER_INNER.half,
  z1: UPPER_INNER.z + UPPER_INNER.half,
};

/**
 * The two rectangles of the upper flat the model leaves without a floor or a ceiling, to be drawn
 * procedurally under and over it. See HouseBuilder, which reads this after the room loop.
 *
 * `modelled: true` on the upper room suppresses both procedural planes, on the understanding that the
 * imported flat brings its own. It does, for 99% of the plan — and not at all for the room its front
 * door opens into, nor for the small room in the south-east corner. Measured by area on the live
 * scene: 179.90 m2 of slab at y 2.35 and 148.15 m2 of ceiling at 5.30 across the rest of the flat,
 * against 1.01 m2 of horizontal geometry over the whole of this first room. That is why it reads pitch
 * black on entry — the lantern is a point light with nothing under it to land on — and it is the same
 * defect as the sealed partition above, seen from the other side.
 *
 * The heights bracket the model's own slabs rather than meeting them: 1 cm under the floor at 2.35 and
 * 2 cm over the ceiling at 5.30, both outside the room's own 2.4..5.29 band. A patch level with either
 * would z-fight it along every shared edge, and the room's own y1 of 5.29 would hide the model's
 * ceiling everywhere rather than fill in the two holes.
 */
export const UPPER_PATCH = {
  floorY: UP_Y - 0.06,
  ceilY: UP_Y + 2.92,
  rects: [
    /** The room the stair's door opens into: the model's cutaway edge to the new partition doorway. */
    { x0: UPPER.x0, x1: 19.9, z0: UPPER.z0, z1: 3.72 },
    /** The small south-east room, walled off on its own and only ever seen through its doorway. */
    { x0: 21.05, x1: UPPER.x1, z0: UPPER.z0, z1: 0.55 },
  ],
};

/**
 * Where the player wakes: on the bedroom's imported bed, near its foot and clear of the curled cat. The
 * y here is the measured mattress (0.47 m) plus the standing eye height; HouseScene replaces it with the
 * model's exact fitted value as soon as bed.glb lands.
 *
 * x follows that bed. It stood against the west wall at -8.26 while HouseProps also built a procedural
 * bed in the middle of the room; the procedural one is gone and the imported one took its place, so the
 * spawn is now the middle of the floor. z stays at 8.05 — 0.95 m south of the bed's centre, which is its
 * foot end on a 2.1 m mattress — and so does everything tuned against it.
 *
 * yaw -0.45 faces diagonally toward the bedroom door rather than into a wall or straight at the
 * headboard, so the first frame immediately shows a way out of the room.
 */
export const SPAWN = { x: -6.2, y: 2.17, z: 8.05, yaw: -0.45 };

// --- Stairs ---
/** Top landing, flat, just outside the cellar door. */
const STAIR_TOP_X = -9.6;
const STEP_RUN = 0.28;
const STEP_RISE = 0.2;
const STEP_COUNT = 15;

/**
 * The stair as a list of walkable rectangles, one per tread. The controller snaps to the
 * highest surface under the player's feet, so treads need no ramp geometry or special casing —
 * and a 0.2 m rise is under the 0.35 m step-up, so walking back up works too.
 */
export function stairFloors(): FloorRect[] {
  const out: FloorRect[] = [{ x0: STAIR_TOP_X, x1: SHAFT.x1, z0: SHAFT.z0, z1: SHAFT.z1, y: 0 }];
  for (let i = 0; i < STEP_COUNT; i++) {
    const x1 = STAIR_TOP_X - STEP_RUN * i;
    out.push({
      x0: x1 - STEP_RUN,
      x1,
      z0: SHAFT.z0,
      z1: SHAFT.z1,
      y: -STEP_RISE * (i + 1),
    });
  }
  return out;
}

/** Riser + tread boxes, so the stair reads as a stair instead of an invisible slope. */
export function stairTreads(): Array<{ cx: number; cy: number; cz: number; w: number; h: number; d: number }> {
  return (
    stairFloors()
      // First off the top because that rect is the landing, not a step. Last off the bottom because
      // that rect *is* the cellar floor: its tread box came out 0.12 thick with its top face at
      // exactly BASE_Y, i.e. buried in the floor slab with 0.73 m2 of it coplanar — trim against
      // stone, in two different meshes, picking a different winner as the player came down the
      // stairs. There was never a step to see there; you step off the last tread onto the floor.
      .slice(1, -1)
      .map((f) => ({
        cx: (f.x0 + f.x1) / 2,
        cy: f.y - 0.06,
        cz: (f.z0 + f.z1) / 2,
        w: f.x1 - f.x0,
        h: 0.12,
        d: f.z1 - f.z0,
      }))
  );
}

// --- Upper stair ---
// Measured off stair-wood.glb at the scale ModelProps gives it, not chosen: eight treads rising
// 0.300 and running 0.470, each overlapping its neighbour by a 0.078 nosing so there is no seam
// between rects to fall through. No tread geometry here — the model is the geometry.
const UP_STEP_COUNT = 8;
const UP_STEP_RISE = 0.3;
const UP_STEP_RUN = 0.47016;
const UP_STEP_NOSE = 0.0777;
/** East edge of the lowest tread, back-figured so the top one ends on the upper room's floor. */
const UP_STEP_X1 = UPPER.x0 - UP_STEP_RUN * (UP_STEP_COUNT - 1);

/** The imported stair as walkable rectangles, the same trick stairFloors plays going down. */
export function upStairFloors(): FloorRect[] {
  const out: FloorRect[] = [];
  for (let i = 0; i < UP_STEP_COUNT; i++) {
    const x1 = UP_STEP_X1 + UP_STEP_RUN * i;
    out.push({
      x0: x1 - UP_STEP_RUN - UP_STEP_NOSE,
      x1,
      z0: UP_SHAFT.z0,
      z1: UP_SHAFT.z1,
      y: UP_STEP_RISE * (i + 1),
    });
  }
  return out;
}

export const ROOMS: RoomSpec[] = [
  {
    id: 'hall',
    name: 'Main Hall',
    floorY: 0,
    height: WALL_H,
    floor: HALL,
    ceiling: true,
    tone: 'plaster',
    walls: [HALL_WALLS.south, HALL_WALLS.west, HALL_WALLS.east],
  },
  {
    id: 'hallway',
    name: 'Hallway',
    floorY: 0,
    height: WALL_H,
    floor: HALLWAY,
    ceiling: true,
    tone: 'plaster',
    walls: [
      // Owns the shared wall. Only its Main Hall-wide centre uses imported model collision.
      { x1: HALLWAY.x0, z1: HALLWAY.z0, x2: HALL.x0, z2: HALLWAY.z0 },
      HALL_WALLS.north,
      { x1: HALL.x1, z1: HALLWAY.z0, x2: HALLWAY.x1, z2: HALLWAY.z0 },
      {
        x1: HALLWAY.x0,
        z1: HALLWAY.z1,
        x2: HALLWAY.x1,
        z2: HALLWAY.z1,
        openings: [
          { at: BEDROOM_DOOR.x, half: BEDROOM_DOOR.half, y1: BEDROOM_DOOR.top },
          { at: LIVING_DOOR.x, half: LIVING_DOOR.half, y1: LIVING_DOOR.top },
        ],
      },
      {
        x1: HALLWAY.x0,
        z1: HALLWAY.z0,
        x2: HALLWAY.x0,
        z2: HALLWAY.z1,
        openings: [{ at: CELLAR_DOOR.z, half: CELLAR_DOOR.half, y1: CELLAR_DOOR.top }],
      },
      // East wall: the door to the upper stair. Nothing else fits on this wall now, which is why
      // painting-sus.glb hangs on the south wall instead of here.
      {
        x1: HALLWAY.x1,
        z1: HALLWAY.z0,
        x2: HALLWAY.x1,
        z2: HALLWAY.z1,
        openings: [{ at: STAIR_DOOR.z, half: STAIR_DOOR.half, y1: STAIR_DOOR.top }],
      },
    ],
  },
  {
    id: 'bedroom',
    name: 'Bedroom',
    floorY: 0,
    height: WALL_H,
    floor: BEDROOM,
    ceiling: true,
    tone: 'plaster',
    walls: [
      {
        x1: BEDROOM.x0,
        z1: BEDROOM.z0,
        x2: BEDROOM.x0,
        z2: BEDROOM.z1,
        openings: [{ at: 6.0, half: 0.8, y0: 1.0, y1: 2.2 }],
      },
      { x1: BEDROOM.x0, z1: BEDROOM.z1, x2: BEDROOM.x1, z2: BEDROOM.z1 },
      { x1: BEDROOM.x1, z1: BEDROOM.z0, x2: BEDROOM.x1, z2: BEDROOM.z1 },
    ],
  },
  {
    id: 'living',
    name: 'Living Room',
    floorY: 0,
    height: WALL_H,
    floor: LIVING,
    ceiling: true,
    tone: 'plaster',
    walls: [
      {
        x1: LIVING.x0,
        z1: LIVING.z1,
        x2: LIVING.x1,
        z2: LIVING.z1,
        openings: [{ at: 4.0, half: 1.1, y0: 0.9, y1: 2.3 }],
      },
      { x1: LIVING.x1, z1: LIVING.z0, x2: LIVING.x1, z2: LIVING.z1 },
    ],
  },
  {
    id: 'shaft',
    name: 'Cellar Stair',
    floorY: BASE_Y,
    // Tall: the shaft runs from the basement floor to well above the ground floor's head height,
    // so looking down it from the cellar door reads as a drop rather than a corridor.
    height: 5.4,
    floor: SHAFT,
    ceiling: true,
    tone: 'cellar',
    walls: [
      {
        x1: SHAFT.x0,
        z1: SHAFT.z0,
        x2: SHAFT.x0,
        z2: SHAFT.z1,
        openings: [
          { at: BASEMENT_DOOR.z, half: BASEMENT_DOOR.half, y0: BASEMENT_DOOR.bottom, y1: BASEMENT_DOOR.top },
        ],
      },
      // Both side walls stop HALF_T short of the landing, so their padded ends finish flush at
      // x = SHAFT.x1 instead of reaching -8.9 and coinciding face-for-face with the hallway's and
      // bedroom's own walls, which are cellar-toned against plaster and so cannot be hidden by
      // sharing a texture. Nothing opens: below the landing wall[3] closes the corner, above it the
      // hallway's own run does, and both still overlap this one by 0.1.
      { x1: SHAFT.x0, z1: SHAFT.z0, x2: SHAFT.x1 - HALF_T, z2: SHAFT.z0 },
      { x1: SHAFT.x0, z1: SHAFT.z1, x2: SHAFT.x1 - HALF_T, z2: SHAFT.z1 },
      // East side, but only below the landing. Above it the hallway's own west wall carries the
      // cellar door; below it there is nothing at all, and without this the shaft looks out
      // sideways under the ground floor into empty space. It stops a centimetre under the ground
      // floor rather than exactly at it: its top face was coplanar with the hallway slab over the
      // 0.1 the wall thickness leaves exposed in the cellar doorway — the one bit of that seam the
      // player walks right over.
      { x1: SHAFT.x1, z1: SHAFT.z0, x2: SHAFT.x1, z2: SHAFT.z1, y0: BASE_Y, y1: -0.01 },
    ],
  },
  {
    id: 'basement',
    name: 'Basement',
    floorY: BASE_Y,
    height: BASE_CEIL_H,
    floor: BASEMENT,
    ceiling: true,
    tone: 'cellar',
    walls: [
      // Split around the stair shaft, which owns the wall between them.
      { x1: BASEMENT.x1, z1: BASEMENT.z0, x2: BASEMENT.x1, z2: SHAFT.z0 },
      { x1: BASEMENT.x1, z1: SHAFT.z1, x2: BASEMENT.x1, z2: BASEMENT.z1 },
      {
        x1: BASEMENT.x0,
        z1: BASEMENT.z0,
        x2: BASEMENT.x0,
        z2: BASEMENT.z1,
        openings: [
          { at: RITUAL_DOOR.z, half: RITUAL_DOOR.half, y0: RITUAL_DOOR.bottom, y1: RITUAL_DOOR.top },
        ],
      },
      { x1: BASEMENT.x0, z1: BASEMENT.z0, x2: BASEMENT.x1, z2: BASEMENT.z0 },
      {
        x1: BASEMENT.x0,
        z1: BASEMENT.z1,
        x2: BASEMENT.x1,
        z2: BASEMENT.z1,
        openings: [
          { at: BLACK_DOOR.x, half: BLACK_DOOR.half, y0: BLACK_DOOR.bottom, y1: BLACK_DOOR.top },
        ],
      },
    ],
  },
  {
    id: 'ritual',
    name: 'Ritual Room',
    floorY: BASE_Y,
    height: BASE_CEIL_H,
    floor: RITUAL,
    ceiling: true,
    tone: 'cellar',
    walls: [
      { x1: RITUAL.x0, z1: RITUAL.z0, x2: RITUAL.x0, z2: RITUAL.z1 },
      { x1: RITUAL.x0, z1: RITUAL.z0, x2: RITUAL.x1, z2: RITUAL.z0 },
      { x1: RITUAL.x0, z1: RITUAL.z1, x2: RITUAL.x1, z2: RITUAL.z1 },
    ],
  },
  {
    id: 'black',
    name: 'Black Magic Room',
    floorY: BASE_Y,
    // 2 cm taller than the model's walls, so its own ceiling is the one you see and there is no slot
    // between the two for the sky to come through.
    height: 2.82,
    floor: BLACK,
    ceiling: true,
    tone: 'cellar',
    // South side omitted: that is the basement's north wall, and it carries BLACK_DOOR.
    walls: [
      { x1: BLACK.x0, z1: BLACK.z0, x2: BLACK.x0, z2: BLACK.z1 },
      { x1: BLACK.x1, z1: BLACK.z0, x2: BLACK.x1, z2: BLACK.z1 },
      { x1: BLACK.x0, z1: BLACK.z1, x2: BLACK.x1, z2: BLACK.z1 },
    ],
  },
  {
    id: 'upshaft',
    name: 'Upper Stair',
    floorY: 0,
    // Tall enough to clear the stair model's handrail at 3.53 and to leave headroom on the top
    // tread, where the player's eye is already at 4.1.
    height: 4.6,
    floor: UP_SHAFT,
    ceiling: true,
    tone: 'plaster',
    walls: [
      // Both stop HALF_T short of the upper room, for the reason shaft's side walls do: reaching
      // UP_SHAFT.x1 padded their ends out to 14.5, exactly where the upper room's own west wall
      // ends, and that room is cellar-toned where this stair is plaster. wall[3] below and the
      // upper room's wall above still overlap these by 0.1, so nothing opens up.
      { x1: UP_SHAFT.x0, z1: UP_SHAFT.z0, x2: UP_SHAFT.x1 - HALF_T, z2: UP_SHAFT.z0 },
      { x1: UP_SHAFT.x0, z1: UP_SHAFT.z1, x2: UP_SHAFT.x1 - HALF_T, z2: UP_SHAFT.z1 },
      // West side, opened over exactly the span the hallway's own east wall fills — that wall
      // carries the door and stops at 3.0, so this run only has to close the strip above it and
      // the slivers north and south of it. Half is HALF_T wider than the hallway is, so the two
      // walls abut instead of overlapping in a 10 cm coplanar sliver and z-fighting.
      {
        x1: UP_SHAFT.x0,
        z1: UP_SHAFT.z0,
        x2: UP_SHAFT.x0,
        z2: UP_SHAFT.z1,
        openings: [
          {
            at: (HALLWAY.z0 + HALLWAY.z1) / 2,
            half: (HALLWAY.z1 - HALLWAY.z0) / 2 + HALF_T,
            y1: WALL_H,
          },
        ],
      },
      // East side, but only below the upper floor: above it the imported room's own west wall
      // carries the door. Below it there is nothing at all, exactly as under the cellar landing.
      { x1: UP_SHAFT.x1, z1: UP_SHAFT.z0, x2: UP_SHAFT.x1, z2: UP_SHAFT.z1, y0: 0, y1: UP_Y },
    ],
  },
  {
    id: 'upper',
    name: 'Upper Room',
    floorY: UP_Y,
    // Floor to the imported ceiling, which sits 2.89 above the imported floor. Both come from the
    // model; this height is only what the walls below need to reach.
    height: 2.89,
    floor: UPPER,
    modelled: true,
    tone: 'cellar',
    walls: [
      // --- The sides the model leaves open. It is a cutaway diorama: measured face by face, its
      // shell is missing its west side over the stair's half of the plan, and both outside walls
      // of the bathroom in its south-east corner. ---
      // West: the way in, and the only one of these the player ever sees.
      {
        x1: UPPER.x0,
        z1: -0.99,
        x2: UPPER.x0,
        z2: 3.6,
        openings: [{ at: UPPER_DOOR.z, half: UPPER_DOOR.half, y1: UPPER_DOOR.top }],
      },
      // South, west of where the model's own front wall starts.
      { x1: UPPER.x0, z1: -0.99, x2: 18.6, z2: -0.99 },
      // The bathroom's two missing walls. Sealed rather than opened: the model's own partitions
      // make that corner a dead end, so these only keep the void out of frame.
      { x1: 20.97, z1: UPPER.z0, x2: UPPER.x1, z2: UPPER.z0 },
      { x1: UPPER.x1, z1: UPPER.z0, x2: UPPER.x1, z2: 0.6 },

      // --- Colliders for the walls the model draws itself, ends run long so they overlap rather
      // than leave a 10 cm slot at a corner. Overlapping colliders cost nothing; a slot lets the
      // player squeeze out of the building. ---
      { x1: UPPER.x0, z1: 3.3, x2: UPPER.x0, z2: 9.4, collideOnly: true },
      { x1: UPPER.x0, z1: UPPER.z1, x2: UPPER.x1, z2: UPPER.z1, collideOnly: true },
      { x1: UPPER.x1, z1: 0.3, x2: UPPER.x1, z2: 9.4, collideOnly: true },
      { x1: 18.4, z1: -0.99, x2: 21.3, z2: -0.99, collideOnly: true },
      { x1: 18.61, z1: -2.0, x2: 18.61, z2: 0.6, collideOnly: true },
      { x1: 21.12, z1: -1.1, x2: 21.12, z2: 3.9, collideOnly: true },
      // The cross wall, keeping the 1.3 m gap that leads through it into the nook behind.
      {
        x1: 18.4,
        z1: 0.49,
        x2: UPPER.x1,
        z2: 0.49,
        openings: [{ at: 20.645, half: 0.825 }],
        collideOnly: true,
      },
    ],
  },
];

/** Every walkable surface in the house: room floors plus both stairs' treads. */
export function houseFloors(): FloorRect[] {
  const out: FloorRect[] = ROOMS.filter((r) => r.id !== 'shaft').map((r) => ({
    x0: r.floor.x0,
    x1: r.floor.x1,
    z0: r.floor.z0,
    z1: r.floor.z1,
    y: r.floorY,
  }));
  return [...out, ...stairFloors(), ...upStairFloors()];
}
