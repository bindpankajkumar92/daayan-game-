/**
 * Why did rotating the pivot move nothing?
 *
 * _swing.js reported every `matrixAutoUpdate` true and still got a bit-identical world box after a 100 deg
 * turn, which cannot happen if the object being turned is the leaf's actual ancestor. The likely reason is in
 * how the pivot was found: `scene.traverse((o) => { if (o.name === 'inner-door.pivot') pivot = o; })` keeps
 * the *last* match, and armInnerDoor's own `parts` filter — `c.name !== 'inner-door.pivot'` — says the author
 * expected more than one to be possible.
 *
 * So count them, take the one that is genuinely an ancestor of a leaf mesh, and print the leaf's world
 * translation before and after the turn. Also print each pivot's matrix, since a pivot whose parent chain is
 * culled to `visible = false` still transforms and one that was never `attach`ed to does not.
 *
 *   node tools/cdp.mjs --file tools/_pivot.js
 */
(() => {
  const d = window.__daayan;
  const scene = d.engine.scene;
  scene.updateMatrixWorld(true);

  const pivots = [];
  scene.traverse((o) => { if (o.name === 'inner-door.pivot') pivots.push(o); });
  const leaves = [];
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    for (let q = o; q; q = q.parent) if (/door-inner/.test(q.name || '')) { leaves.push(o); return; }
  });

  const out = [];
  out.push(`${pivots.length} object(s) named inner-door.pivot; ${leaves.length} leaf meshes`);
  const anc = [];
  for (let q = leaves[0]; q; q = q.parent) anc.push(q);
  for (let i = 0; i < pivots.length; i++) {
    const pv = pivots[i];
    out.push(
      `  pivot ${i}: children ${pv.children.length}  rot.y ${pv.rotation.y.toFixed(4)}  ` +
        `pos ${pv.position.x.toFixed(2)},${pv.position.y.toFixed(2)},${pv.position.z.toFixed(2)}  ` +
        `ancestor of leaves[0]: ${anc.includes(pv)}  visible ${pv.visible}  parent ${pv.parent ? pv.parent.name || pv.parent.type : 'none'}`,
    );
  }

  const pivot = pivots.find((pv) => anc.includes(pv)) || pivots[0];
  const leaf = leaves[0];
  const tr = () => {
    scene.updateMatrixWorld(true);
    const m = leaf.matrixWorld.elements;
    return `leaf world translate ${m[12].toFixed(3)}, ${m[13].toFixed(3)}, ${m[14].toFixed(3)}  scale ${Math.hypot(m[0], m[1], m[2]).toFixed(5)}`;
  };
  out.push('');
  out.push(`using pivot with ${pivot.children.length} children, ancestor: ${anc.includes(pivot)}`);
  out.push(`before  rot.y ${pivot.rotation.y.toFixed(4)}   ${tr()}`);
  const shut = pivot.rotation.y;
  pivot.rotation.y = shut + Math.PI / 2;
  out.push(`+90 deg rot.y ${pivot.rotation.y.toFixed(4)}   ${tr()}`);
  out.push(`  pivot.matrix after: ${Array.from(pivot.matrix.elements).map((v) => v.toFixed(3)).join(' ')}`);
  pivot.rotation.y = shut;
  scene.updateMatrixWorld(true);
  out.push(`restored rot.y ${pivot.rotation.y.toFixed(4)}   ${tr()}`);

  // And the geometry's own local extent, because a leaf whose vertices sit far from its node origin moves
  // its box without moving its translation and the reverse is also possible.
  const g = leaf.geometry;
  if (!g.boundingBox) g.computeBoundingBox();
  out.push('');
  out.push(
    `leaf geometry local box  x ${g.boundingBox.min.x.toFixed(2)}..${g.boundingBox.max.x.toFixed(2)}  ` +
      `y ${g.boundingBox.min.y.toFixed(2)}..${g.boundingBox.max.y.toFixed(2)}  z ${g.boundingBox.min.z.toFixed(2)}..${g.boundingBox.max.z.toFixed(2)}`,
  );
  return out.join('\n');
})()
