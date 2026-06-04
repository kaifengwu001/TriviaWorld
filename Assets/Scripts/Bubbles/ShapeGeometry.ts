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
 *   - The rounded rect spends ALL of its points on the CORNER arcs (the only
 *     curved part) and NONE on the straight edges (which are exact between their
 *     corner endpoints). So N=16 gives 4 points per corner and 0 on the flats;
 *     this lets a small N render smooth corners with no wasted midpoints.
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
 * Generates the rounded-rectangle RING the bubble's two rims morph onto: an
 * `outer` rounded rect and an `inner` rounded rect inset uniformly by
 * `lineWeight`, so the band keeps a constant width at full morph (the ring no
 * longer collapses to nothing now that there is no separate outline stroke).
 *
 * Width/height are arbitrary; the corner radius is held FIXED (clamped to half
 * the shorter side) so corners keep their shape at any size/aspect.
 *
 * Point distribution is deterministic, NOT weight-based:
 *   - Rounded corners (r > 0): a straight edge is exact between its two corner
 *     endpoints, so it needs ZERO interior points. ALL `numPoints` go to the four
 *     corner arcs, split as evenly as possible (each corner gets ~numPoints/4,
 *     remainder spread round-robin). Each arc owns its two endpoint vertices.
 *   - Sharp corners (r ~ 0): there are no arcs to sample, so each corner gets a
 *     single vertex and the rest spread along the edges by length.
 * This is what makes a small N render clean corners with no stray midpoints on
 * the flats (e.g. N=16 -> 4 points per corner, 0 on edges).
 *
 * The point allocation AND the start-angle rotation are computed once from the
 * outer rect and reused verbatim for the inner rect, so `outer[i]` and
 * `inner[i]` correspond exactly (the band never twists). Called once per size
 * change (cached), so it is not on the per-frame hot path.
 */
export function getRoundedRectRing(
  numPoints: number,
  width: number,
  height: number,
  cornerRadius: number,
  lineWeight: number
): { outer: Point[]; inner: Point[] } {
  const n = Math.max(4, Math.floor(numPoints));
  const halfW = Math.max(width, 0.0001) * 0.5;
  const halfH = Math.max(height, 0.0001) * 0.5;
  const r = Math.max(0, Math.min(cornerRadius, Math.min(halfW, halfH)));

  // Allocate points from the OUTER rect; the inner rect reuses the same counts.
  const edgeLens = [2 * (halfW - r), 2 * (halfH - r), 2 * (halfW - r), 2 * (halfH - r)];
  const { cornerCounts, edgeCounts } = allocateRoundedRect(n, r > 1e-6, edgeLens);

  const outer = buildRectPoints(cornerCounts, edgeCounts, halfW, halfH, r);

  // Inner rect: uniform inset by the line weight (constant-width band). The
  // corner radius shrinks with the inset; everything clamps so it never inverts.
  const lw = Math.max(0, Math.min(lineWeight, Math.min(halfW, halfH)));
  const innerHalfW = Math.max(halfW - lw, 0.0001);
  const innerHalfH = Math.max(halfH - lw, 0.0001);
  const innerR = Math.max(0, Math.min(r - lw, Math.min(innerHalfW, innerHalfH)));
  const inner = buildRectPoints(cornerCounts, edgeCounts, innerHalfW, innerHalfH, innerR);

  // Align both rings to the blob's start angle using the SAME rotation.
  const rot = startAngleRotation(outer);
  return { outer: rotateBy(outer, rot), inner: rotateBy(inner, rot) };
}

/**
 * Builds a single rounded-rect outline (CCW, unrotated) from a fixed per-segment
 * point budget. Sharing `cornerCounts`/`edgeCounts` across two different
 * (outer/inner) rects guarantees index-aligned points.
 */
function buildRectPoints(
  cornerCounts: number[],
  edgeCounts: number[],
  halfW: number,
  halfH: number,
  r: number
): Point[] {
  const ix = halfW - r;
  const iy = halfH - r;
  // Corners CCW (TR, TL, BL, BR): center + start angle sweeping +90 degrees.
  const corners = [
    { cx: ix, cy: iy, a0: 0 },
    { cx: -ix, cy: iy, a0: HALF_PI },
    { cx: -ix, cy: -iy, a0: Math.PI },
    { cx: ix, cy: -iy, a0: 3 * HALF_PI },
  ];

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
  return pts;
}

/**
 * Allocates exactly `n` points across 4 corners + 4 edges (counts sum to `n`).
 *
 * Rounded corners: a straight edge between two corner endpoints is geometrically
 * exact, so edges get ZERO interior points and ALL `n` go to the corners, split
 * as evenly as possible (each corner ~n/4, remainder round-robin). This is what
 * gives, e.g., n=16 -> [4,4,4,4] corners and [0,0,0,0] edges — no stray midpoints
 * on the flats and the full corner budget the caller expects.
 *
 * Sharp corners: there is no arc to sample, so each corner gets a single vertex
 * and the remaining points spread along the edges by length.
 */
function allocateRoundedRect(
  n: number,
  hasRoundedCorners: boolean,
  edgeLens: number[]
): { cornerCounts: number[]; edgeCounts: number[] } {
  const cornerCounts = [0, 0, 0, 0];
  const edgeCounts = [0, 0, 0, 0];

  if (hasRoundedCorners) {
    // Even split across the four corner arcs; spread any remainder round-robin so
    // the corners stay as balanced as possible. Edges contribute no interior pts.
    const base = Math.floor(n / 4);
    let remainder = n - base * 4;
    for (let k = 0; k < 4; k++) {
      cornerCounts[k] = base + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder--;
    }
    return { cornerCounts, edgeCounts };
  }

  // Sharp rect: one vertex per corner, the rest distributed along edges by length.
  let toCorners = Math.min(n, 4);
  for (let k = 0; k < toCorners; k++) cornerCounts[k] = 1;
  const remaining = n - toCorners;
  if (remaining > 0) {
    const add = distributeByWeight(edgeLens, remaining);
    for (let k = 0; k < 4; k++) edgeCounts[k] = add[k];
  }
  return { cornerCounts, edgeCounts };
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
 * Index of the CCW point whose angle from the origin is closest to START_ANGLE
 * (used to align the rect rings with the blob's first vertex).
 */
function startAngleRotation(pts: Point[]): number {
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const diff = angularDistance(Math.atan2(pts[i][1], pts[i][0]), START_ANGLE);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return best;
}

/** Cyclically rotates a point ring by `k`, returning a new array. */
function rotateBy(pts: Point[], k: number): Point[] {
  if (k <= 0 || k >= pts.length) return pts.slice();
  return pts.slice(k).concat(pts.slice(0, k));
}
