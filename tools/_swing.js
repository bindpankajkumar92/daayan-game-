/**
 * Does the leaf actually swing?
 *
 * _legalflip.js set `pivot.rotation.y = shut + 100 deg`, called `scene.updateMatrixWorld(true)`, and got the
 * *same* world box back: x 19.740..19.970, z 1.213..2.287, identical to shut. So either the rotation did not
 * take, or the swing is not a rotation about that pivot.
 *
 * Which it is decides what the bug is. If `matrixAutoUpdate` is off on the pivot or an ancestor — which is
 * what ModelProps would plausibly do to a static placement — then setting `rotation` moves nothing, in this
 * probe *and in the tween that opens the door*. The player would push the door, the blocker would drop to
 * y -60, the leaf would stay standing in the opening, and they would walk through a door that still looks
 * shut with their eye inside the slab. That is both the flicker and a gameplay bug.
 *
 * So: report the flag up the whole chain, then move the pivot three ways — rotation alone, rotation with an
 * explicit updateMatrix, and rotation with matrixAutoUpdate forced on — and print the leaf's world box after
 * each. Whichever one moves it is the one the fix has to use.
 *
 *   node tools/cdp.mjs --file tools/_swing.js
 */
(() => {
  const d = window.__daayan;
  const scene = d.engine.scene;
  scene.updateMatrixWorld(true);

  let pivot = null;
  scene.traverse((o) => { if (o.name === 'inner-door.pivot') pivot = o; });
  if (!pivot) return 'inner-door.pivot NOT FOUND';

  const leaves = [];
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    for (let q = o; q; q = q.parent) if (/door-inner/.test(q.name || '')) { leaves.push(o); return; }
  });

  const box = () => {
    scene.updateMatrixWorld(true);
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const o of leaves) {
      const g = o.geometry, pos = g.attributes.position;
      const el = o.matrixWorld.elements;
      for (let j = 0; j < pos.count; j++) {
        const x = pos.getX(j), y = pos.getY(j), z = pos.getZ(j);
        const w = [el[0] * x + el[4] * y + el[8] * z + el[12], el[1] * x + el[5] * y + el[9] * z + el[13], el[2] * x + el[6] * y + el[10] * z + el[14]];
        for (let m = 0; m < 3; m++) { if (w[m] < lo[m]) lo[m] = w[m]; if (w[m] > hi[m]) hi[m] = w[m]; }
      }
    }
    return `x ${lo[0].toFixed(3)}..${hi[0].toFixed(3)}  z ${lo[2].toFixed(3)}..${hi[2].toFixed(3)}`;
  };

  const out = [];
  // The chain from the leaf up to the scene, with the flag that decides whether a rotation is honoured.
  out.push('chain from a leaf mesh up to the scene:');
  for (let q = leaves[0]; q; q = q.parent) {
    out.push(`  ${(q.name || q.type).padEnd(28)} ${q.type.padEnd(12)} matrixAutoUpdate ${String(q.matrixAutoUpdate).padEnd(5)} matrixWorldAutoUpdate ${q.matrixWorldAutoUpdate}  children ${q.children.length}`);
    if (q === scene) break;
  }
  out.push(`pivot children: ${pivot.children.map((c) => c.name || c.type).join(', ')}`);
  out.push(`pivot.rotation.y ${pivot.rotation.y.toFixed(4)}  position ${pivot.position.x.toFixed(3)}, ${pivot.position.y.toFixed(3)}, ${pivot.position.z.toFixed(3)}`);
  out.push('');

  const shut = pivot.rotation.y;
  const open = shut + (100 * Math.PI) / 180;
  out.push(`shut box                            ${box()}`);

  pivot.rotation.y = open;
  out.push(`rotation alone                      ${box()}`);

  pivot.updateMatrix();
  out.push(`rotation + pivot.updateMatrix()     ${box()}`);

  const a0 = pivot.matrixAutoUpdate;
  pivot.matrixAutoUpdate = true;
  pivot.rotation.y = open;
  out.push(`rotation + matrixAutoUpdate on      ${box()}`);
  pivot.matrixAutoUpdate = a0;

  // Restore, by whichever route worked.
  pivot.rotation.y = shut;
  pivot.updateMatrix();
  scene.updateMatrixWorld(true);
  out.push(`restored                            ${box()}`);
  return out.join('\n');
})()
