/**
 * Specs Inc. 2026
 * Shared unit-quad mesh for the textured Bubble Field.
 *
 * Builds a single 1x1 quad centered on the local origin (X/Y plane, +Z normal,
 * UVs 0..1 with v=0 at the top so PNGs render upright). The same RenderMesh is
 * assigned to every bubble's RenderMeshVisual — each bubble only varies by its
 * cloned material (texture) and its transform (position / scale / rotation), so
 * the geometry never needs to be rebuilt per bubble or per frame.
 */

// Interleaved vertex layout: position (xyz) + normal (xyz) + uv (xy) = 8 floats.
const QUAD_VERTICES: number[] = [
  // pos              normal      uv
  -0.5, 0.5, 0, 0, 0, 1, 0, 0, // top-left
  0.5, 0.5, 0, 0, 0, 1, 1, 0, // top-right
  0.5, -0.5, 0, 0, 0, 1, 1, 1, // bottom-right
  -0.5, -0.5, 0, 0, 0, 1, 0, 1, // bottom-left
];

const QUAD_INDICES: number[] = [0, 1, 2, 0, 2, 3];

/** Builds a fresh unit-quad RenderMesh. Build once and share across bubbles. */
export function createUnitQuadMesh(): RenderMesh {
  const builder = new MeshBuilder([
    { name: "position", components: 3 },
    { name: "normal", components: 3 },
    { name: "texture0", components: 2 },
  ]);
  builder.topology = MeshTopology.Triangles;
  builder.indexType = MeshIndexType.UInt16;
  builder.appendVerticesInterleaved(QUAD_VERTICES);
  builder.appendIndices(QUAD_INDICES);
  builder.updateMesh();
  return builder.getMesh();
}
