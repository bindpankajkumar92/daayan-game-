/**
 * HouseBuilder — turns the HouseRooms data into meshes, colliders and walkable floors.
 *
 * Two deliberate choices:
 *
 * - **Merged per room, per material.** Every wall in a room becomes one BufferGeometry. Seven
 *   rooms of individual boxes would be ~150 draw calls; merged it is closer to 25, and merging
 *   per *room* rather than per house keeps frustum culling useful — the ritual room costs nothing
 *   while you are upstairs.
 * - **World-anchored UVs, baked.** Every vertex's UV is computed from where it ends up in the
 *   world, so the plaster runs continuously through corners and door jambs instead of restarting
 *   at every segment. Combined with the seamless textures in ProcTextures, that is what stops a
 *   long wall reading as a grid of identical panels — and see worldUv for the second, larger
 *   thing it buys.
 *
 * Materials are Lambert, not Standard: a physical BRDF per fragment measured 3.5x the frame time
 * on the 4 GB target for detail that is invisible in a house lit by one lantern.
 */

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Group,
  Matrix3,
  Mesh,
  MeshLambertMaterial,
  MirroredRepeatWrapping,
  PlaneGeometry,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
  type Material,
  type Matrix4,
  type Texture,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { AABB, FloorRect } from '@/player/FPController';
import { makeCeilingBoards, makePlaster, makeWoodFloor, makeWoodPanel } from './ProcTextures';
import { expandRun, segmentBox, type Box, type Segment } from './HouseLayout';
import { ROOMS, UPPER_PATCH, houseFloors } from './HouseRooms';

/**
 * World size one texture repeat covers. Wall plaster at 2.4 m ≈ 210 px/m from a 512 px map.
 *
 * Exported because the upper flat's imported shell wears this same plaster and has to tile at the same
 * pitch — see ModelProps.dressShell. Two constants would put a step in the pattern at every seam where
 * a procedural wall meets the .glb's own.
 */
export const WALL_TILE = 3.0;
export const WALL_TILE_U = 6.0;
export const WALL_TILE_V = 3.0;
/** Ceilings and the upper flat's ceiling patches. Floors have their own pair below. */
const CEIL_TILE = 1.6;
const TRIM_TILE = 0.9;
const SKIRT_H = 0.14;

/**
 * The floor's photographed wooden boards, and the one map in the house that is *not* square.
 *
 * FLOOR_MAP is baked from wooden_flooring.glb by tools/bake-floor.mjs rather than sampled from the
 * model at runtime, and the reason is arithmetic rather than taste: that file is 187,716 triangles
 * over a 2.891 x 1.944 m patch, this house has some 470 m2 of floor, and 84 copies of the patch is
 * 15.7 M triangles against a whole-house budget of about 35 k. So the boards arrive as an image of
 * that exact patch — rasterised top-down through the model's own UVs, which is what makes it usable
 * as a tile at all, since the source map is an atlas rather than a repeating texture.
 *
 * Baked at a known metres-per-pixel, so the two tile sizes below are the patch's real dimensions and
 * the boards come out life-size: 1024 x 689 px over 2.891 x 1.944 m is 354 px/m on both axes. They
 * are separate constants for the same reason they are not 1.6: a single number would stretch a plank
 * on one axis, and a plank is the one thing in this house whose proportions the player knows.
 */
const FLOOR_MAP = '/assets/textures/floor-wood.webp';
const FLOOR_TILE_X = 2.891;
const FLOOR_TILE_Z = 1.944;
const WALL_MAP = '/assets/textures/wall-damaged.webp';

