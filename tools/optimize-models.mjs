/**
 * Model pipeline entry point. Turns the raw Sketchfab-grade GLBs in "glb files/" into something a
 * 4 GB phone can load, and writes the results to public/assets/models/. Originals are never touched.
 *
 *   node tools/optimize-models.mjs                 # everything
 *   node tools/optimize-models.mjs lantern.glb     # one asset, by either of its two names
 *
 * Two passes, in two processes. Pass A (tools/shrink-textures.mjs) does the texture work; pass B is
 * this file and does the geometry. They are split because the two sharp installs in this tree cannot
 * share a process — see the header of shrink-textures.mjs for the full story.
 *
 * Geometry, not texture, is the bulk of these files: the daayan is 114 MB of which 14 MB is images,
 * at 622k triangles for one character. So pass B is where most of the size goes, via weld +
 * meshoptimizer simplification, then EXT_meshopt_compression on what survives.
 */
import { readdirSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, weld, simplify, resample, meshopt, join as joinPrims } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';

const SRC = 'glb files';
const TMP = '.tmp-glb';
const DST = 'public/assets/models';
/**
 * How much of each texture's own resolution to keep — one number for the whole house.
 *
 * This replaced an absolute longest edge (256, with per-asset overrides to 512 and 1024) because the
 * clamp was throwing away detail out of all proportion to what it saved: every source map in this tree
 * is authored at 1024 or below, so 256 discarded 16/17ths of the texels on almost every asset and the
 * result read as mush at arm's length. A relative reduction needs no per-asset exceptions at all —
 * a map authored small stays small, and the room the player stands inside keeps its authored density —
 * which is why the `tex` field those exceptions used is gone.
 *
 * Now 1.0, i.e. authored resolution. The 0.8 it replaced was paying for a frame budget that measurement
 * says is not spent: the target phone renders the finished house in 13.2 ms against the 33.3 ms the
 * 30 FPS floor allows. See shrink-textures.mjs.
 */
const TEX_SCALE = 1.0;

/**
 * Which assets to build. Names match either side of the plan's rename, so one asset can be re-shipped
 * without rewriting the other ten: the outputs are inputs to a lot of hand-tuned placement numbers,
 * and a rebuild that only needed to touch the lantern should not put every other file back on the
 * clock. No arguments means the whole set.
 */
const only = process.argv.slice(2);

/**
 * Per-asset plan. `ratio` is the fraction of vertices to keep and `error` the tolerated deviation as
 * a fraction of mesh radius; omit both to leave geometry alone. The simplifier stops at whichever
 * bound it hits first, so a tiny ratio with a tight error barely moves — the error is the real dial,
 * and raising a ratio on its own buys nothing unless the error is tightened with it.
 *
 * **Every bound here was loosened once the frame budget was actually measured.** The original numbers
 * were picked against a guessed budget of 50k triangles; the target phone (Adreno 613, 90 Hz) draws the
 * finished house at 35.4k triangles in 13.2 ms, against the 33.3 ms that the 30 FPS floor allows. Two
 * thirds of the frame was being left on the table, and a mobile GPU spends far less on a vertex than on
 * the fragments it covers, so triangles were the cheapest thing being rationed. Each entry below now
 * pairs a higher ratio with a *tighter* error, since the error is what was binding on most of them.
 *
 * Characters get a tighter bound than furniture: a collapsed silhouette reads as a bug on something
 * that moves, whereas nobody inspects the underside of a bed in the dark.
 */
