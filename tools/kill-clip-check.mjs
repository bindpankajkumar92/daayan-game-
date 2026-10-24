/**
 * Structural check for the exported kill clip.
 *
 * The kill clip is authored in Blender against a copy of the daayan's rig and exported clip-only
 * (armature + action, no mesh). Two things can silently break that handoff:
 *
 * - **A typo in a bone name.** The clip's channels are keyed by node name; Three binds them by name
 *   against the daayan's skeleton. One renamed node means that bone simply does not play — usually
 *   the sword arm, which would leave the kill looking like she is standing still.
 * - **A clip that is not actually animated.** A constant channel exports fine and looks like a valid
 *   clip in every tool, but nothing moves. This check counts keys, not channels.
 *
 * It also asserts the clip is clip-only: a mesh or skin in here would mean the whole character was
 * exported by accident, and the game would download a second copy of her.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This file is run from `tools/` directly and from the suite runner's `tools/.tmp/` bundle. Resolve
// the project root from the file location in both cases so the GLBs are found either way.
const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = here.endsWith(join('tools', '.tmp')) ? join(here, '..', '..') : join(here, '..');
const models = join(projectRoot, 'public', 'assets', 'models');

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;

function readGlb(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error(`${path} is not a GLB`);
  let json = null;
  let bin = null;
  let p = 12;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32LE(p);
    const type = buf.readUInt32LE(p + 4);
    const body = buf.subarray(p + 8, p + 8 + len);
    if (type === CHUNK_JSON) json = JSON.parse(body.toString('utf8'));
    else if (type === 0x004e4942) bin = body;
    p += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error(`${path} has no JSON chunk`);
  return { json, bin };
}

const COMPONENTS = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPES = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function accessorValues(glb, index) {
  const { json, bin } = glb;
  const acc = json.accessors[index];
  const view = json.bufferViews[acc.bufferView];
  if (!bin) return [];
  const comps = TYPES[acc.type] ?? 1;
  const bytes = COMPONENTS[acc.componentType] ?? 4;
  const stride = view.byteStride ?? comps * bytes;
  const start = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const out = [];
  for (let i = 0; i < acc.count; i++) {
    const row = [];
    for (let c = 0; c < comps; c++) {
      const at = start + i * stride + c * bytes;
      row.push(acc.componentType === 5126 ? bin.readFloatLE(at) : bin.readUInt32LE(at));
    }
    out.push(row);
  }
  return out;
}

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

let model;
let clip;
try {
  model = readGlb(join(models, 'daayan.glb'));
  clip = readGlb(join(models, 'daayan-kill.glb'));
} catch (err) {
  console.log(`FAIL  assets load  ${String(err.message)}`);
  process.exit(1);
}

const modelNames = new Set((model.json.nodes ?? []).map((n) => n.name));
const animations = clip.json.animations ?? [];
check('clip shipping has exactly one animation', animations.length === 1, `${animations.length}`);
check('clip is clip-only (no meshes)', (clip.json.meshes ?? []).length === 0);
check('clip is clip-only (no skins)', (clip.json.skins ?? []).length === 0);

const anim = animations[0];
const channels = anim?.channels ?? [];
const samplers = anim?.samplers ?? [];
const nodeName = new Map((clip.json.nodes ?? []).map((n, i) => [i, n.name]));
const byBone = new Map();
for (const ch of channels) {
  const name = nodeName.get(ch.target.node);
  if (!name) continue;
  const list = byBone.get(name) ?? [];
  list.push(ch);
  byBone.set(name, list);
}

const targets = [...byBone.keys()];
const missing = targets.filter((n) => !modelNames.has(n));
check('every animation target exists in daayan.glb', missing.length === 0, missing.slice(0, 4).join(', '));

const times = accessorValues(clip, samplers[0]?.input);
const duration = times.length ? Math.max(...times.map((t) => t[0])) : 0;
check('clip is 1.2 s long', Math.abs(duration - 1.2) < 0.01, `${duration.toFixed(3)} s`);

function keys(bone) {
  const chs = byBone.get(bone) ?? [];
  const ch = chs.find((c) => c.target.path === 'rotation') ?? chs[0];
  return ch ? (clip.json.accessors[samplers[ch.sampler].output]?.count ?? 0) : 0;
}

const required = [
  'CC_Base_R_Upperarm_078',
  'CC_Base_R_Forearm_079',
  'CC_Base_R_Hand_083',
  'CC_Base_L_Upperarm_050',
  'CC_Base_L_Forearm_051',
  'CC_Base_L_Hand_055',
];
for (const bone of required) {
  check(`${bone} is in the clip`, byBone.has(bone));
}
// The left hand rides its forearm, so only the arm bones are expected to carry motion.
const animated = ['CC_Base_R_Upperarm_078', 'CC_Base_R_Forearm_079', 'CC_Base_R_Hand_083', 'CC_Base_L_Upperarm_050', 'CC_Base_L_Forearm_051'];
const moving = animated.filter((b) => keys(b) > 3);
check('both arms are actually animated (not constant)', moving.length === animated.length, moving.map((b) => `${b}:${keys(b)}`).join(' '));
check('the sword hand is animated', keys('CC_Base_R_Hand_083') > 3, `${keys('CC_Base_R_Hand_083')} keys`);
check('the left fingers close for the grab', keys('CC_Base_L_Index1_065') > 2, `${keys('CC_Base_L_Index1_065')} keys`);

// Constant channels are normal for the legs and pelvis; a translation channel on the root that
// changes would move the whole character out of the anchor the game puts her at.
const hip = 'CC_Base_Hip_02';
const hipCh = (byBone.get(hip) ?? []).find((c) => c.target.path === 'translation');
if (hipCh) {
  const vals = accessorValues(clip, samplers[hipCh.sampler].output);
  const spread = vals.reduce((m, v) => Math.max(m, Math.hypot(...v.map((x, i) => x - vals[0][i]))), 0);
  check('the root does not translate during the kill', spread < 1e-4, `${spread.toExponential(1)}`);
}

const names = targets.filter((n) => /Index|Mid|Ring|Pinky|Thumb/.test(n));
const right = names.filter((n) => n.includes('_R_'));
const left = names.filter((n) => n.includes('_L_'));
check('both hands have finger tracks', right.length > 0 && left.length > 0, `R:${right.length} L:${left.length}`);

console.log(failures === 0 ? '\nKILL CLIP OK' : `\n${failures} KILL CLIP CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
