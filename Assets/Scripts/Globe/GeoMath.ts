/**
 * Specs Inc. 2026
 * GeoMath – pure geo/UV math for the Interactive Globe -> Guided City Zoom lens.
 *
 * NO engine dependencies (no vec3/quat/SceneObject). Everything is plain numbers
 * and plain `{x, y}` / `{lat, lng}` objects so this file stays trivially testable
 * and reusable. The Lens Studio components (GlobeView / MapViewport) convert the
 * plain results into engine types (vec3, quat) at their boundary.
 *
 * Web-Mercator slippy-tile math intentionally lives in the OFFLINE Python tool
 * (tools/generate_map_textures.py), NOT here: the in-lens path only needs the
 * forgiving small-area linear approximation described below.
 *
 * Coordinate conventions
 *   - lat in [-90, 90] (north positive), lng in [-180, 180] (east positive).
 *   - Equirectangular UV (globe base texture): u = (lng + 180) / 360,
 *     v = (90 - lat) / 180  (v = 0 at the north pole, top of the image).
 *   - Small city crops are treated as SQUARE in degrees (lat span = lng span =
 *     spanDeg). Mercator distortion is negligible at city scale; revisit only if
 *     a span ever grows very large (see plan "Risks / fallbacks").
 *
 * Immutability: every function RETURNS A NEW object; nothing is mutated.
 */

/** A geographic coordinate. */
export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * A square-ish geographic region: a center coordinate plus an angular span
 * (longitude width in degrees; latitude is treated with the same span).
 */
export interface GeoBounds {
  centerLatLng: LatLng;
  spanDeg: number;
}

/** A plain 2D value (UV offset/scale or a texture-space point). */
export interface Vec2Like {
  x: number;
  y: number;
}

/** A UV transform applied as `mapUV = windowUV * scale + offset`. */
export interface UvTransform {
  offset: Vec2Like;
  scale: Vec2Like;
}

const DEG2RAD = Math.PI / 180;

// --- scalar helpers ----------------------------------------------------------

/** Clamps `v` to the inclusive range [min, max]. */
export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** Clamps `v` to [0, 1]. */
export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/** Linear interpolation from `a` to `b` by `t` (t is NOT clamped). */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Smooth ease-in-out (cubic) over t in [0, 1]. */
export function easeInOutCubic(t: number): number {
  const c = clamp01(t);
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
}

/** No easing — constant rate. */
export function easeLinear(t: number): number {
  return clamp01(t);
}

/** Ease in (cubic): slow start, fast end. */
export function easeInCubic(t: number): number {
  const c = clamp01(t);
  return c * c * c;
}

/** Ease out (cubic): fast start, slow end. */
export function easeOutCubic(t: number): number {
  const c = clamp01(t);
  return 1 - Math.pow(1 - c, 3);
}

/** A scalar easing curve over t in [0, 1]. */
export type Easing = (t: number) => number;

/**
 * A single, intuitive easing knob driven by one signed `bias` in [-1, 1]:
 *
 *   bias  0  -> smooth ease-in-out (the natural default: gentle start AND stop)
 *   bias +1  -> FRONT-LOADED: fast start, gentle finish (ease-out)
 *   bias -1  -> BACK-LOADED:  slow start, fast finish (ease-in)
 *
 * The magnitude is the strength (how far from the symmetric S-curve it leans), so
 * one number fully describes a channel's feel — no opaque mode codes. It blends
 * the symmetric cubic S-curve toward a pure ease-out (bias > 0) or pure ease-in
 * (bias < 0). Returns the eased fraction for `t` in [0, 1].
 */
export function biasedEase(t: number, bias: number): number {
  const c = clamp01(t);
  const b = clamp(bias, -1, 1);
  const s = easeInOutCubic(c);
  if (b > 0) return lerp(s, easeOutCubic(c), b);
  if (b < 0) return lerp(s, easeInCubic(c), -b);
  return s;
}

// --- equirectangular UV (globe base texture) --------------------------------

/**
 * Maps a coordinate to equirectangular UV on the globe base texture.
 * u wraps longitude across [0, 1]; v = 0 is the north pole (image top).
 */
export function lonLatToUV(lng: number, lat: number): Vec2Like {
  return {
    x: (lng + 180) / 360,
    y: (90 - lat) / 180,
  };
}

/** Inverse of {@link lonLatToUV}. */
export function uvToLonLat(u: number, v: number): LatLng {
  return {
    lng: u * 360 - 180,
    lat: 90 - v * 180,
  };
}

/**
 * Position of a coordinate on a unit-ish sphere of the given radius.
 *
 * Convention (matches our globe mesh, whose equirectangular texture wraps so
 * that +lng/east runs toward -X, with the prime meridian / (0,0) facing -Z
 * toward a viewer in front):
 *   x = -R * cos(lat) * sin(lng)
 *   y =  R * sin(lat)
 *   z = -R * cos(lat) * cos(lng)
 * The -sin(lng) on X mirrors longitude east<->west to match the mesh's texture
 * wrap; keep it in lockstep with {@link aimEuler}'s +lng yaw so a selected
 * marker still rotates to front-center. Returns a plain {x, y, z}; callers wrap
 * it in a vec3.
 */
