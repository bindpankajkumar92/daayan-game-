import fs from 'fs';
import path from 'path';

// Read wardrobe GLB using gltf parser or three.js in node if possible, or inspection script
// Let's see what tools we have: tools/.glbinfo.mjs or tools/glb-bounds.mjs
console.log('Checking tools/glb-bounds.mjs...');
