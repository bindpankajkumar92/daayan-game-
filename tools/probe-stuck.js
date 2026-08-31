/**
 * Movement-jam tracer. Paste into the running app over CDP:
 *
 *   adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 *   node tools/cdp.mjs --file tools/probe-stuck.js      # install
 *   ... play for a while ...
 *   node tools/cdp.mjs "JSON.stringify(window.__stuckTrace, null, 1)"
 *
 * Wraps FPController.move and records every frame where the joystick was deflected but the player
 * barely moved, together with the colliders that were in range to refuse it. Contiguous blocked
 * frames collapse into one row, so leaning into a wall for two seconds is one entry, not 120.
 * This is the difference between "the player says movement froze" and knowing which box did it.
 */
(() => {
  const d = window.__daayan;
  const P = d.player;
  if (window.__stuckTrace) return 'tracer already installed';

  const T = { inputFrames: 0, stuckFrames: 0, jams: [], lastJam: null };
  window.__stuckTrace = T;

  const origMove = Object.getPrototypeOf(P).move;
  P.move = function (strafe, forward, dt) {
    const bx = this.position.x;
    const bz = this.position.z;
    origMove.call(this, strafe, forward, dt);
    if (strafe === 0 && forward === 0) {
      T.lastJam = null;
      return;
    }
    T.inputFrames++;
    const moved = Math.hypot(this.position.x - bx, this.position.z - bz);
    // A tenth of the distance the slowest gait (crouch) covers in one 60 Hz step.
    if (moved > (1.1 / 60) * 0.1) {
      T.lastJam = null;
      return;
    }
    T.stuckFrames++;
    if (T.lastJam) {
      T.lastJam.frames++;
      return;
    }
    const r = 0.35;
    const eye = this.crouching ? 1.1 : 1.7;
    const feet = this.position.y - eye;
    const blockers = [];
    for (const a of this.aabbs) {
      if (a.maxY <= feet + 0.05) continue; // underfoot, same skip rule as collidesAabb
      if (a.minY >= this.position.y + 0.05) continue; // overhead
      const dx = Math.max(a.minX - bx, 0, bx - a.maxX);
      const dz = Math.max(a.minZ - bz, 0, bz - a.maxZ);
      if (dx < r + 0.1 && dz < r + 0.1) {
        blockers.push([a.minX, a.maxX, a.minY, a.maxY, a.minZ, a.maxZ].map((n) => +n.toFixed(2)).join(','));
      }
    }
    T.lastJam = {
      at: [+bx.toFixed(2), +this.position.y.toFixed(2), +bz.toFixed(2)],
      input: [+strafe.toFixed(2), +forward.toFixed(2)],
      yaw: +this.facing.y.toFixed(2),
      crouch: this.crouching,
      frames: 1,
      blockers,
    };
    T.jams.push(T.lastJam);
    if (T.jams.length > 40) T.jams.shift();
  };
  return 'tracer installed — play, then read window.__stuckTrace';
})()
