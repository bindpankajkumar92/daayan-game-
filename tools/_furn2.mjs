/**
 * _furn2.mjs — world-space boxes for the nine new furniture GLBs.
 *
 * _furn1.mjs prints local node transforms and per-mesh local boxes, which is enough to see structure
 * but not to place anything: a Sketchfab export hides its real scale in a 0.014 root, and composing the
 * chain by hand is exactly the kind of arithmetic this tree keeps getting wrong. This walks the node
 * tree with full TRS composition (same math three.js does), measures each node's subtree box in world
 * metres, and prints top-level pieces individually so a multi-prop pack can be split for placement.
 * Throwaway; nothing written.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const SRC = 'glb files';
const FILES = process.argv.slice(2).length > 0 ? process.argv.slice(2) : [
  'furniture_chateau_de_la_foret.glb',
  'furniture_for_bedroom.glb',
  'furniture_pack_for_summer_caffe_free.glb',
  'key.glb',
  'low_poly_abandoned_brick_room.glb',
  'low_poly_animated_furniture_-_game_ready.glb',
  'low_poly_kitchen_furniture_-_game_ready.glb',
  'mechanical_table.glb',
  'antique_table.glb',
];

await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

// quaternion multiply
const qMul = (a, b) => [
  a[0] * b[3] + a[3] * b[0] + a[1] * b[2] - a[2] * b[1],
  a[1] * b[3] + a[3] * b[1] + a[2] * b[0] - a[0] * b[2],
  a[2] * b[3] + a[3] * b[2] + a[0] * b[1] - a[1] * b[0],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qMulV = (q, v) => {
  // v' = q * v * q^-1, expanded
  const [x, y, z] = v;
  const [qx, qy, qz, qw] = q;
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
};

// compose a local TRS into a world {p, q, s} from a parent's
const compose = (pt, pr, ps, t, r, s) => ({
  p: [pt[0] + ps[0] * (qMulV(pr, t))[0], pt[1] + ps[1] * (qMulV(pr, t))[1], pt[2] + ps[2] * (qMulV(pr, t))[2]],
  q: qMul(pr, r),
  s: [ps[0] * s[0], ps[1] * s[1], ps[2] * s[2]],
});

const V = (n) => [n.getX ? n.getX(0) : 0, 0, 0]; // unused guard

for (const name of FILES) {
  const doc = await io.read(join(SRC, name));
  const root = doc.getRoot();
  console.log(`\n================ ${name} (${(statSync(join(SRC, name)).size / 1048576).toFixed(2)} MB)`);

  const boxes = []; // {node, path, box}
  // measure a node's own mesh vertices under a world {p,q,s}
  const meshBox = (node, W) => {
    const mesh = node.getMesh();
    if (!mesh) return null;
    const mn = [Infinity, Infinity, Infinity];
    const mx = [-Infinity, -Infinity, -Infinity];
    let any = false;
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue;
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const v = [0, 0, 0];
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, v);
        // world = p + q*(s*v)
        const sv = [W.s[0] * v[0], W.s[1] * v[1], W.s[2] * v[2]];
        const wv = qMulV(W.q, sv);
        for (let k = 0; k < 3; k++) {
          const c = W.p[k] + wv[k];
          if (c < mn[k]) mn[k] = c;
          if (c > mx[k]) mx[k] = c;
        }
        any = true;
      }
    }
    return any ? { mn, mx } : null;
  };

  const walk = (node, W, path, depth) => {
    const t = [...node.getTranslation()];
    const r = [...node.getRotation()];
    const s = [...node.getScale()];
    const Wn = compose(W.p, W.q, W.s, t, r, s);
    const b = meshBox(node, Wn);
    if (b) {
      boxes.push({
        name: node.getName() || '<node>',
        path: `${path}/${node.getName() || '<node>'}`,
        box: b,
        depth,
      });
    }
    for (const c of node.listChildren()) walk(c, Wn, `${path}/${node.getName() || ''}`, depth + 1);
  };

  for (const scene of root.listScenes()) {
    for (const c of scene.listChildren()) {
      walk(c, { p: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] }, '', 0);
    }
  }

  // whole-scene box
  const gmn = [Infinity, Infinity, Infinity];
  const gmx = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) for (let k = 0; k < 3; k++) { gmn[k] = Math.min(gmn[k], b.box.mn[k]); gmx[k] = Math.max(gmx[k], b.box.mx[k]); }
  const f = (x) => +x.toFixed(3);
  console.log(`  WHOLE ${gmn.map(f)} .. ${gmx.map(f)}  size ${(gmx[0] - gmn[0]).toFixed(3)} x ${(gmx[1] - gmn[1]).toFixed(3)} x ${(gmx[2] - gmn[2]).toFixed(3)}`);
  for (const b of boxes) {
    const { mn, mx } = b.box;
    console.log(
      `  ${'  '.repeat(b.depth)}${b.name}: ${mn.map(f)} .. ${mx.map(f)}  size ${(mx[0] - mn[0]).toFixed(3)} x ${(mx[1] - mn[1]).toFixed(3)} x ${(mx[2] - mn[2]).toFixed(3)}`,
    );
  }
}