const PLAN = {
  // The daayan is 95% hair. See thinCardHair() for why the simplifier alone cannot touch it, and
  // why the gentler thinning below beats a harsher one. The hair fractions are raised further than
  // the body ratio because thinning strands is what visibly cost her: at 0.25/0.5 the silhouette had
  // gaps the room light came through, which reads as a broken asset rather than as a horror figure.
  // Wisps come back at a tenth rather than staying dropped — they are the flyaway strands that catch
  // the lantern, and alphaTest (not blending) is what makes a tenth of them affordable.
  'evil_old_lady.glb': {
    out: 'daayan.glb',
    ratio: 0.14,
    error: 0.02,
    dropMorphs: true,
    cards: { Wisps: 0.1, Base_Transparency: 0.35, Main_Transparency: 0.65 },
  },
  // Was 0.02/0.05, where the error bound was binding and this decorative cat still came out heavier
  // than the daayan herself (34k tris). Tightening the error is what lets the ratio matter.
  'fred_-_the_cat.glb': { out: 'cat-still.glb', ratio: 0.06, error: 0.03 },
  // The viewmodel fist, replacing fps_arms.glb's rig. A Revopoint photogrammetry scan: no rig, no
  // texture, one white material — 24 unskinned primitives, 2.47 M triangles, 1.55 M vertices, raw.
  // The object on screen in every frame of the game, seen 20-35 cm from the eye, which is why a scan
  // is worth its triangles where a wall is not: knuckle skin folds and finger gaps are what reads as
  // a closed hand rather than a mitten at that distance. Even so, 2.47 M is 70x the whole house
  // budget, so this takes the hardest collapse in the plan — ratio 0.02 of the vertices at an error
  // bound of 0.005 of the scan's own radius (the scan is 20 cm units, radius ~1.2 dm, so 0.005 keeps
  // features above half a millimetre). What survives is ~12-15k triangles of fist and forearm,
  // no normals repair needed (the scan ships NORMAL at the same density), no texture work (pass A
  // finds no images in the file and moves on), no animations to drop (there are none). It ships as
  // fist-left.glb: HeldLantern pins it by its measured fist box rather than by bones, since a scan
  // has none.
  'revopoint_inspire_-_strike_fist_-_767x203x154.glb': {
    out: 'fist-left.glb',
    join: true,
    ratio: 0.04,
    error: 0.001,
    dropAnims: true,
  },
  'bed_model_002.glb': { out: 'bed.glb', ratio: 0.15, error: 0.015 },
  // The viewmodel arms: 0.35 m from the near plane, never culled, and the object on screen in every
  // single frame of the game. It replaces arms_throwing.glb — the *same* 47-joint Sketchfab rig, bone
  // names identical down to R_pink4_045, so HeldLantern measures and pins it through the unchanged code
  // path; what differs is the stored pose. arms_throwing held the follow-through of a two-handed throw,
  // where the fist that carries the lantern is mid-swing; this one is authored as a held first-person
  // pose. It is also cheaper: 7.0k triangles against 9.8k, and it ships no animation at all.
  //
  // No `ratio`, deliberately. weld() + simplify() collapse vertices without regard for JOINTS_0 /
  // WEIGHTS_0, so a skinned primitive comes back with blended influences on the seams — on fingers at
  // 35 cm that reads as melted knuckles. It is already the cheapest hand this game has shipped.
  //
  // `dropAnims` is a no-op on this file (it has no clips) and stays as insurance: the viewmodel holds a
  // single pinned pose, so a clip arriving in some future re-export would fight HeldLantern's grip
  // measurement rather than be ignored, and it would drag IK helper nodes back in through prune().
  //
  // Its colour map needs flattenSpecGloss() in pass A — this is the one asset here that stores its
  // diffuse only inside KHR_materials_pbrSpecularGlossiness, which three.js cannot read.
  //
  // `tone` is the other thing pass A has to do to this file, and it is not cosmetic polish. This atlas is
  // bimodal where arms_throwing's was unimodal: 27% of its texels sit below luma 24 (black glove, black
  // cloth sleeve) against 3% on the old one, with a hole where the mid-tones should be. The lantern
  // PointLight is a camera child sitting to the *right* of the arm, so the face of the forearm the player
  // sees has a negative dot-N-L and is lit by ambient alone — measured on the device at 0.47 ambient
  // irradiance against 0.26 diffuse. Ambient times a near-black texel times ARMS_ALBEDO lands under
  // FilmGrade's own black floor, and because the arm sits in the bottom-right corner the vignette takes
  // off up to another half. What reaches the screen is a featureless black wedge with two brightly lit
  // fingertips — maximum contrast, no readable texture — on the one object present in every frame.
  //
  // The LUT is matched to arms_throwing.glb's own histogram, which is why that file stays in `glb files/`
  // although nothing ships it any more: it is the reference for what this arm is supposed to look like.
  'fps_arms.glb': { out: 'arms.glb', dropAnims: true, tone: 'tools/tone-lut-arms.json' },
  'an_animated_cat.glb': { out: 'cat.glb' },
  'cat_walk.glb': { out: 'cat-walk.glb' },
  'hexagonal_table_01.glb': { out: 'table.glb' },
  'knife.glb': { out: 'knife.glb' },
  // The held lantern, replacing metal_hanging_lantern.glb. 3.6k triangles, one material, and — the
  // reason it was chosen — a body that hangs below its handle, so it can swing from a pivot instead of
  // being parented rigid to the hand. Local bbox is 0.712 x 2.0 x 0.704 with the handle top at y = +1.
  'old_lantern.glb': { out: 'lantern.glb' },
  // The upper floor: a whole furnished room, walls/floor/ceiling included, already authored at metre
  // scale, and it takes no simplification. Its 33.5k triangles are 22 separate meshes of furniture,
  // none of which survives a 5% collapse the way a bed frame does, and it is one room at the end of a
  // staircase, drawn only when the player is up there.
  'room_scene.glb': { out: 'room-upper.glb' },
  // 4k triangles for a staircase is already cheap, and the ironwork-thin balusters are exactly what a
  // simplifier eats first.
  'wood_stair.glb': { out: 'stair-wood.glb' },
  'sun_painting.glb': { out: 'painting-sun.glb' },
  'sus_minecraft_painting.glb': { out: 'painting-sus.glb' },
  // The upper flat's own front door, in the opening at the top of the stair. 590 triangles, so there is
  // nothing for the simplifier to take — but its frame and leaf are drawn with 2.58 m and 2.37 m edges,
  // and this is the door the player stands inside the frame of. See subdivide().
  'door.glb': { out: 'door.glb', split: { placedHeight: 2.56, maxEdge: 1.0 } },
  // The leaf for the doorway carved through the flat's east partition, and the same file again for the
  // ground floor's bedroom door. 988 triangles across two meshes, so nothing to simplify; the 74-triangle
  // leaf carries 2.15 m edges and is the mesh a player squeezing past an ajar door gets closest to.
  'door_inner.glb': { out: 'door-inner.glb', split: { placedHeight: 2.15, maxEdge: 1.0 } },
  // The main gate, replacing the procedural one. 59.6k triangles is the most expensive single object in
  // the game and it is a slab with mouldings — the detail is in the maps, not the mesh, which is what
  // made it safe to take an eighth of the vertices where the daayan could only give up her hair. It is
  // also the first thing the player sees, lit from the front and inspected while three bolts are found,
  // so it now keeps a third of them at an error bound tightened to 0.006.
  'highpoly_medieval_door_for_vfxgames.glb': { out: 'gate-main.glb', ratio: 0.35, error: 0.006 },
  // The basement, replacing the procedural cellar. 14.8k triangles across 71 meshes is cheap enough to
  // leave alone, and its 43 images are mostly 256 and smaller already.
  'basement_scene.glb': { out: 'basement.glb' },
  // The lady's black magic room, off the basement. Same argument as room_scene: the player stands
  // inside it, and its 41k triangles are separate pieces of furniture, none of which survives a collapse.
  'living_room_interior.glb': { out: 'black-magic-room.glb' },
  // The ground floor's own walls, replacing painted boxes. Two variants so the same corridor can decay
  // as it goes: horror_wall_clean is a flat plastered panel, damaged_wall is the same wall with the
  // render blown off it. Both are single-material panels, so any triangle they have is silhouette.
  'damaged_wall.glb': { out: 'wall-damaged.glb' },
  'horror_wall_clean.glb': { out: 'wall-horror.glb' },
  // The sliding screen that hides the ritual doorway, replacing the procedural push-aside shelf. It
  // ships one clip, "Take 001", which slides the leaves apart — so no `ratio` and no `dropAnims`: weld()
  // and simplify() are what would break a clip that translates whole nodes, and the clip is the point of
  // the asset. HouseScene drives it from the interaction instead of playing it on load.
  'sliding_japanese_doors_animated.glb': { out: 'doors-sliding.glb' },
  // The ritual room's coffin, replacing the procedural plinth makeAltar() used to build out of boxes.
  // It ships two clips — "coffin_top|open.001" and "coffin_top|open.002" — both of which rotate the
  // lid node open, so — like the sliding doors — no `ratio` and no `dropAnims`: weld() and simplify()
  // are what break a clip that moves a whole node, and the lid opening is the point of the asset.
  // HouseScene drives it on puzzle-solve instead of playing it on load.
  'animated_coffin.glb': { out: 'coffin.glb' },
  /**
   * What is lying in it. Seen only once, from directly above, at the moment the lid swings back — but
   * seen from a metre away with a lantern held over it, which is the worst distance for a collapsed rib
   * cage. So a light hand: 0.55 of the vertices at a tight 0.008 bound keeps the ribs and the finger
   * bones, both of which are thin free-standing loops that a harder collapse welds into paddles.
   * `dropAnims` because the file's clips are study poses for a figure that is meant to lie still.
   */
  'skeleton_pre-cut.glb': { out: 'skeleton.glb', ratio: 0.55, error: 0.008, dropAnims: true },
  /**
   * The mother, lying in the hidden room. Same class of subject as `skeleton.glb` above — a thin
   * free-standing loop of ribs and finger bones that a hard collapse welds into paddles — so it takes
   * the same light hand. The source is only 2.4 MB across 3 nodes, so this is cheap either way.
   *
   * `dropAnims` is not strictly needed (the file ships none) but is stated for the same reason as its
   * neighbour: a figure meant to lie still should never be driven by a study pose, and a future
   * re-export of this file that happens to carry one must not silently start moving her.
   */
  'female_human_skeleton_-_zbrush_-_anatomy_study.glb': {
    out: 'skeleton-mother.glb',
    ratio: 0.55,
    error: 0.008,
    dropAnims: true,
  },
  /**
   * The heart necklace, on her neck. Under 10 cm once fitted, but it is the object the player leans in
   * to take, so it is seen from 30 cm rather than across a room and the chain is the whole of what
   * identifies it. 554 KB across 6 nodes to begin with, so a gentle bound is enough to matter and
   * nothing here needs a hero's budget.
   */
  'heart_necklace.glb': { out: 'necklace-heart.glb', ratio: 0.6, error: 0.01, dropAnims: true },
  /**
   * The Egyptian collar that replaced the heart necklace on her neck. Same bound and same reasoning:
   * it is looked at from inside the wardrobe, so the silhouette of the collar is what has to survive.
   */
  'egyptian_necklace.glb': { out: 'necklace-egyptian.glb', ratio: 0.6, error: 0.01, dropAnims: true },
  /**
   * The room behind the red-locked door. Unlike every other import here this one is a *space* the
   * player stands inside, so the bound is set by what the walls look like at arm's length rather than
   * by silhouette at three metres — and it is the largest source in the tree at 17 MB across 192
   * nodes, which is what a whole building interior costs.
   *
   * `dropAnims` because the file's single clip ("Take 01") is a walkthrough the scene never plays: the
   * player provides the camera. Keeping it would ship dead weight and, worse, leave a clip armed that
   * nothing holds shut.
   */
  'haunted_space_-_abandoned_diplomat_building.glb': {
    out: 'hidden-room.glb',
    ratio: 0.3,
    error: 0.015,
    dropAnims: true,
  },
  /**
   * The wooden floor, and the one entry here that ships an *image* rather than a model — `bake` instead
   * of `out`, handled by pass A2 (tools/bake-floor.mjs) and never reaching the geometry loop.
   *
   * It cannot ship as geometry at any bound. 187,716 triangles cover a 2.89 x 1.94 m patch, the house has
   * ~470 m2 of floor, and 84 copies of that patch is 15.7 M triangles against a whole-house budget of
   * 35k — so even a 99% collapse would cost more than every other asset in this table put together, and
   * what a collapse takes first is exactly the plank edges that are the only thing anyone looks at on a
   * floor. A floor is flat: all of its detail is in the map. See bake-floor.mjs for why the map has to be
   * baked from above rather than lifted out of the file.
   */
  'wooden_flooring.glb': { bake: 'public/assets/textures/floor-wood.webp', px: 1024 },
  // Bedroom dressing for the ground floor. Beds and a closet are all slab-and-frame shapes where the
  // detail is painted rather than modelled, so they take a collapse the way bed_model_002 does. The
  // bound is looser than the hero assets' because nobody inspects the underside of a bed in the dark —
  // but 0.2/0.03 was collapsing the turned bedposts and the closet's panel edges, which the player does
  // stand next to with a lantern.
  'old_closet.glb': { out: 'closet-old.glb', ratio: 0.45, error: 0.02 },
  'horror_bed.glb': { out: 'bed-horror.glb', ratio: 0.45, error: 0.02 },
  'hospital_bed.glb': { out: 'bed-hospital.glb', ratio: 0.45, error: 0.02 },
  'old_bed.glb': { out: 'bed-old.glb', ratio: 0.45, error: 0.02 },
  // Painted-wood furniture, same class as the beds and closet — carved detail that survives a 45% quad
  // collapse at 0.02 tolerance. The cushion uses the same simplify budget; the wood frame keeps enough
  // silhouette to read as gothic at three metres.
  'gothic_chair.glb': { out: 'gothic-chair.glb', ratio: 0.45, error: 0.02 },
  // The four touchable noise props: bottles and plates the player can knock. Each is under 30 cm once
  // fitted, so nothing here is silhouette across a room — but they are floor dressing the player walks
  // right up to and taps, which puts them at half a metre from the eye at the moment of interaction, and
  // a faceted bottle neck or a polygonal plate rim reads as a bug at that distance. plate.glb spends
  // 8.5k triangles on a disc and still takes the hardest collapse of the four; beer_bottle is 6k across
  // five primitives, where the cost is the five draw calls rather than the triangles, so it keeps most
  // of them. bottle.glb and old_ceramic_plate are already 2.1k and 576, which is nothing; their weight
  // is in their maps, and TEX_SCALE handles that for every entry alike.
  'plate.glb': { out: 'plate.glb', ratio: 0.25, error: 0.01 },
  'beer_bottle.glb': { out: 'bottle-beer.glb', ratio: 0.6, error: 0.006 },
  'bottle.glb': { out: 'bottle.glb' },
  'old_ceramic_plate.glb': { out: 'plate-ceramic.glb' },
  // Photogrammetry hallway facing: 49.7k triangles on an almost-flat wall. The texture/normal maps carry
  // the graffiti and mortar; keeping a quarter of the scan is still denser than damaged_wall's full
  // 2.2k triangles while avoiding the raw mesh cost on every pass through the corridor.
  'graffiti_wall_mendlak_brno.glb': { out: 'wall-graffiti.glb', ratio: 0.25, error: 0.012 },
  // Nine distributed furniture / room dressing assets:
  // Chateau armoire with animated swinging doors and sliding drawer. No simplify: node animations must not be broken.
  'furniture_chateau_de_la_foret.glb': { out: 'wardrobe-chateau.glb' },
  // Bedroom vanity with lamp and animated sliding drawer. Pass A flattens its KHR_materials_pbrSpecularGlossiness map.
  'furniture_for_bedroom.glb': { out: 'dresser-bedroom.glb' },
  // Summer cafe table and folding chairs for back corridor.
  'furniture_pack_for_summer_caffe_free.glb': { out: 'caffe-set.glb' },
  // Bedside cabinet with animated rotating door and sliding drawer.
  'low_poly_animated_furniture_-_game_ready.glb': { out: 'cabinet-animated.glb' },
  // Complete kitchen cabinetry suite.
  'low_poly_kitchen_furniture_-_game_ready.glb': { out: 'kitchen-counter.glb' },
  // Industrial steel mechanical / workshop table.
  'mechanical_table.glb': { out: 'table-mechanical.glb' },
  // Antique round carved pedestal table.
  'antique_table.glb': { out: 'table-antique.glb' },
  // High-poly antique iron key model.
  'key.glb': { out: 'key-iron.glb', ratio: 0.35, error: 0.01 },
};

