/**
 * ASCII envelope plot. Peak-picking arguments are guesses until you can see the waveform's shape —
 * this prints one row per slice of time with a bar per bucket, so a recording's real structure
 * (how many bursts, how loud, where the junk at the ends is) is readable without a DAW.
 *
 *   node tools/audio-plot.mjs "sounds/walking/foo.mp3" [bucketMs] [cols] [startSec] [durSec]
 */
import { spawnSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';

const file = process.argv[2];
const BUCKET_MS = Number(process.argv[3] ?? 20);
const COLS = Number(process.argv[4] ?? 100);
const START = process.argv[5];
const DUR = process.argv[6];
const RATE = 8000;

const res = spawnSync(
  ffmpeg,
  [
    '-hide_banner',
    '-loglevel',
    'error',
    ...(START ? ['-ss', START] : []),
    ...(DUR ? ['-t', DUR] : []),
    '-i',
    file,
    '-ac',
    '1',
    '-ar',
    String(RATE),
    '-f',
    'f32le',
    '-',
  ],
  { maxBuffer: 1 << 28 },
);
if (res.status !== 0) throw new Error(`ffmpeg failed: ${res.stderr}`);
const pcm = new Float32Array(res.stdout.buffer, res.stdout.byteOffset, Math.floor(res.stdout.length / 4));

const win = Math.round((BUCKET_MS / 1000) * RATE);
const env = [];
for (let i = 0; i + win <= pcm.length; i += win) {
  let s = 0;
  for (let k = 0; k < win; k++) s += pcm[i + k] * pcm[i + k];
  env.push(Math.sqrt(s / win));
}
const sorted = env.slice().sort((a, b) => a - b);
const p999 = sorted[Math.floor(sorted.length * 0.999)];
const median = sorted[sorted.length >> 1];
const RAMP = ' .:-=+*#%@';

console.log(
  `${file}\ndur=${((pcm.length / RATE) / 1).toFixed(2)}s buckets=${env.length}@${BUCKET_MS}ms  p99.9=${p999.toFixed(4)} median=${median.toFixed(4)} max=${Math.max(...env).toFixed(4)}`,
);
for (let r = 0; r < env.length; r += COLS) {
  const row = env.slice(r, r + COLS);
  const bars = row
    .map((v) => RAMP[Math.min(RAMP.length - 1, Math.round((v / p999) * (RAMP.length - 1)))])
    .join('');
  console.log(`${String(Math.round(r * BUCKET_MS + (START ? Number(START) * 1000 : 0))).padStart(6)}ms |${bars}|`);
}
