/**
 * HouseRooms — the concrete floor plan. Coordinates in metres; +x east, +z north, y up.
 *
 *                                z
 *   KITCHEN   PRAYER   STORE     ^      ground floor, y = 0     z = 12.2 .. 17.2
 *   ---[door]--[door]--[door]--- z = 12.2
 *          BACK CORRIDOR         z = 10.2 .. 12.2, x = -9 .. 9
 *   ------[door]------[door]---- z = 10.2
 *   BEDROOM         LIVING ROOM  |
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
 *   ATTIC STORE  x = 14.4 .. 18.6, z = -6.4 .. -1.93   y = 2.4, through the flat's south wall
 *   CHILD'S ROOM x = 18.6 .. 24.45, z = -6.4 .. -1.93  y = 2.4, off the store
 *   SHRINE ROOM  x = 14.4 .. 24.45, z = -11 .. -6.4    y = 2.4, off the store
 *
 * The basement wing extends west rather than sitting under the ground floor, the ground floor's rear
 * wing extends north, and the upper storey extends east with its own wing running south: no floor needs
 * a hole and no two levels share a footprint. Nobody can tell from inside, because every route between
 * levels is an enclosed stair.
 */

import { BASE_CEIL_H, BASE_Y, HALF_T, WALL_H, type FloorRect, type Rect, type RoomSpec, type WallRun } from './HouseLayout';

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

// --- Ground floor, rear wing: a back corridor and the three rooms off it ---
/**
 * The rear wing runs north, off the back of the bedroom and living room, because that is the only
 * direction the ground floor has left. West is the cellar stair, east is the upper stair, south is the
 * hall and the gate; north of z = 10.2 there is nothing at any level — the basement wing sits at
 * x < -13.8 and the upper flat at x > 14.4, so a room out here overlaps neither in plan.
 *
 * Two ways in rather than one, because the corridor spans the whole 18 m of the house and a single door
 * at one end would make the far room a walk down a dead corridor and back. The bedroom is where the
 * player wakes, so its door is the one they find first; the living room's is at x 7 and not at the
 * symmetric x 5, because the living room's north wall already carries a window at x 4 whose opening runs
 * to 5.1 and two openings that overlap would cut each other's jamb away.
 */
export const BACKHALL = { x0: -9, x1: 9, z0: 10.2, z1: 12.2 };
export const KITCHEN = { x0: -9, x1: -3, z0: 12.2, z1: 17.2 };
export const POOJA = { x0: -3, x1: 3, z0: 12.2, z1: 17.2 };
export const STORE = { x0: 3, x1: 9, z0: 12.2, z1: 17.2 };

/** Bedroom into the back corridor, in the wall the bedroom owns. */
export const BACK_DOOR_W = { x: -5, z: BEDROOM.z1, half: 0.8, top: 2.1 };
/** Living room into the back corridor. Clear of that wall's window, which ends at x 5.1. */
export const BACK_DOOR_E = { x: 7, z: LIVING.z1, half: 0.8, top: 2.1 };
/** The three doorways off the corridor's north side, which the corridor owns as one run. */
export const KITCHEN_DOOR = { x: -6, z: BACKHALL.z1, half: 0.7, top: 2.1 };
export const POOJA_DOOR = { x: 0, z: BACKHALL.z1, half: 0.7, top: 2.1 };
export const STORE_DOOR = { x: 6, z: BACKHALL.z1, half: 0.7, top: 2.1 };

// --- Basement wing ---
export const SHAFT = { x0: -13.8, x1: -9, z0: 0, z1: 2.6 };
export const BASEMENT = { x0: -22, x1: -13.8, z0: -2, z1: 6.6 };
export const RITUAL = { x0: -30, x1: -22, z0: -1, z1: 5.6 };
/**
 * Doorway at the bottom of the stairs, into the basement.
 *
 * 2.45 above the cellar floor rather than the 2.1 the ground-floor doors use, for the same reason
 * UPPER_DOOR stands at 2.5: this one sits where the stair's last two treads rise past it. The
 * controller's fall branch tests a sphere of the player's radius about the *eye* with no overhead
 * skip (FPController.collidesAabbAt), so a standing head reaches eye + 0.35 = feet + 2.05. On the
 * flat cellar floor that clears a 2.1 header by 5 cm, but the second-to-last tread (y −2.8, its east
 * edge at x −13.52) puts the head sphere's top at −0.75 while its west edge (−13.87) is still inside
 * the header's x span (−13.90 .. −13.70) — a 15 cm catch, felt as the face thudding the lintel on the
 * way down. At 2.45 the worst point clears by 20 cm, and 2.95 m of header still stands under the
 * shaft's 5.4 m top, so the way in reads as a doorway and not a hole punched in the wall.
 */
export const BASEMENT_DOOR = { x: -13.8, z: 1.3, half: 1.0, bottom: BASE_Y, top: BASE_Y + 2.45 };
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
 * The upper storey's own rear wing: three rooms south of the imported flat, at the flat's own level.
 *
 * This is where the request for rooms behind the two upper doors lands, and the reason it is *south* is
 * that the flat leaves exactly one usable side. Its north and east walls are `collideOnly` — the model
 * draws them, so an opening there would need a CarveBox through imported triangles the way UPPER_INNER
 * already does. Its south side, west of x 18.6, is a run this file draws itself, which means one
 * `openings` entry is the whole cut.
 *
 * Better still, that wall is the south wall of the *room the flat's front door opens into*. So the
 * chain reads: stair → door.glb → entry room → this wing, and the flat's east partition door
 * (door-inner.glb) continues into the rest of the flat. Both upper doors now have somewhere to go that
 * is not the room the player is already standing in.
 *
 * The doorway lands on the walkable strip at z -1.93 .. -0.99 that UPPER's floor rect already covers
 * and UPPER_PATCH already floors and ceils — the corner its own comment calls unreachable because a
 * wall stands on the -0.99 line. Opening that wall is what reaches it, so the flat's west run had to be
 * carried down from -0.99 to UPPER.z0 in the same change: without that the strip has no west wall and
 * the player walks out of the building at x 14.4.
 *
 * z -11.0 is the far edge. Nothing is under it (the ground floor stops at x 9 out here) and nothing is
 * over it, so the only constraint was keeping the shrine deep enough to read as a room rather than a
 * corridor at 10 m wide.
 */
export const UP_STORE = { x0: UPPER.x0, x1: 18.6, z0: -6.4, z1: UPPER.z0 };
export const UP_CHILD = { x0: 18.6, x1: UPPER.x1, z0: -6.4, z1: UPPER.z0 };
export const UP_SHRINE = { x0: UPPER.x0, x1: UPPER.x1, z0: -11.0, z1: -6.4 };

/** Ceiling height of the three, measured up from UP_Y. Under the flat's own 2.89 and out of its way. */
const UP_BACK_H = 2.7;

