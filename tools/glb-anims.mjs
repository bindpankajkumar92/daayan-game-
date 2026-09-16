/**
 * List what each .glb actually contains: animations, their names, and the node names they target.
 *
 * Reading a GLB's JSON chunk directly is enough — no three.js, no WebGL. The header is
 * magic(4) version(4) length(4), then chunks of length(4) type(4) data. Chunk type 0x4E4F534A
 * ("JSON") is the glTF document, and its `animations` array is what decides whether a prop can
 * swing its own door.
 *
 * Usage: node tools/glb-anims.mjs "glb files/*.glb"
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

function readGlbJson(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${path}: not a GLB (bad magic)`);
  const total = buf.readUInt32LE(8);
  let off = 12;
  while (off < Math.min(total, buf.length)) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) return JSON.parse(data.toString('utf8'));
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  throw new Error(`${path}: no JSON chunk`);
}

const dir = process.argv[2] ?? 'glb files';
const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.glb'));

console.log('file'.padEnd(56), 'anims', 'nodes', 'sample animation names');
console.log('-'.repeat(120));

for (const f of files) {
  const p = join(dir, f);
  let g;
  try {
    g = readGlbJson(p);
  } catch (e) {
    console.log(basename(f).padEnd(56), 'ERR', String(e.message).slice(0, 40));
    continue;
  }
  const anims = g.animations ?? [];
  const nodes = (g.nodes ?? []).length;
  const names = anims
    .slice(0, 3)
    .map((a) => a.name ?? '(unnamed)')
    .join(', ');
  const mark = anims.length > 0 ? ' <-- animated' : '';
  console.log(
    basename(f).padEnd(56),
    String(anims.length).padStart(5),
    String(nodes).padStart(5),
    names.slice(0, 52) + mark,
  );
}
