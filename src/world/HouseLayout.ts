/**
 * HouseLayout — the whole house as data, per the Environment & Puzzle Design Brief.
 *
 * Areas: Entrance/Main Hall (three-lock gate), Hallway, Bedroom (Puzzle 2), Living Room,
 * Stair Shaft, Basement (Puzzle 3) and the Secret Ritual Room (Puzzle 1) hidden behind a
 * movable shelf at the far end of the basement.
 *
 * Two rules this file exists to enforce:
 *
 * 1. Geometry and collision come from the same array. Hand-maintaining a second list of
 *    colliders is how a doorway ends up sealed while looking open. `collideOnly` is the one
 *    sanctioned exception, and only because an imported model draws walls it cannot collide.
 * 2. Openings are declared as *clear* width. `segmentBox` pads every segment end by half the
 *    wall thickness so corners join without a gap, which silently narrows any opening a segment
 *    ends at — so `expandRun` nudges those ends back by the same amount. Getting this wrong once
 *    cost a doorway the player could see through but not walk through.
 *
 * The basement and ritual room sit outside the ground floor's footprint in plan view rather than
 * underneath it. Nobody can tell from inside, and it means no floor needs a hole cut in it.
 */

export const WALL_H = 3.0;
export const WALL_T = 0.2;
export const HALF_T = WALL_T / 2;

/** Basement floor and ceiling heights. */
export const BASE_Y = -3.0;
export const BASE_CEIL_H = 2.8;

export interface Opening {
  /** Centre of the opening along the run's own axis (x for an E-W run, z for a N-S run). */
  at: number;
  /** Half the clear width. */
  half: number;
  /** Bottom of the opening; omit for a doorway that reaches the floor. */
  y0?: number;
  /** Top of the opening; omit for a full-height archway. */
  y1?: number;
}

export interface WallRun {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  y0?: number;
  y1?: number;
  openings?: Opening[];
  /**
   * Contribute the collider but not the geometry. For a wall an imported model already draws: a
   * second box in the same place is z-fighting rather than a wall, but the run still has to be
   * written down, because a .glb brings no colliders of its own and without them the player walks
   * out through the far wall into the sky.
   */
  collideOnly?: boolean;
}

export interface Segment {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  y0: number;
  y1: number;
}

export interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** A walkable surface. The controller snaps the player's feet to the highest one below them. */
export interface FloorRect extends Rect {
  y: number;
}

export interface Box {
  cx: number;
  cy: number;
  cz: number;
  w: number;
  h: number;
  d: number;
}

export type RoomTone = 'plaster' | 'cellar';

export interface RoomSpec {
  id: string;
  name: string;
  floorY: number;
  /** Wall height above floorY. */
  height: number;
  floor: Rect;
  /** Omit to leave the room open above (used for the tall stair shaft). */
  ceiling?: boolean;
  /**
   * An imported model supplies this room's floor, so no plane is built for it — two surfaces a
   * centimetre apart z-fight. Walls still come from `walls`, which for such a room means the faces
   * the model leaves open plus `collideOnly` runs for the ones it draws itself.
   */
  modelled?: boolean;
  walls: WallRun[];
  tone: RoomTone;
}

/** Turn a wall segment into the box that renders it and the AABB that blocks it. */
export function segmentBox(s: Segment): Box {
  const dx = Math.abs(s.x2 - s.x1);
  const dz = Math.abs(s.z2 - s.z1);
  const alongX = dx > dz;
  return {
    cx: (s.x1 + s.x2) / 2,
    cy: (s.y0 + s.y1) / 2,
    cz: (s.z1 + s.z2) / 2,
    w: alongX ? dx + WALL_T : WALL_T,
    h: s.y1 - s.y0,
    d: alongX ? WALL_T : dz + WALL_T,
  };
}

/**
 * Expand one wall run into solid segments, cutting its openings out and leaving the header
 * above a door and the sill below a window.
 */
export function expandRun(run: WallRun, defY0: number, defY1: number): Segment[] {
  const y0 = run.y0 ?? defY0;
  const y1 = run.y1 ?? defY1;
  const alongX = Math.abs(run.x2 - run.x1) > Math.abs(run.z2 - run.z1);
  const a0 = alongX ? Math.min(run.x1, run.x2) : Math.min(run.z1, run.z2);
  const a1 = alongX ? Math.max(run.x1, run.x2) : Math.max(run.z1, run.z2);
  const fixed = alongX ? run.z1 : run.x1;
  const out: Segment[] = [];

  const push = (b0: number, b1: number, sy0: number, sy1: number): void => {
    if (b1 - b0 < 0.02 || sy1 - sy0 < 0.02) return;
    out.push(
      alongX
        ? { x1: b0, z1: fixed, x2: b1, z2: fixed, y0: sy0, y1: sy1 }
        : { x1: fixed, z1: b0, x2: fixed, z2: b1, y0: sy0, y1: sy1 },
    );
  };

  let cursor = a0;
  for (const op of [...(run.openings ?? [])].sort((p, q) => p.at - q.at)) {
    const o0 = op.at - op.half;
    const o1 = op.at + op.half;
    // Solid up to the opening. The far end pulls back by HALF_T so that once segmentBox pads
    // it the inner face lands exactly on the edge of the clear opening.
    push(cursor, o0 - HALF_T, y0, y1);
    const oy0 = op.y0 ?? y0;
    const oy1 = op.y1 ?? y1;
    // Sill and header are inset at both ends for the same reason, so they abut their
    // neighbours' padded faces instead of overlapping them and z-fighting.
    if (oy0 > y0 + 0.01) push(o0 + HALF_T, o1 - HALF_T, y0, oy0);
    if (oy1 < y1 - 0.01) push(o0 + HALF_T, o1 - HALF_T, oy1, y1);
    cursor = o1 + HALF_T;
  }
  push(cursor, a1, y0, y1);
  return out;
}
