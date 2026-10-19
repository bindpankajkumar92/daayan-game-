(() => {
  const d = window.__daayan;
  const p = d.player, cam = d.engine.camera;
  const f = p.facing;
  const yaw = Math.atan2(-cam.getWorldDirection(new (cam.position.constructor)()).x, 0);
  const dir = cam.getWorldDirection(new (cam.position.constructor)());
  return JSON.stringify({
    facing: f ? (f.isVector3 ? [+f.x.toFixed(3), +f.y.toFixed(3), +f.z.toFixed(3)] : f) : null,
    facingType: f ? (f.isVector3 ? 'Vector3' : typeof f) : null,
    camRot: [+cam.rotation.x.toFixed(4), +cam.rotation.y.toFixed(4), +cam.rotation.z.toFixed(4)],
    camOrder: cam.rotation.order,
    yawDeg: +(cam.rotation.y * 180 / Math.PI).toFixed(1),
    pitchDeg: +(cam.rotation.x * 180 / Math.PI).toFixed(1),
    dir: [+dir.x.toFixed(3), +dir.y.toFixed(3), +dir.z.toFixed(3)],
    locked: p.movementLocked,
    groundY: p.groundY,
    onGround: p.onGround,
  }, null, 1);
})()
