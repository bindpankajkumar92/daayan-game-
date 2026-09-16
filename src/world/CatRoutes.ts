/**
 * CatRoutes — the walkable graph the cat wanders, as data.
 *
 * Coordinates follow HouseRooms, the same frame as ModelProps: +x east, +z north, y the floor the
 * node stands on. Every node was placed by measuring the room against the wall and furniture boxes
 * the controller collides with, at the cat's own size rather than the player's — a 0.15 m radius got
 * through the 0.595 m gap between the side table and the fireplace that the player's 0.35 m could not,
 * which is why this is a separate graph and not a reuse of anything the player walks. That particular
 * gap is now open floor, the fireplace having been removed, but the reason for a second graph is not:
 * the basement and the ritual room still have squeezes only the cat fits through.
 *
 * Two things are deliberate:
 *
 * - **Nodes carry their own y and edges lerp it.** The staircase is the only place where an edge
 *   changes height, and there four nodes describe the flight. Everywhere else both ends of an edge
 *   share a y and the lerp is a no-op, so no floor query is needed anywhere.
 * - **Edges are listed as chains, not pairs.** `'a b c'` is two edges. The rooms are mostly rails
 *   and loops, and writing them as chains keeps the shape of the room visible in the source.
 *
 * The one gated edge is the ritual room's, through the doorway the sliding screen covers. It is the
 * only reason CatRoamer needs to know anything about puzzle state.
 */

import { BASE_Y } from '@/world/HouseLayout';

