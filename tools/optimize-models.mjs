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
import { dedup, prune, weld, simplify, resample, meshopt } from '@gltf-transform/functions';
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
  'bed_model_002.glb': { out: 'bed.glb', ratio: 0.15, error: 0.015 },
  // The viewmodel arms: 0.35 m from the near plane, never culled, and the object on screen in every
  // single frame of the game. It replaces hand.glb, an unskinned open hand whose straight fingers no
  // Euler could curl — this is a 47-joint rig whose *stored rest pose* already closes the digits, which
  // is the whole reason for the swap, and it costs 9.8k triangles against hand.glb's 41.2k.
  //
  // No `ratio`, deliberately. weld() + simplify() collapse vertices without regard for JOINTS_0 /
  // WEIGHTS_0, so a skinned primitive comes back with blended influences on the seams — on fingers at
  // 35 cm that reads as melted knuckles. It is already the cheapest hand this game has shipped.
  //
  // `dropAnims` removes the one 0.667 s "throw" clip: the game holds a pose and never plays it, and
  // with the clip gone the IK helper nodes it was the only reference to (R_wrist_Goal, L_wrist_Goal,
  // both arm poles) fall out in prune() as well.
  'arms_throwing.glb': { out: 'arms.glb', dropAnims: true },
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
  // nothing for the simplifier to take.
  'door.glb': { out: 'door.glb' },
  // The leaf for the doorway carved through the flat's east partition, and the same file again for the
  // ground floor's bedroom door. 988 triangles across two meshes, so nothing to simplify.
  'door_inner.glb': { out: 'door-inner.glb' },
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
  // Bedroom dressing for the ground floor. Beds and a closet are all slab-and-frame shapes where the
  // detail is painted rather than modelled, so they take a collapse the way bed_model_002 does. The
  // bound is looser than the hero assets' because nobody inspects the underside of a bed in the dark —
  // but 0.2/0.03 was collapsing the turned bedposts and the closet's panel edges, which the player does
  // stand next to with a lantern.
  'old_closet.glb': { out: 'closet-old.glb', ratio: 0.45, error: 0.02 },
  'horror_bed.glb': { out: 'bed-horror.glb', ratio: 0.45, error: 0.02 },
  'hospital_bed.glb': { out: 'bed-hospital.glb', ratio: 0.45, error: 0.02 },
  'old_bed.glb': { out: 'bed-old.glb', ratio: 0.45, error: 0.02 },
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
 * Remove morph targets and the animation channels that drive them. These are facial blend shapes on
 * the daayan's head primitives (931 of them, 13 weight channels); the game has no facial animation
 * system and Lambert at lantern range would not show one, so they are data we would compress and
 * upload for nothing. Skeletal animation is untouched.
 */
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
    ([name, cfg]) => only.length === 0 || only.includes(name) || only.includes(cfg.out),
  );
  if (plan.length === 0) {
    console.error(`nothing in the plan matches: ${only.join(' ')}`);
    process.exit(1);
  }

  // Pass A, in its own process. One invocation for the whole batch: the reduction is relative to each
  // image's own size, so there is nothing left to group by. inherit so its table and any texture
  // failures reach the terminal.
  const texPass = spawnSync(
    process.execPath,
    ['tools/shrink-textures.mjs', SRC, TMP, String(TEX_SCALE), plan.map(([name]) => name).join(',')],
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
  for (const [name, cfg] of plan) {
    if (!staged.has(name)) {
      console.error(`! missing ${name}`);
      continue;
    }
    const rawBytes = statSync(join(SRC, name)).size;
    const doc = await io.read(join(TMP, name));
    const trisBefore = triangles(doc);

    if (cfg.dropMorphs) dropMorphTargets(doc);
    if (cfg.dropAnims) dropAnimations(doc);
    const steps = [dedup(), prune({ keepAttributes: false, keepIndices: false })];
    if (cfg.ratio) {
      // weld first: the simplifier collapses shared vertices, and an unwelded export has none.
      // Card thinning also needs welded indices, or every triangle looks like its own strand.
      steps.push(weld());
      if (cfg.cards) steps.push((d) => void thinCardHair(d, cfg.cards));
      steps.push(simplify({ simplifier: MeshoptSimplifier, ratio: cfg.ratio, error: cfg.error ?? 0.01 }));
    }
    steps.push(resample(), prune(), meshopt({ encoder: MeshoptEncoder, level: 'high' }));
    await doc.transform(...steps);
    await io.write(join(DST, cfg.out), doc);

    const outBytes = statSync(join(DST, cfg.out)).size;
    rows.push({
      asset: `${basename(name)} -> ${cfg.out}`,
      MB: `${(rawBytes / 1048576).toFixed(1)} -> ${(outBytes / 1048576).toFixed(2)}`,
      cut: `${Math.round((1 - outBytes / rawBytes) * 100)}%`,
      tris: `${trisBefore} -> ${triangles(doc)}`,
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
