/**
 * The coplanar audit, run against the *whole live scene* instead of buildHouse alone.
 *
 * tools/audit-coplanar.ts reports 0 overlaps and that is true and not enough: it walks `house.group`,
 * so it cannot see imported .glb rooms, door props, prop-level shadow quads, or anything installModels
 * adds. The reported defect is a dark skewed quad on floorboards *at a door threshold* that changes
 * shape with the viewing angle, which is what two horizontal surfaces within a depth-buffer epsilon of
 * each other look like — so the pair has to be found across the whole graph, not one subtree.
 *
 * World boxes come from each geometry's own boundingBox pushed through matrixWorld's 8 corners rather
 * than from Box3.setFromObject(precise), because precise walks every vertex and this scene has meshes
 * with 20k of them; the house has no rotated slabs, so the corner transform is exact where it matters.
 *
 * Also reports degenerate-in-one-axis meshes (a "riser" filling a height difference of nothing is a
 * zero-area quad, and a zero-area quad is the round-1 w -> 0 failure again) and everything named riser,
 * since round 3 added those at exactly these thresholds and they have never been seen on the device.
 *
 *   node tools/cdp.mjs --file tools/_coplanar-live.js
 */
(() => {
  const d = window.__daayan;
  const scene = d.engine.scene;
  const COPLANAR = 0.02;
  const FLAT = 0.03;
  const MIN_AREA = 0.05;

  const xf = (m, x, y, z) => {
    const e = m.elements;
    return [
      e[0] * x + e[4] * y + e[8] * z + e[12],
      e[1] * x + e[5] * y + e[9] * z + e[13],
      e[2] * x + e[6] * y + e[10] * z + e[14],
    ];
  };
  const worldBox = (mesh) => {
    const g = mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const b = g.boundingBox;
    if (!b || !isFinite(b.min.x)) return null;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < 8; i++) {
      const p = xf(
        mesh.matrixWorld,
        i & 1 ? b.max.x : b.min.x,
        i & 2 ? b.max.y : b.min.y,
        i & 4 ? b.max.z : b.min.z,
      );
      for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; }
    }
    return { lo, hi };
  };

  scene.updateMatrixWorld(true);
  const slabs = [];
  const degenerate = [];
  const risers = [];
  let meshes = 0;
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    // Deliberately NOT filtering on `visible`: the culler flips it per frame from wherever the player
    // happens to stand, so a filtered pass reports only the room being stood in — the first run of this
    // probe saw 443 of the scene's meshes and missed every threshold in the house.
    meshes++;
    const wb = worldBox(o);
    if (!wb) return;
    const { lo, hi } = wb;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    const path = [];
    for (let p = o; p && p !== scene; p = p.parent) path.push(p.name || p.type);
    const rec = {
      name: o.name || '(unnamed)',
      path: path.reverse().join('/'),
      lo, hi,
      dy: hi[1] - lo[1],
      off: m && m.polygonOffset ? (m.polygonOffsetFactor ?? 0) : 0,
      units: m && m.polygonOffset ? (m.polygonOffsetUnits ?? 0) : 0,
      order: o.renderOrder,
      writes: !m || m.depthWrite !== false,
      trans: !!(m && m.transparent),
      mat: (m && (m.name || m.type)) || '?',
      matId: m ? m.id : -1,
      tris: o.geometry.index ? o.geometry.index.count / 3 : (o.geometry.attributes.position ? o.geometry.attributes.position.count / 3 : 0),
    };
    if (/riser/i.test(rec.name)) risers.push(rec);
    const span = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const thin = span.filter((s) => s < 0.002).length;
    if (thin >= 2 && rec.tris > 0) degenerate.push(rec);
    if (rec.dy <= FLAT) slabs.push(rec);
  });

  slabs.sort((a, b) => (a.lo[1] + a.hi[1]) - (b.lo[1] + b.hi[1]));
  const yOf = (s) => (s.lo[1] + s.hi[1]) / 2;
  const hits = [];
  for (let i = 0; i < slabs.length; i++) {
    for (let j = i + 1; j < slabs.length; j++) {
      if (yOf(slabs[j]) - yOf(slabs[i]) > COPLANAR) break;
      const a = slabs[i], b = slabs[j];
      const w = Math.min(a.hi[0], b.hi[0]) - Math.max(a.lo[0], b.lo[0]);
      const t = Math.min(a.hi[2], b.hi[2]) - Math.max(a.lo[2], b.lo[2]);
      if (w <= 0 || t <= 0 || w * t < MIN_AREA) continue;
      const separated = a.units !== b.units || a.off !== b.off || !a.writes || !b.writes;
      hits.push({ a, b, area: w * t, separated });
    }
  }
  // The same test on the other two axes. A wall is a plane too, and the first version of this probe only
  // looked at horizontal ones — which is how a scene with a reported z-fight came back clean.
  const walls = { 0: [], 2: [] };
  for (const ax of [0, 2]) {
    scene.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const wb = worldBox(o);
      if (!wb) return;
      if (wb.hi[ax] - wb.lo[ax] > FLAT) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      const path = [];
      for (let p = o; p && p !== scene; p = p.parent) path.push(p.name || p.type);
      walls[ax].push({
        name: o.name || '(unnamed)', path: path.reverse().join('/'),
        lo: wb.lo, hi: wb.hi,
        off: m && m.polygonOffset ? (m.polygonOffsetFactor ?? 0) : 0,
        units: m && m.polygonOffset ? (m.polygonOffsetUnits ?? 0) : 0,
        order: o.renderOrder, writes: !m || m.depthWrite !== false,
        mat: (m && (m.name || m.type)) || '?', matId: m ? m.id : -1,
      });
    });
  }
  const wallHits = [];
  for (const ax of [0, 2]) {
    const list = walls[ax];
    const mid = (s) => (s.lo[ax] + s.hi[ax]) / 2;
    list.sort((a, b) => mid(a) - mid(b));
    const u = ax === 0 ? 2 : 0;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (mid(list[j]) - mid(list[i]) > COPLANAR) break;
        const a = list[i], b = list[j];
        const w = Math.min(a.hi[u], b.hi[u]) - Math.max(a.lo[u], b.lo[u]);
        const t = Math.min(a.hi[1], b.hi[1]) - Math.max(a.lo[1], b.lo[1]);
        if (w <= 0 || t <= 0 || w * t < MIN_AREA) continue;
        const separated = a.units !== b.units || a.off !== b.off || !a.writes || !b.writes;
        wallHits.push({ ax, a, b, area: w * t, separated, d: (mid(b) - mid(a)) * 1000, at: mid(a) });
      }
    }
  }

  const out = [];
  out.push(`${meshes} visible meshes, ${slabs.length} flat (dy<=${FLAT})`);
  out.push('');
  hits.sort((p, q) => q.area - p.area);
  const bad = hits.filter((h) => !h.separated);
  out.push(`coplanar overlaps: ${hits.length} total, ${bad.length} with nothing separating them`);
  for (const h of hits.slice(0, 24)) {
    out.push(
      `${h.separated ? '  ok ' : ' BAD '}${`${h.a.name} + ${h.b.name}`.slice(0, 44).padEnd(44)} ` +
        `y ${yOf(h.a).toFixed(3)}/${yOf(h.b).toFixed(3)} dy ${((yOf(h.b) - yOf(h.a)) * 1000).toFixed(1)}mm ` +
        `area ${h.area.toFixed(2)}m2 units ${h.a.units}/${h.b.units} order ${h.a.order}/${h.b.order} ` +
        `write ${h.a.writes ? 1 : 0}/${h.b.writes ? 1 : 0}`,
    );
    if (!h.separated) {
      out.push(`      a: ${h.a.path} mat#${h.a.matId} ${h.a.mat} x ${h.a.lo[0].toFixed(2)}..${h.a.hi[0].toFixed(2)} z ${h.a.lo[2].toFixed(2)}..${h.a.hi[2].toFixed(2)}`);
      out.push(`      b: ${h.b.path} mat#${h.b.matId} ${h.b.mat} x ${h.b.lo[0].toFixed(2)}..${h.b.hi[0].toFixed(2)} z ${h.b.lo[2].toFixed(2)}..${h.b.hi[2].toFixed(2)}`);
    }
  }
  out.push('');
  const badWalls = wallHits.filter((h) => !h.separated);
  out.push(`vertical coplanar overlaps: ${wallHits.length} total, ${badWalls.length} with nothing separating them`);
  wallHits.sort((p, q) => (p.separated === q.separated ? q.area - p.area : p.separated ? 1 : -1));
  for (const h of wallHits.slice(0, 20)) {
    out.push(
      `${h.separated ? '  ok ' : ' BAD '}${h.ax === 0 ? 'x' : 'z'}=${h.at.toFixed(3)} ` +
        `${`${h.a.name} + ${h.b.name}`.slice(0, 40).padEnd(40)} d ${h.d.toFixed(1)}mm ` +
        `area ${h.area.toFixed(2)}m2 units ${h.a.units}/${h.b.units} write ${h.a.writes ? 1 : 0}/${h.b.writes ? 1 : 0}`,
    );
    if (!h.separated) {
      out.push(`      a: ${h.a.path.slice(0, 110)} mat#${h.a.matId} ${h.a.mat}`);
      out.push(`      b: ${h.b.path.slice(0, 110)} mat#${h.b.matId} ${h.b.mat}`);
      out.push(`         a box x ${h.a.lo[0].toFixed(2)}..${h.a.hi[0].toFixed(2)} y ${h.a.lo[1].toFixed(2)}..${h.a.hi[1].toFixed(2)} z ${h.a.lo[2].toFixed(2)}..${h.a.hi[2].toFixed(2)}`);
      out.push(`         b box x ${h.b.lo[0].toFixed(2)}..${h.b.hi[0].toFixed(2)} y ${h.b.lo[1].toFixed(2)}..${h.b.hi[1].toFixed(2)} z ${h.b.lo[2].toFixed(2)}..${h.b.hi[2].toFixed(2)}`);
    }
  }
  out.push('');
  out.push(`degenerate (two axes < 2mm): ${degenerate.length}`);
  for (const r of degenerate.slice(0, 12)) out.push(`  ${r.name} ${r.path} tris ${r.tris} x ${r.lo[0].toFixed(3)}..${r.hi[0].toFixed(3)} y ${r.lo[1].toFixed(3)}..${r.hi[1].toFixed(3)} z ${r.lo[2].toFixed(3)}..${r.hi[2].toFixed(3)}`);
  out.push('');
  out.push(`risers: ${risers.length}`);
  for (const r of risers) {
    out.push(
      `  ${r.name} y ${r.lo[1].toFixed(3)}..${r.hi[1].toFixed(3)} (h ${((r.hi[1] - r.lo[1]) * 1000).toFixed(1)}mm) ` +
        `x ${r.lo[0].toFixed(2)}..${r.hi[0].toFixed(2)} z ${r.lo[2].toFixed(2)}..${r.hi[2].toFixed(2)} ` +
        `mat#${r.matId} ${r.mat} units ${r.units} order ${r.order} tris ${r.tris}`,
    );
  }
  return out.join('\n');
})()