/**
 * The doorway from the entry room into the rear wing — and the reason it sits at the west end rather
 * than in the middle of its wall.
 *
 * It was at x 16.5, which put its clear span at 15.8 .. 17.2, straight across the stairwell (x 16.21 ..
 * 18.61). Two things were wrong with that, and both were reported before they were understood. A metre
 * of the doorway had no floor under it, so walking south through it dropped the player onto the flight;
 * and the wall's only opening stood over the very thing the wall is there to hide, so from the entry
 * room the doorway was a hole you looked through into the room below — which is the "pura wall nahi
 * hai". The user drew a rough wall over exactly that opening, and circled the floor west of it.
 *
 * At 15.0 the opening is 14.4 .. 15.6: the flat's own west end, where this wall meets `UPPER.x0`. That
 * span is real floor on both sides of the wall — `UPPER_PATCH`'s first rect floors x 14.4 .. 16.21 from
 * z 3.72 down to -1.93, and it is outside every hole in the collision table — so the chain stair →
 * door.glb → entry room → strip → rear wing is walkable end to end. The wall then runs solid from 15.6
 * east to 18.61, covering the well, which is the whole point of it.
 *
 * The west jamb is the flat's own west wall, so no piece of wall is left standing beside the opening:
 * `expandRun` drops the zero-width slice at the run's end and keeps the header over the doorway, which
 * is what stops the opening reading as a gap cut out of a wall. Every header here is 2.1 above the
 * floor, as everywhere else in the house except the two doors that stand where a stair's step-up fires.
 */
export const UP_BACK_DOOR = { x: 15.0, z: -0.99, half: 0.6, top: UP_Y + 2.1 };
export const UP_CHILD_DOOR = { x: UP_STORE.x1, z: -4.0, half: 0.7, top: UP_Y + 2.1 };
export const UP_SHRINE_DOOR = { x: 16.5, z: UP_STORE.z0, half: 0.7, top: UP_Y + 2.1 };

/**
 * The hidden door, in the wall between the nook and the flat's entry room.
 *
 * Found on the player's own coordinates rather than derived: they stood at (20.19, 4.18, −0.41) and
 * looked west, and the wall they were looking at is the `collideOnly` run at x 18.61, z −2.0 .. 0.6.
 * What reads as a plank door with a red square on it there is not a prop — it is painted into
 * `room-upper.glb`'s own texture (a scene-wide scan finds no red material anywhere, and hiding the
 * model removes it). So opening it means carving the panel, and the painted square goes with the
 * carve; nothing is rebuilt in its place.
 *
 * z −0.46 is the player's own line of sight, so the opening lands exactly where they were pointing.
 * `top` is 2.05 rather than the house's usual 2.1 for the reason `UPPER_INNER` is 2.2: this is a carve
 * through imported triangles, not a framed run, and it has to leave a lintel behind.
 */
export const UP_HIDDEN_DOOR = { x: 18.61, z: -0.46, half: 0.62, top: UP_Y + 2.05 };

/**
 * The same opening as a world box for CarveBox, 0.15 either side of the panel's centre so the panel
 * and any trim against it go with it — the shape `UPPER_INNER_CUT` already established.
 */
export const UP_HIDDEN_CUT = {
  x0: UP_HIDDEN_DOOR.x - 0.15,
  x1: UP_HIDDEN_DOOR.x + 0.15,
  y0: UP_Y + 0.02,
  y1: UP_HIDDEN_DOOR.top,
  z0: UP_HIDDEN_DOOR.z - UP_HIDDEN_DOOR.half,
  z1: UP_HIDDEN_DOOR.z + UP_HIDDEN_DOOR.half,
};

/**
 * The hidden room, in the empty volume **under** the upper storey.
 *
 * This is the only space attached to the door that costs nothing. The basement wing is 48 m west and
 * already holds three rooms; west of the door is the flat's own entry room; and the rear wing
 * (`UP_STORE` / `UP_CHILD` / `UP_SHRINE`) is south of the flat and would all have to move — which would
 * take `key-iron` and three doorways with it.
 *
 * Underneath is free because the ground floor only spans x −9 .. 9: nothing at all sits below the
 * upper storey out here, at any height. So a room can be built from y 0 up to the underside of the
 * upper floor with no hole in any other storey and no room moved.
 *
 * It reads as a cellar because it *is* one — the door opens onto a short flight of steps down — and
 * the story wants it: the lady's ritual is in the basement at the far end of the house, and the father
 * hid the mother's body behind the one door that woman could not open. Furthest from the ritual is the
 * whole point.
 */
/**
 * The hidden room's wall lines — the rectangle the four walls stand on.
 *
 * This is *not* the walkable floor; see `UP_HIDDEN_FLOOR` for that, and for why the two had to be
 * separated. Walls are thickened by WALL_T (0.2) about these lines, so the room's interior runs from
 * `x0 + 0.1` to `x1 - 0.1` and `z0 + 0.1` to `z1 - 0.1`.
 *
 * `z1` is 0.61 rather than a line flush with the entry room's own north wall at 0.49, and the
 * difference is the player's collider rather than aesthetics. The stairwell's northernmost walkable
 * line is the doorway's own edge, `UP_HIDDEN_DOOR.z + UP_HIDDEN_DOOR.half` = 0.16, which cannot move
 * because it *is* the width of the door. A 0.35 m cylinder standing on that line reaches z = 0.51.
 * So the north wall's inner face has to be at or beyond 0.51, which puts its centre-line at 0.61 and
 * its outer face at 0.71 — 0.12 m north of the entry room's wall. That 0.12 m is invisible: it sits
 * inside the wall thickness, above this room's ceiling, and the ceiling is level with the upper
 * storey's floor at 2.4 either way.
 *
 * At the original 0.4 the inner face was 0.30, well inside the player's reach from the doorway line,
 * which is what let them end up standing *inside* the wall and unable to leave — the reported trap.
 */
export const UP_HIDDEN = { x0: 15.6, x1: 21.6, z0: -6.2, z1: 0.61 };

/**
 * The room's interior floor, inset from the wall lines by half a wall thickness.
 *
 * Kept separate from `UP_HIDDEN` because `UP_HIDDEN` also places the walls, and a floor must never
 * extend under a wall. `groundYAt` reports the highest *walkable* surface under a point and knows
 * nothing about walls, so any floor rect reaching under one advertises "you may stand here" for a
 * strip that is solid. The player walks in, arrives already intersecting the wall box, and then
 * cannot leave in ANY direction — there is no approach to have stopped them and no face to slide
 * along, so every horizontal move is refused while the ground query keeps returning a floor. They
 * neither move nor fall. That is the trap, and the report of it was "jaise daldal" — like quicksand.
 *
 * Inset on all four sides, not just the north one. The first pass at this fixed the north wall only
 * and a sweep of the room still found sixteen trapped poses, all of them hugging the west wall at
 * x = 15.7 — the floor's `x0` was 15.6, the wall occupied 15.5..15.7, and the 0.1 m overlap was
 * enough to seat a 0.35 m cylinder inside it. A bug of this shape is a property of the floor rect
 * versus every wall, not of one wall, so it is fixed once for all of them: the floor is the wall
 * centre-line rectangle shrunk by HALF_T.
 *
 * Everything else about the room reads `UP_HIDDEN` — the walls themselves, the ceiling's extent, the
 * stairwell's own hole. Only the walkable floor uses this.
 */
export const UP_HIDDEN_FLOOR = {
  x0: UP_HIDDEN.x0 + HALF_T,
  x1: UP_HIDDEN.x1 - HALF_T,
  z0: UP_HIDDEN.z0 + HALF_T,
  z1: UP_HIDDEN.z1 - HALF_T,
};

/** Floor height of the hidden room. Below the upper storey and above nothing. */
export const UP_HIDDEN_Y = 0.2;

/** Ceiling height, measured up from `UP_HIDDEN_Y`. Under the upper storey's own 2.4. */
export const UP_HIDDEN_H = 2.2;