/**
 * Largest edge, in metres, allowed on a floor, ceiling or wall triangle.
 *
 * Not a texture or lighting concern — a depth one. A room slab drawn as two triangles is up to
 * 10x7 m, and when the player stands beside one of its corners that corner's view depth passes
 * through zero: the vertex lands on the camera plane, w -> 0, and the projected triangle runs off
 * to infinity. The near-plane clip still produces the right silhouette, but 1/w interpolation
 * across the survivor is worthless, and the slab's depth comes out metres wrong — enough for a
 * ceiling 4.4 m away to win the depth test against a solid wall at 1.8 m. On screen that is a
 * black wedge punched through the wall, moving and reshaping as the player walks past, which is
 * exactly the reported glitch. It only bites on diagonal views, because only there does a corner
 * sit exactly on the camera plane.
 *
 * Splitting the slab into metre quads bounds the damage to the one small triangle that owns the
 * degenerate corner. Measured on the worst view: 5958 flipped pixels -> 70. Costs ~2k triangles
 * across the whole house and not one extra draw call.
 *
 * Metre quads were not the end of it, though. The 2026-09 re-sweep of the upper storey — after the
 * fixture batches stopped carrying 2.2-3.2 m edges — still blamed up-store-floor from diagonal
 * down-looks (2444 flipped px at one pose). The reason is the hypotenuse: SLAB_SEG bounds a quad's
 * width, but each quad is two triangles whose longest edge is the sqrt(2) diagonal, 1.41 m at
 * SLAB_SEG = 1, and the failure is a property of the *triangle*. So the bound the segs() helper has
 * always promised is the one it now enforces: no triangle edge over SLAB_SEG metres, which puts a
 * 1 m hypotenuse under a 0.707 m quad side. Upper-storey worst pose: 2444 -> 106 flipped px.
 *
 * This used to apply to slabPlane() alone, which was half a fix: the house's largest single face is
 * not a floor but a wall — 27.0 m2 of hallway drawn as two triangles — and a wall is the surface the
 * player stands closest to, so it is *more* likely to put a corner on the camera plane, not less.
 * worldBox subdivides on the same number now.
 */
const SLAB_SEG = 1;

/** Segments needed along an edge of `n` metres so no *triangle* edge exceeds SLAB_SEG: a quad
 * subdivided to this size has a sqrt(2) diagonal, so its side is SLAB_SEG / sqrt(2). */
const segs = (n: number): number => Math.max(1, Math.ceil((n * Math.SQRT2) / SLAB_SEG));

/** A floor/ceiling plane subdivided so no triangle is large enough to break depth interpolation. */
function slabPlane(w: number, d: number): PlaneGeometry {
  return new PlaneGeometry(w, d, segs(w), segs(d));
}

/**
 * Risers: the vertical strip where two floors — or two ceilings — meet in plan at different heights.
 *
 * A floor here is a plane, so it has no thickness and therefore no edge. Where two of them abut at
 * different heights the difference is not a step, it is a hole: nothing at all is drawn across the
 * band between them, and the player sees straight through it to whatever lies beyond the room, which
 * is fog or nothing. It reads as a dead-straight dark band lying across the floorboards, hard-edged
 * and unrelated to the texture under it.
 *
 * That is the third distinct defect to be reported as one "view glitch", and the only one left. It is
 * not the depth-interpolation wedge SLAB_SEG bounds above — that one reshapes as you walk, and moving
 * the near plane by a tenth of a millimetre makes it jump. It is not the wrong-material panel the
 * rooms' `tone` fixed either — that one was painted, just painted the colour of the cellar. Here there
 * is genuinely nothing there to draw.
 *
 * The upper storey had it twice over on one line, and that line is a doorway. `UPPER_PATCH.floorY` was
 * `UP_Y - 0.06`, chosen to sit 1 cm under what the imported flat's own slab was thought to be; the rear
 * wing's three rooms floor at `UP_Y` itself, 2.40. They abut along z = -1.93 with no overlap at all, and
 * up-store's north side is deliberately absent along it because that is the way in from the flat's back
 * door. So the route the player walks into the wing crossed a 60 mm slot at the floor and, worse, a
 * 220 mm one overhead where the wing's 5.10 ceiling meets the patch's 5.32.
 *
 * The floor half of that is now fixed at its source instead: the patch was 6 cm below the whole storey,
 * not 1 cm below a slab, and it sits at `UP_Y - 0.004` — see UPPER_PATCH, which carries the measurements.
 * The riser pass still runs and still matters; along z = -1.93 it now closes 4 mm rather than 60, and the
 * 220 mm ceiling join is unchanged, being a genuine difference in storey height.
 *
 * Filling them generically rather than by hand: the heights involved are tuned against an imported
 * model and will be tuned again, and a rule that closes whatever join exists survives that, where six
 * hand-placed quads would quietly stop lining up.
 */
/** Two planes closer than this are a z-fight to keep apart, not a gap to fill. */
const RISER_MIN = 0.002;
/** Beyond this it is a storey, not a step — walls and stairs are already somebody else's geometry. */
const RISER_MAX = 0.5;
/** How near two edges must be in plan to count as meeting rather than merely being nearby. */
const RISER_TOUCH = 0.02;
/** Shorter than this and the two rects touch at a corner; there is no line to close. */
const RISER_SPAN = 0.2;

/** A horizontal plane the builder actually drew, in world space, for the riser pass to pair up. */
type Slab = {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  y: number;
  mat: Material;
  /** Floors pair only with floors: a floor and a ceiling that meet are a wall's business. */
  kind: 'floor' | 'ceil';
};

