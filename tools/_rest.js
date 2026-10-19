/**
 * Throwaway: put the right hand back on its authored rest pose, so FIST's contribution can be seen on
 * its own. Needs tools/_handrig.js installed first (it captures __rest before anything overwrites it).
 */
(() => {
  const d = window.__daayan;
  let arms = null;
  d.engine.scene.traverse((o) => {
    if (o.name === 'held.arms') arms = o;
  });
  if (!arms || !window.__rest) return 'install tools/_handrig.js first';
  let n = 0;
  arms.traverse((o) => {
    const r = window.__rest[o.name];
    if (!r) return;
    o.rotation.set(r[0], r[1], r[2]);
    n++;
  });
  arms.updateMatrixWorld(true);
  return `rest pose restored on ${n} joints`;
})()
