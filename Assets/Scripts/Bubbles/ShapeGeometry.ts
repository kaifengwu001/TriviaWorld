/**
 * Specs Inc. 2026
 * Shape geometry for the Bubble Morph Mesh system.
 *
 * Pure-ish functions (no engine dependency) that generate the two outlines the
 * renderer morphs between:
 *   - an organic, Perlin-distorted blob (ported from getCirclePoints in
 *     Assets/Scripts/ExampleBubbleScript.js), and
 *   - a rounded rectangle of arbitrary width/height that keeps a fixed corner
 *     radius regardless of size/aspect ratio.
 *
 * Both outlines have the SAME number of points (N) and morph by index
 * (point i <-> point i); all outlines are centered on the local origin (0,0).
 *
 * Point distribution is deliberately ASYMMETRIC between the two shapes:
 *   - The blob keeps an EVEN angular distribution (point i at a uniformly spaced
 *     angle), so the resting bubble at morph 0 stays uniform.
 *   - The rounded rect spends almost all of its points on the CORNER arcs (the
 *     only curved part) and barely any on the straight edges (which only need
 *     their endpoints). This lets a small N render smooth corners.
 * The rect's points are perimeter-ordered (CCW) and rotated to start near the
 * blob's start angle, so the index-based morph still slides cleanly.
 *
 * Hot-path note: the per-frame helpers (`getBubblePointsInto`, `morphInPlace`)
 * WRITE INTO a caller-owned scratch buffer instead of allocating, to avoid GC
 * churn at 60fps across many bubbles. They never mutate their read-only inputs
 * (noise tables, direction arrays, the cached rect outline).
 */
import { PerlinNoise } from "./PerlinNoise";

// A 2D outline point as [x, y]. Plain arrays (not vec2) avoid per-frame
// allocation churn in the hot path and mirror the original example.
export type Point = [number, number];

// Matches the original example's reference radius used to normalize distortion.
export const DEFAULT_REFERENCE_RADIUS = 40;

// Default weighting of corner arcs vs. straight edges when distributing
// rounded-rect points. Higher packs points into the corners (high curvature)
// and leaves the straight edges with little more than their endpoints.
export const DEFAULT_CORNER_WEIGHT = 12;

// Starting angle of the first outline point, matching the example (-60 degrees).
const START_ANGLE = -Math.PI / 3;
const HALF_PI = Math.PI / 2;
const TWO_PI = Math.PI * 2;

/**
 * Smoothstep-style easing used to shape the morph progress (port of the
 * example's easeInOutQuad).
 */
export function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/**
 * Precomputes the cos/sin of each blob rim direction (evenly spaced angles).
 * These are constant per bubble, so computing them once and reusing them keeps
 * all trigonometry out of the per-frame blob update.
 */
export function buildRimDirections(numPoints: number): { cos: number[]; sin: number[] } {
  const cos = new Array<number>(numPoints);
  const sin = new Array<number>(numPoints);
  for (let i = 0; i < numPoints; i++) {
    const a = START_ANGLE + (i / numPoints) * TWO_PI;
    cos[i] = Math.cos(a);
    sin[i] = Math.sin(a);
  }
  return { cos, sin };
}

/** Allocates a reusable outline buffer of `n` zeroed points. */
export function allocPointBuffer(n: number): Point[] {
  const buf = new Array<Point>(n);
  for (let i = 0; i < n; i++) buf[i] = [0, 0];
  return buf;
}

/**
 * Writes the organic blob outline into `out` (length must match the direction
 * arrays). Each point sits on its precomputed rim direction, pushed out by a
 * Perlin-noise-modulated radius; `timeOffset` animates the wobble.
 *
 * Port of getCirclePoints (ExampleBubbleScript.js lines 499-531), in place.
 */
