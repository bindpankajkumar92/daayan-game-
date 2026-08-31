/**
 * ContactShadow — the dark patch under furniture, as a multiply blend and no shadow pass.
 *
 * The renderer has `shadowMap.enabled = false` and QualityManager has said "fake contact shadows
 * instead — no extra render pass" since it was written, with nothing on the other end of the promise.
 * This is that other end. It matters more here than the phrase "fake shadows" suggests: the only real
 * light in this house is a point light on the camera, so every surface is lit from wherever the player
 * is standing, and a prop lit from the eye with nothing under it does not sit on the floor — it hovers
 * over a photograph of one. Grounding is most of what a shadow buys, and grounding is exactly the part
 * that does not need a depth map from a light's point of view.
 *
 * **It multiplies rather than paints.** A flat black quad at 42% opacity — which is what
 * scenes/dev/feasibility.ts prototyped — adds the same grey wherever it lands, so it reads as a dark
 * coin on a lit floor and as a *lighter* patch on an unlit one. The blend here is
 *
 *     result = dst * srcColor        (blendSrc = ZeroFactor, blendDst = SrcColorFactor)
 *
 * so the texture is not a colour, it is a per-pixel factor: 1.0 leaves the floor exactly as it was and
 * 0.38 takes it down by nearly two thirds. Black floor stays black, lantern-lit floor darkens hard, and
 * there is no opacity to retune per room.
 *
 * **Which means both of the material's opt-outs are load-bearing, not tidiness.** `toneMapped: false`
 * because ACES would bend a factor as though it were a radiance — the frame underneath has already been
 * tone-mapped, and bending 0.38 through the curve turns a shadow into a smudge. And the map is tagged
 * `SRGBColorSpace` so the sampler's sRGB->linear and the renderer's linear->sRGB round-trip cancel and
 * the byte in the canvas *is* the factor applied to the encoded frame; left untagged, the authored 0.38
 * arrives at the blend as 0.65 and the effect quietly halves. Multiplying encoded values is what
 * "Multiply" means to whoever authored the gradient, which is the point.
 *
 * Cost: one shared texture, one shared material, two triangles each — and because Batch merges by
 * material, every shadow under the procedural dressing is *one* draw call for the whole house. The
 * imported models pay one each, since they arrive asynchronously and are culled individually.
 *
 * Known limit, worth knowing before hunting it as a bug: the quad sits SHADOW_LIFT above the floor it
 * belongs to, so a shadow that falls on something thin lying *on* that floor is behind it and does not
 * draw. The house has five such things — four cloths whose tops are 21 mm up (the hall and hallway
 * runners, the bedroom and living-room rugs) and the scuff ring at 13 mm — and three places where it
 * bites:
 *
 *   - cat.glb sits on the hallway runner, and is seated at the runner's top rather than at y 0 so that
 *     its shadow clears the cloth. That was a placement bug either way; see the row.
 *   - table.glb straddles the living-room rug's east edge, where no single height works. It has no
 *     shadow, and the rug grounds that half of it instead.
 *   - the armchair stands wholly on the living-room rug, so its procedural shadow is clipped away
 *     entirely; three more (the ledger table, the procedural bed, the hallway crate) lose a corner
 *     where their quad laps a rug's edge. Left as is: a chair on a rug is already sitting on a visible
 *     surface, which is most of what a shadow buys, and a soft gradient losing its outermost corner is
 *     not something anyone can see.
 *
 * Raising SHADOW_LIFT past 21 mm would trade all three for a worse one — the lift is also the parallax
 * between a shadow and the floor it is on, and at 26 mm it exceeds the 17 mm of visible shadow ring
 * around bottle-beer.glb's 7 cm base, i.e. the bottle would come away from its own shadow. The real fix
 * is a per-shadow height, which means knowing what each prop stands on, which is a raycast per prop
 * against geometry that is already merged.
 */

import {
  CanvasTexture,
  ClampToEdgeWrapping,
  CustomBlending,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  SrcColorFactor,
  ZeroFactor,
} from 'three';

/**
 * 128 is not a compromise. The whole image is a smooth radial falloff with no feature in it smaller
 * than a quarter of the tile, so the only thing more resolution buys is banding headroom, and a 128
 * tile stretched over a 2 m bed is 1.6 cm per texel — below the point the bilinear filter's own
 * gradient is distinguishable from a bigger map's.
 */
const TEX = 128;

/**
 * The falloff, as (radius, factor) pairs against the inscribed circle: r = 1 is the edge of the quad's
 * shorter side, and the corners past it are left at 1.0 so a square quad shows nothing at its corners.
 *
 * Read with SPREAD below, which is what decides where the prop's own outline falls on this curve. The
 * curve is deliberately not linear: a contact shadow is nearly opaque where the object meets the floor
 * and gone within a fraction of the object's width, because the light it is blocking is a lamp a couple
 * of metres off and not a sky. Most of the darkening is therefore spent inside r = 0.55.
 */
