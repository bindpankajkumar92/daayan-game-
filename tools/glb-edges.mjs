/**
 * Longest *triangle* edge in a GLB, in world metres, after node transforms and a game scale.
 *
 * Round 1 of the "view glitch" hunt bounded procedural triangles to <=1 m because a triangle with a
 * vertex near the camera plane has w -> 0, its 1/w interpolation collapses, and the fragment's depth
 * lands metres out — a black wedge that changes shape as the player moves. That pass covered
 * Fixtures.boxMesh, Batch.box, HouseBuilder.slabPlane/worldBox and the stair rail. It did not cover
 * imported geometry, and optimize-models.mjs only ever *simplifies*: weld + meshopt take triangles
 * away, nothing in the pipeline subdivides. So an imported door slab still ships as whatever few big
 * triangles the artist gave it, and a door leaf is the one piece of architecture the player routinely
 * stands 20 cm from with the camera looking along it.
 *
 * Usage — one or more model names, with the world scale each is instanced at:
 *
 *     node tools/glb-edges.mjs door-inner.glb=1.9 door.glb=2.05
 *     node tools/glb-edges.mjs door-inner.glb          (scale defaults to 1)
 *
 * Reports per primitive: triangle count, longest edge, and how many triangles exceed 1 m, since that
 * is the threshold round 1 settled on.
 */

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const MODELS = 'public/assets/models';
const LIMIT = 1.0; // metres — round 1's bound on the longest triangle edge

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: node tools/glb-edges.mjs <name.glb>[=scale] ...');
  console.error('available:', readdirSync(MODELS).filter((f) => f.endsWith('.glb')).join(' '));
  process.exit(2);
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.decoder': MeshoptDecoder,
});

/** 4x4 (column-major, glTF order) times a point. */
function xform(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

function mul(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}

for (const arg of args) {
  const [name, scaleTxt] = arg.split('=');
  const scale = scaleTxt === undefined ? 1 : Number(scaleTxt);
  const doc = await io.read(join(MODELS, name));

  console.log(`\n${name}  (world scale ${scale})`);
  console.log('  primitive                       tris   longest edge   >1m');

  let worstAll = 0;
  let overAll = 0;
  let trisAll = 0;
  // Bounding box, so the caller can turn MODEL_PLACEMENTS' `height` into the scale to pass back in:
  // the loader fits a model to `height`, so scale = height / bboxHeight.
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];

  // Walk every node so the local transforms are included; a door leaf is usually a child node that
  // carries the hinge offset and sometimes a rotation.
  for (const scene of doc.getRoot().listScenes()) {
    const walk = (node, parent) => {
      const world = mul(parent, node.getWorldMatrix ? node.getMatrix() : node.getMatrix());
      const mesh = node.getMesh();
      if (mesh) {
        for (const prim of mesh.listPrimitives()) {
          const pos = prim.getAttribute('POSITION');
          if (!pos) continue;
          const idx = prim.getIndices();
          const count = idx ? idx.getCount() : pos.getCount();
          const at = (i) => (idx ? idx.getScalar(i) : i);
          const p = [0, 0, 0];
          let worst = 0;
          let over = 0;
          for (let i = 0; i + 2 < count; i += 3) {
            const v = [];
            for (let k = 0; k < 3; k++) {
              pos.getElement(at(i + k), p);
              const w = xform(world, p[0], p[1], p[2]);
              for (let k2 = 0; k2 < 3; k2++) {
                if (w[k2] < lo[k2]) lo[k2] = w[k2];
                if (w[k2] > hi[k2]) hi[k2] = w[k2];
              }
              v.push([w[0] * scale, w[1] * scale, w[2] * scale]);
            }
            let longest = 0;
            for (let e = 0; e < 3; e++) {
              const a = v[e];
              const b = v[(e + 1) % 3];
              const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
              if (d > longest) longest = d;
            }
            if (longest > worst) worst = longest;
            if (longest > LIMIT) over++;
          }
          const tris = Math.floor(count / 3);
          const label = `${node.getName() || '(unnamed)'}/${mesh.getName() || 'mesh'}`;
          console.log(
            `  ${label.slice(0, 30).padEnd(30)} ${String(tris).padStart(6)}   ` +
              `${worst.toFixed(2).padStart(9)} m   ${String(over).padStart(4)}`,
          );
          worstAll = Math.max(worstAll, worst);
          overAll += over;
          trisAll += tris;
        }
      }
      for (const child of node.listChildren()) walk(child, world);
    };
    for (const node of scene.listChildren()) walk(node, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  }

  console.log(
    `  TOTAL ${trisAll} tris, longest ${worstAll.toFixed(2)} m, ` +
      `${overAll} triangle(s) over ${LIMIT} m`,
  );
  const size = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  console.log(
    `  bbox (unscaled) ${size.map((s) => s.toFixed(3)).join(' x ')} m` +
      `   -> a placement of height H uses scale H/${size[1].toFixed(3)}`,
  );
}
