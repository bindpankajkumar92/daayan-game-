/**
 * HouseProps — the furniture and dressing, and the surfaces the clues lie on.
 *
 * Two jobs, and they are the same job. The brief (§8) forbids glowing puzzle objects and quest
 * markers, which means a readable note has to be findable *because of where it is* — weighted
 * under a cup on the dining table, pinned beside the gate, nailed up next to the panel it
 * describes. So the furniture is not decoration that happens to be near the clues; the furniture
 * is what makes the clues discoverable at all, and the two get built together here.
 *
 * Everything in this file is static and merged by material. Anything that moves is built by
 * Fixtures instead. Positions that both this file and the scene need — the dressing table and the
 * box on it, the workbench and the panel beside it — live in PLACE so they cannot drift apart.
 */

import { BoxGeometry, Group, Vector3, type BufferGeometry } from 'three';
import { Batch } from './Batch';
import { SHADOW_LIFT, shadowQuad } from './ContactShadow';
import { aabbOf, type FixtureMats } from './Fixtures';
import { BASE_Y } from './HouseLayout';
import type { AABB } from '@/player/FPController';

/** Shared placements. The scene puts fixtures here; this file builds what they stand on. */
export const PLACE = {
  /** Bedroom strongbox — rests on the dressing table top, front face toward +z. */
  codeBox: { x: -7.4, y: 0.76, z: 3.0 },
  /** Stopped clock, on the wall directly above the box. */
  clock: { x: -7.4, y: 1.92, z: 2.72 },
  /** Basement breaker panel on the south wall; its hatch sits 0.95 m to the +x side. */
  breaker: { x: -19.5, y: -1.55, z: -1.86 },
  /** Shelf against the basement's west wall, standing over the ritual doorway. */
  shelf: { x: -21.55, z: 2.3 },
  /** Altar, broadside to the door so all four symbols are visible on entering. */
  altar: { x: -26.8, z: 2.3 },
} as const;

export interface HouseProps {
  group: Group;
  aabbs: AABB[];
  /** Where each readable thing is, keyed by its id in CLUES. */
  anchors: Record<string, Vector3>;
  /** Merged buffers, for the scene's dispose path. */
  geos: BufferGeometry[];
}

