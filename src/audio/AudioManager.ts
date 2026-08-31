/**
 * AudioManager — the only place in the project that touches WebAudio.
 *
 * Three things here are not obvious:
 *
 * - **The context has to be woken by hand.** `AudioListener` builds its AudioContext in its
 *   constructor and three never calls `resume()` on it. Browsers hand back a *suspended* context
 *   until the page has seen a gesture, so a sound triggered before the player's first tap is
 *   scheduled into a clock that is not running and simply never arrives — which looks exactly like a
 *   missing file. Capacitor's `setMediaPlaybackRequiresUserGesture(false)` does not help: it governs
 *   `<audio>`/`<video>` elements, not WebAudio. Hence the one-shot listeners below.
 *
 * - **dispose() must not close the context.** `AudioListener` takes its context from three's
 *   `AudioContext.getContext()`, which caches a single instance for the whole page. Closing it on
 *   scene teardown would leave a rebuilt house with a dead context and no way to get another. Not
 *   closing it is also the right answer for the browser limit of a handful of contexts per page,
 *   since every rebuild now reuses the same one.
 *
 * - **The distance defaults are wrong for this house.** WebAudio's `refDistance` of 1 with linear
 *   rolloff is tuned for a room; the hallway alone is 18 m, and at those defaults a sound two rooms
 *   away is still clearly audible. The numbers in TUNE were picked so a source stops carrying at
 *   roughly the length of one room.
 */

import { AudioListener, AudioLoader, PositionalAudio, type Camera, type Object3D } from 'three';

/** Mirrors ModelLoader's MODEL_DIR: served straight out of public/, with no bundler involvement. */
const AUDIO_DIR = '/assets/audio/';

export interface SoundTune {
  /** Metres over which the source plays at full volume. */
  ref: number;
  /** Metres past which it stops getting quieter — it does not stop being audible, so keep it low. */
  max: number;
  /** How sharply it falls off between the two. Above 1 is steeper than physical. */
  rolloff: number;
  volume: number;
}

const TUNE: SoundTune = { ref: 1.5, max: 12, rolloff: 1.4, volume: 0.9 };

export interface GameAudio {
  /**
   * Hang a positional one-shot on `host` and resolve once the file has decoded. The source is
   * returned rather than played: the caller owns when it fires, and `Audio.play()` warns and
   * no-ops if it is already playing, so a caller that may retrigger should `stop()` first.
   */
  attach: (host: Object3D, file: string, tune?: Partial<SoundTune>) => Promise<PositionalAudio>;
  /**
   * The same, except a file that is not there is not an error. `attach` reports a failed load to the
   * scene's error sink, which paints a red box over the running game — right for a sound the build
   * is supposed to ship, wrong for one whose asset is still to be delivered. This resolves with an
   * empty source instead, and an empty source is silent as long as the caller guards on `buffer`.
   */
  attachOptional: (host: Object3D, file: string, tune?: Partial<SoundTune>) => Promise<PositionalAudio>;
  dispose: () => void;
}

const WAKE_EVENTS = ['pointerdown', 'keydown', 'touchstart'] as const;

export function installAudio(
  camera: Camera,
  onError: (err: unknown, where: string) => void,
): GameAudio {
  const listener = new AudioListener();
  camera.add(listener);

  const wake = (): void => {
    void listener.context.resume();
  };
  for (const ev of WAKE_EVENTS) {
    window.addEventListener(ev, wake, { once: true, passive: true });
  }

  const loader = new AudioLoader();
  /** Cached per file name, and the *promise* is cached, so two callers share one download. */
  const buffers = new Map<string, Promise<AudioBuffer>>();
  const live: PositionalAudio[] = [];
  let dead = false;

  const load = (file: string): Promise<AudioBuffer> => {
    let p = buffers.get(file);
    if (p === undefined) {
      p = new Promise<AudioBuffer>((res, rej) => {
        loader.load(AUDIO_DIR + file, res, undefined, rej);
      });
      buffers.set(file, p);
    }
    return p;
  };

  const mount = async (
    host: Object3D,
    file: string,
    tune: Partial<SoundTune> | undefined,
    onFail: (err: unknown, where: string) => void,
  ): Promise<PositionalAudio> => {
    const t = { ...TUNE, ...tune };
    const snd = new PositionalAudio(listener);
    snd.setRefDistance(t.ref);
    snd.setMaxDistance(t.max);
    snd.setRolloffFactor(t.rolloff);
    snd.setVolume(t.volume);
    host.add(snd);
    live.push(snd);
    try {
      const buf = await load(file);
      // The scene can be torn down while the file is in flight. Setting a buffer on a source that
      // has already been detached is harmless, but it would also resurrect it in the live list.
      if (!dead) snd.setBuffer(buf);
    } catch (err) {
      onFail(err, `audio:${file}`);
    }
    return snd;
  };

  return {
    attach: (host, file, tune) => mount(host, file, tune, onError),
    attachOptional: (host, file, tune) =>
      mount(host, file, tune, () => {
        /* asset not delivered yet — stay silent rather than shout */
      }),
    dispose: () => {
      dead = true;
      for (const snd of live) {
        if (snd.isPlaying) snd.stop();
        snd.disconnect();
        snd.parent?.remove(snd);
      }
      live.length = 0;
      camera.remove(listener);
      for (const ev of WAKE_EVENTS) window.removeEventListener(ev, wake);
    },
  };
}