/** Triangles across every primitive, so the reduction is reported rather than assumed. */
function triangles(doc) {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      const pos = prim.getAttribute('POSITION');
      n += Math.floor(((idx ?? pos)?.getCount() ?? 0) / 3);
    }
  }
  return n;
}

/**
 * Bound the longest *triangle* edge of an imported asset, in the metres it will occupy in the game.
 *
 * This is the imported half of the 2026-09-04 wedge fix. A triangle with a vertex near the camera
 * plane has w -> 0, so its 1/w depth interpolation collapses and the fragment's depth lands metres
 * out: a black wedge that changes shape as the player moves. That pass bounded every *procedural*
 * triangle to 1 m — Fixtures.boxMesh, Batch.box, HouseBuilder.slabPlane/worldBox, the stair rail — and
 * measured `posesWithWedge 17 -> 0`. It could not touch imported art, and nothing else here would
 * either: weld() and simplify() only ever take triangles *away*. So a door leaf still ships as the
 * two or three big triangles the artist drew it with, and a door is the one piece of architecture the
 * player routinely stands 20 cm from, looking along it, with the leaf swung towards the eye.
 *
 * Measured with tools/glb-edges.mjs, at the heights MODEL_PLACEMENTS actually asks for:
 *
 *     door-inner.glb  988 tris   longest edge 2.15 m    48 over 1 m
 *     door.glb        590 tris   longest edge 2.58 m    92 over 1 m
 *
 * `maxEdge` is in world metres and `placedHeight` is the tallest height any placement fits this file
 * to, since that is the scale at which the bound has to hold; both are per asset because neither is
 * derivable from the file. Local limit per primitive is therefore
 * `maxEdge * docHeight / (placedHeight * nodeScale)`.
 *
 * Refinement is edge-based rather than per-triangle bisection, which matters: bisecting each triangle
 * independently until *it* is short enough leaves a T-junction wherever two neighbours stopped at
 * different depths, and a T-junction is a hairline crack you can see the fog through. Here every edge
 * that is too long is split in *every* triangle that owns it, at a midpoint keyed by the edge's
 * quantised endpoints, so both sides of a shared edge get a bit-identical vertex position. Attributes
 * are still averaged per triangle, so a hard normal or UV seam stays hard.
 */
