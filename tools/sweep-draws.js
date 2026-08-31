/**
 * Draw-call sweep. Samples renderer.info.render.calls from every room at 8 compass headings so the
 * house's real worst case is measured rather than guessed at.
 *
 *   node tools/cdp.mjs --file tools/sweep-draws.js
 *
 * Saves the player's position, heading and crouch state up front and restores them at the end, so it
 * can be run against a live session without stranding whoever is holding the phone. Each sample waits
 * two frames: one for the new transform to reach the camera, one for the render whose counters we read.
 */
(async () => {
  const d = window.__daayan;
  const P = d.player;
  const dbg = d.debug;

  const saved = {
    x: P.position.x,
    y: P.position.y,
    z: P.position.z,
    yaw: P.facing.y,
    pitch: P.facing.x,
    crouch: P.crouching,
  };

  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

  const ROOMS = [
    ['hall', 0, 1.7, -3.5],
    ['hallway', 0, 1.7, 1.3],
    ['bedroom', -5, 1.7, 6.4],
    ['living', 4, 1.7, 6.4],
    ['basement', -17.9, -1.3, 2.3],
    ['ritual', -26, -1.3, 2.3],
    ['porch', 0, 1.7, -7.9],
  ];

  const out = [];
  let worst = { draws: 0 };

  for (const [name, x, y, z] of ROOMS) {
    let best = { draws: 0, tris: 0, yaw: 0 };
    for (let i = 0; i < 8; i++) {
      const yaw = (i * Math.PI) / 4;
      P.position.set(x, y, z);
      P.facing.y = yaw;
      P.facing.x = 0;
      // The camera is its own object and only follows through syncCamera(); setting position alone
      // leaves the view where it was, which silently makes every sample read the same frame.
      P.syncCamera();
      await frame();
      await frame();
      const draws = dbg.lastDrawCalls;
      const tris = dbg.lastTriangles;
      if (draws > best.draws) best = { draws, tris, yaw: +yaw.toFixed(2) };
    }
    out.push({ room: name, maxDraws: best.draws, tris: best.tris, atYaw: best.yaw });
    if (best.draws > worst.draws) worst = { room: name, ...best };
  }

  // Put the player back exactly where they were standing.
  P.position.set(saved.x, saved.y, saved.z);
  P.facing.y = saved.yaw;
  P.facing.x = saved.pitch;
  P.syncCamera();
  await frame();

  return JSON.stringify({ perRoom: out, worst, restoredTo: [+saved.x.toFixed(2), +saved.y.toFixed(2), +saved.z.toFixed(2)] });
})()
