import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read('public/assets/models/low_poly_sword_handpainted.glb');
const p = [0,0,0];
const pts = [];
const walk = (node) => {
  const mesh = node.getMesh();
  if (mesh) {
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, p);
        pts.push([m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12], m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13], m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]]);
      }
    }
  }
  for (const c of node.listChildren()) walk(c);
};
for (const s of doc.getRoot().listScenes()) for (const n of s.listChildren()) walk(n);
console.log('vertices', pts.length);
// y slices, centroid and extents
for (let y = 0.10; y < 0.50; y += 0.02) {
  const band = pts.filter(q => q[1] >= y && q[1] < y + 0.02);
  if (!band.length) { console.log(y.toFixed(2), 'empty'); continue; }
  const cx = band.reduce((s,q)=>s+q[0],0)/band.length;
  const cz = band.reduce((s,q)=>s+q[2],0)/band.length;
  const xs = band.map(q=>q[0]), zs = band.map(q=>q[2]);
  console.log(y.toFixed(2), 'n='+String(band.length).padStart(2), 'cx='+cx.toFixed(3), 'cz='+cz.toFixed(3), 'x['+Math.min(...xs).toFixed(3)+','+Math.max(...xs).toFixed(3)+']', 'z['+Math.min(...zs).toFixed(3)+','+Math.max(...zs).toFixed(3)+']');
}
// blade slices further up
for (const y of [0.6, 0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 1.94]) {
  const band = pts.filter(q => Math.abs(q[1]-y) < 0.01);
  if (!band.length) { console.log('blade', y, 'empty'); continue; }
  const cx = band.reduce((s,q)=>s+q[0],0)/band.length;
  const xs = band.map(q=>q[0]);
  console.log('blade', y.toFixed(2), 'cx='+cx.toFixed(3), 'x['+Math.min(...xs).toFixed(3)+','+Math.max(...xs).toFixed(3)+']');
}
