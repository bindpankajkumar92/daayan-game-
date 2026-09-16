/**
 * Deep-inspect a GLB: mesh/node names and, for each animation, which nodes it drives.
 *
 * `glb-anims.mjs` answers "does it have animation". This answers the question that actually matters
 * for a closet: *which part moves, and how far*. A door that swings on a hinge reports a rotation
 * channel on a node whose name is not the body, and the animated node's translation gives the hinge
 * position — which is what `Hiding.ts`/`ModelProps.ts` need in order to place and open it.
 *
 * Usage: node tools/glb-inspect.mjs "glb files/furniture_chateau_de_la_foret.glb"
 */

import { readFileSync } from 'node:fs';

function readGlbJson(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
  const total = buf.readUInt32LE(8);
  let off = 12;
  while (off < Math.min(total, buf.length)) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) return JSON.parse(data.toString('utf8'));
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  throw new Error('no JSON chunk');
}

const path = process.argv[2];
const g = readGlbJson(path);
const nodes = g.nodes ?? [];

console.log(`=== ${path} ===`);
console.log(`nodes: ${nodes.length}   meshes: ${(g.meshes ?? []).length}   anims: ${(g.animations ?? []).length}`);
console.log('');

console.log('--- nodes ---');
nodes.forEach((n, i) => {
  const bits = [];
  if (n.mesh !== undefined) bits.push(`mesh=${n.mesh}(${g.meshes?.[n.mesh]?.name ?? '?'})`);
  if (n.translation) bits.push(`t=[${n.translation.map((v) => v.toFixed(3)).join(',')}]`);
  if (n.rotation) bits.push(`r=[${n.rotation.map((v) => v.toFixed(3)).join(',')}]`);
  if (n.scale) bits.push(`s=[${n.scale.map((v) => v.toFixed(3)).join(',')}]`);
  console.log(`  ${String(i).padStart(3)} ${(n.name ?? '(unnamed)').padEnd(34)} ${bits.join(' ')}`);
});

console.log('');
console.log('--- animations ---');
(g.animations ?? []).forEach((a, ai) => {
  console.log(`  [${ai}] ${a.name ?? '(unnamed)'}  channels=${a.channels.length}`);
  const byNode = new Map();
  for (const ch of a.channels) {
    const t = ch.target ?? {};
    const key = `${t.node}`;
    if (!byNode.has(key)) byNode.set(key, new Set());
    byNode.get(key).add(t.path);
  }
  for (const [nodeIdx, paths] of byNode) {
    const nm = nodes[Number(nodeIdx)]?.name ?? '?';
    console.log(`        node ${nodeIdx} "${nm}"  -> ${[...paths].join(', ')}`);
  }
});