// --- The stair down to it ---
//
// Treads are floor rectangles and nothing else, exactly as both other stairs in the house are: the
// controller snaps to the highest surface under the player's feet, so a run of rects is a staircase
// without a single triangle of geometry, and a rise under the 0.35 m step-up means walking back up
// works too. See stairFloors for the same trick going down to the cellar.
const HID_STEP_COUNT = 8;
/** 2.2 m over eight steps. Under the step-up, so the climb back is walkable rather than a ladder. */
const HID_STEP_RISE = (UP_Y - UP_HIDDEN_Y) / HID_STEP_COUNT;
const HID_STEP_RUN = 0.22;

/**
 * The stairwell's footprint in the upper floor, and the hole that has to be left for it.
 *
 * This is the one number the whole arrangement hangs off. The entry room's floor is not the model's —
 * `room-upper.glb` is a cutaway diorama and leaves that room without a slab, which is what `UPPER_PATCH`
 * exists to draw. So the opening is made by **not drawing floor there**, not by carving: a CarveBox
 * would have had to cut imported triangles that are not present in the first place.
 *
 * z is the doorway's own span, so the hole is exactly the width of the door and reads as a threshold
 * rather than as a hole in a room. x runs west from the doorway for the stair's full 2.4 m of travel.
 */
/** West end of the flight itself: the bottom tread's far edge. The well starts further west, see below. */
export const HID_FLIGHT_X0 = UP_HIDDEN_DOOR.x - HID_STEP_RUN * HID_STEP_COUNT;

/**
 * Extra opening past the foot of the flight, so the west head wall stands back from the descent.
 *
 * With the well ending at the flight's own foot, the head wall's lower edge (the storey's slab, 2.4)
 * sat right over the bottom tread. A player on the third tread from the bottom has the eye at 2.45,
 * so the wall came at them at head height half a metre ahead — reported as the head hitting it.
 * 0.6 m back, the eye is under 2.2 before the wall is within reach, and the strip it opens is the
 * room below's own floor at 0.2, under its own 2.2 m ceiling line.
 */
const HID_HEADROOM = 0.6;

export const HID_STAIR_WELL = {
  x0: HID_FLIGHT_X0 - HID_HEADROOM,
  x1: UP_HIDDEN_DOOR.x,
  z0: UP_HIDDEN_DOOR.z - UP_HIDDEN_DOOR.half,
  z1: UP_HIDDEN_DOOR.z + UP_HIDDEN_DOOR.half,
};

/**
 * There used to be a second rectangle here — `HID_ROOM_HOLE`, the room's whole ceiling footprint —
 * listed alongside the well in the `upper` room's `floorHoles`, on the reasoning that the walkable
 * floor table and the visible floor could be decoupled: cut the collision wider than the drawn gap and
 * nothing is seen, because nothing is drawn for it.
 *
 * That reasoning is what broke the rear wing. `UPPER_PATCH` draws boards over x 14.4 .. 16.21 and over
 * the strip at z -1.93 .. -0.99 — the strip being the way in to `UP_STORE` and its neighbours — while
 * this second cut had removed the collision surface underneath them. The boards were a painted floor
 * over a 2.2 m drop, and the route into the wing fell through it. See the note on `floorHoles`.
 */

/**
 * The hidden stair as walkable rectangles, descending west from the doorway.
 *
 * Straight, not an L. An L was tried and removed: the turn bought nothing, because the visibility problem
 * is not the stair's shape but the *hole's* shape — and the hole is `HID_STAIR_WELL`, the only one the
 * storey has. Cutting it wider is what used to hide the room from above and what broke the way into the
 * rear wing; see the note on the `upper` room's `floorHoles`.
 *
 * Treads are rectangles and nothing else, exactly as both other stairs in the house are: the controller
 * snaps to the highest surface under the player's feet, so a run of rects is a staircase without a single
 * triangle of geometry, and a rise under the 0.35 m step-up means walking back up works too. `wood_stair.glb`
 * is placed to match these rects (see its ModelProps row) — the rects are what the player collides with, the
 * model is what they look at.
 */
export function hiddenStairFloors(): FloorRect[] {
  const out: FloorRect[] = [];
  for (let i = 0; i < HID_STEP_COUNT; i++) {
    // The last tread (i = 7) lands at exactly UP_HIDDEN_Y, the room's own floor height. That is not
    // a duplicate to be pruned — it is the bottom tread, and `groundYAt` returning the highest
    // surface makes it and the room floor interchangeable at the same height. Leaving it is correct:
    // the tread's footprint is the stair's own 1.24 m column, the room floor is the whole room, and
    // the two agreeing at 0.2 is what makes the descent land flush instead of ending on a step.
    //
    // Do NOT be tempted to "fix" the 0.475 reading at x = 16.8 by pruning treads. That is tread 6,
    // the second-to-last step, and 0.475 is the correct height for it: 2.4 - 0.275 * 7. It reads as
    // an island in a `groundYAt` table only because the table's x samples straddle the 0.3 m tread
    // run. A stair has steps in it; a step is not a bug.
    const x1 = UP_HIDDEN_DOOR.x - HID_STEP_RUN * i;
    out.push({
      x0: x1 - HID_STEP_RUN,
      x1,
      z0: UP_HIDDEN_DOOR.z - UP_HIDDEN_DOOR.half,
      z1: UP_HIDDEN_DOOR.z + UP_HIDDEN_DOOR.half,
      y: UP_Y - HID_STEP_RISE * (i + 1),
    });
  }
  return out;
}


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
 * The ceiling clears the model's own by 2 cm at 5.32. The upper room's default y1 stays at the
 * model's 5.29 line, but every procedural run bordering this patch names `UPPER_PATCH.ceilY` as its
 * top instead, so those missing-shell walls touch this ceiling rather than leaving a 3 cm slot.
 *
 * The floor used to clear it downward the same way, at UP_Y - 0.06, on the premise that the model's slab
 * under these rects sat at 2.35 and a level patch would z-fight it. Both halves of that were wrong, and
 * measurement is what says so. Exact downward rays (tools/_floor2.js) find *this patch* topmost over most
 * of the first room — the model brings nothing there, which is the whole reason the rect exists — and
 * where the model does reach in, its boards are at 2.371..2.397, not 2.35. So a patch at 2.34 z-fought
 * nothing; it simply stood 6 cm below the storey. Everything else on this floor is keyed to UP_Y: the
 * store, child and shrine slabs at 2.400, `upper-walls` and `upper-skirt` whose geometry *begins* at
 * 2.400, and the door casings' thresholds. Horizontal rays fired out of the room (tools/_gap.js) hit
 * nothing at all at 2.355/2.375/2.395 and the skirting at 2.425: below 2.400 the walls did not exist, so
 * the room had a 6 cm see-through slot round its whole perimeter and a 6 cm drop off every threshold. Seen
 * from a stand in the doorway with the head down that reads as a hard-edged brown band across the lower
 * frame whose shape changes with the angle — the artefact the user reported, and the second half of it
 * after the three ajar upper leaves came out of ModelProps.
 *
 * Hence 4 mm under UP_Y rather than level with it. Level would put the patch exactly coplanar with the
 * casing threshold's top face (0.59 m2 across the back doorway, tools/_gap.js section A) and with the
 * interior partitions' base caps; 4 mm is ~130x the depth buffer's resolution at this range so nothing
 * fights, it leaves the threshold reading correctly proud of the boards, it is over RISER_MIN so
 * findRisers still seals the doorway line, and it covers the model's low boards at 2.371..2.397 instead
 * of being covered by them, which is what makes the surface read as one floor.
 */
