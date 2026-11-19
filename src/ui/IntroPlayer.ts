/**
 * IntroPlayer — the opening cutscene, shown once, on the first launch only.
 *
 * Ten short shots (public/assets/video/intro/01..10.mp4) played strictly in serial order. They are
 * separate files rather than one long video so a single shot can be replaced without re-assembling the
 * rest (see intro-clips/README.md); the shipped copies are re-encodes of those review files.
 *
 * Choices that are not obvious:
 *
 * - **Two <video> elements, alternating.** While one shot plays, the next is already loading in the
 *   hidden element, so the cut between shots is a swap of two decoded frames instead of a black gap
 *   while the next file is fetched and its decoder spun up.
 *
 * - **It does not block the boot.** The overlay sits above the #loading card (10000), and the engine,
 *   house and shader warm-up all run behind it. The ~50 s of cutscene therefore pays for the loading
 *   time, and the title menu is usually ready by the time it fades in.
 *
 * - **Autoplay with sound.** Capacitor's WebView sets `setMediaPlaybackRequiresUserGesture(false)`, so
 *   on the phone the first shot starts with sound and no tap. A desktop browser may refuse that; then
 *   the clip falls back to muted playback (always allowed) and a "tap for sound" hint shows.
 *
 * - **A shot that cannot play is skipped, never waited on.** A decode error or a stall of STALL_MS
 *   moves to the next shot, so a broken file costs one shot, not a black screen the player cannot leave.
 *
 * The "seen" flag is written when the intro ends or is skipped. A launch killed mid-intro plays it again.
 */

import { getPref, setPref } from '@/core/Prefs';
import { localize } from '@/ui/Strings';

/** Same serving convention as models and audio: straight out of public/, no bundler involvement. */
const INTRO_CLIPS: readonly string[] = Array.from(
  { length: 10 },
  (_, i) => `/assets/video/intro/${String(i + 1).padStart(2, '0')}.mp4`,
);

/** Above #loading (10000), so the boot card never shows through between shots. */
const Z = 10050;
/** A shot whose playhead has not moved for this long, while the app is in the foreground, is skipped. */
const STALL_MS = 8000;
const FADE_MS = 450;

/** First launch, or a `?intro=1` URL forcing a replay for testing. */
export function shouldPlayIntro(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get('intro') === '1') return true;
  } catch {
    // No usable URL; fall through to the stored flag.
  }
  return getPref('introSeen') !== true;
}

/**
 * Play every clip in order, then fade out and remove the overlay. Resolves when the fade starts, so
 * whatever is underneath can already respond. Never rejects.
 */