export function getBubblePointsInto(
  out: Point[],
  noise: PerlinNoise,
  cos: number[],
  sin: number[],
  radius: number,
  timeOffset: number,
  noiseScale: number,
  distortion: number,
  referenceRadius: number = DEFAULT_REFERENCE_RADIUS
): void {
  // Guard against a zero/invalid reference radius (e.g. an unset @input on a
  // runtime-created component), which would make every point Infinity/NaN.
  const safeRef = referenceRadius > 0 ? referenceRadius : DEFAULT_REFERENCE_RADIUS;
  const radiusRatio = radius / safeRef;
  const n = cos.length;
  for (let i = 0; i < n; i++) {
    const cx = cos[i];
    const cy = sin[i];
    const nVal = noise.noise(cx * noiseScale + timeOffset, cy * noiseScale + timeOffset);
    const finalOffset = radiusRatio * (safeRef + nVal * distortion);
    const p = out[i];
    p[0] = cx * finalOffset;
    p[1] = cy * finalOffset;
  }
}

/**
 * Lerps `out` (currently holding the blob) toward the rounded rect in place.
 * progress 0 leaves the blob untouched, 1 lands exactly on the rect.
 * Port of morphPoints (ExampleBubbleScript.js lines 534-540), in place.
 */
export function morphInPlace(out: Point[], rect: Point[], progress: number): void {
  const n = out.length;
  const rn = rect.length;
  for (let i = 0; i < n; i++) {
    const o = out[i];
    const r = rect[i % rn];
    o[0] += (r[0] - o[0]) * progress;
    o[1] += (r[1] - o[1]) * progress;
  }
}

/**
 * Generates the rounded-rectangle outline (centered at the origin) with exactly
 * `numPoints` points. Width/height are arbitrary; the corner radius is held
 * FIXED (clamped to half the shorter side) so corners keep their shape no matter
 * the size or aspect ratio.
 *
 * Each of the four corner arcs OWNS its two endpoint vertices (the rect's
 * corner-edge junctions); straight edges contribute only interior points. That
 * means a starved edge simply renders as one exact straight span between its
 * corners — no junction artifacts. Corners receive a curvature-weighted share
 * (scaled by `cornerWeight`) and edges a length-weighted share, so most points
 * land where the curvature is.
 *
 * The boundary is walked CCW, then rotated so index 0 lands near the blob's
 * start angle, keeping the index-based morph aligned. Called once per size
 * change (cached), so it is not on the per-frame hot path.
 */
export function getRoundedRectPoints(
  numPoints: number,
  width: number,
  height: number,
  cornerRadius: number,
  cornerWeight: number = DEFAULT_CORNER_WEIGHT
): Point[] {
  const n = Math.max(4, Math.floor(numPoints));
  const halfW = Math.max(width, 0.0001) * 0.5;
  const halfH = Math.max(height, 0.0001) * 0.5;
  const r = Math.max(0, Math.min(cornerRadius, Math.min(halfW, halfH)));
  const ix = halfW - r; // corner-arc center x (inner box half-width)
  const iy = halfH - r; // corner-arc center y (inner box half-height)
  const arcLen = HALF_PI * r;
  const cw = Math.max(0, cornerWeight);
  const hasCorners = r > 1e-6;

  // Corners in CCW order (TR, TL, BL, BR), each as a center + start angle that
  // sweeps +90 degrees. The edge that FOLLOWS each corner (top, left, bottom,
  // right) runs from this corner's end vertex to the next corner's start vertex.
  const corners = [
    { cx: ix, cy: iy, a0: 0 },
    { cx: -ix, cy: iy, a0: HALF_PI },
    { cx: -ix, cy: -iy, a0: Math.PI },
    { cx: ix, cy: -iy, a0: 3 * HALF_PI },
  ];
  const edgeLens = [2 * ix, 2 * iy, 2 * ix, 2 * iy]; // top, left, bottom, right

  const minCorner = hasCorners ? 2 : 1; // endpoints (or the single sharp vertex)
  const { cornerCounts, edgeCounts } = allocateRoundedRect(n, arcLen * cw, edgeLens, minCorner);

  const pts: Point[] = [];
  for (let k = 0; k < 4; k++) {
    const c = corners[k];
    const cc = cornerCounts[k];
    for (let j = 0; j < cc; j++) {
      const t = cc > 1 ? j / (cc - 1) : 0; // inclusive both ends
      const a = c.a0 + t * HALF_PI;
      pts.push([c.cx + r * Math.cos(a), c.cy + r * Math.sin(a)]);
    }

    // Edge interior points (exclusive of both shared corner vertices).
    const ec = edgeCounts[k];
    if (ec > 0) {
      const sx = c.cx + r * Math.cos(c.a0 + HALF_PI);
      const sy = c.cy + r * Math.sin(c.a0 + HALF_PI);
      const next = corners[(k + 1) % 4];
      const ex = next.cx + r * Math.cos(next.a0);
      const ey = next.cy + r * Math.sin(next.a0);
      for (let j = 0; j < ec; j++) {
        const t = (j + 1) / (ec + 1);
        pts.push([sx + (ex - sx) * t, sy + (ey - sy) * t]);
      }
    }
  }

  return rotateToStartAngle(pts);
}

