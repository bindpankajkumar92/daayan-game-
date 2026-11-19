/**
 * phone-hand.glb -> phone.glb: drop the scanned hand, keep the phone (body, screen, lens, flash).
 *
 * The phone is now held in the player's existing left fist (HeldLantern), so the second hand that came
 * with the Sketchfab model is not wanted. Run once: node tools/strip-phone-hand.mjs
 */
import { NodeIO } from '@gltf-transform/core';
import { prune } from '@gltf-transform/functions';
import { fileURLToPath } from 'node:url';

const dir = new URL('../public/assets/models/', import.meta.url);
const io = new NodeIO();
const doc = await io.read(fileURLToPath(new URL('../../../glb files/phone-hand.glb', dir)));
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh();
  const mats = mesh?.listPrimitives().map((p) => p.getMaterial()?.getName()) ?? [];
  if (mats.includes('phone_skin')) {
    console.log('removing', node.getName(), mats);
    node.dispose();
  }
}
await doc.transform(prune());
const out = fileURLToPath(new URL('phone.glb', dir));
await io.write(out, doc);
for (const node of doc.getRoot().listNodes()) {
  const prims = node.getMesh()?.listPrimitives() ?? [];
  const pos = prims[0]?.getAttribute('POSITION');
  console.log('kept', node.getName(), prims.map((p) => p.getMaterial()?.getName()), 'min', pos?.getMin([]).map((v) => v.toFixed(4)), 'max', pos?.getMax([]).map((v) => v.toFixed(4)), 't', node.getTranslation().map((v) => v.toFixed(4)), 'r', node.getRotation().map((v) => v.toFixed(3)), 's', node.getScale().map((v) => v.toFixed(3)));
}
console.log('wrote', out);

