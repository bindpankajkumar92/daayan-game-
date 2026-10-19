import './dom-shim';
import { Box3, Vector3 } from 'three';
import { fitToHeight } from '../src/world/ModelLoader';
import { readFileSync } from 'fs';

// Let's run a script that measures wardrobe-hidden world bounds
import { readGlbJson } from './_dims.mjs'; // wait let's just inspect using three.js or pure math
