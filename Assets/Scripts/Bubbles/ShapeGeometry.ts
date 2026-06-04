/**
 * Specs Inc. 2026
 * Shape geometry for the Bubble Morph Mesh system.
 *
 * Pure functions (no engine dependency) that generate the two outlines the
 * renderer morphs between:
 *   - an organic, Perlin-distorted blob (ported from getCirclePoints in
 *     Assets/Scripts/ExampleBubbleScript.js), and
 *   - a rounded rectangle of arbitrary width/height that keeps a fixed corner
 *     radius regardless of size/aspect ratio.
 *
 * Both outlines have the SAME number of points (N) and morph by index
 * (point i <-> point i), so all outlines are centered on the local origin (0,0).
 *
 * Point distribution is deliberately ASYMMETRIC between the two shapes:
 *   - The blob keeps an EVEN angular distribution (point i at a uniformly spaced
 *     angle), so the resting bubble at morph 0 stays uniform.
 *   - The rounded rect concentrates its points on the CORNER arcs (high
 *     curvature) and spends very few on the straight edges (which only need
 *     their endpoints). This lets a much smaller N render smooth corners.
 * Because the rect's points are perimeter-ordered (CCW) and rotated to start
 * near the blob's start angle, the index-based morph still slides cleanly even
 * though correspondence is no longer strictly radial.
 */
import { PerlinNoise } from "./PerlinNoise";

// A 2D outline point as [x, y]. Plain arrays (not vec2) avoid per-frame
// allocation churn in the hot path and mirror the original example.
export type Point = [number, number];

// Matches the original example's reference radius used to normalize distortion.
export const DEFAULT_REFERENCE_RADIUS = 40;

// Starting angle of the first outline point, matching the example (-60 degrees).
const START_ANGLE = -Math.PI / 3;

/**
 * Smoothstep-style easing used to shape the morph progress (port of the
 * example's easeInOutQuad).
 */
export function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/**
 * Builds the shared, evenly-spaced angle array (radians) that both the blob and
 * the rounded rectangle sample. Generated once per bubble and reused.
 */
export function buildAngles(numPoints: number): number[] {
  const angles = new Array<number>(numPoints);
  for (let i = 0; i < numPoints; i++) {
    angles[i] = START_ANGLE + (i / numPoints) * Math.PI * 2;
  }
  return angles;
}

/**
 * Generates the organic blob outline centered at the origin. Each point sits on
 * a ray at angle angles[i], pushed out by a Perlin-noise-modulated radius. The
 * timeOffset animates the wobble between frames.
 *
 * Port of getCirclePoints (ExampleBubbleScript.js lines 499-531) with the
 * center fixed at (0, 0) since the bubble's SceneObject handles world placement.
 */
export function getBubblePoints(
  noise: PerlinNoise,
  angles: number[],
  radius: number,
  timeOffset: number,
  noiseScale: number,
  distortion: number,
  referenceRadius: number = DEFAULT_REFERENCE_RADIUS
): Point[] {
  // Guard against a zero/invalid reference radius (e.g. an unset @input on a
  // runtime-created component), which would otherwise make every point
  // Infinity/NaN and collapse the mesh.
  const safeRef = referenceRadius > 0 ? referenceRadius : DEFAULT_REFERENCE_RADIUS;
  const radiusRatio = radius / safeRef;
  const pts: Point[] = new Array<Point>(angles.length);
  for (let i = 0; i < angles.length; i++) {
    const angle = angles[i];
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const nVal = noise.noise(cos * noiseScale + timeOffset, sin * noiseScale + timeOffset);
    const baseOffset = safeRef + nVal * distortion;
    const finalOffset = radiusRatio * baseOffset;
    pts[i] = [cos * finalOffset, sin * finalOffset];
  }
  return pts;
}

// Default extra weighting of corner arcs vs. straight edges when distributing
// rounded-rect points. >1 packs points into the corners (high curvature) and
// spends few on the straight edges, so far fewer total points render smoothly.
export const DEFAULT_CORNER_WEIGHT = 6;

// One straight edge or one corner arc of the rounded-rect boundary, with a
// relative weight used to allocate points and a parametric point generator
// (t in [0, 1), start inclusive / end exclusive so segments never duplicate the
// shared vertex where they meet).
interface BoundarySegment {
  weight: number;
  at: (t: number) => Point;
}

/**
 * Generates the rounded-rectangle outline (centered at the origin) with exactly
 * `numPoints` points. Width/height are arbitrary; the corner radius is held
 * FIXED (clamped to half the shorter side) so corners keep their shape no matter
 * the size or aspect ratio.
 *
 * Points are NOT spread evenly: each segment receives a share proportional to
 * its weight, where corner arcs are weighted `cornerWeight`x their arc length
 * and straight edges by their plain length. Every present segment is guaranteed
 * at least one point so the boundary is fully covered; a straight edge that ends
 * up with no extra points simply renders as a single straight span between its
 * neighbouring corners (exactly correct, and the source of the savings).
 *
 * The boundary is walked counter-clockwise and the result is rotated so index 0
 * lands near the blob's start angle, keeping the index-based morph aligned.
 */
