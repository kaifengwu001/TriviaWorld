/**
 * Specs Inc. 2026
 * Plane-space measurement helpers for the Card Backdrop feature.
 *
 * Pure geometry, no engine lifecycle: given a plane (an origin plus two in-plane
 * unit axes) it projects the world-space footprint of one or more mesh visuals
 * onto that plane and reports the combined min/max extents. Used to size a rect
 * that wraps a set of coplanar visuals (a captured picture + its caption text).
 *
 * Each visual's LOCAL axis-aligned bounding box is transformed by that visual's
 * own world matrix (so rotation and scale are exact) before projection, rather
 * than reusing a world AABB, which would over-estimate the size of a tilted card.
 */

/** A plane defined by a world-space origin and two in-plane unit axes. */
export interface PlaneBasis {
  origin: vec3
  right: vec3
  up: vec3
}

/** Min/max extents expressed in plane coordinates (right = u, up = v). */
export interface PlaneBounds {
  minU: number
  maxU: number
  minV: number
  maxV: number
  valid: boolean
}

/** A centered rect in plane coordinates, ready to drive a BubbleMesh. */
export interface PlaneRect {
  width: number
  height: number
  centerU: number
  centerV: number
}

// The eight corners of a local-space axis-aligned box (min..max).
function boxCorners(min: vec3, max: vec3): vec3[] {
  return [
    new vec3(min.x, min.y, min.z),
    new vec3(max.x, min.y, min.z),
    new vec3(min.x, max.y, min.z),
    new vec3(max.x, max.y, min.z),
    new vec3(min.x, min.y, max.z),
    new vec3(max.x, min.y, max.z),
    new vec3(min.x, max.y, max.z),
    new vec3(max.x, max.y, max.z),
  ]
}

/** A fresh, empty (invalid) bounds ready to accumulate boxes into. */
export function newBounds(): PlaneBounds {
  return { minU: Infinity, maxU: -Infinity, minV: Infinity, maxV: -Infinity, valid: false }
}

/**
 * Projects one LOCAL axis-aligned box (min..max) through `matrix` onto the plane
 * and expands `acc` to include it. Mutates and returns `acc`.
 */
export function accumulateLocalBox(
  acc: PlaneBounds,
  min: vec3,
  max: vec3,
  matrix: mat4,
  basis: PlaneBasis
): PlaneBounds {
  const corners = boxCorners(min, max)
  for (let c = 0; c < corners.length; c++) {
    const world = matrix.multiplyPoint(corners[c])
    const rel = world.sub(basis.origin)
    const u = rel.dot(basis.right)
    const v = rel.dot(basis.up)
    if (u < acc.minU) acc.minU = u
    if (u > acc.maxU) acc.maxU = u
    if (v < acc.minV) acc.minV = v
    if (v > acc.maxV) acc.maxV = v
    acc.valid = true
  }
  return acc
}

/**
 * Unions the plane-space footprint of every visual into a single bounds, using
 * each visual's LOCAL mesh AABB. Skips any null entry. Returns a fresh bounds
 * object and never mutates its inputs.
 *
 * NOTE: a Text component's localAabb does NOT refresh when its `.text` string
 * changes after layout, so callers that resize live-edited captions should measure
 * the caption via its getBoundingBox() and accumulateLocalBox() instead (see
 * CardBackdrop).
 */
export function unionVisualBounds(visuals: BaseMeshVisual[], basis: PlaneBasis): PlaneBounds {
  const acc = newBounds()
  for (let i = 0; i < visuals.length; i++) {
    const visual = visuals[i]
    if (!visual) continue
    const matrix = visual.getSceneObject().getTransform().getWorldTransform()
    accumulateLocalBox(acc, visual.localAabbMin(), visual.localAabbMax(), matrix, basis)
  }
  return acc
}

/** Expands `bounds` by `padding` on every side and converts to a centered rect. */
export function boundsToRect(bounds: PlaneBounds, padding: number): PlaneRect | null {
  if (!bounds.valid) return null
  const pad = Math.max(0, padding)
  const width = bounds.maxU - bounds.minU + 2 * pad
  const height = bounds.maxV - bounds.minV + 2 * pad
  if (!(width > 0) || !(height > 0)) return null
  return {
    width,
    height,
    centerU: (bounds.minU + bounds.maxU) * 0.5,
    centerV: (bounds.minV + bounds.maxV) * 0.5,
  }
}
