/**
 * Turns the raw sound library in `sounds/` into what the game can actually load: mono MP3s under
 * `public/assets/audio/`, which is the only directory AudioManager serves from.
 *
 * The footsteps are the reason this exists. The supplied walking take is one continuous 18.6 s
 * barefoot-on-wood recording, so a single step had to be *cut out* of it — nine of them, chosen off
 * `tools/audio-plot.mjs` for being isolated (no neighbour bleeding into the tail) and cleanly
 * transient. The game then triggers one per stride, which is what makes the cadence follow the legs
 * instead of a loop's own tempo.
 *
 * Levelling is by mean, not peak. Peak-normalising these would flatten the take's natural
 * step-to-step variation into nine identical thumps; matching mean loudness keeps the variation and
 * still lands them all in the same audible range. The gain is then clamped so the peak cannot exceed
 * PEAK_CEIL_DB, because one of the steps has a 29 dB crest and mean-matching alone would clip it.
 *
 * The take is quiet (floor around -47 dBFS), so +15 dB of make-up gain would bring the room hiss up
 * with it. `compand` pulls everything below the knee back down before the gain is applied, which
 * keeps the transient and most of the reverb tail while the silence stays silent.
 *
 *   node tools/prep-audio.mjs            # everything
 *   node tools/prep-audio.mjs step       # only outputs whose name contains "step"
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ffmpeg from 'ffmpeg-static';

const DST = 'public/assets/audio';
const WALK = 'sounds/walking/395654__soundsforhim__walking-barefoot-on-wooden-deck.mp3';
const NOISE = 'sounds/noises';

const TARGET_MEAN_DB = -26; // where a footstep's mean should sit
const PEAK_CEIL_DB = -1.5; // never let make-up gain clip
const RATE = 44100;
/** Below -45 dBFS everything is pushed down ~18 dB; -30 and up is left alone. */
const GATE = 'compand=attacks=0.002:decays=0.05:points=-90/-108|-45/-63|-30/-30|0/0';

/**
 * start/dur are seconds into the source. For the steps they are the windows measured with
 * tools/audio-plot.mjs: ~40 ms of pre-roll before the transient, then long enough to keep the tail.
 */
const PLAN = [
  { src: WALK, out: 'step-1.mp3', start: 1.85, dur: 0.32, gate: true },
  { src: WALK, out: 'step-2.mp3', start: 2.56, dur: 0.34, gate: true },
  { src: WALK, out: 'step-3.mp3', start: 3.22, dur: 0.36, gate: true },
  { src: WALK, out: 'step-4.mp3', start: 3.93, dur: 0.34, gate: true },
  { src: WALK, out: 'step-5.mp3', start: 4.59, dur: 0.34, gate: true },
  { src: WALK, out: 'step-6.mp3', start: 5.33, dur: 0.34, gate: true },
  { src: WALK, out: 'step-7.mp3', start: 8.64, dur: 0.36, gate: true },
  { src: WALK, out: 'step-8.mp3', start: 11.52, dur: 0.34, gate: true },
  { src: WALK, out: 'step-9.mp3', start: 16.19, dur: 0.34, gate: true },

  // Prop bumps. Each source has dead air at the head, hence the offsets.
  {
    src: `${NOISE}/338693__natemarler__glass-bottle-bounce.wav`,
    out: 'bottle-knock.mp3',
    start: 0.5,
    dur: 1.1,
    meanDb: -22,
    kbps: 80,
  },
  {
    src: `${NOISE}/672565__teaganbear__bowl-utensil.wav`,
    out: 'plate-rattle.mp3',
    start: 0,
    dur: 0.26,
    meanDb: -22,
    kbps: 80,
  },
  // 19 s of rolling; only the first ~1.5 s has the bottle actually moving.
  {
    src: `${NOISE}/789462__limpinglizards__bottle-rolling-2.wav`,
    out: 'bottle-roll.mp3',
    start: 0.92,
    dur: 1.55,
    meanDb: -22,
    kbps: 80,
  },
];

const only = process.argv.slice(2);
const wanted = (cfg) => only.length === 0 || only.some((a) => cfg.out.includes(a) || cfg.src.includes(a));

function run(args) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', ...args], { maxBuffer: 1 << 28 });
  return { code: r.status, err: String(r.stderr ?? '') };
}

/** mean/max dBFS of the window after the pre-gain filters, so the gain we pick is the real one. */
function measure(cfg, pre) {
  const { code, err } = run([
    '-ss', String(cfg.start), '-t', String(cfg.dur), '-i', cfg.src,
    '-ac', '1', '-af', `${pre},volumedetect`, '-f', 'null', '-',
  ]);
  if (code !== 0) throw new Error(`volumedetect failed on ${cfg.src}:\n${err}`);
  const grab = (k) => {
    const m = err.match(new RegExp(`${k}:\\s*(-?[\\d.]+) dB`));
    return m ? Number(m[1]) : null;
  };
  const mean = grab('mean_volume');
  const max = grab('max_volume');
  if (mean === null || max === null) throw new Error(`no volume stats for ${cfg.out}`);
  return { mean, max };
}

mkdirSync(DST, { recursive: true });
let made = 0;
const rows = [];

for (const cfg of PLAN) {
  if (!wanted(cfg)) continue;
  if (!existsSync(cfg.src)) {
    console.log(`! missing source: ${cfg.src}`);
    continue;
  }
  const pre = ['highpass=f=55', ...(cfg.gate ? [GATE] : [])].join(',');
  const { mean, max } = measure(cfg, pre);
  const target = cfg.meanDb ?? TARGET_MEAN_DB;
  const gain = Math.min(target - mean, PEAK_CEIL_DB - max);

  // 6 ms in kills the slice's own edge click; the out-fade is long enough to hide the truncated tail.
  const fadeOut = Math.min(0.06, cfg.dur * 0.25);
  const filters = [
    pre,
    `volume=${gain.toFixed(2)}dB`,
    'afade=t=in:st=0:d=0.006',
    `afade=t=out:st=${(cfg.dur - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`,
  ].join(',');

  const dest = join(DST, cfg.out);
  mkdirSync(dirname(dest), { recursive: true });
  const { code, err } = run([
    '-y', '-ss', String(cfg.start), '-t', String(cfg.dur), '-i', cfg.src,
    '-ac', '1', '-ar', String(RATE), '-af', filters,
    '-c:a', 'libmp3lame', '-b:a', `${cfg.kbps ?? 64}k`, '-map_metadata', '-1', dest,
  ]);
  if (code !== 0) throw new Error(`encode failed for ${cfg.out}:\n${err}`);

  rows.push({
    out: cfg.out,
    ms: Math.round(cfg.dur * 1000),
    srcMean: +mean.toFixed(1),
    srcMax: +max.toFixed(1),
    gainDb: +gain.toFixed(1),
    limitedByPeak: PEAK_CEIL_DB - max < target - mean,
    kb: +(statSync(dest).size / 1024).toFixed(1),
  });
  made++;
}

console.table(rows);
console.log(`${made} file(s) -> ${DST}  total ${rows.reduce((a, r) => a + r.kb, 0).toFixed(1)} KB`);
