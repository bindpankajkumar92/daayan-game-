/**
 * Frame period as the player actually experiences it, per room. No manual render() calls anywhere in
 * here: timing a block of renders tells you what the GPU costs, but it also stalls the rAF loop, and
 * anything that reads QualityManager's EMA afterwards reads the stall rather than the game. This
 * measures only the loop's own cadence and leaves the scene alone.
 *
 * Median, not mean: one 200 ms hitch from a texture upload or a GC would otherwise decide the answer.
 */
(async () => {
  const D = window.__daayan;
  const P = D.player;
  const dbg = D.debug;
  const saved = { x: P.position.x, y: P.position.y, z: P.position.z, yaw: P.facing.y, pitch: P.facing.x };
  const frame = () => new Promise((r) => requestAnimationFrame((t) => r(t)));

  const VIEWS = [
    ['hall', 0, 1.7, -3.5, 2.36],
    ['hallway', 0, 1.7, 1.3, 2.36],
    ['bedroom', -5, 1.7, 6.4, 0.79],
    ['living', 4, 1.7, 6.4, 0.79],
    ['basement', -17.9, -1.3, 2.3, 3.93],
    ['ritual', -26, -1.3, 2.3, 4.71],
    ['porch', 0, 1.7, -7.9, 2.36],
  ];

  const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];

  const rows = [];
  for (const [name, x, y, z, yaw] of VIEWS) {
    P.position.set(x, y, z);
    P.facing.y = yaw;
    P.facing.x = 0;
    P.syncCamera();
    // Settle: the first frames after a teleport pay for whatever came into the frustum.
    for (let i = 0; i < 20; i++) await frame();
    const dts = [];
    let prev = await frame();
    for (let i = 0; i < 100; i++) {
      const t = await frame();
      dts.push(t - prev);
      prev = t;
    }
    rows.push({
      room: name,
      medMs: +med(dts).toFixed(2),
      p95Ms: +pct(dts, 0.95).toFixed(2),
      fps: +(1000 / med(dts)).toFixed(1),
      draws: dbg.lastDrawCalls,
      tris: dbg.lastTriangles,
      scale: +dbg.renderScale.toFixed(2),
    });
  }

  P.position.set(saved.x, saved.y, saved.z);
  P.facing.y = saved.yaw;
  P.facing.x = saved.pitch;
  P.syncCamera();
  await frame();

  return JSON.stringify({
    tier: dbg.qualityTier,
    emaMs: +(D.quality.frameTimeEma * 1000).toFixed(2),
    targetMs: +(D.quality.targetFrameTime * 1000).toFixed(2),
    scale: +dbg.renderScale.toFixed(2),
    rows,
  });
})()