function subdivide(doc, cfg) {
  const maxEdge = cfg.maxEdge ?? 1.0;
  const placed = cfg.placedHeight;
  if (!placed) throw new Error('split needs placedHeight');

  // Doc-space height of the whole file, which is what ModelLoader.fitToHeight normalises against.
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const nodes = [];
  for (const scene of doc.getRoot().listScenes()) {
    const walk = (node) => {
      const mesh = node.getMesh();
      const m = node.getWorldMatrix();
      if (mesh) nodes.push({ mesh, m });
      for (const child of node.listChildren()) walk(child);
    };
    for (const node of scene.listChildren()) walk(node);
  }
  const p = [0, 0, 0];
  for (const { mesh, m } of nodes) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, p);
        for (let k = 0; k < 3; k++) {
          const w = m[k] * p[0] + m[4 + k] * p[1] + m[8 + k] * p[2] + m[12 + k];
          if (w < lo[k]) lo[k] = w;
          if (w > hi[k]) hi[k] = w;
        }
      }
    }
  }
  const docHeight = hi[1] - lo[1];
  if (!(docHeight > 0)) throw new Error('split: file has no height');

  let before = 0;
  let after = 0;
  for (const { mesh, m } of nodes) {
    // Largest column norm of the upper-left 3x3: the factor by which this node stretches a local
    // length. Exact for the rigid-plus-uniform-scale transforms these files carry.
    const nodeScale = Math.max(
      Math.hypot(m[0], m[1], m[2]),
      Math.hypot(m[4], m[5], m[6]),
      Math.hypot(m[8], m[9], m[10]),
    );
    const limit = (maxEdge * docHeight) / (placed * Math.max(nodeScale, 1e-9));
    for (const prim of mesh.listPrimitives()) {
      const grew = refinePrimitive(doc, prim, limit);
      before += grew.before;
      after += grew.after;
    }
  }
  return { before, after, docHeight };
}

