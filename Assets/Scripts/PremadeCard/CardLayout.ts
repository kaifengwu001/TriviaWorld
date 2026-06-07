/**
 * Specs Inc. 2026
 * Card layout measurement for the Premade Card feature.
 *
 * Pure geometry: measures the combined footprint of a card's content visuals
 * (the picture quad + the caption text) in the CARD ROOT's local XY plane, so a
 * border can be sized and positioned to wrap them. Working in root-local space
 * keeps the result independent of the card's world placement and of the
 * per-frame billboard rotation applied to the root.
 *
 * Each visual's local AABB is mapped to root-local space via
 * rootInvWorld * visualWorld, so any nesting depth or per-object scale is exact.
 */

/** A centered rect in the card root's local XY plane (centimetres). */
export interface LocalRect {
  width: number
  height: number
  centerX: number
  centerY: number
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

/**
 * Measures the union of every visual's footprint in root-local XY, expands it by
 * `padding` on all sides, and returns it as a centered rect. Skips null visuals;
 * returns null when nothing measurable was found.
 */
export function measureLocalRect(
  visuals: BaseMeshVisual[],
  rootInvWorld: mat4,
  padding: number
): LocalRect | null {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let valid = false

  for (let i = 0; i < visuals.length; i++) {
    const visual = visuals[i]
    if (!visual) continue

    const worldMatrix = visual.getSceneObject().getTransform().getWorldTransform()
    const corners = boxCorners(visual.localAabbMin(), visual.localAabbMax())
    for (let c = 0; c < corners.length; c++) {
      const local = rootInvWorld.multiplyPoint(worldMatrix.multiplyPoint(corners[c]))
      if (local.x < minX) minX = local.x
      if (local.x > maxX) maxX = local.x
      if (local.y < minY) minY = local.y
      if (local.y > maxY) maxY = local.y
      valid = true
    }
  }

  if (!valid) return null
  const pad = Math.max(0, padding)
  const width = maxX - minX + 2 * pad
  const height = maxY - minY + 2 * pad
  if (!(width > 0) || !(height > 0)) return null

  return {
    width,
    height,
    centerX: (minX + maxX) * 0.5,
    centerY: (minY + maxY) * 0.5,
  }
}
