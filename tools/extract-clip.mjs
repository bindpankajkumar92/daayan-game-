import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const outDir = path.resolve('tmp_frames');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const ffmpegExe = path.resolve('node_modules/ffmpeg-static/ffmpeg.exe');
const video = 'C:\\Users\\TIMOTHY\\Videos\\Screen Recordings\\Screen Recording 2026-09-23 163919.mp4';
const outPattern = path.join(outDir, 'frame_%03d.png');

console.log('Extracting frames...');
const res = spawnSync(ffmpegExe, ['-y', '-i', video, '-vf', 'fps=1,scale=640:-1', outPattern], { stdio: 'inherit' });
console.log('Result code:', res.status);
console.log('Files in outDir:', fs.readdirSync(outDir));