export const UPPER_PATCH = {
  floorY: UP_Y - 0.004,
  ceilY: UP_Y + 2.92,
  rects: [
    /**
     * The room the stair's door opens into, drawn around the stair's opening.
     *
     * It was a single rect from the model's cutaway edge to the partition doorway. The hidden room sits
     * under this patch, and because this patch *is* the floor, the opening is made by omission — the
     * pieces below leave exactly `HID_STAIR_WELL` undrawn, which is the same rectangle the walkable
     * floor is cut by. A CarveBox would have had to cut imported triangles that are not present in the
     * first place.
     *
     * The opening is the doorway's own column and nothing more: x 16.21..18.61 (the stair's 2.4 m of
     * travel) by z -1.08..0.16 (the door's 1.24 m). That is the whole point of the shape. An earlier
     * version cut x 15.6..18.61 by z -1.93..0.4 — a 3 m by 2.3 m pit sitting in the middle of the room
     * the player walks into, plainly visible from the doorway with the door shut. The user's report was
     * exactly that: "hidden toh lag hi nahi rha, 2nd floor pe aaya toh dikh jayega". The stair is
     * concealed by its own door now, not by being tucked behind one.
     *
     * The four pieces are the patch minus that rectangle; `HID_STAIR_WELL` is the rectangle itself and
     * is kept as the single source of truth for it, so this list cannot drift from `hiddenStairFloors`.
     */
    { x0: UPPER.x0, x1: HID_STAIR_WELL.x0, z0: UPPER.z0, z1: 3.72 },
    { x0: HID_STAIR_WELL.x1, x1: 19.9, z0: UPPER.z0, z1: 3.72 },
    { x0: HID_STAIR_WELL.x0, x1: HID_STAIR_WELL.x1, z0: HID_STAIR_WELL.z1, z1: 3.72 },
    { x0: HID_STAIR_WELL.x0, x1: HID_STAIR_WELL.x1, z0: UPPER.z0, z1: HID_STAIR_WELL.z0 },
    /**
     * The stair's own top step, covered in timber.
     *
     * The imported flight's top tread is drawn as bare `Base` geometry — a grey slab sitting at floor
     * level across the head of the well, with the timber treads only beginning below it. Seen from the
     * nook that reads as a patch of concrete laid into a wooden floor, which is what was reported:
     * a grey rectangle at the well's mouth with a wooden floor all round it.
     *
     * Drawn here rather than by changing the model because the patch is already the thing that covers
     * the imported flat's bare geometry, and it is visual only — `houseFloors` does not read this list,
     * so the walkable treads underneath are untouched and the descent is unchanged. The rect is the
     * top tread's own footprint, taken from the well rather than restated.
     */
    { x0: HID_STAIR_WELL.x1 - HID_STEP_RUN, x1: HID_STAIR_WELL.x1, z0: HID_STAIR_WELL.z0, z1: HID_STAIR_WELL.z1 },
    /** The small south-east room, walled off on its own and only ever seen through its doorway. */
    { x0: 21.05, x1: UPPER.x1, z0: UPPER.z0, z1: 0.55 },
  ],
};

/**
 * Where the player wakes: on the bedroom's imported bed, near its foot and clear of the curled cat. The
 * y here is the measured mattress (0.47 m) plus the standing eye height; HouseScene replaces it with the
 * model's exact fitted value as soon as bed.glb lands.
 *
 * x and z follow that bed. It stood against the west wall at -8.26 while HouseProps also built a
 * procedural bed in the middle of the room; the procedural one is gone, the imported one took its place,
 * and it has since been turned length-along-x back against the west wall (ModelProps' bed row). Its foot
 * end is the +x end at -6.75, so the spawn sits at x -7.0 — a quarter metre in from the foot edge — on
 * the bed's centre line at z 9.0. Everything tuned against the old (-6.2, 8.05) moves with it.
 *
 * yaw -0.30 points straight at the bedroom door from the new spot — the door is south-east of the bed
 * now, and atan2 of its offset is -0.30 — so the first frame immediately shows a way out of the room
 * rather than the headboard.
 */
export const SPAWN = { x: -7.0, y: 1.7, z: 9.0, yaw: -0.3 };

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