/** One vertical quad, already placed and oriented, that closes the slot between two slabs. */
type Riser = {
  cx: number;
  cy: number;
  cz: number;
  /** Along the shared line; and the height of the step, which is the slot's width. */
  len: number;
  h: number;
  /** The line runs along x, so the quad's face looks up or down z. Sets which tile size the UVs use. */
  alongX: boolean;
  /** Turns slabPlane's +z-facing quad toward the side the slot is actually visible from. */
  rotY: number;
  mat: Material;
  kind: 'floor' | 'ceil';
};

/**
 * Every pair of like slabs that meet in plan with a step between them.
 *
 * Two axis-aligned rects meet along a line when one axis has their facing edges within RISER_TOUCH and
 * the other has a real shared run. Overlapping in plan is a different problem — coplanar z-fighting,
 * which the depth ladder in bias() handles — and a corner touch fails both tests, as it should.
 */
function findRisers(slabs: Slab[]): Riser[] {
  const out: Riser[] = [];
  // slice() over an index pair: this runs once at build time over a few dozen rects, and it keeps every
  // `a` and `b` below a definite Slab rather than a possibly-undefined lookup.
  for (const [i, a] of slabs.entries()) {
    for (const b of slabs.slice(i + 1)) {
      if (a.kind !== b.kind) continue;
      const h = Math.abs(a.y - b.y);
      if (h < RISER_MIN || h > RISER_MAX) continue;
      const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const oz = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
      const alongX = Math.abs(oz) <= RISER_TOUCH && ox >= RISER_SPAN;
      const alongZ = Math.abs(ox) <= RISER_TOUCH && oz >= RISER_SPAN;
      if (!alongX && !alongZ) continue;

      // Which side is the slot open to? Over the *higher* of two floors that band is solid ground, so
      // a floor's slot can only be seen from above the lower one. Under the *lower* of two ceilings
      // that band is above the ceiling, i.e. outside the room, so a ceiling's can only be seen from
      // under the higher one. Either way the quad faces the slab whose own plane still bounds a room
      // across the band — and wears the other one's material, because it is that one's exposed edge.
      const open = a.kind === 'floor' ? (a.y < b.y ? a : b) : (a.y > b.y ? a : b);
      const edge = open === a ? b : a;
      // Of the pair, the one lying further along the axis the quad faces.
      const far = alongX ? (a.z0 + a.z1 > b.z0 + b.z1 ? a : b) : (a.x0 + a.x1 > b.x0 + b.x1 ? a : b);
      const near = far === a ? b : a;
      const line = alongX ? (near.z1 + far.z0) / 2 : (near.x1 + far.x0) / 2;
      const mid = alongX
        ? (Math.max(a.x0, b.x0) + Math.min(a.x1, b.x1)) / 2
        : (Math.max(a.z0, b.z0) + Math.min(a.z1, b.z1)) / 2;
      const positive = open === far;
      // slabPlane faces +z, so: no turn to keep it there, a half turn to face -z, a quarter either way
      // to face +x or -x.
      const rotY = alongX ? (positive ? 0 : Math.PI) : (positive ? Math.PI / 2 : -Math.PI / 2);
      out.push({
        cx: alongX ? mid : line,
        cy: (a.y + b.y) / 2,
        cz: alongX ? line : mid,
        len: alongX ? ox : oz,
        h,
        alongX,
        rotY,
        mat: edge.mat,
        kind: a.kind,
      });
    }
  }
  return out;
}

export interface BuiltHouse {
  group: Group;
  aabbs: AABB[];
  floors: FloorRect[];
  /** Shared materials, exposed so props can reuse them instead of allocating more. */
  mats: {
    trim: MeshLambertMaterial;
    door: MeshLambertMaterial;
    wallWarm: MeshLambertMaterial;
    wallCool: MeshLambertMaterial;
  };
  dispose: () => void;
}

/**
 * Scale a geometry's UVs so one texture repeat covers `tile` world units, then shift them by a
 * world offset so neighbouring pieces continue the same pattern.
 */
function anchorUv(geo: BufferGeometry, su: number, sv: number, ou: number, ov: number): void {
  const uv = geo.getAttribute('uv') as BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * su + ou, uv.getY(i) * sv + ov);
  }
  uv.needsUpdate = true;
}