/** glTF element counts to accessor type names. */
const ACCESSOR_TYPE = { 1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4' };

/**
 * Split every edge of one primitive that is longer than `limit`, repeatedly, until none is.
 *
 * Skipped rather than half-done when the data is something this cannot rewrite faithfully: a
 * non-TRIANGLES mode, a skinned or morphed primitive, or a quantised attribute whose integer
 * component type would be destroyed by writing floats through it. Each of those prints, because a
 * silent skip here is a bound that looks enforced and is not.
 */
function refinePrimitive(doc, prim, limit) {
  const none = { before: 0, after: 0 };
  const pos = prim.getAttribute('POSITION');
  if (!pos) return none;
  if (prim.getMode() !== 4) {
    console.error(`  ! split skipped: primitive mode ${prim.getMode()} is not TRIANGLES`);
    return none;
  }
  if (prim.listTargets().length > 0 || prim.getAttribute('JOINTS_0')) {
    console.error('  ! split skipped: skinned or morphed primitive');
    return none;
  }
  const sems = prim.listSemantics();
  const src = sems.map((s) => prim.getAttribute(s));
  const FLOAT = 5126;
  const odd = sems.filter((s, k) => src[k].getComponentType() !== FLOAT);
  if (odd.length > 0) {
    console.error(`  ! split skipped: non-float attribute(s) ${odd.join(' ')}`);
    return none;
  }
  const dims = src.map((a) => a.getElementSize());
  const posK = sems.indexOf('POSITION');
  // TANGENT's 4th component is a handedness sign, not a quantity: averaging +1 and -1 gives 0, and a
  // zero w means a zero bitangent, which kills normal mapping on every triangle touching that vertex.
  // Both ends of a real shared edge normally agree, but door.glb has two edges that straddle a
  // handedness flip, and its normal map is the one doing visible work on the geometry the player
  // presses their face against. Carry the sign from an endpoint instead of blending it.
  const signK = sems.indexOf('TANGENT');

  // One flat array per attribute, addressed by vertex index. Originals are kept and midpoints are
  // appended, so existing indices stay valid across passes.
  const data = src.map((a, k) => {
    const d = dims[k];
    const out = new Array(a.getCount() * d);
    const tmp = new Array(d);
    for (let i = 0; i < a.getCount(); i++) {
      a.getElement(i, tmp);
      for (let c = 0; c < d; c++) out[i * d + c] = tmp[c];
    }
    return out;
  });
  let count = pos.getCount();

  const idxAcc = prim.getIndices();
  const n = idxAcc ? idxAcc.getCount() : pos.getCount();
  let tris = [];
  for (let i = 0; i + 2 < n; i += 3) {
    tris.push(
      idxAcc
        ? [idxAcc.getScalar(i), idxAcc.getScalar(i + 1), idxAcc.getScalar(i + 2)]
        : [i, i + 1, i + 2],
    );
  }
  const before = tris.length;

  const P = data[posK];
  const lenOf = (a, b) =>
    Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]);
  /**
   * An edge's identity, by quantised endpoint positions rather than vertex indices. Two triangles
   * that meet along a hard normal or UV seam do not share indices there, only coordinates, and if the
   * seam's two sides disagreed about whether the edge is long one of them would not split and the
   * crack would open exactly along the seam.
   */
  const key = (a, b) => {
    const q = (i) =>
      `${Math.round(P[i * 3] * 1e5)},${Math.round(P[i * 3 + 1] * 1e5)},${Math.round(P[i * 3 + 2] * 1e5)}`;
    const ka = q(a);
    const kb = q(b);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };

  // Passes, not recursion: each pass halves every over-long edge, and the medians it creates are
  // measured again on the next one. 8 is 256x on a side and no asset here needs two.
  for (let pass = 0; pass < 8; pass++) {
    const long = new Set();
    for (const t of tris) {
      for (let e = 0; e < 3; e++) {
        const a = t[e];
        const b = t[(e + 1) % 3];
        if (lenOf(a, b) > limit) long.add(key(a, b));
      }
    }
    if (long.size === 0) break;

    const midCache = new Map();
    const midOf = (a, b) => {
      const kk = key(a, b);
      const hit = midCache.get(kk);
      if (hit !== undefined) return hit;
      for (let k = 0; k < data.length; k++) {
        const d = dims[k];
        for (let c = 0; c < d; c++) {
          const av = data[k][a * d + c];
          const bv = data[k][b * d + c];
          data[k].push(k === signK && c === 3 ? av : (av + bv) * 0.5);
        }
      }
      midCache.set(kk, count);
      return count++;
    };

    const next = [];
    for (const t of tris) {
      const marked = [0, 1, 2].map((e) => long.has(key(t[e], t[(e + 1) % 3])));
      const cnt = marked.reduce((s, m) => s + (m ? 1 : 0), 0);
      if (cnt === 0) {
        next.push(t);
      } else if (cnt === 3) {
        const [v0, v1, v2] = t;
        const m01 = midOf(v0, v1);
        const m12 = midOf(v1, v2);
        const m20 = midOf(v2, v0);
        next.push([v0, m01, m20], [m01, v1, m12], [m20, m12, v2], [m01, m12, m20]);
      } else if (cnt === 1) {
        // Relabel so the one long edge is v0-v1.
        const e = marked.indexOf(true);
        const v0 = t[e];
        const v1 = t[(e + 1) % 3];
        const v2 = t[(e + 2) % 3];
        const m = midOf(v0, v1);
        next.push([v0, m, v2], [m, v1, v2]);
      } else {
        // Relabel so the one *short* edge is v0-v1; the other two are split.
        const u = marked.indexOf(false);
        const v0 = t[u];
        const v1 = t[(u + 1) % 3];
        const v2 = t[(u + 2) % 3];
        const m12 = midOf(v1, v2);
        const m20 = midOf(v2, v0);
        next.push([v0, v1, m12], [v0, m12, m20], [m12, v2, m20]);
      }
    }
    tris = next;
  }

  const after = tris.length;
  if (after === before) return { before, after };

  const buffer = doc.getRoot().listBuffers()[0];
  for (let k = 0; k < sems.length; k++) {
    const d = dims[k];
    prim.setAttribute(
      sems[k],
      doc
        .createAccessor(sems[k])
        .setType(ACCESSOR_TYPE[d])
        .setArray(new Float32Array(data[k]))
        .setBuffer(buffer),
    );
  }
  const flat = new Uint32Array(after * 3);
  for (let i = 0; i < after; i++) {
    flat[i * 3] = tris[i][0];
    flat[i * 3 + 1] = tris[i][1];
    flat[i * 3 + 2] = tris[i][2];
  }
  prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(flat).setBuffer(buffer));
  return { before, after };
}