export interface CatNode {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** [name, x, z] on the ground floor at y = 0. */
const GROUND: readonly (readonly [string, number, number])[] = [
  // Main hall, south of the hallway arch. hall_gate is the front door the player leaves by.
  ['hall_arch', 0, -0.8],
  ['hall_mid', 0, -4.4],
  ['hall_nw', -3.9, -1.4],
  ['hall_west', -3.4, -5.8],
  ['hall_east', 3.4, -5.8],
  ['hall_gate', 0, -6.2],
  // Hallway: a straight rail down the middle at z = 1.15, plus the nook at its east end.
  ['hw_west', -8.2, 1.15],
  ['hw_bed', -4.6, 1.15],
  ['hw_mid', 0, 1.15],
  ['hw_liv', 4.6, 1.15],
  ['hw_east', 7.2, 1.15],
  // Two nodes for the nook, because a chest at x 7.56..8.20 / z 1.16..1.80 sits between it and the
  // rail: the dog-leg goes south of the chest, where the straight line clipped its corner.
  ['hw_nook_s', 7.5, 0.75],
  ['hw_nook', 8.3, 0.6],
  // Bedroom. bd_window is the west wall under the window; bd_north clears the foot of the bed.
  //
  // The north rail is at x = -4.17, not the -3.6 it ran at before the room was furnished, and it stays
  // there even though half the reason has gone. bed-horror used to occupy x -3.87 .. -1.73 across
  // z 7.87 .. 8.93, a bed laid across the middle of that rail: checkRoutes() unlinked bd_mid-bd_north on
  // load, bd_north's only edge is that one, so the whole north half of the room went unreachable and the
  // drop surfaced as a player-facing error line. -4.17 was the centre of the one gap that survived — the
  // bed's west face at -3.87 and the 0.48 m bedside table at x -4.94 .. -4.46 / z 9.06 .. 9.54 pinched it
  // to 0.59 m, which clears the cat's 0.30 m width by 0.145 m a side. Measured by sweeping the rail at
  // 0.2 m steps: every x from -3.0 to -4.0 hit the bed, -4.4 to -5.0 hit the table, and only -4.2 and a
  // second slot at -5.2 passed at all.
  //
  // That bed is in the shrine now, so the only thing left on the rail is the bedside table and the gap is
  // open from -4.46 east to the far wall. The nodes are left where they were measured on purpose: widening
  // a gap cannot break a route, checkRoutes() has nothing left to unlink here, and a rail put back to -3.6
  // would be a second set of numbers nobody has swept.
  ['bd_thr', -4.6, 2.6],
  ['bd_in', -4.6, 3.6],
  ['bd_mid', -4.17, 6.0],
  ['bd_north', -4.17, 9.5],
  ['bd_westmid', -7.6, 4.3],
  ['bd_window', -8.3, 4.3],
  ['bd_nw', -6.2, 6.4],
  // Living room, as a ring round where the dining table stood, with a spur to the doorway.
  ['lv_thr', 5.4, 2.6],
  ['lv_in', 5.45, 3.7],
  ['lv_se', 6.0, 3.0],
  ['lv_e_s', 8.2, 3.0],
  ['lv_e_n', 8.2, 8.0],
  ['lv_ne', 5.0, 9.3],
  ['lv_nw', 3.4, 9.3],
  ['lv_c', 3.4, 6.4],
  ['lv_w', 1.4, 5.2],
  ['lv_sw', 1.4, 3.6],
];

/** [name, x, z] in the basement wing at y = BASE_Y. */
const BASEMENT: readonly (readonly [string, number, number])[] = [
  ['bs_in', -14.8, 1.05],
  ['bs_bench', -16.4, -0.6],
  ['bs_mid', -19.0, 1.0],
  ['bs_tbl_w', -20.5, 3.0],
  // The cellar's west end, where the push-aside shelf used to stand. bs_screen is the second node, in
  // front of the sliding screen and on the doorway's own centreline, because the approach has to be
  // square to the opening: the parked leaves sit at x -21.82..-21.72 and carry no collider of their
  // own, so a diagonal that clips one is invisible to the route check and the cat walks through paper.
  // Straight in along z = 2.3 keeps it inside the z 1.669..2.875 gap the open leaves leave, with 0.48 m
  // a side for a cat 0.30 m wide.
  ['bs_west', -21.4, 1.0],
  ['bs_screen', -21.45, 2.3],
  // Pulled 40 cm east and 1.4 m south of the north wall it used to run along. basement.glb's shelving,
  // washing machine and vacuum stand shoulder to shoulder from x -19.68 to -18.22 and out to z 6.39,
  // which buried the old (-19.0, 6.1) inside the vacuum: both ends of the north rail were clear, so
  // nothing showed until the segments themselves were swept.
  ['bs_n_w', -18.6, 4.7],
  ['bs_n_e', -14.8, 6.1],
  // Ritual room, behind the screen: a loop round the altar with a spur to its east face. rt_thr stands
  // at -22.4 rather than on the doorway at -22, to clear the screen's blocker, which fills the opening
  // at x -22.14..-21.86 for as long as it is shut. That clearance matters even though the edge through
  // the doorway is gated: checkRoutes sweeps rt_thr-rt_in with the screen still closed, and a node
  // standing inside a collider fails every edge that touches it. The old -22.1 sat 4 cm inside the
  // blocker, which unlinked rt_thr-rt_in on load and took the whole ritual loop out of the graph.
  ['rt_thr', -22.4, 2.3],
  ['rt_in', -23.0, 2.3],
  ['rt_altar_e', -25.4, 2.3],
  ['rt_se', -23.0, 0.4],
  ['rt_sw', -28.6, 0.4],
  ['rt_nw', -28.6, 5.0],
  ['rt_ne', -23.4, 5.0],
];

/**
 * [name, x, z, y as a fraction of BASE_Y] — the one flight that changes height. Written as fractions
 * so re-cutting the basement moves the treads with it instead of leaving the cat in mid-air.
 */
const STAIR: readonly (readonly [string, number, number, number])[] = [
  ['st_land', -9.3, 1.15, 0],
  ['st_a', -10.6, 1.15, 0.267],
  ['st_b', -12.2, 1.15, 0.667],
  ['st_bot', -13.6, 1.15, 1],
];

export const CAT_NODES: readonly CatNode[] = [
  ...GROUND.map(([name, x, z]) => ({ name, x, y: 0, z })),
  ...BASEMENT.map(([name, x, z]) => ({ name, x, y: BASE_Y, z })),
  ...STAIR.map(([name, x, z, f]) => ({ name, x, y: BASE_Y * f, z })),
];

/**
 * Each string is a chain: consecutive names are joined. A name repeated at the end closes a loop.
 *
 * The omissions matter as much as the entries, and each of these was tried and rejected against the
 * furniture: lv_ne–lv_w crossed the dining table, lv_sw–lv_thr crosses the bookshelf, a direct
 * hw_west–bd_thr diagonal cuts the bedroom door leaf, rt_se–rt_sw run at z = 1.0 passes 0.02 m from the
 * altar, rt_altar_e–rt_sw crosses the altar itself, and a direct bs_west–rt_thr diagonal — the obvious
 * way through the ritual doorway — clips the wall's solid stretch south of the opening at x
 * -22.10..-21.90 / z -2.10..1.40 and grazes a parked leaf on the way, which is what bs_screen is for.
 * bs_mid–bs_n_w clipped the support post until bs_n_w moved off
 * the north wall; it is clear from (-19.0, 1.0) to (-18.6, 4.7) and nowhere near clear to the old one.
 *
 * Past tense on the first of those, and it is the only one: the dining table, the fireplace, the ledger
 * table, the chair and the rugs have all since been removed from HouseProps, so several of this graph's
 * detours now go round nothing. Nothing is broken by that — a route that avoided a box is still a legal
 * route once the box is gone, and the cat taking the long way round an empty floor is invisible at 0.15 m
 * radius. Left alone deliberately: re-cutting the living room's ring to run straight through where the
 * table stood would be re-authoring a working graph for no visible gain, and the furniture may come back.
 *
 * lv_thr–lv_se is the one the route check caught rather than the eye: the living room's south wall
 * runs x 5.80..9.10 and the doorway is the gap west of it, so the only way in is lv_thr–lv_in.
 */
export const CAT_CHAINS: readonly string[] = [
  'hall_arch hall_mid hall_west hall_nw hall_arch',
  'hall_mid hall_east hall_gate hall_west',
  'hall_mid hall_gate',
  'hall_arch hw_mid',
  'hw_west hw_bed hw_mid hw_liv hw_east hw_nook_s hw_nook',
  'hw_bed bd_thr bd_in bd_mid bd_north',
  'bd_in bd_westmid bd_window',
  'bd_westmid bd_nw bd_mid',
  'hw_liv lv_thr lv_in lv_c lv_nw lv_ne lv_e_n lv_e_s lv_se lv_in',
  'lv_c lv_w lv_sw',
  'hw_west st_land st_a st_b st_bot bs_in bs_mid bs_west bs_screen',
  'bs_in bs_bench bs_mid',
  // The north rail is back. It was two spurs for as long as two hand-built crates stood mid-floor at
  // (-17.6, 4.7) and (-16.7, 5.3): the only opening left was the 0.18 m diagonal between the barrel's
  // north-east corner and the crate's south-west one, for a cat 0.30 m wide, and a sweep at every
  // clearance from 0.15 up found nothing north of z 4 that joined the west pocket to the east band. Those
  // crates now sit against the south wall (HouseProps.basement), because they were closing the player's
  // way to the black room's doorway as well. Swept again at 0.15 over the cat's own y band: the whole
  // segment is clear, and it passes half a metre south of the model's workbench at its closest.
  'bs_in bs_n_e bs_n_w bs_tbl_w bs_mid',
  'rt_thr rt_in rt_altar_e',
  'rt_in rt_se rt_sw rt_nw rt_ne rt_in',
];

/** The doorway the screen covers. Walkable only once the player has slid it aside. */
export const CAT_GATED: readonly (readonly [string, string])[] = [['bs_screen', 'rt_thr']];
