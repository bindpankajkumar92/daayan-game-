/**
 * Is the shell's geometry safe for per-vertex world UVs, the way HouseBuilder.worldUv does it?
 *
 * worldUv picks the projection axis from each *vertex's* normal. That is sound on the procedural boxes
 * it was written for, because BoxGeometry splits its corners — every vertex belongs to exactly one
 * facing. An imported mesh may instead share one vertex between a wall triangle and a slab triangle, and
 * then one of the two gets the other's axis: v would come out constant across a floor triangle and the
 * tile would smear into a streak. So count the shared ones before writing the pass, rather than after
 * shipping it.
 *
 *   node tools/cdp.mjs --file tools/_uvchk.js
 */
(() => {
  const d = window.__daayan;
  const scene = d.engine.scene;
  const V3 = d.engine.camera.position.constructor;
  scene.updateMatrixWorld(true);

  const targets = [];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.some((m) => m && !m.map && m.color?.getHex?.() === 0x4a4a52)) targets.push(o);
  });

  const out = [];
  const a = new V3(), b = new V3(), c = new V3(), e1 = new V3(), e2 = new V3(), fn = new V3(), vn = new V3();
  for (const mesh of targets) {
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const nor = geo.attributes.normal;
    const idx = geo.index;
    const nm = mesh.normalMatrix;
    mesh.updateMatrixWorld(true);
    // three keeps normalMatrix up to date only during render; recompute so this does not read a stale one.
    nm.getNormalMatrix(mesh.matrixWorld);

    const axisOf = (v) => {
      const ax = Math.abs(v.x), ay = Math.abs(v.y), az = Math.abs(v.z);
      return ay > ax && ay > az ? 'flat' : az > ax ? 'x' : 'z';
    };

    const perVertexAxes = new Map();
    let faceVsVertexMismatch = 0;
    let tris = 0;
    const count = idx ? idx.count : pos.count;
    for (let i = 0; i < count; i += 3) {
      const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld);
      e1.subVectors(b, a); e2.subVectors(c, a);
      fn.crossVectors(e1, e2);
      if (fn.lengthSq() === 0) continue;
      fn.normalize();
      tris++;
      const fa = axisOf(fn);
      for (const vi of [i0, i1, i2]) {
        const set = perVertexAxes.get(vi) ?? new Set();
        set.add(fa);
        perVertexAxes.set(vi, set);
        if (nor) {
          vn.fromBufferAttribute(nor, vi).applyMatrix3(nm).normalize();
          if (axisOf(vn) !== fa) faceVsVertexMismatch++;
        }
      }
    }
    let shared = 0;
    for (const s of perVertexAxes.values()) if (s.size > 1) shared++;

    geo.computeBoundingBox();
    const bb = geo.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
    out.push(
      `${mesh.name}: ${tris} tris, ${pos.count} verts, ${idx ? 'indexed' : 'non-indexed'}, ` +
        `attrs [${Object.keys(geo.attributes).join(',')}]`,
    );
    out.push(
      `  verts touching >1 facing: ${shared} / ${perVertexAxes.size}  ` +
        `(${((shared / Math.max(1, perVertexAxes.size)) * 100).toFixed(1)}%)`,
    );
    out.push(`  triangle-corners whose vertex normal disagrees with its face normal: ${faceVsVertexMismatch} / ${tris * 3}`);
    out.push(`  world box ${bb.min.toArray().map((v) => v.toFixed(2)).join()} .. ${bb.max.toArray().map((v) => v.toFixed(2)).join()}`);
    out.push(`  matrixWorld scale ${mesh.matrixWorld.elements[0].toFixed(3)}  rotY? ${mesh.matrixWorld.elements[2].toFixed(4)}`);
  }
  return out.join('\n') || 'no shell mesh matched';
})()
