/**
 * Audit: which interior wall faces the shell draws are NOT covered by a wall-damaged.glb facing.
 *
 * A bare face is procedural plaster; a faced one is the scan. The two do not match, so a wall that is
 * faced on one side of a seam and bare on the other reads as a rendering fault rather than as a wall.
 * This walks every ROOMS run the shell actually draws and reports the along-axis metres left bare.
 */
import { expandRun, HALF_T, type RoomSpec, type WallRun } from '@/world/HouseLayout';
import { ROOMS } from '@/world/HouseRooms';
import { MODEL_PLACEMENTS, type ModelPlacement } from '@/world/ModelProps';

const PANEL_REVEAL = 0.05;
const PANEL_FACE_LIFT = 0.01;

interface Panel {
  id: string;
  alongX: boolean;
  a0: number;
  a1: number;
  fixed: number;
  y0: number;
  y1: number;
}

const panels: Panel[] = [];
for (const p of MODEL_PLACEMENTS as ModelPlacement[]) {
  if (p.name !== 'wall-damaged.glb' || p.fit === undefined) continue;
  const yaw = p.yaw ?? 0;
  const q = Math.round(yaw / (Math.PI / 2)) & 3; // 0 = +z, 1 = +x, 3 = -x, 2 = -z
  const alongX = q === 0 || q === 2;
  const w = p.fit.width;
  panels.push({
    id: p.id ?? p.name,
    alongX,
    a0: (alongX ? p.x : p.z) - w / 2,
    a1: (alongX ? p.x : p.z) + w / 2,
    fixed: alongX ? p.z : p.x,
    y0: p.y ?? 0,
    y1: (p.y ?? 0) + p.fit.height,
  });
}

/** Length of [a0,a1] left uncovered by the given intervals. */
function bareSpans(a0: number, a1: number, cover: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let cursor = a0;
  for (const [c0, c1] of [...cover].sort((p, q) => p[0] - q[0])) {
    if (c1 <= cursor) continue;
    if (c0 > cursor + 0.02) out.push([cursor, Math.min(c0, a1)]);
    cursor = Math.max(cursor, c1);
    if (cursor >= a1) break;
  }
  if (cursor < a1 - 0.02) out.push([cursor, a1]);
  return out.filter(([b0, b1]) => b1 - b0 > 0.06);
}

let totalBare = 0;
const rows: string[] = [];

for (const room of ROOMS as RoomSpec[]) {
  const cx = (room.floor.x0 + room.floor.x1) / 2;
  const cz = (room.floor.z0 + room.floor.z1) / 2;
  for (const [index, run] of (room.walls as WallRun[]).entries()) {
    if (run.collideOnly === true) continue;
    const alongX = Math.abs(run.x2 - run.x1) > Math.abs(run.z2 - run.z1);
    const inward = alongX ? Math.sign(cz - run.z1) : Math.sign(cx - run.x1);
    const fixed = alongX ? run.z1 : run.x1;
    const wantFixed = fixed + inward * (HALF_T + PANEL_FACE_LIFT);
    const runA0 = alongX ? Math.min(run.x1, run.x2) : Math.min(run.z1, run.z2);
    const runA1 = alongX ? Math.max(run.x1, run.x2) : Math.max(run.z1, run.z2);

    for (const seg of expandRun(run, room.floorY, room.floorY + room.height)) {
      const segA0 = alongX ? Math.min(seg.x1, seg.x2) : Math.min(seg.z1, seg.z2);
      const segA1 = alongX ? Math.max(seg.x1, seg.x2) : Math.max(seg.z1, seg.z2);
      const a0 = Math.max(runA0, segA0 - HALF_T) + PANEL_REVEAL;
      const a1 = Math.min(runA1, segA1 + HALF_T) - PANEL_REVEAL;
      if (a1 - a0 < 0.06) continue;
      const h = seg.y1 - seg.y0;

      const cover: Array<[number, number]> = [];
      for (const q of panels) {
        if (q.alongX !== alongX) continue;
        if (Math.abs(q.fixed - wantFixed) > 0.09) continue;
        const yOverlap = Math.min(q.y1, seg.y1) - Math.max(q.y0, seg.y0);
        if (yOverlap < Math.min(h, q.y1 - q.y0) * 0.5) continue;
        if (q.a1 <= a0 || q.a0 >= a1) continue;
        cover.push([q.a0, q.a1]);
      }
      const bare = bareSpans(a0, a1, cover);
      for (const [b0, b1] of bare) {
        const area = (b1 - b0) * h;
        totalBare += area;
        rows.push(
          `${room.id.padEnd(10)} run ${String(index).padStart(2)}  ${alongX ? 'x' : 'z'} ${b0.toFixed(2)}..${b1.toFixed(2)}` +
            `  ${(alongX ? 'z' : 'x')}=${fixed.toFixed(2)} inward ${inward > 0 ? '+' : '-'}` +
            `  y ${seg.y0.toFixed(2)}..${seg.y1.toFixed(2)}  ${area.toFixed(2)} m2` +
            `  ${cover.length === 0 ? '(no facing on this side)' : '(partly faced)'}`,
        );
      }
    }
  }
}

console.log(`panels found: ${panels.length}`);
console.log(`bare interior wall faces: ${rows.length} spans, ${totalBare.toFixed(1)} m2\n`);
for (const r of rows) console.log(r);

/**
 * Second pass: props a newly added facing would swallow.
 *
 * A facing's front stands 6 cm proud of the plaster it hangs on, so anything authored flat against that
 * plaster ends up inside the panel. Every row whose centre falls in a panel's slab, or within 4 cm in
 * front of it, is listed — the two are the same mistake at different depths.
 */
const NEW = process.argv[2] ?? 'upper-wall-';
console.log(`\nprops inside or within 4 cm of a '${NEW}*' facing:`);
let hits = 0;
for (const q of panels) {
  if (!q.id.startsWith(NEW)) continue;
  for (const p of MODEL_PLACEMENTS as ModelPlacement[]) {
    if (p.name === 'wall-damaged.glb') continue;
    const along = q.alongX ? p.x : p.z;
    const across = q.alongX ? p.z : p.x;
    if (along < q.a0 - 0.3 || along > q.a1 + 0.3) continue;
    // The panel spans fixed +/- depth/2 = 5 cm; 4 cm of clearance in front of that is the danger band.
    if (Math.abs(across - q.fixed) > 0.05 + 0.04) continue;
    const y = p.y ?? 0;
    if (y > q.y1 || y + (p.fit?.height ?? p.height ?? 0) < q.y0) continue;
    hits += 1;
    console.log(
      `  ${q.id} <- ${p.id ?? p.name} at (${p.x.toFixed(2)}, ${y.toFixed(2)}, ${p.z.toFixed(2)})` +
        `  ${(across - q.fixed).toFixed(3)} m off the panel centre`,
    );
  }
}
if (hits === 0) console.log('  none');
