import './dom-shim.js';
import * as THREE from 'three';
import { readFileSync } from 'fs';

// Let's parse GLB manually or use Three's GLTFLoader if possible, or read accessors
// Let's see how vertices of Mesh 0 (stairs base) are laid out
const buf = readFileSync('public/assets/models/stair-hidden.glb');
// We know from earlier inspect:
// Mesh 0: .012_wood_stairs_Base_0
// Node hierarchy:
// 0: Sketchfab_model rot [-0.707, 0, 0, 0.707]
// 1: wood_stairs.fbx rot [0.707, 0, 0, 0.707], scale [0.01, 0.01, 0.01]
// 2: RootNode
// 3: .012 transl [-701.8, 556.2, 0], rot [-0.707, 0, 0, 0.707], scale 45.29
// 4: .012_wood_stairs_Base_0 transl [5.8, 0, -5.65], scale 10.2

// Wait, let's write a small script that loads GLTF using three/examples/jsm/loaders/GLTFLoader.js!
