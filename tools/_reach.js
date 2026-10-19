/**
 * Is the flipping pose one the player can actually stand in?
 *
 * _fix.js proved the artefact and its mechanism — hide the leaf and UPPER_INNER's 494 flipped pixels go to
 * 0; raise near past the leaf and 494 becomes 16 — but it also printed the leaf's world box as
 * x 19.74..19.89, z 1.21..2.29, and the pose I had been scoring is (19.855, 2.3). That is *inside* the
 * closed slab. While the door is shut a blocker AABB fills the opening, so the player cannot be there, and
 * an artefact at an unreachable pose is not the user's bug.
 *
 * What makes it reachable is the swing. InnerDoor.ts:80 — "a swinging leaf has no collider of its own" —
 * and the blocker is dropped to y -60 the moment the door opens, so once open there is nothing at all to
 * keep the player out of the leaf. This finds out whether that is true in practice, which needs three
 * things this file goes looking for rather than assuming: the controller's AABB array, the interaction that
 * opens the door, and the leaf's box before and after.
 *
 *   node tools/cdp.mjs --file tools/_reach.js
 */
(() => {
  const d = window.__daayan;
  const out = [];
  out.push(`__daayan keys: ${Object.keys(d).join(' ')}`);

  const p = d.player;
  if (p) {
    out.push(`player: ${p.constructor && p.constructor.name} keys ${Object.keys(p).join(' ')}`);
    if (p.opts) out.push(`player.opts keys: ${Object.keys(p.opts).join(' ')}`);
    for (const k of Object.keys(p)) {
      const v = p[k];
      if (Array.isArray(v)) out.push(`  player.${k} is an array of ${v.length}${v.length ? `, first keys ${Object.keys(v[0]).join(',')}` : ''}`);
    }
    if (p.opts) for (const k of Object.keys(p.opts)) {
      const v = p.opts[k];
      if (Array.isArray(v)) out.push(`  player.opts.${k} is an array of ${v.length}${v.length ? `, first keys ${Object.keys(v[0]).join(',')}` : ''}`);
    }
    out.push(`player position ${['x', 'y', 'z'].map((k) => (p.position ? p.position[k].toFixed(2) : '?')).join(', ')}  radius ${p.radius}`);
  } else {
    out.push('no d.player');
  }

  // The interaction registry, so the door can be opened the way the player opens it rather than by
  // reaching into the pivot and inventing a rotation.
  for (const k of Object.keys(d)) {
    const v = d[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const ks = Object.keys(v);
      if (ks.some((n) => /interact|entries|items|list/i.test(n))) out.push(`d.${k} keys: ${ks.join(' ')}`);
    }
  }

  const scene = d.engine.scene;
  scene.updateMatrixWorld(true);
  let pivot = null;
  scene.traverse((o) => { if (o.name === 'inner-door.pivot') pivot = o; });
  out.push(pivot ? `inner-door.pivot found, rotation.y ${pivot.rotation.y.toFixed(4)} rad (${((pivot.rotation.y * 180) / Math.PI).toFixed(1)} deg)` : 'inner-door.pivot NOT FOUND');

  return out.join('\n');
})()
