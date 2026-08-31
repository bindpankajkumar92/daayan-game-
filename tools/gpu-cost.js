/**
 * GPU cost of a frame, on the device, with and without the contact shadows.
 *
 * `gl.finish()` after a block of renders is the honest way to get this without a timer-query
 * extension: the driver is free to buffer work behind the API, so timing a single render measures the
 * submit and nothing else. Thirty renders then one finish measures the queue actually draining.
 *
 * The rAF loop is still running, but every timed block is synchronous, so it cannot interleave.
 */
(async () => {
  const D = window.__daayan;
  const R = D.engine.renderer;
  const S = D.engine.scene;
  const cam = D.engine.camera;
  const P = D.player;
  const gl = R.getContext();
  const dbg = D.debug;

  const timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');

  const models = S.getObjectByName('models');
  const props = S.getObjectByName('props');
  const quads = models.children.filter((o) => o.isMesh && o.name.endsWith(':shadow'));
  const merged = [];
  props.traverse((o) => {
    if (o.isMesh && o.material.blending === 5 && o.material.blendSrc === 200) merged.push(o);
  });
  const shadows = [...quads, ...merged];

  const saved = { x: P.position.x, y: P.position.y, z: P.position.z, yaw: P.facing.y, pitch: P.facing.x };
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

  const N = 30;
  const block = () => {
    // Warm: first render after a state change compiles nothing here but does refill the caches.
    for (let i = 0; i < 5; i++) R.render(S, cam);
    gl.finish();
    const t0 = performance.now();
    for (let i = 0; i < N; i++) R.render(S, cam);
    gl.finish();
    return (performance.now() - t0) / N;
  };
  const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  const measure = () => med([block(), block(), block()]);

  // The rooms the sweep just called worst, plus the hall the old baseline was taken in.
  const VIEWS = [
    ['hall', 0, 1.7, -3.5, 2.36],
    ['living', 4, 1.7, 6.4, 0.79],
    ['ritual', -26, -1.3, 2.3, 4.71],
    ['porch', 0, 1.7, -7.9, 2.36],
  ];

  const rows = [];
  for (const [name, x, y, z, yaw] of VIEWS) {
    P.position.set(x, y, z);
    P.facing.y = yaw;
    P.facing.x = 0;
    P.syncCamera();
    await frame();
    await frame();

    shadows.forEach((o) => (o.visible = true));
    const on = measure();
    const onDraws = dbg.lastDrawCalls;
    const onTris = dbg.lastTriangles;
    shadows.forEach((o) => (o.visible = false));
    const off = measure();
    await frame();
    const offDraws = dbg.lastDrawCalls;
    shadows.forEach((o) => (o.visible = true));
    await frame();

    rows.push({
      room: name,
      msOn: +on.toFixed(2),
      msOff: +off.toFixed(2),
      shadowMs: +(on - off).toFixed(2),
      shadowPct: +(((on - off) / off) * 100).toFixed(1),
      draws: onDraws,
      drawsNoShadow: offDraws,
      tris: onTris,
    });
  }

  P.position.set(saved.x, saved.y, saved.z);
  P.facing.y = saved.yaw;
  P.facing.x = saved.pitch;
  P.syncCamera();
  await frame();

  return JSON.stringify({
    gpu: (() => {
      const d = gl.getExtension('WEBGL_debug_renderer_info');
      return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'n/a';
    })(),
    timerQuery: !!timerExt,
    drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    renderScale: dbg.renderScale,
    tier: dbg.qualityTier,
    samplesMSAA: gl.getParameter(gl.SAMPLES),
    frameTimeEmaMs: +(D.quality.frameTimeEma * 1000).toFixed(2),
    quads: quads.length,
    mergedPasses: merged.length,
    rows,
  });
})()
