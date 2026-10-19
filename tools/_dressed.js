/**
 * Did dressShell actually run in the build that is installed?
 *
 * Three things have to be true and each one has failed separately elsewhere in this project: the shell
 * geometry has a `uv` attribute where it had none, the material holds the *same* Texture instance the
 * procedural walls hold (not a copy, which would be a second 1024 upload), and the tint under it is
 * white so the map reads at the value HouseBuilder's walls read at.
 *
 * It also prints the UV range in tiles, because a world-space projection that came out in the wrong units
 * would still satisfy "has a uv attribute" and would render as one texel stretched across 10 m.
 *
 *   node tools/cdp.mjs --file tools/_dressed.js
 */
(() => {
  const d = window.__daayan;
  const scene = d.engine.scene;
  const out = [];
  const shell = [];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    if (ms.some((m) => m && m.userData && m.userData.sealed === true)) shell.push(o);
  });
  out.push(`meshes flagged sealed: ${shell.length}`);

  // The procedural walls' own map, to compare identity against. upper-walls is the storey's plaster.
  let houseMap = null;
  scene.traverse((o) => {
    if (!o.isMesh || houseMap) return;
    if (!/^upper-walls|^walls/.test(o.name)) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (m && m.map) houseMap = { tex: m.map, from: o.name, col: m.color.getHexString() };
  });
  out.push(houseMap ? `house wall map from ${houseMap.from} (tint #${houseMap.col})` : 'no procedural wall map found');

  for (const mesh of shell) {
    const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const uv = mesh.geometry.attributes.uv;
    let mn = Infinity, mx = -Infinity;
    if (uv) for (let i = 0; i < uv.count; i++) { mn = Math.min(mn, uv.getX(i), uv.getY(i)); mx = Math.max(mx, uv.getX(i), uv.getY(i)); }
    out.push(
      `${mesh.name}: uv ${uv ? uv.count : 'NONE'}  range ${uv ? `${mn.toFixed(2)} .. ${mx.toFixed(2)}` : '-'}  ` +
        `map ${m.map ? 'yes' : 'NO'}  sameTextureAsHouse ${houseMap ? m.map === houseMap.tex : '?'}  ` +
        `tint #${m.color.getHexString()}  transparent ${m.transparent}  depthWrite ${m.depthWrite}  side ${m.side}`,
    );
    if (m.map) out.push(`  map: ${m.map.constructor.name} ${m.map.image ? `${m.map.image.width}x${m.map.image.height}` : '?'} wrap ${m.map.wrapS}/${m.map.wrapT} repeat ${m.map.repeat.x},${m.map.repeat.y} aniso ${m.map.anisotropy}`);
  }
  out.push('', `draws ${d.debug.lastDrawCalls}  tris ${d.debug.lastTriangles}`);
  return out.join('\n');
})()
