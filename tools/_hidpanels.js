/**
 * Are the stairwell's own facings in the scene, and how many of them?
 *
 * `probe-panels.mjs` counts wall facings, but it requires the node's name to contain "wall" — and these
 * rows are named after the holes they stand on (`up-hidden-kerb-north`, `up-hidden-shaft-south`), which
 * does not. A screenshot cannot answer it either: the facing is the same scan texture the plaster already
 * resembles, so a missing kerb facing and a present one look the same in a still.
 *
 * Run:  node tools/cdp.mjs --file tools/_hidpanels.js     (CDP_PORT for a non-default port)
 */
(() => {
  const g = window.__daayan;
  const scene = (g.engine && g.engine.scene) || g.scene;
  if (!scene || !scene.traverse) return JSON.stringify({ error: 'no scene' });
  const byName = {};
  const rows = [];
  scene.traverse((o) => {
    let n = o;
    let tag = '';
    while (n) {
      if (n.name) tag = n.name + '/' + tag;
      n = n.parent;
    }
    if (!/up-hidden-(kerb|shaft)/i.test(tag)) return;
    // The placement id is the root the row was loaded into, so the first segment that matches is the
    // name this file wants; the mesh inside it is the model's own node and its name is noise.
    const m = /(up-hidden-[a-z-]+)\//i.exec(tag);
    const key = m ? m[1] : tag;
    const p = o.getWorldPosition ? o.getWorldPosition(new (o.position.constructor)()) : o.position;
    byName[key] = (byName[key] || 0) + 1;
    if (rows.length < 12) {
      rows.push({ mesh: tag.slice(0, 60), at: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)] });
    }
  });
  return JSON.stringify({ groups: byName, count: Object.keys(byName).length, rows });
})();