/**
 * UVs straight from world position, so two faces that meet — or coincide — sample the same texel at
 * the same point in the world.
 *
 * This replaced a scale-and-offset of BoxGeometry's own UVs, which could not do that however the
 * offset was chosen. BoxGeometry lays out its `nz` and `px` faces with udir = -1, i.e. u increasing
 * the other way, so an offset that lined one face up left its mirror running backwards: at world
 * x = -1.0 the bedroom's face sampled u = -3.750 where the living room's sampled u = +1.167, a
 * 4.9-tile jump at one point in the world. That is a hard seam at every segment join.
 *
 * It is also what made this house's coplanar overlaps *visible*, which is the bigger half. segmentBox
 * pads every wall segment by HALF_T at both ends so corners close without a gap, so wherever two
 * rooms both claim the wall between them the two pieces overlap in a 0.2 x 0.2 column and their outer
 * faces are exactly coincident — 0.000 m apart, so no near-plane or depth-format change can separate
 * them. Walls merge per room, so each such pair is two draw calls, and the opaque sort is by
 * bounding-sphere view depth: the winner flips as the player walks past, which is precisely the
 * "glitch pe alag alag dekhta hai" in the report. Feed both faces the same texel and it stops
 * mattering who wins. Measured: of 163 cross-batch coplanar overlaps in the shell, this silences
 * every one whose two sides share a material — 140 of them.
 *
 * Per vertex from the face normal rather than from the box's long axis, so ends and tops are anchored
 * as well as sides. Positions must already be in world space — or `matrix` must be the transform that
 * puts them there.
 *
 * `matrix` exists for imported geometry, which cannot simply be baked into world space: ModelLoader
 * fits every .glb by writing a scale on its root, animation and colliders both read that scale, and
 * these room shells carry a factor of 5.604. So the world position is computed for the UV and thrown
 * away, and the vertex stays where the fit put it. A geometry with no `uv` attribute gets one — the
 * boxes here always have theirs from BoxGeometry, but a .glb authored for a flat colour has none.
 *
 * The axis is chosen per *vertex*, which is only sound where a vertex belongs to one facing. That is
 * free on a box, whose corners are split; on imported geometry it has to be checked. Measured on the
 * upper flat's two shells: 18 of 18,749 and 22 of 20,514 vertices touch more than one facing, 0.1%
 * either way, so those meshes are hard-edged and this is safe on them. A smooth-shaded mesh would
 * instead need de-indexing first, and would smear a tile along every corner without it.
 */
export function worldUv(
  geo: BufferGeometry,
  tileU: number,
  tileVOrMatrix?: number | Matrix4,
  matrix?: Matrix4,
): void {
  const tileV = typeof tileVOrMatrix === 'number' ? tileVOrMatrix : tileU;
  const mat = typeof tileVOrMatrix === 'object' ? tileVOrMatrix : matrix;
  const pos = geo.getAttribute('position') as BufferAttribute;
  const nor = geo.getAttribute('normal') as BufferAttribute;
  let uv = geo.getAttribute('uv') as BufferAttribute | undefined;
  if (!uv) {
    uv = new BufferAttribute(new Float32Array(pos.count * 2), 2);
    geo.setAttribute('uv', uv);
  }
  const p = new Vector3();
  const n = new Vector3();
  const nm = mat ? new Matrix3().getNormalMatrix(mat) : undefined;
  for (let i = 0; i < uv.count; i++) {
    p.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nor, i);
    if (mat && nm) {
      p.applyMatrix4(mat);
      n.applyMatrix3(nm).normalize();
    }
    const ax = Math.abs(n.x);
    const ay = Math.abs(n.y);
    const az = Math.abs(n.z);
    // A horizontal face reads x across and z up the image; a vertical one reads whichever horizontal
    // axis it runs along, and y up. No ties to break: every normal on a box is a world axis.
    const flat = ay > ax && ay > az;
    const u = flat || az > ax ? p.x : p.z;
    const v = flat ? p.z : p.y;
    uv.setXY(i, u / tileU, v / tileV);
  }
  uv.needsUpdate = true;
}

/** A wall/prop box, subdivided against depth error and UV-anchored to where it sits in the world. */
function worldBox(b: Box, tileU: number, tileV = tileU): BufferGeometry {
  const geo = new BoxGeometry(b.w, b.h, b.d, segs(b.w), segs(b.h), segs(b.d));
  geo.translate(b.cx, b.cy, b.cz);
  worldUv(geo, tileU, tileV);
  return geo;
}