const STOPS: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0.38],
  [0.3, 0.44],
  [0.55, 0.62],
  [0.78, 0.86],
  [1.0, 1.0],
];

/**
 * How far past the prop's own footprint the quad reaches, as a multiplier on the footprint.
 *
 * 1.5 puts the footprint's outline at r = 1/1.5 = 0.67 on the curve above, i.e. the floor is still 25%
 * down where the object's edge is and clean a quarter of a footprint further out. Below about 1.2 the
 * penumbra has nowhere to happen and the shadow reads as the object's own silhouette stamped on the
 * floor; well above 1.5 a bed starts darkening the walkway beside it.
 */
export const SHADOW_SPREAD = 1.5;

/**
 * Height above the floor the quad is placed at. Small enough to be invisible at a grazing angle under
 * a plate 32 mm tall, large enough to beat the depth buffer's resolution over the 60 m the far plane
 * covers. See the header for what it costs.
 */
export const SHADOW_LIFT = 0.012;

/**
 * The falloff as a texture. One of these for the whole game — every shadow in the house is this same
 * image on a differently-sized quad, which is what lets them share a material and merge.
 */
export function makeContactShadowTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = TEX;
  canvas.height = TEX;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('[ContactShadow] 2D canvas context unavailable');
  const half = TEX / 2;
  const grad = g.createRadialGradient(half, half, 0, half, half, half);
  for (const [r, v] of STOPS) {
    const b = Math.round(v * 255);
    grad.addColorStop(r, `rgb(${b},${b},${b})`);
  }
  // Filling the whole square with a gradient whose radius reaches only the inscribed circle is
  // deliberate: a canvas gradient holds its last stop past its radius, so the corners come out at the
  // 1.0 the curve ends on — no seam, and no second fill to keep in step with STOPS.
  g.fillStyle = grad;
  g.fillRect(0, 0, TEX, TEX);

  const t = new CanvasTexture(canvas);
  // See the header. Without this the round trip does not cancel and every shadow in the game lands at
  // roughly half the strength the curve above says.
  t.colorSpace = SRGBColorSpace;
  // Clamped, not repeated: the edge texel is 1.0, so clamping is what makes a quad sampled slightly
  // outside its own bounds — which bilinear filtering does — read as "no shadow" rather than wrap round
  // to the dark centre.
  t.wrapS = ClampToEdgeWrapping;
  t.wrapT = ClampToEdgeWrapping;
  // Worth having rather than an accident: the mips average toward the tile's own mean, so a shadow seen
  // from across the house flattens into a faint even darkening instead of shimmering.
  t.generateMipmaps = true;
  return t;
}

/** The shared material. `map` is expected to be makeContactShadowTexture()'s, and is not owned here. */
export function makeContactShadowMaterial(map: CanvasTexture): MeshBasicMaterial {
  return new MeshBasicMaterial({
    map,
    // Not because anything here is see-through, but because it puts the quad in the transparent queue,
    // which is the only queue that runs after the floor it has to multiply.
    transparent: true,
    blending: CustomBlending,
    blendSrc: ZeroFactor,
    blendDst: SrcColorFactor,
    // Writing depth would have the shadow occlude whatever stands in it, starting with the legs of the
    // table casting it.
    depthWrite: false,
    toneMapped: false,
    // Fog mixes a material's output toward the fog colour, which here is very nearly black — on a
    // factor rather than a colour that reads as "the further away, the darker the shadow", i.e. exactly
    // backwards. The mips above are what makes distance behave instead.
    fog: false,
  });
}

/**
 * One shadow, as world-space geometry ready for Batch.add(). `w` and `d` are the prop's own footprint;
 * the spread is applied here so no caller has to remember it.
 */
export function shadowQuad(x: number, y: number, z: number, w: number, d: number, ry = 0): PlaneGeometry {
  const g = new PlaneGeometry(w * SHADOW_SPREAD, d * SHADOW_SPREAD);
  // Flat first, then turned, matching Batch.box's order — a plane is authored standing in xy.
  g.rotateX(-Math.PI / 2);
  if (ry !== 0) g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

/**
 * The same quad, unit-sized and unplaced, for a shadow that is a mesh of its own rather than one
 * merged into a batch — an imported model's, since those arrive over the following few seconds and are
 * culled individually. One of these is shared by every such mesh; each one carries its own position and
 * scale, so the geometry is uploaded once no matter how many models ask for a shadow.
 *
 * Its vertices span x and z in [-0.5, 0.5] at y = 0, so a caller scales by the footprint (times
 * SHADOW_SPREAD) on x and z and leaves y alone.
 */
export function shadowUnitQuad(): PlaneGeometry {
  const g = new PlaneGeometry(1, 1);
  g.rotateX(-Math.PI / 2);
  return g;
}