/**
 * Allocates `n` points across 4 corners + 4 edges, summing to exactly `n`.
 * Every corner is reserved `minCorner` points (its endpoint vertices) so the
 * boundary is always closed; the remainder is split by weight (corners by their
 * curvature weight, edges by length).
 */
function allocateRoundedRect(
  n: number,
  cornerWeightValue: number,
  edgeLens: number[],
  minCorner: number
): { cornerCounts: number[]; edgeCounts: number[] } {
  const counts = [0, 0, 0, 0, 0, 0, 0, 0]; // 4 corners then 4 edges

  // Reserve corner endpoints (round-robin so a tiny n still spreads sanely).
  let toReserve = Math.min(n, 4 * minCorner);
  let rr = 0;
  while (toReserve > 0) {
    counts[rr % 4]++;
    toReserve--;
    rr++;
  }

  const remaining = n - Math.min(n, 4 * minCorner);
  if (remaining > 0) {
    const weights = [
      cornerWeightValue,
      cornerWeightValue,
      cornerWeightValue,
      cornerWeightValue,
      edgeLens[0],
      edgeLens[1],
      edgeLens[2],
      edgeLens[3],
    ];
    const add = distributeByWeight(weights, remaining);
    for (let i = 0; i < 8; i++) counts[i] += add[i];
  }

  return { cornerCounts: counts.slice(0, 4), edgeCounts: counts.slice(4, 8) };
}

/** Splits `total` across `weights`, summing to exactly `total`. */
function distributeByWeight(weights: number[], total: number): number[] {
  const counts = weights.map(() => 0);
  if (total <= 0) return counts;

  let sum = 0;
  for (const w of weights) sum += Math.max(0, w);
  if (sum <= 0) {
    for (let i = 0; i < total; i++) counts[i % counts.length]++;
    return counts;
  }

  const raw = weights.map((w) => (w > 0 ? (total * w) / sum : 0));
  let assigned = 0;
  for (let i = 0; i < counts.length; i++) {
    counts[i] = Math.floor(raw[i]);
    assigned += counts[i];
  }
  let leftover = total - assigned;
  const fracs = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .filter((f) => weights[f.i] > 0)
    .sort((a, b) => b.frac - a.frac);
  let k = 0;
  while (leftover > 0 && fracs.length > 0) {
    counts[fracs[k % fracs.length].i]++;
    leftover--;
    k++;
  }
  return counts;
}

/** Smallest absolute angular gap (radians) between two angles. */
function angularDistance(a: number, b: number): number {
  let d = Math.abs(a - b) % TWO_PI;
  if (d > Math.PI) d = TWO_PI - d;
  return d;
}

/**
 * Rotates a CCW-ordered point ring so index 0 is the point whose angle from the
 * origin is closest to START_ANGLE, aligning it with the blob's first vertex.
 * Returns a new array (the input is never mutated).
 */
function rotateToStartAngle(pts: Point[]): Point[] {
  if (pts.length === 0) return pts;
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const diff = angularDistance(Math.atan2(pts[i][1], pts[i][0]), START_ANGLE);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  if (best === 0) return pts;
  return pts.slice(best).concat(pts.slice(0, best));
}
