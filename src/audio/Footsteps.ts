/**
 * Footsteps — the sound of the player's own boots.
 *
 * This is deliberately not inside FPController. The controller decides *when* a boot lands and says so
 * on the bus; this file decides what that sounds like. Two consequences are worth keeping: the cadence
 * stays testable without an AudioContext, and everything else that reacts to a footfall — HeldLantern's
 * jolt on the hanging lantern, and whatever ends up hunting the player by sound — hears the same event
 * on the same frame the sample starts. main.ts calls `player.move()` and then `scene.update()`, so the
 * emit happens strictly before the lantern integrates its springs for that frame. That is the sync.
 *
 * Three notes on the sound itself:
 *
 * - **Nine variants, and the previous one never repeats.** Nine samples cut from one recording and
 *   played in order read as a loop within about four steps — the ear locks onto the repeat rather than
 *   onto the sample. A random pick with the last index excluded, plus a few per cent of detune, is
 *   enough to break that, and it costs one integer of state.
 *
 * - **They hang on the camera, which is where the listener is.** So they play at zero distance with no
 *   panning and no attenuation, which is right for your own feet: you do not hear them from somewhere.
 *   `ref` is set well past eye height anyway, so nothing surprising happens if a later change hangs
 *   them off the body instead.
 *
 * - **Volume comes from the loudness the controller already assigned.** `noise:emitted.radius` is how
 *   far a step carries, in metres — 1 crouched, 2.5 walking, 4 running. Deriving the gain from it beats
 *   copying those three numbers here and letting the two copies drift apart.
 */

import type { Camera, PositionalAudio } from 'three';
import type { GameAudio, SoundTune } from '@/audio/AudioManager';
import { globalBus } from '@/core/EventBus';

/** step-1 .. step-9, as cut out of sounds/walking by tools/prep-audio.mjs. */
const STEP_FILES = Array.from({ length: 9 }, (_, i) => `step-${i + 1}.mp3`);

/**
 * Full volume at any distance the camera could put these at, and `volume` is the loudest a step gets —
 * a running one. See gainFor().
 */
const STEP_TUNE: Partial<SoundTune> = { ref: 6, max: 12, rolloff: 1, volume: 0.6 };

/** Playback spread either side of 1. Small: past about 8% a boot starts sounding like a different boot. */
const DETUNE = 0.06;

/**
 * Radius in metres to gain. Crouching lands at 0.35 rather than the 0.25 the bare ratio would give: a
 * sneaking step that is inaudible over a phone speaker in a lit room reads as broken, not as quiet.
 */
function gainFor(radius: number): number {
  return 0.35 + 0.65 * Math.min(Math.max((radius - 1) / 3, 0), 1);
}

export interface FootstepHandles {
  dispose: () => void;
}

/**
 * Start playing the player's footsteps. Nothing to call per frame — it lives entirely off the bus.
 * Install it after installAudio(), so there is a listener for the sources to hang beside.
 */
export function installFootsteps(audio: GameAudio, camera: Camera): FootstepHandles {
  const sources: (PositionalAudio | null)[] = STEP_FILES.map(() => null);
  STEP_FILES.forEach((file, i) => {
    void audio.attach(camera, file, STEP_TUNE).then((snd) => {
      sources[i] = snd;
    });
  });

  let last = -1;

  const off = globalBus.on('noise:emitted', (e) => {
    if (e.kind !== 'footstep') return;
    // Any variant but the one just played. Nudging a collision up by one keeps the distribution even
    // across the other eight, where re-rolling would bias toward whatever the next index happens to be.
    let i = Math.floor(Math.random() * STEP_FILES.length);
    if (i === last) i = (i + 1) % STEP_FILES.length;
    last = i;
    const snd = sources[i];
    // `buffer` guards the step that lands before the file has decoded — the first moment of a fresh
    // load, where a silent step is the right answer rather than an error over the running game.
    if (!snd?.buffer) return;
    // Steps overlap at a run: 3.5 Hz against a sample with a couple of hundred milliseconds of tail.
    // Nine sources means those tails do overlap, which is what a corridor sounds like; only a repeat of
    // the *same* index inside its own tail has to cut itself off, and play() no-ops without this.
    if (snd.isPlaying) snd.stop();
    snd.setVolume((STEP_TUNE.volume ?? 1) * gainFor(e.radius));
    snd.setPlaybackRate(1 + (Math.random() * 2 - 1) * DETUNE);
    snd.play();
  });

  return {
    // The sources themselves belong to AudioManager's live list and go out with audio.dispose().
    dispose: off,
  };
}