function boxToAabb(b: Box): AABB {
  return {
    minX: b.cx - b.w / 2,
    maxX: b.cx + b.w / 2,
    minY: b.cy - b.h / 2,
    maxY: b.cy + b.h / 2,
    minZ: b.cz - b.d / 2,
    maxZ: b.cz + b.d / 2,
  };
}

/**
 * Metres the skirting stops short of its wall segment at each end.
 *
 * Without it the skirting is exactly as long as the wall, so its end cap is coplanar with the wall's
 * end cap over the full 0.2 x 0.14 of it — trim against plaster, in two different merged meshes, which
 * is the flickering-patch case again and it happens at all 26 segment ends. 2 mm is invisible where the
 * end is buried in a corner, reads as the skirting stopping at the reveal where it is not, and still
 * leaves 98 mm of overlap with the skirting round the corner.
 */
const SKIRT_END = 0.004;

/** Skirting board: the same footprint as the wall, slightly proud of it and ankle-high. */
function skirtBox(b: Box): Box {
  const alongX = b.w > b.d;
  return {
    cx: b.cx,
    cy: b.cy - b.h / 2 + SKIRT_H / 2,
    cz: b.cz,
    w: alongX ? b.w - SKIRT_END : b.w + 0.03,
    h: SKIRT_H,
    d: alongX ? b.d + 0.03 : b.d - SKIRT_END,
  };
}

