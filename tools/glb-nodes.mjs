/**
 * Node/skin/animation dump for a GLB, straight out of the JSON chunk. Enough to decide whether a
 * rigged file can be used as a static pose: how many joints, what the animation actually drives, and
 * where the mesh's own bounding box sits before anything is fitted.
 *
 *   node tools/glb-nodes.mjs "glb files/arms_throwing.glb"
 */
import { readFileSync } from 'node:fs';

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;

function parseGlb(buf) {
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error('not a GLB');
  let json = null;
  let p = 12;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32LE(p);
    const type = buf.readUInt32LE(p + 4);
    if (type === CHUNK_JSON) json = JSON.parse(buf.subarray(p + 8, p + 8 + len).toString('utf8'));
    p += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error('no JSON chunk');
  return json;
}

const file = process.argv[2];
const j = parseGlb(readFileSync(file));

const nodeLine = (i, depth) => {
  const n = j.nodes[i];
  const bits = [];
  if (n.mesh !== undefined) bits.push(`mesh=${n.mesh}`);
  if (n.skin !== undefined) bits.push(`skin=${n.skin}`);
  if (n.translation) bits.push(`t=[${n.translation.map((v) => +v.toFixed(3))}]`);
  if (n.rotation) bits.push(`r=[${n.rotation.map((v) => +v.toFixed(3))}]`);
  if (n.scale) bits.push(`s=[${n.scale.map((v) => +v.toFixed(3))}]`);
  if (n.matrix) bits.push('matrix');
  console.log(`${'  '.repeat(depth)}#${i} ${n.name ?? ''} ${bits.join(' ')}`);
  for (const c of n.children ?? []) nodeLine(c, depth + 1);
};

console.log('=== scenes ===');
for (const [si, s] of (j.scenes ?? []).entries()) {
  console.log(`scene ${si} ${s.name ?? ''}`);
  for (const r of s.nodes ?? []) nodeLine(r, 1);
}

console.log(`\n=== nodes: ${j.nodes?.length ?? 0} ===`);

console.log('\n=== skins ===');
for (const [si, s] of (j.skins ?? []).entries()) {
  console.log(`skin ${si} ${s.name ?? ''} joints=${s.joints.length} skeleton=${s.skeleton}`);
  console.log('  joint names: ' + s.joints.map((n) => j.nodes[n].name ?? `#${n}`).join(', '));
}

console.log('\n=== meshes ===');
for (const [mi, m] of (j.meshes ?? []).entries()) {
  for (const [pi, p] of m.primitives.entries()) {
    const pos = j.accessors[p.attributes.POSITION];
    console.log(
      `mesh ${mi}/${m.name ?? ''} prim ${pi} verts=${pos.count}` +
        ` min=[${(pos.min ?? []).map((v) => +v.toFixed(3))}] max=[${(pos.max ?? []).map((v) => +v.toFixed(3))}]` +
        ` attrs=${Object.keys(p.attributes).join(',')} mat=${p.material}`,
    );
  }
}

console.log('\n=== animations ===');
for (const [ai, a] of (j.animations ?? []).entries()) {
  const paths = {};
  let maxT = 0;
  for (const ch of a.channels) {
    paths[ch.target.path] = (paths[ch.target.path] ?? 0) + 1;
    const sampler = a.samplers[ch.sampler];
    const input = j.accessors[sampler.input];
    if (input.max) maxT = Math.max(maxT, input.max[0]);
  }
  console.log(`anim ${ai} "${a.name ?? ''}" channels=${a.channels.length} dur=${maxT.toFixed(3)}s paths=${JSON.stringify(paths)}`);
}

console.log('\n=== materials ===');
for (const [mi, m] of (j.materials ?? []).entries()) {
  const keys = Object.keys(m.pbrMetallicRoughness ?? {});
  console.log(
    `mat ${mi} "${m.name ?? ''}" pbr=[${keys}] normal=${m.normalTexture !== undefined}` +
      ` alphaMode=${m.alphaMode ?? 'OPAQUE'} doubleSided=${m.doubleSided ?? false}`,
  );
}