export function lonLatToSpherePos(
  lng: number,
  lat: number,
  radius: number
): { x: number; y: number; z: number } {
  const la = lat * DEG2RAD;
  const lo = lng * DEG2RAD;
  const cl = Math.cos(la);
  return {
    x: -radius * cl * Math.sin(lo),
    y: radius * Math.sin(la),
    z: -radius * cl * Math.cos(lo),
  };
}

/**
 * Euler angles (radians, XYZ) that rotate the globe so the given coordinate is
 * brought to FRONT-CENTER (facing the viewer along -Z).
 *
 * With the {@link lonLatToSpherePos} convention, (0,0) already faces -Z. To
 * bring (lat, lng) forward we yaw the globe by +lng about +Y, then pitch by
 * +lat about +X. The +lng yaw matches the east<->west mirror baked into
 * lonLatToSpherePos's -sin(lng); the two MUST share the same sign so a marker
 * placed by lonLatToSpherePos rotates to front-center when its city is picked.
 * Returned as a plain {x, y, z}; GlobeView builds the quat.
 */
export function aimEuler(lng: number, lat: number): { x: number; y: number; z: number } {
  return {
    x: lat * DEG2RAD,
    y: lng * DEG2RAD,
    z: 0,
  };
}

// --- table UV transform (driven by bounds) ----------------------------------

/**
 * Computes the `{offset, scale}` that makes the table pane (windowUV in [0,1])
 * display `viewBounds` out of a texture that was captured to frame `texBounds`.
 *
 * Derivation (mapUV = windowUV * scale + offset):
 *   windowUV = 0 -> the view's LEFT/TOP edge; windowUV = 1 -> RIGHT/BOTTOM.
 *   In the texture's own UV space (u increases east, v increases south):
 *     uLeft  = 0.5 + (viewC.lng - texC.lng)/texSpan - viewSpan/(2*texSpan)
 *     vTop   = 0.5 - (viewC.lat - texC.lat)/texSpan - viewSpan/(2*texSpan)
 *     scale  = viewSpan / texSpan   (same in x and y; crops are square)
 *   offset = (uLeft, vTop).
 *
 * When `viewBounds == texBounds` this returns scale = 1, offset = 0 (the texture
 * exactly fills the pane) — the LOD "home" framing, by construction.
 */
export function boundsToUv(texBounds: GeoBounds, viewBounds: GeoBounds): UvTransform {
  const texSpan = texBounds.spanDeg;
  const viewSpan = viewBounds.spanDeg;
  const dLng = viewBounds.centerLatLng.lng - texBounds.centerLatLng.lng;
  const dLat = viewBounds.centerLatLng.lat - texBounds.centerLatLng.lat;
  const scale = viewSpan / texSpan;
  return {
    offset: {
      x: 0.5 + dLng / texSpan - viewSpan / (2 * texSpan),
      y: 0.5 - dLat / texSpan - viewSpan / (2 * texSpan),
    },
    scale: { x: scale, y: scale },
  };
}

/**
 * Inverse of {@link boundsToUv}: recovers the geographic `viewBounds` currently
 * shown given a texture's `texBounds` and the live `{offset, scale}`. Used when
 * switching LOD so the new texture keeps the same centered coordinate.
 */
export function uvToBounds(texBounds: GeoBounds, uv: UvTransform): GeoBounds {
  const texSpan = texBounds.spanDeg;
  const viewSpan = uv.scale.x * texSpan;
  // Center UV in the texture = offset + scale/2.
  const centerU = uv.offset.x + uv.scale.x / 2;
  const centerV = uv.offset.y + uv.scale.y / 2;
  const lng = texBounds.centerLatLng.lng + (centerU - 0.5) * texSpan;
  const lat = texBounds.centerLatLng.lat - (centerV - 0.5) * texSpan;
  return { centerLatLng: { lat, lng }, spanDeg: viewSpan };
}

/**
 * Clamps a pan `offset` so the sampled region (`offset .. offset + scale`) stays
 * fully inside the texture [0, 1] on both axes. Returns a NEW offset.
 */
export function clampPan(offset: Vec2Like, scale: Vec2Like): Vec2Like {
  return {
    x: clamp(offset.x, 0, Math.max(0, 1 - scale.x)),
    y: clamp(offset.y, 0, Math.max(0, 1 - scale.y)),
  };
}

// --- globe <-> table footprint match ----------------------------------------

/**
 * Globe scale factor whose on-screen footprint roughly matches a table of
 * `tableSizeCm` showing `spanDeg` degrees, so the dock crossfade reads as detail
 * sharpening rather than a swap.
 *
 * The arc length subtended by `spanDeg` on the globe's surface is
 * `globeRadiusCm * scale * spanRad`. Setting that equal to `tableSizeCm` gives
 * `scale = tableSizeCm / (globeRadiusCm * spanRad)`. A LARGE L0 span keeps the
 * required scale modest and the handoff forgiving.
 */
export function dockScaleForSpan(
  spanDeg: number,
  globeRadiusCm: number,
  tableSizeCm: number
): number {
  const spanRad = Math.max(1e-6, spanDeg * DEG2RAD);
  const r = Math.max(1e-6, globeRadiusCm);
  return tableSizeCm / (r * spanRad);
}