export function getRoundedRectPoints(
  numPoints: number,
  width: number,
  height: number,
  cornerRadius: number,
  cornerWeight: number = DEFAULT_CORNER_WEIGHT
): Point[] {
  const n = Math.max(3, Math.floor(numPoints));
  const halfW = Math.max(width, 0.0001) * 0.5;
  const halfH = Math.max(height, 0.0001) * 0.5;
  const r = Math.max(0, Math.min(cornerRadius, Math.min(halfW, halfH)));

  const ix = halfW - r; // x of the corner-arc centers (inner box half-width)
  const iy = halfH - r; // y of the corner-arc centers (inner box half-height)
  const edgeW = 2 * ix; // top/bottom straight length
  const edgeH = 2 * iy; // left/right straight length
  const arcLen = (Math.PI / 2) * r; // one corner arc length
  const cw = Math.max(0, cornerWeight);

  // Point on a corner arc (center cx,cy) at fraction t of its 90-degree sweep.
  const arc = (cx: number, cy: number, startAngle: number, t: number): Point => {
    const a = startAngle + t * (Math.PI / 2);
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };

  // CCW boundary starting at the bottom of the right edge:
  //   right edge up, top-right corner, top edge left, top-left corner,
  //   left edge down, bottom-left corner, bottom edge right, bottom-right corner.
  const segments: BoundarySegment[] = [
    { weight: edgeH, at: (t) => [halfW, -iy + edgeH * t] },
    { weight: arcLen * cw, at: (t) => arc(ix, iy, 0, t) },
    { weight: edgeW, at: (t) => [ix - edgeW * t, halfH] },
    { weight: arcLen * cw, at: (t) => arc(-ix, iy, Math.PI / 2, t) },
    { weight: edgeH, at: (t) => [-halfW, iy - edgeH * t] },
    { weight: arcLen * cw, at: (t) => arc(-ix, -iy, Math.PI, t) },
    { weight: edgeW, at: (t) => [-ix + edgeW * t, -halfH] },
    { weight: arcLen * cw, at: (t) => arc(ix, -iy, (3 * Math.PI) / 2, t) },
  ];

  const counts = allocateCounts(segments.map((s) => s.weight), n);

  const pts: Point[] = [];
  for (let s = 0; s < segments.length; s++) {
    const count = counts[s];
    const seg = segments[s];
    for (let j = 0; j < count; j++) {
      pts.push(seg.at(j / count));
    }
  }

  return rotateToStartAngle(pts);
}

/**
 * Splits `total` points across segments by weight, summing to EXACTLY `total`.
 * Every positive-weight segment is reserved one point first (so the boundary is
 * never left with an uncovered run), then the remainder is distributed
 * proportionally with leftovers going to the largest fractional shares.
 */
function allocateCounts(weights: number[], total: number): number[] {
  const counts = weights.map(() => 0);
  const positive: number[] = [];
  for (let i = 0; i < weights.length; i++) {
    if (weights[i] > 0) positive.push(i);
  }
  if (positive.length === 0) {
    for (let i = 0; i < total; i++) counts[i % counts.length]++;
    return counts;
  }

  let assigned = 0;
  for (const i of positive) {
    if (assigned >= total) break;
    counts[i] = 1;
    assigned++;
  }

  let remaining = total - assigned;
  if (remaining > 0) {
    const sum = positive.reduce((acc, i) => acc + weights[i], 0);
    const raw = weights.map((w) => (w > 0 ? (remaining * w) / sum : 0));
    for (let i = 0; i < counts.length; i++) counts[i] += Math.floor(raw[i]);
    let leftover = remaining - raw.reduce((acc, v) => acc + Math.floor(v), 0);
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
  }
  return counts;
}

/** Smallest absolute angular gap (radians) between two angles. */
function angularDistance(a: number, b: number): number {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
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

/**
 * Per-vertex linear interpolation between the blob and rounded-rect outlines.
 * progress 0 = pure blob, 1 = pure rounded rect. Returns a fresh array (no
 * mutation of the inputs), matching the project's immutability convention.
 * Port of morphPoints (ExampleBubbleScript.js lines 534-540).
 */
export function morphPoints(blobPts: Point[], rectPts: Point[], progress: number): Point[] {
  const n = blobPts.length;
  const out: Point[] = new Array<Point>(n);
  for (let i = 0; i < n; i++) {
    const b = blobPts[i];
    const r = rectPts[i % rectPts.length];
    out[i] = [b[0] + (r[0] - b[0]) * progress, b[1] + (r[1] - b[1]) * progress];
  }
  return out;
}

/**
 * Returns a copy of an outline pulled radially toward the local origin by a
 * fixed `width` (cm). Because every outline point already sits on a ray from the
 * origin (blob and rounded-rect alike), moving each point inward along its own
 * radius yields a thin inner contour that hugs the original — exactly what the
 * outer stroke band needs. The inset is clamped so points never cross the
 * origin (degenerate stroke on a tiny shape simply collapses to ~0 width).
 * Pure: the input array is never mutated.
 */
export function insetRadial(points: Point[], width: number): Point[] {
  const n = points.length;
  const out: Point[] = new Array<Point>(n);
  for (let i = 0; i < n; i++) {
    const px = points[i][0];
    const py = points[i][1];
    const len = Math.sqrt(px * px + py * py);
    if (len <= 1e-5) {
      out[i] = [px, py];
      continue;
    }
    // Scale toward origin by `width`, clamped so the point stays on its ray.
    const scale = Math.max(0, len - width) / len;
    out[i] = [px * scale, py * scale];
  }
  return out;
}
