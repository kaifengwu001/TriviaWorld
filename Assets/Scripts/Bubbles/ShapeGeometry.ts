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
 * Both outlines are generated for the SAME shared array of angles, so outline
 * point i on the blob corresponds (by angle, radially) to point i on the rect.
 * That makes morphPoints() a clean per-vertex radial interpolation that holds
 * up for any aspect ratio. All outlines are centered on the local origin (0,0).
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

/**
 * Signed distance from point (px, py) to a rounded rectangle centered at the
 * origin with half-extents (halfW, halfH) and the given corner radius.
 * Negative inside, positive outside, zero on the boundary.
 */
function roundedRectSDF(
  px: number,
  py: number,
  halfW: number,
  halfH: number,
  cornerRadius: number
): number {
  // Inner box the corner disk is swept around.
  const bx = halfW - cornerRadius;
  const by = halfH - cornerRadius;
  const qx = Math.abs(px) - bx;
  const qy = Math.abs(py) - by;
  const outsideX = Math.max(qx, 0);
  const outsideY = Math.max(qy, 0);
  const outsideLen = Math.sqrt(outsideX * outsideX + outsideY * outsideY);
  const inside = Math.min(Math.max(qx, qy), 0);
  return outsideLen + inside - cornerRadius;
}

/**
 * Casts a ray from the origin at the given angle and returns the point where it
 * crosses the rounded-rectangle boundary. The rounded rect is convex and
 * contains the origin, so the signed distance increases monotonically outward
 * along the ray, making a binary search robust and stable.
 */
function roundedRectPointAtAngle(
  angle: number,
  halfW: number,
  halfH: number,
  cornerRadius: number
): Point {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);

  let lo = 0; // origin: SDF < 0 (inside)
  let hi = halfW + halfH + cornerRadius; // comfortably outside: SDF > 0
  for (let iter = 0; iter < 40; iter++) {
    const mid = (lo + hi) * 0.5;
    const sd = roundedRectSDF(dx * mid, dy * mid, halfW, halfH, cornerRadius);
    if (sd > 0) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  const t = (lo + hi) * 0.5;
  return [dx * t, dy * t];
}

/**
 * Generates the rounded-rectangle outline (centered at the origin) sampled at
 * the same angles as the blob. Width/height are arbitrary; the corner radius is
 * held FIXED (clamped to half the shorter side) so corners keep their shape no
 * matter the size or aspect ratio. Cheap enough to call on size changes, but
 * intended to be precomputed since the target is usually static per bubble.
 */
export function getRoundedRectPoints(
  angles: number[],
  width: number,
  height: number,
  cornerRadius: number
): Point[] {
  const halfW = Math.max(width, 0.0001) * 0.5;
  const halfH = Math.max(height, 0.0001) * 0.5;
  // A corner can never be larger than half the shorter side.
  const clampedCorner = Math.max(0, Math.min(cornerRadius, Math.min(halfW, halfH)));

  const pts: Point[] = new Array<Point>(angles.length);
  for (let i = 0; i < angles.length; i++) {
    pts[i] = roundedRectPointAtAngle(angles[i], halfW, halfH, clampedCorner);
  }
  return pts;
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