// No tread geometry for the cellar stair either, as upstairs: stair-wood.glb is the geometry (see the
// `stair-cellar.glb` row in ModelProps). stairFloors() above stays — the model's 0.75 m rise is more
// than the controller's step-up, so the walkable path remains the fifteen procedural steps.

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
      // North: was solid, and now carries the western way into the rear wing.
      {
        x1: BEDROOM.x0,
        z1: BEDROOM.z1,
        x2: BEDROOM.x1,
        z2: BEDROOM.z1,
        openings: [{ at: BACK_DOOR_W.x, half: BACK_DOOR_W.half, y1: BACK_DOOR_W.top }],
      },
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
      // North: the existing window at x 4, plus the eastern way into the rear wing. The door is at
      // x 7 rather than mirroring the bedroom's at x 5 because the window's opening already runs to
      // 5.1 and expandRun cuts openings in order — two that overlap would each eat the other's jamb.
      {
        x1: LIVING.x0,
        z1: LIVING.z1,
        x2: LIVING.x1,
        z2: LIVING.z1,
        openings: [
          { at: 4.0, half: 1.1, y0: 0.9, y1: 2.3 },
          { at: BACK_DOOR_E.x, half: BACK_DOOR_E.half, y1: BACK_DOOR_E.top },
        ],
      },
      { x1: LIVING.x1, z1: LIVING.z0, x2: LIVING.x1, z2: LIVING.z1 },
    ],
  },
  {
    id: 'backhall',
    name: 'Back Corridor',
    floorY: 0,
    height: WALL_H,
    floor: BACKHALL,
    ceiling: true,
    tone: 'plaster',
    // South side omitted on purpose: those are the bedroom's and living room's north runs above, and
    // they carry the two doorways. One wall, one collider, two rooms — the arrangement the hallway
    // already uses for the bedroom and living-room doors on the other side of the house.
    walls: [
      { x1: BACKHALL.x0, z1: BACKHALL.z0, x2: BACKHALL.x0, z2: BACKHALL.z1 },
      { x1: BACKHALL.x1, z1: BACKHALL.z0, x2: BACKHALL.x1, z2: BACKHALL.z1 },
      // The partition the three rooms open off, as one run with three openings. Leaves 2.3 m of wall
      // at each end and 4.6 m between doors, all well over WALL_MIN_RUN.
      {
        x1: BACKHALL.x0,
        z1: BACKHALL.z1,
        x2: BACKHALL.x1,
        z2: BACKHALL.z1,
        openings: [
          { at: KITCHEN_DOOR.x, half: KITCHEN_DOOR.half, y1: KITCHEN_DOOR.top },
          { at: POOJA_DOOR.x, half: POOJA_DOOR.half, y1: POOJA_DOOR.top },
          { at: STORE_DOOR.x, half: STORE_DOOR.half, y1: STORE_DOOR.top },
        ],
      },
    ],
  },
  {
    id: 'kitchen',
    name: 'Kitchen',
    floorY: 0,
    height: WALL_H,
    floor: KITCHEN,
    ceiling: true,
    tone: 'plaster',
    // Each of the three owns its west and north sides and shares its east with the next one along, so
    // the two partitions between them are written once. The corridor owns all three south sides.
    walls: [
      { x1: KITCHEN.x0, z1: KITCHEN.z0, x2: KITCHEN.x0, z2: KITCHEN.z1 },
      { x1: KITCHEN.x0, z1: KITCHEN.z1, x2: KITCHEN.x1, z2: KITCHEN.z1 },
      { x1: KITCHEN.x1, z1: KITCHEN.z0, x2: KITCHEN.x1, z2: KITCHEN.z1 },
    ],
  },
  {
    id: 'pooja',
    name: 'Prayer Room',
    floorY: 0,
    height: WALL_H,
    floor: POOJA,
    ceiling: true,
    tone: 'plaster',
    walls: [
      { x1: POOJA.x0, z1: POOJA.z1, x2: POOJA.x1, z2: POOJA.z1 },
      { x1: POOJA.x1, z1: POOJA.z0, x2: POOJA.x1, z2: POOJA.z1 },
    ],
  },
  {
    id: 'store',
    name: 'Store Room',
    floorY: 0,
    height: WALL_H,
    floor: STORE,
    ceiling: true,
    tone: 'plaster',
    walls: [
      { x1: STORE.x0, z1: STORE.z1, x2: STORE.x1, z2: STORE.z1 },
      { x1: STORE.x1, z1: STORE.z0, x2: STORE.x1, z2: STORE.z1 },
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
    // This room, the ritual room and the black magic room are seen from above through the bedroom's
    // west window; see RoomSpec.roof. The shaft needs none: its top, at 2.4, is above the window's eye.
    roof: true,
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
    roof: true,
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
    roof: true,
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
      // ends. That used to matter twice over, because the upper room was cellar-toned and this stair
      // plaster, so the overlap was a cross-material tie and those flicker; the upper room is plaster
      // now, so the tie would be invisible either way and this is kept only because abutting is the
      // cleaner join. wall[3] below and the upper room's wall above still overlap these by 0.1, so
      // nothing opens up.
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
      //
      // y1 stops 2 cm under UPPER_PATCH.floorY rather than on UP_Y. A run that ends at UP_Y caps
      // itself with an upward face at 2.4000 exactly, and this run crosses the whole of UPPER_DOOR —
      // so that cap was a 12 cm wide strip lying 4 mm above the flat's floorboards, straight across
      // the threshold the player walks in over, wearing world-anchored UVs stretched along a strip
      // too narrow to show a tile. Standing in the doorway it is the pale smeared band in the report.
      // Ending below the patch floor leaves the floorboards as the only surface there. 8 mm, not more:
      // the run's top face is what the shaft sees when you look up at the landing from the flight, so
      // every millimetre below the boards is a millimetre of slot up there. 8 is twice the clearance
      // the same trick already holds at UP_BACK_DOOR and small enough to read as the join it is.
      { x1: UP_SHAFT.x1, z1: UP_SHAFT.z0, x2: UP_SHAFT.x1, z2: UP_SHAFT.z1, y0: 0, y1: UPPER_PATCH.floorY - 0.008 },
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
    /**
     * Plaster, like every other room on this floor.
     *
     * This was 'cellar', which is the one thing on the upper storey that made it look broken. The tone
     * picks the wall material in HouseBuilder — 'cellar' means wallCool, i.e. the cool plaster map under
     * a 0x9aa0a8 tint — and it also gates the skirting, which is only laid where the tone is plaster. So
     * the two walls of this room the model leaves for us to draw came out smooth, blue-grey and bare at
     * the floor, and those two are precisely the ones the player meets first: the west wall is the way in
     * off the upper stair, and the south wall carries the door into the rear wing. Everything they abut —
     * upshaft on the other side of that west wall, and up-store / up-child / up-shrine through their
     * doorways — is plaster, warm, brick-patched and skirted. The join therefore read as a large dark
     * panel dropped into a warm room, appearing and disappearing as those walls came in and out of frame,
     * which is the "2nd floor ke kuch rooms me view glitch" in the report.
     *
     * Worth being clear about what this is not: not a depth-interpolation artefact and not a coplanar
     * sort flicker. Those were the metre-quad subdivision and the world-anchored UVs, both already in and
     * both measurably gone. This was only ever the wrong material on the wall.
     */
    tone: 'plaster',
    // The hidden room is under this room's floor, and the floor drawn over it is the floor the player
    // walks on. The two used to disagree, and everything else wrong in this corner came out of that.
    //
    // The visible floor is `UPPER_PATCH`: four rects, described there as "the patch minus
    // HID_STAIR_WELL". The walkable floor is this file's `houseFloors`, which subtracts whatever is
    // listed here. A second, *larger* rectangle used to be listed — the room's whole ceiling footprint,
    // x 15.6 .. 18.61 by z -1.93 .. 0.16 — and that made the boards over it a lie: `UPPER_PATCH` drew
    // boards across the strip that is the way into the rear wing, with no collision surface under them,
    // so a player taking that route fell through visible floor into the room below.
    //
    // Four 0.45 m kerbs were built to fence that lie, and the answer was to remove them: "player vo
    // dusre room me enter kaise karega" — how is the player supposed to get in. That was the right
    // call. The fence was treating the symptom; the lie was the disease, and one rectangle is the cure.
    //
    // With only the stairwell listed, the walkable floor and the drawn floor are the same rectangle by
    // construction: the strip is a real passage, and the well is the only hole in the storey. From
    // inside the room `groundYAt` still finds the room's own floor at 0.2 — the slab overhead is above
    // the reach of anyone standing under it, so it is never a stepping surface for them.
    floorHoles: [HID_STAIR_WELL],
    walls: [
      // --- The sides the model leaves open. It is a cutaway diorama: measured face by face, its
      // shell is missing its west side over the stair's half of the plan, and both outside walls
      // of the bathroom in its south-east corner. ---
      // West: the way in, and the only one of these the player ever sees. It starts at UPPER.z0 rather
      // than at the -0.99 line its own south wall stands on, because that south wall is now open — see
      // UP_BACK_DOOR. Without this extra 0.94 m the strip behind the new doorway has no west wall at
      // all and the player steps straight out of the building.
      //
      // Both drawn runs rise to UPPER_PATCH.ceilY rather than the room's default 5.29: they are the
      // walls beside the patch's missing ceiling, and stopping 3 cm short leaves the black/red sliver
      // across their tops that the user marked. The default remains for the runs against the model's
      // own 5.29 ceiling, where the imported shell is the surface that should be seen.
      {
        x1: UPPER.x0,
        z1: UPPER.z0,
        x2: UPPER.x0,
        z2: 3.6,
        y1: UPPER_PATCH.ceilY,
        openings: [{ at: UPPER_DOOR.z, half: UPPER_DOOR.half, y1: UPPER_DOOR.top }],
      },
      // South, west of where the model's own front wall starts — and now the door into the rear wing.
      //
      // It stops at the stairwell's west lip. It used to run on to 18.6, which put it straight across
      // the well 9 cm inside its south edge (the well is z -1.08..0.16), hanging from the slab line
      // 2.4 upward. Anyone climbing the flight south of its centre line had their capsule (eye + 0.35)
      // reach that line by the third tread, the vertical test refused the step, and the controller held
      // their height while they kept walking — feet frozen at 0.475, carried along under the flight and
      // out the other side. Over the well the storey is already fenced by the well's own south cheek at
      // z -1.18, so nothing is lost by stopping here.
      {
        x1: UPPER.x0,
        z1: -0.99,
        x2: HID_STAIR_WELL.x0,
        z2: -0.99,
        y1: UPPER_PATCH.ceilY,
        openings: [{ at: UP_BACK_DOOR.x, half: UP_BACK_DOOR.half, y1: UP_BACK_DOOR.top }],
      },
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

      // The nook's west wall, now carrying the hidden door's opening. `collideOnly` still — the model
      // draws the panel, and `openings` on a collideOnly run cuts the collider exactly as it cuts the
      // cross wall below, which is the precedent this follows.
      {
        x1: 18.61,
        z1: -2.0,
        x2: 18.61,
        z2: 0.6,
        openings: [{ at: UP_HIDDEN_DOOR.z, half: UP_HIDDEN_DOOR.half, y1: UP_HIDDEN_DOOR.top }],
        collideOnly: true,
      },
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
  {
    id: 'up-store',
    name: 'Attic Store',
    floorY: UP_Y,
    height: UP_BACK_H,
    floor: UP_STORE,
    ceiling: true,
    tone: 'plaster',
    // North side omitted: that is the way in, off the flat's own south wall through the strip at
    // z -1.93 .. -0.99 that UPPER already floors. This room owns both partitions off it.
    walls: [
      { x1: UP_STORE.x0, z1: UP_STORE.z0, x2: UP_STORE.x0, z2: UP_STORE.z1 },
      {
        x1: UP_STORE.x0,
        z1: UP_STORE.z0,
        x2: UP_STORE.x1,
        z2: UP_STORE.z0,
        openings: [{ at: UP_SHRINE_DOOR.x, half: UP_SHRINE_DOOR.half, y1: UP_SHRINE_DOOR.top }],
      },
      {
        x1: UP_STORE.x1,
        z1: UP_STORE.z0,
        x2: UP_STORE.x1,
        z2: UP_STORE.z1,
        openings: [{ at: UP_CHILD_DOOR.z, half: UP_CHILD_DOOR.half, y1: UP_CHILD_DOOR.top }],
      },
    ],
  },
  {
    id: 'up-child',
    name: "Child's Room",
    floorY: UP_Y,
    height: UP_BACK_H,
    floor: UP_CHILD,
    ceiling: true,
    tone: 'plaster',
    walls: [
      // North, only as far as x 20.97 — from there east the flat's own south run already stands on
      // this line (see the bathroom's two missing walls above), so carrying on would double it.
      { x1: UP_CHILD.x0, z1: UP_CHILD.z1, x2: 20.97, z2: UP_CHILD.z1 },
      { x1: UP_CHILD.x1, z1: UP_CHILD.z0, x2: UP_CHILD.x1, z2: UP_CHILD.z1 },
      { x1: UP_CHILD.x0, z1: UP_CHILD.z0, x2: UP_CHILD.x1, z2: UP_CHILD.z0 },
    ],
  },
  {
    id: 'up-shrine',
    name: 'Shrine Room',
    floorY: UP_Y,
    height: UP_BACK_H,
    floor: UP_SHRINE,
    ceiling: true,
    tone: 'plaster',
    // North side omitted: the two rooms above own it, and the store's run carries the only doorway.
    walls: [
      { x1: UP_SHRINE.x0, z1: UP_SHRINE.z0, x2: UP_SHRINE.x0, z2: UP_SHRINE.z1 },
      { x1: UP_SHRINE.x0, z1: UP_SHRINE.z0, x2: UP_SHRINE.x1, z2: UP_SHRINE.z0 },
      { x1: UP_SHRINE.x1, z1: UP_SHRINE.z0, x2: UP_SHRINE.x1, z2: UP_SHRINE.z1 },
    ],
  },
  {
    id: 'up-hidden',
    name: 'Hidden Room',
    floorY: UP_HIDDEN_Y,
    height: UP_HIDDEN_H,
    // The interior, not `UP_HIDDEN` — the floor stops at the inner face of the north wall so the
    // ground query never advertises a surface under it. See `UP_HIDDEN_FLOOR`.
    floor: UP_HIDDEN_FLOOR,
    /**
     * Its own ceiling, and it has to be its own — the alternative is a lid the player stands on.
     *
     * The first attempt omitted this on the reasoning that the upper storey's slab already covers the
     * room, so a plane here would be a duplicate surface and would cap the stairwell. That reasoning was
     * only half right, and the wrong half was the expensive one. The slab *did* cover the room, because
     * only the stairwell had been cut out of it — everything else north of the doorway line was still
     * solid at 2.4. So the "ceiling" was a walkable floor: the player came down the steps and stood on
     * it, and from underneath it read as a lid over the room.
     *
     * With the slab overhead, the room still needs a top of its own, and for a plainer reason than the
     * one the first attempt was avoiding: `UPPER_PATCH` is a single plane facing *up*, so from below it
     * is not a surface at all. Without a ceiling here the room was open to the storey's air and you
     * looked straight up into the entry room through the boards. It is drawn at `UP_HIDDEN_Y +
     * UP_HIDDEN_H` = 2.4, exactly level with the storey's own floor, so the two read as one structural
     * slab rather than as a room with a lid floating in it.
     *
     * Note the visible floor above is solid everywhere except `HID_STAIR_WELL`, so from above this
     * plane is not seen at all through the floor — it is what you see standing on the stair, looking
     * back up, and what stops the room being open to the sky. The stairwell itself is not capped: the
     * gap at 2.4 and the room's ceiling at 2.4 are the same line, and the top tread lands flush.
     *
     * It covers the room's whole rectangle, north edge included. Over the southern half the rear wing's
     * own floor lies at the same 2.4 and the two are coplanar — safe here because the wing's floor is
     * imported boards a few millimetres off 2.400 (see `UPPER_PATCH`'s note on 2.371..2.397), so the two
     * never share a depth. Drawing it only where the storey's floor is real would leave the room's south
     * edge open to the wing's floor joists from below.
     */
    ceiling: true,
    /**
     * The stairwell, left open in the ceiling as well as in the floor above it.
     *
     * This ceiling sits at 2.4, which is the upper storey's own floor line, and the upper slab has
     * `HID_STAIR_WELL` cut out of it — so from the entry room the well is a genuine opening you look
     * down through. The ceiling was a single uncut plane, so from the stair the same well was capped:
     * open from above, boarded from below, for one opening. Listing the well here makes both views
     * agree, and it is the same rectangle the floor above is cut by, so the two cannot drift.
     *
     * Nothing is lost by opening it: the well is a hole in the floor, so there is no surface above it
     * that this ceiling was protecting the player from seeing. The room's remaining ceiling still
     * covers everything else, which is what stops the room reading as open to the sky.
     */
    ceilingHoles: [HID_STAIR_WELL],
    walls: [
      { x1: UP_HIDDEN.x0, z1: UP_HIDDEN.z0, x2: UP_HIDDEN.x1, z2: UP_HIDDEN.z0 },
      { x1: UP_HIDDEN.x0, z1: UP_HIDDEN.z0, x2: UP_HIDDEN.x0, z2: UP_HIDDEN.z1 },
      { x1: UP_HIDDEN.x1, z1: UP_HIDDEN.z0, x2: UP_HIDDEN.x1, z2: UP_HIDDEN.z1 },
      { x1: UP_HIDDEN.x0, z1: UP_HIDDEN.z1, x2: UP_HIDDEN.x1, z2: UP_HIDDEN.z1 },
      /**
       * The stairwell, walled on all four sides — and fenced on none of the floor around it.
       *
       * The report was "stairwell ko chaaro taraf se cover karo": from the entry room the well was an
       * open shaft — a 2.4 x 1.24 m gap with the room the player had not found yet visible through it
       * — and from the stair itself there was nothing at all to either hand, so the flight read as
       * boards floating in a void. The four runs above are the *room's* walls; the well needed its own.
       *
       * Two rectangles were cut out of the upper storey's floor when these were built — `HID_STAIR_WELL`
       * and a larger collision-only one — so the list fenced every edge the two did not share. The
       * second cut is gone (see the `upper` room's `floorHoles`), which leaves the well as the only hole
       * in the storey. The east end is the doorway, so it is a threshold rather than an edge; the other
       * three are runs. The last of the three — the west lip, the head — was found after the other two,
       * standing on the landing and looking east: see below.
       *
       *   HID_STAIR_WELL   x 16.21..18.61, z -1.08..0.16. The floor gap that is *drawn*, and the column
       *                    the imported flight fills exactly (`hidden-stair.glb` is fitted to it).
       *   UP_Y             2.4, the storey above. Its floor line is where a rise has to start.
       *
       * - **North, the parapet.** The well's north lip at `HID_STAIR_WELL.z1 + HALF_T` = 0.26, rising to
       *   `UP_Y` + 0.45. The 0.45 is load-bearing: it is over the controller's 0.35 m step-up, so nobody
       *   walks up onto it, and `groundYAt` reads `FloorRect`s only, so its top is not a surface at all.
       *   A player is stopped by its side — which is what a parapet is for. It is also what answers the
       *   original report from the entry room's side: below 2.85 the well is open, and above it the flat's
       *   south wall carries on to the storey's ceiling, so the only way to see down the well is to stand
       *   at the lip and look over it.
       * - **South, the cheek.** The well's south lip at `HID_STAIR_WELL.z0 - HALF_T` = -1.18, the same
       *   16.21..18.61 and the same height. Downward it is the wall the flight descends against, seen from
       *   the room; upward it is the 0.45 m cheek on the store's side of the well, which is what stops the
       *   well's south edge reading as the edge of a stage from the rear wing.
       *
       * Both runs take the room's own floor (0.2) as their base rather than `UP_Y`. They are drawn from
       * inside the room as much as from the storey, and a run starting at 2.4 would leave 0.1 m of bare
       * floor at its foot, because the skirting pass only reaches runs that touch the room's own floor.
       * Neither is `modelCollision`, so the shell draws both and the AABBs that stop the player are the
       * ones the shell draws — the bargain every other room's runs make.
       */
      /**
       * North wall of the stairwell carried to the flat's ceiling.
       */
      { x1: HID_STAIR_WELL.x0, z1: HID_STAIR_WELL.z1 + HALF_T, x2: HID_STAIR_WELL.x1, z2: HID_STAIR_WELL.z1 + HALF_T, y1: UPPER_PATCH.ceilY },
      /**
       * South wall / cheek of the stairwell:
       * - From x = 17.07 (HID_STAIR_WELL.x0 + HID_STEP_RUN) to HID_STAIR_WELL.x1 (18.61):
       *   Full height wall along the south flank to close the open side under the elevated treads (treads 0-6),
       *   preventing players from walking into the side or underneath of the stairs from the hidden room.
       * - From x = HID_STAIR_WELL.x0 to 17.07:
       *   Leaves the ground level (y < 2.4) open so the player can enter/exit Tread 7 (at y = 0.20) into the hidden room,
       *   while fencing the upper storey (y0 = UP_Y) so players upstairs cannot fall into the well.
       */
      // The split is at the bottom tread's east edge (HID_FLIGHT_X0 + run), not the well's west end:
      // the well now reaches HID_HEADROOM past the flight, and all of that is open floor below.
      { x1: HID_FLIGHT_X0 + HID_STEP_RUN, z1: HID_STAIR_WELL.z0 - HALF_T, x2: HID_STAIR_WELL.x1, z2: HID_STAIR_WELL.z0 - HALF_T, y1: UPPER_PATCH.ceilY },
      { x1: HID_STAIR_WELL.x0, z1: HID_STAIR_WELL.z0 - HALF_T, x2: HID_FLIGHT_X0 + HID_STEP_RUN, z2: HID_STAIR_WELL.z0 - HALF_T, y0: UP_Y, y1: UPPER_PATCH.ceilY },
      /**
       * **West, the head.** The well's west lip at `HID_STAIR_WELL.x0` = 16.21, closed from the
       * storey's own floor line up to eye height. The third of the four sides, and the one the two
       * runs above cannot cover.
       *
       * Look north or south at the well and the long runs are between the eye and the flight, which is
       * what a parapet is for. Look along it from the west and there is nothing between the eye and the
       * flight at all, because the flight descends *away* from this end: tread 0, the top, is the far end
       * of the column (18.31..18.61 at 2.125) and tread 7, the bottom, is the near one (16.21..16.51 at
       * 0.2, level with the room below). So the storey's floor edge was a brow over 2.4 m of open flight,
       * and from the landing one was looking up the run of it.
       *
       * The parapet cannot cover this and neither can the flat's own runs. From the reported stance
       * (14.91, 4.10, 0.46) — 1.3 m west of the lip, 0.2 m north of the parapet's line — the sightline to
       * the middle of the top tread, (18.46, 2.15, −0.46), crosses the parapet's own line z = 0.26 at
       * x = 15.68, which is *west* of where the parapet begins (16.21). What the view goes over is the
       * lip itself. The rays leaving that stance for the five upper treads cross this wall's plane at
       * 3.44 m down to 2.54 m — 1.04 m above the storey's floor down to 0.14 m — and every tread below
       * those is already occluded by the floor slab, which is why the flight showed and the room below
       * did not.
       *
       * Measured before it was built (`tools/_wellsight.mjs 5174 14.91 4.1 0.46 1.67`, which raycasts at
       * the well's own surfaces rather than at a screen grid): six of the twelve sample surfaces inside
       * the well were visible — the five upper treads, and the flight likewise stopped the ray aimed at
       * the room below's floor. After: none, from that stance, from 2.6 m further back (13.61) and from
       * a stance south of the well (14.91, −1.60). The pressed stance (15.76, 0.35 m from this face) is
       * *not* among them: it sits inside `look()`'s own 0.5 m ray offset, so no ray can test it — see
       * the north end below for what that offset did when it was missed.
       *
       * 1.7 over the floor, i.e. a top at 4.10, the standing eye height. The arithmetic asks for less:
       * the binding surface is the top of the flight where it meets the storey's floor line at the far
       * end (18.61, 2.4), and a ray to it crosses this wall's face at 3.89 from the closest stance the
       * wall allows, 3.55 from 1.3 m back and 3.25 from 3 m back — 1.49, 1.15 and 0.85 m of wall. But
       * that answer is arithmetic about `hiddenStairFloors`, and the flight that is drawn is a fitted
       * model a few centimetres off those rects. Eye height makes the guarantee structural instead, and
       * free of both the model's fit and the stance: a ray that clears a top at eye level is level or
       * rising where it crosses, and a straight ray that is level or rising there never comes back down
       * to a well lying entirely below the storey's floor. It holds for the crouched eye too (1.1, so
       * 3.5) because that eye is lower still. 0.21 m of extra wall buys all of that, inside an enclosure
       * nobody can see into.
       *
       * Two runs rather than one, and the split is the descent. A walker on the hidden flight passes
       * *under* this wall, and the moving test inflates their capsule by its radius both ways — 1.7 of
       * eye and 0.35 of it, so the box a step down is refused by reaches eye + 0.35, and a walker
       * *falling* a step is a step above the tread under them while they do. Inside this head's own
       * 0.55 m of reach that puts a running descent's feet at 1.025 at most, i.e. 3.075 at the top of its
       * capsule. Measured with `tools/_wellwalk.mjs` — which names the box that holds the walker, not just
       * that it is held: a collider based at `UP_Y + 0.13` held the descent at feet 0.635 from x 16.65 to
       * 16.07 and the room's own floor was never reached. `collidesAabb`, the horizontal test, skips that
       * same box — it compares the top against the eye and not the capsule — which is exactly why walking
       * in never showed it.
       *
       * So the wall is drawn `drawOnly` down to the floor line, where nothing is seen through it, and its
       * collider is the `collideOnly` twin beside it, based at `UP_Y + 0.8` = 3.2. That is inside a window
       * with two ends, and both are tested: above 3.075 so no pose the descent passes under is refused,
       * and below the crouched eye the storey itself can put at this lip (2.4 + 1.1 = 3.5), because a
       * collider based higher would let a crouched player walk out over the well — the one thing the
       * parapet's own 0.45 is there to prevent. 3.2..4.1 still covers the storey's standing band
       * (2.4..4.1) and its crouched one (2.4..3.5), and still reads as an obstacle to the nav bake: 0.8
       * under the storey's 1.9 m of headroom, and 3.0 above the room below's floor, past its own.
       *
       * The base is `UP_Y` rather than the room's own floor like the two runs above, and that leaves the
       * stair's foot and the room below as they were: the flight's bottom tread is at 0.2, the collider
       * starts above the capsule of anyone walking under it, and the room's ceiling hole is this same
       * rectangle — so from the room the wall's foot lands on the hole's west edge and the two read as one
       * line rather than as a wall floating over a ledge.
       *
       * **The north end, and the reading that once put a longer one there.** This run ends at
       * `z1 + HALF_T` = 0.26 like the collider twin beside it, and `segmentBox` pads both by `WALL_T/2`,
       * so the drawn face and the collider stop at z 0.36 together — the face of the flat's south wall.
       * For a while it ended at `z1 + 2 * HALF_T`, on the strength of a reading taken from the *pressed*
       * stance (15.76, 4.10, 0.46): that reading said the drawn edge stopped at 0.31 and a ray crossing
       * 0.03 m north of it slipped through to the flight.
       *
       * It was an artifact of the probe and not a gap. `handles.look()` fires from
       * `camera.position + 0.5 * dir` — offset to clear the lantern, the arm and the fist, which are
       * children of the camera — so from a stance 0.35 m from this face the ray *starts* 0.15 m past it,
       * and nothing that close can be tested with that tool at all. What those rows hit was the geometry
       * *behind* the wall. Level rays from x 15.2 — 0.91 m of clearance, and pitch 0, so no aim to get
       * wrong either — put the face at z 0.20..0.34 with the run ending at 0.36: 0.34 is the last hit
       * inside, 0.36 grazes the corner, and 0.38 on lands on the imported model beyond. That is the box
       * `segmentBox` builds from this run, with no shortfall to make up.
       *
       * Re-measured after the run was cut back: 0 of the 12 sample surfaces are visible from the landing
       * (14.91, the reported stance, 1.2 m back), from 13.61 (2.6 m back) or from south of the well
       * (14.91, −1.60). North of this face the slot between its own end (0.36) and the room's north wall
       * (0.51) is over the storey's floor slab rather than over the well — the storey's hole is the well,
       * z −1.08..0.16 — so a ray crossing the plane above 0.36 has solid floor beneath it and cannot come
       * down the shaft. `tools/_wellsight.mjs` and `tools/_wellcorner.mjs` now name this blind spot when a
       * sample falls inside it, instead of reporting what the ray found behind the wall as a sighting.
       */
      /**
       * West head of the stairwell, extended to the flat's ceiling as well.
       *
       * It stopped at eye height (4.10) because that was enough to hide the flight from the
       * landing — but the user asked for walls that touch the ceiling, and above 4.10 the shaft
       * was open again. The drawn run now reaches `UPPER_PATCH.ceilY` (5.32) like the north and
       * south lips.
       *
       * The `collideOnly` twin keeps its 3.2 base — that window is load-bearing for the descent
       * (see above) — and only its top moves to the ceiling. A higher top cannot refuse any pose
       * the lower one already allowed: the walker's capsule sits under 3.2 while descending, and
       * the storey's own band (2.4..4.1) is entirely below 5.32.
       */
      { x1: HID_STAIR_WELL.x0, z1: HID_STAIR_WELL.z0 - HALF_T, x2: HID_STAIR_WELL.x0, z2: HID_STAIR_WELL.z1 + HALF_T, y0: UP_Y, y1: UPPER_PATCH.ceilY, drawOnly: true },
      { x1: HID_STAIR_WELL.x0, z1: HID_STAIR_WELL.z0 - HALF_T, x2: HID_STAIR_WELL.x0, z2: HID_STAIR_WELL.z1 + HALF_T, y0: UP_Y + 0.8, y1: UPPER_PATCH.ceilY, collideOnly: true },
    ],
    tone: 'plaster',
  },
];

/** Every walkable surface in the house: room floors plus both stairs' treads. */
/**
 * `outer` with `hole` taken out of it, as up to four rectangles.
 *
 * The pieces that would be zero-width are dropped rather than emitted: a degenerate rect still matches
 * `x >= f.x0 && x <= f.x1`, so a sliver would hand `groundYAt` a floor at a height it should not have.
 */
export function subtractRect(outer: Rect, hole: Rect): Rect[] {
  // No overlap at all: the hole is somewhere else entirely.
  if (hole.x1 <= outer.x0 || hole.x0 >= outer.x1 || hole.z1 <= outer.z0 || hole.z0 >= outer.z1) {
    return [outer];
  }
  const out: Rect[] = [];
  const push = (x0: number, x1: number, z0: number, z1: number): void => {
    if (x1 - x0 > 1e-6 && z1 - z0 > 1e-6) out.push({ x0, x1, z0, z1 });
  };
  const cx0 = Math.max(outer.x0, hole.x0);
  const cx1 = Math.min(outer.x1, hole.x1);
  const cz0 = Math.max(outer.z0, hole.z0);
  const cz1 = Math.min(outer.z1, hole.z1);
  push(outer.x0, cx0, outer.z0, outer.z1); // west of the hole
  push(cx1, outer.x1, outer.z0, outer.z1); // east of it
  push(cx0, cx1, outer.z0, cz0); // south of it, within the hole's columns
  push(cx0, cx1, cz1, outer.z1); // north of it
  return out;
}

export function houseFloors(): FloorRect[] {
  const out: FloorRect[] = [];
  for (const r of ROOMS) {
    if (r.id === 'shaft') continue;
    let rects: Rect[] = [r.floor];
    for (const hole of r.floorHoles ?? []) rects = rects.flatMap((q) => subtractRect(q, hole));
    for (const q of rects) out.push({ ...q, y: r.floorY });
  }
  return [...out, ...stairFloors(), ...upStairFloors(), ...hiddenStairFloors()];
}