function dropMorphTargets(doc) {
  let dropped = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      for (const target of prim.listTargets()) {
        prim.removeTarget(target);
        target.dispose();
        dropped++;
      }
    }
    mesh.setWeights([]);
  }
  for (const anim of doc.getRoot().listAnimations()) {
    for (const ch of anim.listChannels()) if (ch.getTargetPath() === 'weights') ch.dispose();
  }
  return dropped;
}

/**
 * Remove every animation, leaving the skin and its rest pose intact.
 *
 * For an asset the game holds as a static pose this is not just dead weight — a clip in the file is a
 * standing invitation for someone to wire an AnimationMixer to it later and quietly break the pose.
 * The keyframe accessors go with the samplers, and any node the clips were the only reference to (IK
 * goals, arm poles) stops being reachable, so the following prune() takes those too. Joint nodes are
 * referenced by the skin, so they stay.
 */
function dropAnimations(doc) {
  const anims = doc.getRoot().listAnimations();
  const n = anims.length;
  for (const anim of anims) {
    for (const ch of anim.listChannels()) ch.dispose();
    for (const s of anim.listSamplers()) s.dispose();
    anim.dispose();
  }
  return n;
}

/**
 * Thin card hair by dropping whole strands. Must run after weld() and before simplify().
 *
 * The daayan's hair is 526k of her 622k triangles, and the simplifier is nearly powerless against
 * it: it is ~5,700 alpha-textured ribbons of exactly 68 triangles, each an isolated connected
 * component. Collapsing an edge across a ribbon's width destroys it, so almost every candidate
 * collapse is high-error and the whole thing survives (measured: 526k -> 179k at error 0.05, while
 * the body reaches the 5% target exactly). Cheap fill-rate matters too — these are transparent.
 *
 * So instead of asking for finer strands, we ask for fewer, which is what artists do by hand: label
 * components with union-find, then keep every Nth. `rules` maps a substring of the mesh name to the
 * fraction of strands to keep, 0 meaning drop the primitive outright.
 */
