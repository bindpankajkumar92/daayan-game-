/**
 * Where are the footsteps in a recording? Decodes to mono via ffmpeg, builds a short-window RMS
 * envelope, and reports onsets plus the gaps between them — which is what tells you the recorded
 * cadence, and therefore whether a loop can ever line up with the player's stride.
 *
 *   node tools/audio-onsets.mjs "sounds/walking/foo.mp3" [thresholdDb] [minGapMs]
 */
import { spawnSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';

const file = process.argv[2];
const THRESH_DB = Number(process.argv[3] ?? -34);
const MIN_GAP_MS = Number(process.argv[4] ?? 140);
const RATE = 8000;
const WIN = 64; // samples per envelope bucket -> 8 ms buckets

const res = spawnSync(
  ffmpeg,
  ['-hide_banner', '-loglevel', 'error', '-i', file, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'],
  { maxBuffer: 1 << 28 },
);
if (res.status !== 0) throw new Error(`ffmpeg failed: ${res.stderr}`);
const pcm = new Float32Array(
  res.stdout.buffer,
  res.stdout.byteOffset,
  Math.floor(res.stdout.length / 4),
);

const env = [];
for (let i = 0; i + WIN <= pcm.length; i += WIN) {
  let s = 0;
  for (let k = 0; k < WIN; k++) s += pcm[i + k] * pcm[i + k];
  env.push(Math.sqrt(s / WIN));
}
const peak = Math.max(...env);
const thresh = peak * 10 ** (THRESH_DB / 20);
const bucketMs = (WIN / RATE) * 1000;
const minGapBuckets = Math.round(MIN_GAP_MS / bucketMs);

// Rising-edge onsets, then keep the local envelope maximum inside each burst.
const onsets = [];
let i = 0;
while (i < env.length) {
  if (env[i] < thresh) {
    i++;
    continue;
  }
  let j = i;
  let best = i;
  while (j < env.length && (env[j] >= thresh || j - i < minGapBuckets)) {
    if (env[j] > env[best]) best = j;
    j++;
  }
  onsets.push({ startMs: i * bucketMs, peakMs: best * bucketMs, endMs: j * bucketMs, amp: env[best] / peak });
  i = j;
}

console.log(`file=${file} dur=${((pcm.length / RATE) * 1000).toFixed(0)}ms peakRms=${peak.toFixed(4)} thresh=${thresh.toFixed(4)}`);
console.log(`onsets=${onsets.length}`);
let prev = null;
for (const [n, o] of onsets.entries()) {
  const gap = prev === null ? '' : ` gap=${(o.peakMs - prev).toFixed(0)}ms`;
  console.log(
    `  ${String(n).padStart(2)} start=${o.startMs.toFixed(0)} peak=${o.peakMs.toFixed(0)} end=${o.endMs.toFixed(0)} len=${(o.endMs - o.startMs).toFixed(0)}ms amp=${o.amp.toFixed(2)}${gap}`,
  );
  prev = o.peakMs;
}
if (onsets.length > 2) {
  const gaps = onsets.slice(1).map((o, k) => o.peakMs - onsets[k].peakMs).sort((a, b) => a - b);
  const medGap = gaps[gaps.length >> 1];
  console.log(`median gap=${medGap.toFixed(0)}ms -> ${(1000 / medGap).toFixed(2)} steps/s`);
}