/** A slab on four legs. Used for every table in the house; the proportions are all that change. */
function table(b: Batch, m: FixtureMats, x: number, z: number, w: number, d: number, topY: number, footY: number): void {
  b.box(m.wood, w, 0.05, d, x, topY - 0.025, z);
  const ix = w / 2 - 0.07;
  const iz = d / 2 - 0.07;
  for (const dx of [-ix, ix]) {
    for (const dz of [-iz, iz]) {
      b.box(m.wood, 0.06, topY - 0.05 - footY, 0.06, x + dx, (topY - 0.05 + footY) / 2, z + dz);
    }
  }
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

type Ctx = { b: Batch; m: FixtureMats; aabbs: AABB[]; at: Record<string, Vector3> };

// --- Hall ------------------------------------------------------------------------------------

/**
 * The hall. The gate is here, so this room's job is to be the place the player keeps coming back
 * to — which means it must stay legible in the dark and must not hide anything. Two clues, both
 * at eye height on the way in.
 */
function hall({ b, m, aabbs, at }: Ctx): void {
  // Runner, and boot scuffs worn into the boards in front of the gate. Eleven people walked in.
  b.box(m.cloth, 2.0, 0.02, 3.6, 0, 0.011, -3.4);
  b.ring(m.dark, 0.9, 1.35, 14, 0, 0.013, -6.0, Math.PI * 0.15, Math.PI * 0.7);

  // The pinned notice, beside the gate at the height of a face.
  sheet(b, m, 1.9, 1.45, -6.86, 0.3, 0.4, 'z');
  b.box(m.iron, 0.02, 0.02, 0.02, 1.9, 1.62, -6.83);
  at['hall.notice'] = new Vector3(1.9, 1.45, -6.6);

  // Coat pegs, and one good coat still hanging. Nobody who owned it left.
  b.box(m.wood, 0.05, 0.08, 1.3, 4.86, 1.85, -2.2);
  for (const pz of [-2.7, -2.35, -2.0, -1.65]) b.cyl(m.brass, 0.016, 0.016, 0.1, 5, 4.8, 1.82, pz, 'x');
  b.box(m.cloth, 0.16, 0.95, 0.42, 4.76, 1.28, -2.5);

  frame(b, m, 4.87, 1.68, -3.6, 0.5, 0.62, 'x', -1);
  at['hall.photo'] = new Vector3(4.58, 1.68, -3.6);

  table(b, m, -4.6, -3.0, 0.5, 1.3, 0.76, 0);
  aabbs.push(aabbOf(-4.6, 0, -3.0, 0.26, 0.66, 0.76));
  // A dead oil lamp. The house has not had working light in a long time.
  b.cyl(m.brass, 0.09, 0.11, 0.1, 8, -4.6, 0.81, -3.3);
  b.cyl(m.dark, 0.06, 0.08, 0.18, 8, -4.6, 0.95, -3.3);

  b.cyl(m.dark, 0.13, 0.15, 0.56, 8, -4.5, 0.28, -1.3);
  for (const t of [0.2, -0.1, 0.35]) b.cyl(m.wood, 0.014, 0.014, 0.8, 4, -4.5 + t * 0.1, 0.62, -1.3 + t * 0.1);
}

// --- Hallway ---------------------------------------------------------------------------------

/** The corridor. Deliberately bare: it is a junction, and a junction with clues in it is a maze. */
function hallway({ b, m, aabbs }: Ctx): void {
  // Runner, down the length of the corridor. The corridor runs along x, so 15.6 is its x extent —
  // as w and d it was 15.6 m of cloth laid *across* the house, through two walls and over the
  // hall's own runner at the same height.
  b.box(m.cloth, 15.6, 0.02, 1.1, 0, 0.011, 1.3);

  b.box(m.wood, 1.6, 0.06, 0.36, 0, 0.44, 2.28);
  for (const dx of [-0.72, 0.72]) {
    for (const dz of [-0.13, 0.13]) b.box(m.wood, 0.07, 0.41, 0.07, dx, 0.215, 2.28 + dz);
  }
  aabbs.push(aabbOf(0, 0, 2.28, 0.82, 0.2, 0.47));

  // Sconces, cold. They are here so the darkness reads as a failure rather than a style.
  for (const sx of [-2.8, 2.8]) {
    b.box(m.iron, 0.1, 0.16, 0.08, sx, 2.0, 2.46);
    b.cyl(m.dark, 0.05, 0.03, 0.12, 6, sx, 2.14, 2.42);
  }

  // Crates at the far end, stacked by someone who did not expect to move them again. Against the
  // north wall rather than mid-corridor: the east end wall is now the door to the upper stair, and
  // in the middle of the floor these left a 0.66 m gap south of them and 0.30 m north, which is a
  // door the player can see and not reach. 2.15 keeps the deeper crate 5 cm off the wall face.
  b.box(m.wood, 0.6, 0.58, 0.6, 7.9, 0.29, 2.15);
  b.box(m.wood, 0.52, 0.5, 0.52, 7.85, 0.83, 2.09, 0.3);
  aabbs.push(aabbOf(7.88, 0, 2.13, 0.32, 0.32, 1.08));
}

// --- Bedroom ---------------------------------------------------------------------------------

/**
 * The bedroom, and Puzzle 2's clue chain.
 *
 * The dressing table stands against the south wall with the box on it and the stopped clock hung
 * on the wall directly above, so the puzzle and the number it wants are in one glance — that is
 * §9's "minimal backtracking" taken literally. The diary that explains the connection is
 * deliberately *not* on that table: it is across the room by the bed, where somebody would
 * actually have written it. The player has to walk the room once. That is exploration; making
 * them walk to another floor for it would be backtracking.
 *
 * Nothing is spread further than one room. Two objects on the same table would also fight each
 * other for the interaction pick, and the box must always win at the box.
 */
function bedroom({ b, m, aabbs, at }: Ctx): void {
  const P = PLACE.codeBox;
  table(b, m, P.x, 2.98, 1.5, 0.52, P.y, 0);
  aabbs.push(aabbOf(P.x, 0, 2.98, 0.76, 0.27, P.y));
  candle(b, m, P.x - 0.58, P.y + 0.01, 2.92, 0.11);
  at['bedroom.clock'] = new Vector3(PLACE.clock.x, PLACE.clock.y, PLACE.clock.z + 0.1);

  // Bed. Made, and not slept in — the coverlet is flat and the pillow has no dent.
  b.box(m.wood, 1.5, 0.2, 2.1, -6.2, 0.28, 8.3);
  for (const dx of [-0.68, 0.68]) {
    for (const dz of [-0.98, 0.98]) b.box(m.wood, 0.09, 0.18, 0.09, -6.2 + dx, 0.09, 8.3 + dz);
  }
  b.box(m.cloth, 1.44, 0.2, 2.02, -6.2, 0.48, 8.3);
  b.box(m.paper, 0.62, 0.13, 0.34, -6.2, 0.64, 9.14);
  b.box(m.wood, 1.5, 0.9, 0.08, -6.2, 0.83, 9.41);
  aabbs.push(aabbOf(-6.2, 0, 8.3, 0.76, 1.08, 0.58));

  // Wardrobe against the east wall, doors shut.
  b.box(m.wood, 0.62, 2.05, 1.5, -1.45, 1.025, 6.6);
  for (const dz of [-0.36, 0.36]) b.box(m.door, 0.03, 1.86, 0.7, -1.75, 1.02, 6.6 + dz);
  b.cyl(m.brass, 0.016, 0.016, 0.06, 5, -1.78, 1.02, 6.6, 'x');
  aabbs.push(aabbOf(-1.45, 0, 6.6, 0.33, 0.76, 2.05));

  // Bedside table: the diary page, and a candle burned down to nothing.
  table(b, m, -4.7, 9.3, 0.46, 0.46, 0.56, 0);
  candle(b, m, -4.62, 0.57, 9.42, 0.05);
  sheet(b, m, -4.74, 0.575, 9.24, 0.24, 0.3, 'flat', 0.18);
  at['bedroom.diary'] = new Vector3(-4.74, 0.66, 9.24);
  aabbs.push(aabbOf(-4.7, 0, 9.3, 0.24, 0.24, 0.56));

  // The window seat. A photograph left face down on the sill, which is a thing people do.
  sheet(b, m, -8.82, 1.035, 6.0, 0.2, 0.26, 'flat', 0.1);
  at['bedroom.photo'] = new Vector3(-8.72, 1.1, 6.0);

  b.box(m.cloth, 2.4, 0.02, 2.8, -5.0, 0.011, 6.2);

  // A chair pulled out and left at an angle, under the window.
  b.box(m.wood, 0.44, 0.05, 0.44, -8.1, 0.45, 5.4, 0.4);
  b.box(m.wood, 0.44, 0.5, 0.05, -8.1, 0.72, 5.62, 0.4);
  for (const dx of [-0.17, 0.17]) {
    for (const dz of [-0.17, 0.17]) b.box(m.wood, 0.05, 0.43, 0.05, -8.1 + dx, 0.215, 5.4 + dz);
  }
  aabbs.push(aabbOf(-8.1, 0, 5.4, 0.26, 0.26, 0.5));
}

// --- Living room -----------------------------------------------------------------------------

/**
 * The living room. The brief asks this one to "primarily build curiosity", so nothing here is a
 * puzzle and nothing here is a key — it is three documents that each say something is wrong with
 * the arithmetic of this house, and a fireplace to read them by.
 */
function living({ b, m, aabbs, at }: Ctx): void {
  // Fireplace and mantelpiece. The four photographs stand on the shelf in their four frames.
  b.box(m.wood, 0.36, 1.15, 2.1, 8.72, 0.575, 6.0);
  b.box(m.dark, 0.3, 0.72, 1.12, 8.8, 0.42, 6.0);
  b.box(m.wood, 0.46, 0.07, 2.24, 8.67, 1.185, 6.0);
  const frames: Array<[number, number, number]> = [[5.12, 0.24, 0.3], [5.68, 0.22, 0.27], [6.32, 0.26, 0.32], [6.88, 0.2, 0.25]];
  for (const [fz, fw, fh] of frames) frame(b, m, 8.62, 1.22 + fh / 2, fz, fw, fh, 'x', -1);
  at['living.mantel'] = new Vector3(8.32, 1.36, 6.0);
  aabbs.push(aabbOf(8.72, 0, 6.0, 0.19, 1.13, 1.25));
  // Cold ash, and one log that was never burned.
  b.box(m.dark, 0.24, 0.05, 0.9, 8.8, 0.09, 6.0);
  b.cyl(m.wood, 0.07, 0.08, 0.5, 6, 8.78, 0.16, 6.1, 'z');

  // Armchair, facing the fire. Worn on the arms and nowhere else.
  b.box(m.cloth, 0.84, 0.16, 0.86, 6.7, 0.44, 4.7);
  b.box(m.cloth, 0.16, 0.72, 0.86, 6.32, 0.72, 4.7);
  for (const dz of [-0.43, 0.43]) b.box(m.cloth, 0.8, 0.2, 0.14, 6.74, 0.62, 4.7 + dz);
  for (const dx of [-0.34, 0.34]) {
    for (const dz of [-0.36, 0.36]) b.box(m.wood, 0.07, 0.36, 0.07, 6.7 + dx, 0.18, 4.7 + dz);
  }
  aabbs.push(aabbOf(6.7, 0, 4.7, 0.46, 0.48, 0.82));

  // The ledger, open on the little table where she left off counting.
  table(b, m, 6.7, 3.6, 0.5, 0.5, 0.6, 0);
  b.box(m.door, 0.32, 0.045, 0.26, 6.7, 0.623, 3.6, -0.14);
  sheet(b, m, 6.7, 0.648, 3.6, 0.3, 0.24, 'flat', -0.14);
  at['living.ledger'] = new Vector3(6.7, 0.72, 3.6);
  aabbs.push(aabbOf(6.7, 0, 3.6, 0.26, 0.26, 0.6));

  // Dining table, one chair, and the shopping list weighted down with a cup.
  table(b, m, 2.0, 8.4, 1.1, 1.7, 0.74, 0);
  aabbs.push(aabbOf(2.0, 0, 8.4, 0.56, 0.86, 0.74));
  sheet(b, m, 2.0, 0.745, 7.94, 0.26, 0.32, 'flat', 0.08);
  b.cyl(m.paper, 0.045, 0.038, 0.08, 8, 2.04, 0.79, 7.9);
  at['living.list'] = new Vector3(2.0, 0.83, 7.94);
  b.box(m.wood, 0.44, 0.05, 0.44, 2.0, 0.45, 7.1);
  b.box(m.wood, 0.44, 0.52, 0.05, 2.0, 0.73, 6.89);
  for (const dx of [-0.17, 0.17]) {
    for (const dz of [-0.17, 0.17]) b.box(m.wood, 0.05, 0.43, 0.05, 2.0 + dx, 0.215, 7.1 + dz);
  }
  aabbs.push(aabbOf(2.0, 0, 7.05, 0.26, 0.3, 0.5));

  b.box(m.cloth, 2.8, 0.02, 2.8, 6.2, 0.011, 5.0);

  // Standing lamp, cold like everything else.
  b.cyl(m.iron, 0.02, 0.02, 1.55, 6, 8.2, 0.79, 8.8);
  b.cyl(m.iron, 0.16, 0.18, 0.03, 8, 8.2, 0.02, 8.8);
  b.cyl(m.cloth, 0.17, 0.13, 0.24, 8, 8.2, 1.66, 8.8);
}

// --- Stair shaft -----------------------------------------------------------------------------

/** The stair down. A handrail, because a 3 m drop with no rail reads as a hole, not a stair. */
function shaft({ b, m }: Ctx): void {
  const rail = new BoxGeometry(5.0, 0.05, 0.05);
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
 * The shelf against the west wall is the other thing this room does, and the only help it gets is
 * geometry and a scuff on the floor.
 */
function basement({ b, m, aabbs, at }: Ctx): void {
  const P = PLACE.breaker;

  // The diagram, nailed to the wall an arm's length from the panel.
  sheet(b, m, -20.62, P.y - 0.05, -1.88, 0.44, 0.54, 'z');
  for (const dx of [-0.18, 0.18]) b.box(m.iron, 0.018, 0.018, 0.018, -20.62 + dx, P.y + 0.19, -1.85);
  at['basement.diagram'] = new Vector3(-20.62, P.y - 0.05, -1.6);

  // Workbench. Tools, jars, and the note about the draught weighted under one of them.
  b.box(m.wood, 2.2, 0.07, 0.66, -16.4, BASE_Y + 0.83, -1.55);
  for (const dx of [-1.02, 1.02]) {
    for (const dz of [-0.26, 0.26]) b.box(m.wood, 0.08, 0.79, 0.08, -16.4 + dx, BASE_Y + 0.4, -1.55 + dz);
  }
  aabbs.push(aabbOf(-16.4, BASE_Y, -1.55, 1.12, 0.34, BASE_Y + 0.87));
  sheet(b, m, -16.4, BASE_Y + 0.875, -1.62, 0.26, 0.3, 'flat', 0.1);
  b.cyl(m.dark, 0.055, 0.055, 0.13, 8, -16.34, BASE_Y + 0.94, -1.58);
  at['basement.draught'] = new Vector3(-16.4, BASE_Y + 0.96, -1.3);
  let s = 5;
  for (let i = 0; i < 6; i++) {
    s = (s * 41 + 13) % 89;
    b.cyl(s % 2 ? m.paper : m.dark, 0.05, 0.05, 0.14, 7, -17.3 + i * 0.36, BASE_Y + 0.94, -1.4);
  }
  b.box(m.iron, 0.24, 0.03, 0.06, -15.8, BASE_Y + 0.88, -1.44, 0.5);

  // The tally, cut into the plaster beside the door at the height of someone sitting down.
  // Ten groups of five in two rows, then the fifty-first mark on its own.
  //
  // x = -13.895, not -13.89. The wall these are scratched into is centred on BASEMENT.x1 = -13.8 and
  // 0.2 thick, so the face the player sees from inside the cellar is at -13.900 — and a 14 mm mark
  // centred at -13.890 spans -13.897..-13.883, which is 3 mm *behind* that face. Fifty-one marks the
  // whole point of the room, invisible except where the depth test went the other way. Centred at
  // -13.895 each one stands 2 mm proud and reads as cut in.
  for (let g = 0; g < 10; g++) {
    const gy = BASE_Y + 0.62 - Math.floor(g / 5) * 0.26;
    const gz = 2.45 + (g % 5) * 0.46;
    for (let k = 0; k < 5; k++) b.box(m.dark, 0.014, 0.19, 0.012, -13.895, gy, gz + k * 0.075);
  }
  b.box(m.dark, 0.016, 0.2, 0.014, -13.895, BASE_Y + 0.36, 4.78);
  at['basement.tally'] = new Vector3(-14.16, BASE_Y + 0.55, 3.6);

  // Scuff arc where the shelf has been dragged back and forth. Mentioned in the note; not marked.
  b.ring(m.dark, 0.88, 1.02, 16, -21.24, BASE_Y + 0.012, PLACE.shelf.z, -Math.PI / 2, Math.PI);

  // Support post, crates, coal. The room has to look used or the shelf looks placed.
  b.cyl(m.wood, 0.16, 0.16, 2.8, 8, -18.0, BASE_Y + 1.4, 2.3);
  aabbs.push(aabbOf(-18.0, BASE_Y, 2.3, 0.17, 0.17, BASE_Y + 2.8));
  // The crates are in the two corners the south wall does not use, and that is not decoration. They stood
  // at (-17.6, 4.7) and (-16.7, 5.3) — mid-floor, on the diagonal between the stair and the black room's
  // doorway — where they did two kinds of damage. For the player they closed the north half of the cellar:
  // with the shelving, the washing machine and the model's own workbench lining the north wall from
  // x -19.68 to -16.31, those two boxes carried the line east to -16.36 and left one lane through, hard
  // against the east wall. For the cat they were the whole reason CatRoutes had no bs_n_w-bs_n_e rail:
  // 0.18 m between the barrel's north-east corner and the crate's south-west one, for a cat 0.30 m wide.
  //
  // The corners are the point. The south wall itself is full and every metre of it is spoken for — the
  // diagram at x -20.62, the breaker at PLACE.breaker.x, its hatch 0.95 m to the +x side of that, then the
  // workbench from -17.52 to -15.28 — so a crate anywhere along it stands in front of something the player
  // has to reach. What is left is the strip east of the workbench, where the player comes in, and the
  // strip west of the diagram. Both are dead ends for a 0.70 m box, both are more than a metre from the
  // nearest cat edge, and a crate by the door is the first thing the lantern picks out on the way down.
  b.box(m.wood, 0.66, 0.62, 0.66, -14.42, BASE_Y + 0.31, -1.5);
  b.box(m.wood, 0.56, 0.54, 0.56, -14.32, BASE_Y + 0.89, -1.42, 0.35);
  b.box(m.wood, 0.6, 0.58, 0.6, -21.35, BASE_Y + 0.29, -1.45, 0.15);
  aabbs.push(aabbOf(-14.4, BASE_Y, -1.48, 0.36, 0.36, BASE_Y + 1.16));
  aabbs.push(aabbOf(-21.35, BASE_Y, -1.45, 0.34, 0.34, BASE_Y + 0.58));
  b.cyl(m.wood, 0.28, 0.24, 0.78, 10, -20.4, BASE_Y + 0.39, 5.5);
  aabbs.push(aabbOf(-20.4, BASE_Y, 5.5, 0.29, 0.29, BASE_Y + 0.78));
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
function ritual({ b, m, aabbs, at }: Ctx): void {
  const A = PLACE.altar;

  // Chalk. Two rings, the outer one gone over more than once.
  b.ring(m.paper, 1.72, 1.79, 40, A.x, BASE_Y + 0.012, A.z);
  b.ring(m.paper, 1.5, 1.53, 36, A.x, BASE_Y + 0.011, A.z);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.4;
    candle(b, m, A.x + Math.cos(a) * 1.62, BASE_Y, A.z + Math.sin(a) * 1.62, 0.16 + (i % 3) * 0.04);
  }

  // Her records, the whole of the west wall. Eleven columns, and a twelfth begun.
  for (let c = 0; c < 11; c++) {
    const cz = 0.2 + c * 0.4;
    sheet(b, m, -29.88, BASE_Y + 1.72, cz, 0.3, 0.36, 'x');
    sheet(b, m, -29.88, BASE_Y + 1.3, cz, 0.3, 0.36, 'x');
    b.box(m.paper, 0.006, 0.07, 0.3, -29.88, BASE_Y + 1.02, cz);
    b.box(m.paper, 0.006, 0.05, 0.24, -29.88, BASE_Y + 0.9, cz);
    for (const py of [1.9, 1.48]) b.box(m.iron, 0.02, 0.016, 0.016, -29.85, BASE_Y + py, cz);
  }
  b.box(m.iron, 0.03, 0.018, 0.018, -29.85, BASE_Y + 1.9, 4.6);
  b.box(m.paper, 0.006, 0.05, 0.22, -29.88, BASE_Y + 0.9, 4.6);
  at['ritual.records'] = new Vector3(-29.55, BASE_Y + 1.4, 2.3);

  // The rite, pinned at eye height on the wall by the door — the last thing read, first obeyed.
  sheet(b, m, -25.4, BASE_Y + 1.52, -0.88, 0.36, 0.46, 'z');
  b.box(m.iron, 0.02, 0.02, 0.02, -25.4, BASE_Y + 1.72, -0.85);
  at['ritual.rite'] = new Vector3(-25.4, BASE_Y + 1.52, -0.6);

  // A chair with straps on the arms, set well back from the circle.
  b.box(m.wood, 0.5, 0.06, 0.5, -24.2, BASE_Y + 0.46, 4.3, -0.5);
  b.box(m.wood, 0.5, 0.86, 0.06, -24.2, BASE_Y + 0.9, 4.54, -0.5);
  for (const dx of [-0.2, 0.2]) {
    for (const dz of [-0.2, 0.2]) b.box(m.wood, 0.06, 0.44, 0.06, -24.2 + dx, BASE_Y + 0.22, 4.3 + dz);
  }
  for (const dz of [-0.24, 0.24]) b.box(m.cloth, 0.1, 0.02, 0.12, -24.2, BASE_Y + 0.62, 4.3 + dz);
  aabbs.push(aabbOf(-24.2, BASE_Y, 4.3, 0.32, 0.32, BASE_Y + 0.5));

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

// --- Assembly --------------------------------------------------------------------------------

/**
 * A contact shadow under every collider this file emitted. See ContactShadow for what they are.
 *
 * Driven off the colliders rather than off a second hand-written list of positions, and that is the
 * whole reason this is eight lines instead of sixty: `aabbs` here is exactly the furniture — twenty
 * boxes, every one of them a thing standing on a floor, since walls and casings come from HouseRooms
 * and never pass through this file. So the footprint and the floor are both already known and correct,
 * and a table that gets nudged 20 cm in a later edit takes its shadow with it. Sharing one material
 * means Batch merges all twenty into a single draw call.
 *
 * `minY` is the floor and not an assumption about it: every push in this file seats its box on the
 * storey it belongs to, which is why the basement's five come out at BASE_Y without this knowing that
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
  const ctx: Ctx = { b: new Batch(), m: mats, aabbs: [], at: {} };
  hall(ctx);
  hallway(ctx);
  bedroom(ctx);
  living(ctx);
  shaft(ctx);
  basement(ctx);
  ritual(ctx);
  // Last, so it sees every collider the rooms pushed.
  shadows(ctx);
  const geos = ctx.b.flush(group, 'props');
  return { group, aabbs: ctx.aabbs, anchors: ctx.at, geos };
}