function thinCardHair(doc, rules) {
  let removed = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    const rule = Object.entries(rules).find(([key]) => (mesh.getName() || '').includes(key));
    if (!rule) continue;
    const keep = rule[1];
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      if (keep === 0 || !idx) {
        removed += Math.floor((idx?.getCount() ?? 0) / 3);
        prim.dispose();
        continue;
      }
      const n = idx.getCount();
      const parent = new Int32Array(prim.getAttribute('POSITION').getCount()).fill(-1);
      const find = (x) => {
        let root = x;
        while (parent[root] >= 0) root = parent[root];
        while (parent[x] >= 0) [parent[x], x] = [root, parent[x]]; // path compression
        return root;
      };
      const union = (a, b) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent[rb] = ra;
      };
      for (let i = 0; i < n; i += 3) {
        union(idx.getScalar(i), idx.getScalar(i + 1));
        union(idx.getScalar(i + 1), idx.getScalar(i + 2));
      }
      // Rank strands in first-seen order so the survivors are spread over the head, not clustered.
      const rank = new Map();
      const step = Math.round(1 / keep);
      const kept = [];
      for (let i = 0; i < n; i += 3) {
        const root = find(idx.getScalar(i));
        if (!rank.has(root)) rank.set(root, rank.size);
        if (rank.get(root) % step === 0) kept.push(idx.getScalar(i), idx.getScalar(i + 1), idx.getScalar(i + 2));
      }
      removed += (n - kept.length) / 3;
      idx.setArray(new Uint32Array(kept));
    }
    if (mesh.listPrimitives().length === 0) mesh.dispose();
  }
  return removed;
}