export function playIntro(clips: readonly string[] = INTRO_CLIPS): Promise<void> {
  return new Promise<void>((resolve) => {
    const root = document.createElement('div');
    root.id = 'intro-layer';
    root.style.cssText = `
      position: fixed; inset: 0; z-index: ${Z}; background: #000; overflow: hidden;
      opacity: 1; transition: opacity ${FADE_MS}ms ease-out;
      user-select: none; -webkit-user-select: none; touch-action: none;
    `;

    const makeVideo = (): HTMLVideoElement => {
      const v = document.createElement('video');
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.setAttribute('webkit-playsinline', '');
      v.preload = 'auto';
      v.controls = false;
      v.disablePictureInPicture = true;
      v.style.cssText = `
        position: absolute; inset: 0; width: 100%; height: 100%;
        object-fit: contain; background: #000; opacity: 0; pointer-events: none;
      `;
      root.appendChild(v);
      return v;
    };

    const skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.textContent = `${localize('SKIP')} ›`;
    skipBtn.style.cssText = `
      position: absolute; z-index: 2;
      right: calc(14px + env(safe-area-inset-right, 0px));
      bottom: calc(12px + env(safe-area-inset-bottom, 0px));
      -webkit-appearance: none; appearance: none; -webkit-tap-highlight-color: transparent;
      min-height: 40px; padding: 0 16px; cursor: pointer;
      background: rgba(0,0,0,0.45); color: rgba(230,223,210,0.85);
      border: 1px solid rgba(255,255,255,0.22); border-radius: 2px;
      font: 600 12px/1 ui-monospace, monospace; letter-spacing: 0.16em;
    `;

    const soundHint = document.createElement('div');
    soundHint.textContent = localize('TAP FOR SOUND');
    soundHint.style.cssText = `
      position: absolute; z-index: 2; display: none; pointer-events: none;
      left: calc(14px + env(safe-area-inset-left, 0px));
      bottom: calc(22px + env(safe-area-inset-bottom, 0px));
      color: rgba(230,223,210,0.7); font: 600 11px/1 ui-monospace, monospace; letter-spacing: 0.14em;
    `;

    const a = makeVideo();
    const b = makeVideo();
    root.appendChild(skipBtn);
    root.appendChild(soundHint);
    document.body.appendChild(root);

    let cur = a;
    let nxt = b;
    let index = 0;
    let muted = false;
    let finished = false;
    let lastProgressAt = performance.now();

    const load = (v: HTMLVideoElement, i: number): void => {
      const url = clips[i];
      if (url !== undefined) {
        v.src = url;
        v.load();
      } else {
        v.removeAttribute('src');
        v.load();
      }
    };

    const play = (v: HTMLVideoElement): void => {
      if (finished) return;
      if (v.error) {
        advance();
        return;
      }
      v.muted = muted;
      v.play().catch((err: unknown) => {
        if (finished || v !== cur) return;
        // Autoplay-with-sound refused (desktop browsers). Muted playback is always allowed.
        if (!muted && err instanceof DOMException && err.name === 'NotAllowedError') {
          muted = true;
          v.muted = true;
          soundHint.style.display = 'block';
          v.play().catch(() => {
            if (!finished && v === cur) advance();
          });
          return;
        }
        advance();
      });
    };

    function advance(): void {
      if (finished) return;
      index++;
      if (index >= clips.length) {
        finish();
        return;
      }
      const prev = cur;
      cur = nxt;
      nxt = prev;
      prev.pause();
      prev.style.opacity = '0';
      cur.style.opacity = '1';
      lastProgressAt = performance.now();
      play(cur);
      load(nxt, index + 1);
    }

    const onEnded = (e: Event): void => {
      if (e.target === cur) advance();
    };
    const onError = (e: Event): void => {
      // An error on the preloading element is handled when it becomes current (play() checks v.error).
      if (e.target === cur) advance();
    };
    const onTime = (e: Event): void => {
      if (e.target === cur) lastProgressAt = performance.now();
    };
    for (const v of [a, b]) {
      v.addEventListener('ended', onEnded);
      v.addEventListener('error', onError);
      v.addEventListener('timeupdate', onTime);
    }

    const watchdog = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (performance.now() - lastProgressAt > STALL_MS) advance();
    }, 1000);

    // The WebView pauses media when the app is backgrounded; pick the shot back up on return.
    const onVisibility = (): void => {
      if (finished) return;
      if (document.visibilityState === 'visible') {
        lastProgressAt = performance.now();
        play(cur);
      } else {
        cur.pause();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    const onTap = (): void => {
      if (!muted) return;
      muted = false;
      cur.muted = false;
      soundHint.style.display = 'none';
    };
    root.addEventListener('pointerdown', onTap);

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        finish();
      }
    };
    // Capture phase, so the key does not also reach TouchControls (Escape there means "pause").
    window.addEventListener('keydown', onKey, true);

    skipBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    skipBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      finish();
    });

    function finish(): void {
      if (finished) return;
      finished = true;
      window.clearInterval(watchdog);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('keydown', onKey, true);
      setPref('introSeen', true);
      root.style.pointerEvents = 'none';
      root.style.opacity = '0';
      window.setTimeout(() => {
        for (const v of [a, b]) {
          v.pause();
          v.removeAttribute('src');
          v.load(); // releases the decoder and the buffered media
        }
        root.remove();
      }, FADE_MS + 50);
      resolve();
    }

    if (clips.length === 0) {
      finish();
      return;
    }
    load(cur, 0);
    load(nxt, 1);
    cur.style.opacity = '1';
    play(cur);
  });
}