export function buildHouse(anisotropy: number): BuiltHouse {
  const disposables: Array<{ dispose: () => void }> = [];
  const track = <T extends { dispose: () => void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  // --- Textures. 1024 procedural tiles; see ProcTextures for why they are no longer 512, and why
  // the bump halves these generators used to return are gone rather than wired up. ---
  // `anisotropy` arrives already capped by HouseScene, which caps the imported art by the same
  // number. Clamping again here is how the two drifted apart in the first place.
  const pick = (t: Texture): Texture => {
    t.anisotropy = anisotropy;
    return track(t);
  };
  const texWallWarm = pick(makePlaster(4242, 'warm'));
  const texWallCool = pick(makePlaster(1717, 'cool'));
  const texFloorWood = pick(makeWoodFloor(1337, 8));
  const texCeil = pick(makeCeilingBoards(7171));
  const texTrim = pick(makeWoodPanel(909, 0.7));
  const texDoor = pick(makeWoodPanel(515, 0.9));

  /**
   * A fixed depth bias, so that every remaining exact tie in the house has the same winner from every
   * eye position.
   *
   * World-anchored UVs make a tie invisible when both sides share a material, which is 140 of the 163
   * cross-batch coplanar pairs the shell has. The rest are cross-material, and for those the fragment
   * colours genuinely differ, so *something* has to decide — and the default, a per-object sort by
   * bounding-sphere view depth, decides differently as the player walks past. That is the flicker.
   *
   * One depth unit is all it takes: at the far plane's 60 m a 24-bit buffer still resolves well under a
   * millimetre, so this can never open a visible gap, and it is applied per fragment rather than per
   * object so it does not care which mesh drew first. What it buys is a *ladder* with the imported models
   * on the rung they should be on. They keep their own materials and so sit at offset 0, and every
   * procedural shell surface is pushed behind them: a procedural wall only ever stands where a model
   * leaves a hole, so wherever the two coincide the model is the surface that was meant to be seen. That
   * settles the one class of tie this file cannot measure at all. Above the models sits trim, because a
   * skirting board and a door casing *are* proud of their wall; below them plaster; and below that the
   * cellar tones, so at the cellar doorway — where a hallway wall and the stair shaft's own wall claim
   * the same 0.2 m column — the plaster the player is standing next to wins, from either side.
   */
  const TRIM_Z = -1;
  const WARM_Z = 1;
  const COOL_Z = 2;
  /**
   * Units only, factor 0. GL's offset is `factor * maxDepthSlope + r * units`, where r is by definition
   * the smallest value that produces a resolvable difference — so one unit is exactly enough to break a
   * tie, and the slope term is not merely unnecessary but harmful: it scales with view angle, and a wall
   * seen edge-on has an enormous depth slope, so a non-zero factor would push that wall back by far more
   * than a hair at exactly the grazing angles this house is full of. Two coincident faces share a slope,
   * so the constant term alone orders them the same way from every direction.
   */
  const bias = (units: number): { polygonOffset: true; polygonOffsetFactor: 0; polygonOffsetUnits: number } => ({
    polygonOffset: true,
    polygonOffsetFactor: 0,
    polygonOffsetUnits: units,
  });

  /**
   * The floors, both tones, over one map.
   *
   * `color` is a tint and not a brightness fix, but it is doing the work of one. floor-wood.webp means
   * 162,148,130 — luma 149.4, i.e. 0.3037 in linear, three quarters of the warm plaster's 0.40 — which
   * is a photographed board in daylight and reads as a pale slab in a house lit by one lantern. The
   * procedural floor it replaces sat near 0.08 linear, and a floor four times darker than the walls is
   * what a derelict house looks like from the inside. 0x9a9a9a is 0.3232 in linear, so the boards land
   * at 0.098 — the old floor's value, reached by scaling the photograph rather than by regrading it,
   * which is what keeps the grain and the plank seams intact.
   *
   * floorStone is the same map under the cellar's existing cool tint rather than its own texture: the
   * request was the whole game's floor, and one map for both tones is one less 1024 canvas at startup
   * and one less texture bound per frame. 0x8f9096 puts it at 0.083 to 0.092 linear with the blue
   * fractionally ahead of the red, so the basement's boards read as the same timber gone cold.
   *
   * Both keep their own rung on the depth ladder — see bias() — because that is about which surface
   * wins a coplanar tie at a doorway, not about what they are made of.
   */
  const mats = {
    wallWarm: track(new MeshLambertMaterial({ map: texWallWarm, ...bias(WARM_Z) })),
    wallCool: track(new MeshLambertMaterial({ map: texWallCool, color: 0x9aa0a8, ...bias(COOL_Z) })),
    floorWood: track(new MeshLambertMaterial({ map: texFloorWood, color: 0x9a9a9a, ...bias(WARM_Z) })),
    floorStone: track(new MeshLambertMaterial({ map: texFloorWood, color: 0x8f9096, ...bias(COOL_Z) })),
    ceil: track(new MeshLambertMaterial({ map: texCeil, ...bias(WARM_Z) })),
    trim: track(new MeshLambertMaterial({ map: texTrim, ...bias(TRIM_Z) })),
    door: track(new MeshLambertMaterial({ map: texDoor, ...bias(TRIM_Z) })),
  };

  /**
   * Swap the procedural planks for the baked photograph as soon as it arrives.
   *
   * A swap rather than a load, because this house has no LoadingManager and deliberately so — models
   * pop in and the intro is gated on a named handful of them, see ModelPlacement.first. So the floors
   * are built with makeWoodFloor's canvas already on them and are correct from the first frame; the
   * webp replaces the *map* on two materials that already exist, at their already-chosen tints, and
   * the shader signature does not change, so there is neither a black floor for two frames nor a
   * recompile mid-walk. The UV scaling is FLOOR_TILE_X/Z in both cases: the procedural tile is square
   * and takes the same numbers happily, so the geometry never has to know which map it is wearing.
   *
   * MirroredRepeat, not Repeat. The bake dilates its edges outward to fill the holes between the
   * model's UV islands, so its two borders do not meet; mirroring reflects them into each other
   * instead, which costs a faint line of symmetry every 2.891 / 1.944 m and buys a seam-free floor
   * without hand-retouching the image.
   *
   * `disposed` is not paranoia. dispose() runs when the scene is torn down, which on a phone can
   * easily happen while a 140 kB fetch is still in flight, and assigning a map to a disposed material
   * would resurrect it in the renderer's cache.
   */
  let disposed = false;
  new TextureLoader().load(
    FLOOR_MAP,
    (tex) => {
      if (disposed) {
        tex.dispose();
        return;
      }
      tex.colorSpace = SRGBColorSpace;
      tex.wrapS = MirroredRepeatWrapping;
      tex.wrapT = MirroredRepeatWrapping;
      pick(tex);
      for (const m of [mats.floorWood, mats.floorStone]) {
        m.map = tex;
        m.needsUpdate = true;
      }
    },
    undefined,
    () => {
      // Reported and no more: the procedural planks are already on the floor and are a floor.
      console.warn(`floor map failed to load: ${FLOOR_MAP}`);
    },
  );

  new TextureLoader().load(
    WALL_MAP,
    (tex) => {
      if (disposed) {
        tex.dispose();
        return;
      }
      tex.colorSpace = SRGBColorSpace;
      tex.wrapS = MirroredRepeatWrapping;
      tex.wrapT = MirroredRepeatWrapping;
      pick(tex);
      for (const m of [mats.wallWarm, mats.wallCool]) {
        m.map = tex;
        m.needsUpdate = true;
      }
    },
    undefined,
    () => {
      console.warn(`wall map failed to load: ${WALL_MAP}`);
    },
  );

  const group = new Group();
  group.name = 'house';
  const aabbs: AABB[] = [];
  /** Filled as the horizontal planes are drawn, read once at the end by the riser pass. */
  const slabs: Slab[] = [];

  const addMerged = (geos: BufferGeometry[], mat: Material, name: string): void => {
    if (geos.length === 0) return;
    const merged = mergeGeometries(geos);
    for (const g of geos) g.dispose();
    if (!merged) return;
    const mesh = new Mesh(track(merged), mat);
    mesh.name = name;
    group.add(mesh);
  };

  for (const room of ROOMS) {
    const y0 = room.floorY;
    const y1 = room.floorY + room.height;
    const wallGeos: BufferGeometry[] = [];
    const skirtGeos: BufferGeometry[] = [];

    for (const run of room.walls) {
      const segments: Segment[] = expandRun(run, y0, y1);
      for (const s of segments) {
        const b = segmentBox(s);
        // A collide-only run stands where an imported model has already drawn the wall.
        if (run.collideOnly !== true) {
          wallGeos.push(worldBox(b, WALL_TILE_U, WALL_TILE_V));
          // Skirting only where the segment actually meets the floor, and only upstairs — a
          // cellar has bare walls.
          if (room.tone === 'plaster' && Math.abs(s.y0 - y0) < 0.01) {
            skirtGeos.push(worldBox(skirtBox(b), TRIM_TILE));
          }
        }
        if (run.modelCollision !== true) aabbs.push(boxToAabb(b));
      }
    }
    addMerged(wallGeos, room.tone === 'plaster' ? mats.wallWarm : mats.wallCool, `${room.id}-walls`);
    addMerged(skirtGeos, mats.trim, `${room.id}-skirt`);

    /**
     * Floor and ceiling as single planes.
     *
     * The floor is world-anchored, which it did not need to be while it wore procedural noise: one
     * mesh covers a whole room, so a tiling that restarts at the room's own corner has no visible
     * neighbour — except that it does. The 3.2 m archway and the two 1.6 m doorways all show two
     * rooms' floors at once, and a photographed 2.9 m plank makes a break in the run obvious at a
     * glance where noise hid it. Anchoring to x0 and z1 makes every floor in the house one continuous
     * board pattern that happens to be cut into meshes at the walls.
     *
     * The v anchor is negative because the plane is laid down by rotation.x = -PI/2, which maps its
     * local +y onto world -z; so v grows southward and the row that must line up with the world is
     * the one at z1, not z0. The ceiling below rotates the other way, maps +y onto +z, and keeps its
     * z0 anchor — that asymmetry is the whole reason the two lines do not read alike.
     *
     * The ceiling stays unanchored on CEIL_TILE. Its boards are still procedural, a ceiling is only
     * ever seen at a grazing angle through a doorway, and this task is the floor.
     */
    const fw = room.floor.x1 - room.floor.x0;
    const fd = room.floor.z1 - room.floor.z0;
    if (room.modelled !== true) {
      const floorGeo = track(slabPlane(fw, fd));
      anchorUv(
        floorGeo,
        fw / FLOOR_TILE_X,
        fd / FLOOR_TILE_Z,
        room.floor.x0 / FLOOR_TILE_X,
        -room.floor.z1 / FLOOR_TILE_Z,
      );
      const floor = new Mesh(floorGeo, room.tone === 'plaster' ? mats.floorWood : mats.floorStone);
      floor.rotation.x = -Math.PI / 2;
      floor.position.set((room.floor.x0 + room.floor.x1) / 2, y0, (room.floor.z0 + room.floor.z1) / 2);
      floor.name = `${room.id}-floor`;
      group.add(floor);
      slabs.push({ ...room.floor, y: y0, mat: floor.material as Material, kind: 'floor' });
    }

    if (room.ceiling) {
      const ceilGeo = track(slabPlane(fw, fd));
      anchorUv(ceilGeo, fw / CEIL_TILE, fd / CEIL_TILE, 0, 0);
      const ceil = new Mesh(ceilGeo, room.tone === 'plaster' ? mats.ceil : mats.wallCool);
      ceil.rotation.x = Math.PI / 2;
      ceil.position.set((room.floor.x0 + room.floor.x1) / 2, y1, (room.floor.z0 + room.floor.z1) / 2);
      ceil.name = `${room.id}-ceil`;
      group.add(ceil);
      slabs.push({ ...room.floor, y: y1, mat: ceil.material as Material, kind: 'ceil' });
    }
  }

  // The two holes the imported flat leaves in its own floor and ceiling. See UPPER_PATCH: `modelled`
  // suppressed both planes for the whole room on the promise that the model brings them, and it keeps
  // that promise everywhere except the room the player walks into first. Drawn here rather than by
  // relaxing `modelled`, because a plane over the whole rect would bury the 99% the model does cover.
  //
  // The materials follow the upper room's own tone rather than being named outright, which is what they
  // used to be — floorStone and wallCool, i.e. the cellar's. That was consistent for exactly as long as
  // the upper room was tagged 'cellar'; the moment it became plaster (see HouseRooms) it left the first
  // room upstairs standing on a blue-grey slab under a plastered ceiling while every wall around it was
  // warm and every other ceiling in the house was timber. Reading the tone here means the next person to
  // change it only has to change it once.
  const upperTone = ROOMS.find((r) => r.id === 'upper')?.tone ?? 'plaster';
  const upperWarm = upperTone === 'plaster';
  for (const [i, r] of UPPER_PATCH.rects.entries()) {
    const w = r.x1 - r.x0;
    const d = r.z1 - r.z0;
    const cx = (r.x0 + r.x1) / 2;
    const cz = (r.z0 + r.z1) / 2;
    const floorGeo = track(slabPlane(w, d));
    // World-anchored on the same grid as the room floors above, and for a second reason on top of
    // theirs: these two abut the model's own slab, and a tiling that restarted at each patch's centre
    // would show the join as a seam straight across the landing.
    anchorUv(floorGeo, w / FLOOR_TILE_X, d / FLOOR_TILE_Z, r.x0 / FLOOR_TILE_X, -r.z1 / FLOOR_TILE_Z);
    const floor = new Mesh(floorGeo, upperWarm ? mats.floorWood : mats.floorStone);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(cx, UPPER_PATCH.floorY, cz);
    floor.name = `upper-patch-floor-${i}`;
    group.add(floor);
    slabs.push({ ...r, y: UPPER_PATCH.floorY, mat: floor.material as Material, kind: 'floor' });

    const ceilGeo = track(slabPlane(w, d));
    anchorUv(ceilGeo, w / CEIL_TILE, d / CEIL_TILE, r.x0 / CEIL_TILE, r.z0 / CEIL_TILE);
    const ceil = new Mesh(ceilGeo, upperWarm ? mats.ceil : mats.wallCool);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(cx, UPPER_PATCH.ceilY, cz);
    ceil.name = `upper-patch-ceil-${i}`;
    group.add(ceil);
    slabs.push({ ...r, y: UPPER_PATCH.ceilY, mat: ceil.material as Material, kind: 'ceil' });
  }

  /**
   * Close the slots. See findRisers: this is the 60 mm one across the upper flat's back doorway and the
   * 220 mm one above it, plus whatever the next change to those heights opens up.
   *
   * Merged per material, because the alternative is a draw call apiece for six quads on a phone that is
   * already spending 57 of them, and they all wear one of two floor materials anyway. worldUv rather
   * than anchorUv: the geometry is in world space by then and its normals say which pair of world axes
   * the face runs along, so the strip picks up the boards of the floor it hangs off without being told
   * which way it is turned. No aabbs entry — a 60 mm lip is not something to walk into, and the
   * controller steps over it already.
   */
  const riserGeos = new Map<Material, BufferGeometry[]>();
  for (const rs of findRisers(slabs)) {
    const geo = slabPlane(rs.len, rs.h);
    geo.rotateY(rs.rotY);
    geo.translate(rs.cx, rs.cy, rs.cz);
    worldUv(geo, rs.kind === 'ceil' ? CEIL_TILE : rs.alongX ? FLOOR_TILE_X : FLOOR_TILE_Z);
    const bucket = riserGeos.get(rs.mat);
    if (bucket) bucket.push(geo);
    else riserGeos.set(rs.mat, [geo]);
  }
  let riserBatch = 0;
  for (const [mat, geos] of riserGeos) addMerged(geos, mat, `risers-${riserBatch++}`);

  // The cellar shaft's visible stair is stair-wood.glb (see the `stair-cellar.glb` row in ModelProps),
  // so the procedural stairTreads() boxes are no longer drawn. stairFloors() stays — the player still
  // walks fifteen 0.2 m steps, because the model's own 0.75 m rise is more than the controller's step-up.

  const dispose = (): void => {
    disposed = true;
    group.removeFromParent();
    for (const d of disposables) d.dispose();
    disposables.length = 0;
  };

  return { group, aabbs, floors: houseFloors(), mats, dispose };
}