async function main() {
  const plan = Object.entries(PLAN).filter(
    ([name, cfg]) => only.length === 0 || only.includes(name) || only.includes(cfg.out) || only.includes(cfg.bake),
  );
  if (plan.length === 0) {
    console.error(`nothing in the plan matches: ${only.join(' ')}`);
    process.exit(1);
  }
  // An entry ships either a model (`out`, the geometry loop below) or a baked image (`bake`, pass A2).
  // Never both: a bake entry's source is far too heavy to ship as geometry, which is why it is baked.
  const geoPlan = plan.filter(([, cfg]) => cfg.out);
  const bakePlan = plan.filter(([, cfg]) => cfg.bake);

  // Pass A2, before the texture pass so a bake failure stops the run early. Own process for the same
  // reason pass A has one — see bake-floor.mjs — and reading the *raw* file, not TMP: the bake resolves
  // the source atlas's UV packing itself, so pass A's re-encode would only cost time here.
  for (const [name, cfg] of bakePlan) {
    const bake = spawnSync(
      process.execPath,
      ['tools/bake-floor.mjs', join(SRC, name), cfg.bake, String(cfg.px ?? 1024)],
      { stdio: 'inherit' },
    );
    if (bake.status !== 0) {
      console.error(`bake failed for ${name} (exit ${bake.status})`);
      process.exit(bake.status ?? 1);
    }
  }
  if (geoPlan.length === 0) return;

  // Pass A, in its own process. One invocation for the whole batch: the reduction is relative to each
  // image's own size, so there is nothing left to group by. inherit so its table and any texture
  // failures reach the terminal. The tone map goes as JSON rather than as a flag per asset because it is
  // per-asset data, and only the assets in this run's plan are listed — a LUT for an asset nobody asked
  // to rebuild would be read for nothing.
  const texPass = spawnSync(
    process.execPath,
    [
      'tools/shrink-textures.mjs',
      SRC,
      TMP,
      String(TEX_SCALE),
      geoPlan.map(([name]) => name).join(','),
      JSON.stringify(
        Object.fromEntries(geoPlan.filter(([, cfg]) => cfg.tone).map(([name, cfg]) => [name, cfg.tone])),
      ),
    ],
    { stdio: 'inherit' },
  );
  if (texPass.status !== 0) {
    console.error(`texture pass failed (exit ${texPass.status}) — stopping before geometry.`);
    process.exit(texPass.status ?? 1);
  }

  mkdirSync(DST, { recursive: true });
  await MeshoptSimplifier.ready;
  await MeshoptEncoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

  const staged = new Set(readdirSync(TMP).filter((f) => f.toLowerCase().endsWith('.glb')));
  for (const name of staged) if (!PLAN[name]) console.error(`! no plan entry for ${name} — not shipped`);

  const rows = [];
  for (const [name, cfg] of geoPlan) {
    if (!staged.has(name)) {
      console.error(`! missing ${name}`);
      continue;
    }
    const rawBytes = statSync(join(SRC, name)).size;
    const doc = await io.read(join(TMP, name));
    const trisBefore = triangles(doc);

    const steps = [];
    if (cfg.join) steps.push(joinPrims({ keepNamed: false }));
    steps.push(dedup(), prune({ keepAttributes: false, keepIndices: false }));
    if (cfg.ratio) {
      // weld first: the simplifier collapses shared vertices, and an unwelded export has none.
      // Card thinning also needs welded indices, or every triangle looks like its own strand.
      steps.push(weld());
      if (cfg.cards) steps.push((d) => void thinCardHair(d, cfg.cards));
      steps.push(simplify({ simplifier: MeshoptSimplifier, ratio: cfg.ratio, error: cfg.error ?? 0.01 }));
    }
    // After any simplification, because the simplifier would take straight back out what this puts in,
    // and before resample/prune/meshopt, which are the encoders.
    let split = null;
    if (cfg.split) steps.push((d) => void (split = subdivide(d, cfg.split)));
    steps.push(resample(), prune(), meshopt({ encoder: MeshoptEncoder, level: 'high' }));
    await doc.transform(...steps);
    await io.write(join(DST, cfg.out), doc);

    const outBytes = statSync(join(DST, cfg.out)).size;
    rows.push({
      asset: `${basename(name)} -> ${cfg.out}`,
      MB: `${(rawBytes / 1048576).toFixed(1)} -> ${(outBytes / 1048576).toFixed(2)}`,
      cut: `${Math.round((1 - outBytes / rawBytes) * 100)}%`,
      tris: `${trisBefore} -> ${triangles(doc)}`,
      split: split ? `${split.before} -> ${split.after} @${cfg.split.maxEdge}m` : '',
    });
  }

  console.table(rows);
  const shipped = rows.reduce((n, r) => n + parseFloat(r.MB.split('-> ')[1]), 0);
  const raw = rows.reduce((n, r) => n + parseFloat(r.MB.split(' ->')[0]), 0);
  const tris = rows.reduce((n, r) => n + parseInt(r.tris.split('-> ')[1], 10), 0);
  console.log(`raw ${raw.toFixed(1)} MB -> shipped ${shipped.toFixed(2)} MB, ${tris} triangles total`);
  rmSync(TMP, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
