/**
 * Specs Inc. 2026
 * Runtime mesh builder for a single bubble in the Bubble Morph Mesh system.
 *
 * Wraps a Lens Studio MeshBuilder to turn a closed outline (N points around the
 * local origin) into a filled, triangle-fan mesh. The index buffer is built
 * once (topology never changes); only vertex positions are rewritten each frame
 * via setVertexInterleaved + updateMesh, which is the cheap in-place update path.
 */
import { Point } from "./ShapeGeometry";

// Interleaved vertex layout: position (xyz) + normal (xyz) + uv (xy) = 8 floats.
// Normals/uvs are included so standard (lit or textured) materials render fine.
const FLOATS_PER_VERTEX = 8;

export class BubbleMeshBuilder {
  private readonly builder: MeshBuilder;
  private readonly numPoints: number;
  // Half-extent used to normalize UVs into roughly [0,1]; flat-color materials
  // ignore UVs, but keeping them sane lets a texture map cleanly if desired.
  private readonly uvHalfExtent: number;

  constructor(numPoints: number, uvHalfExtent: number) {
    this.numPoints = numPoints;
    this.uvHalfExtent = Math.max(uvHalfExtent, 0.0001);

    this.builder = new MeshBuilder([
      { name: "position", components: 3 },
      { name: "normal", components: 3 },
      { name: "texture0", components: 2 },
    ]);
    this.builder.topology = MeshTopology.Triangles;
    this.builder.indexType = MeshIndexType.UInt16;

    this.appendInitialVertices();
    this.appendFanIndices();
    this.builder.updateMesh();
  }

  /**
   * The RenderMesh asset to assign to a RenderMeshVisual's `mesh`. Stays linked
   * to this builder, so later updateMesh() calls update what is rendered.
   */
  getMesh(): RenderMesh {
    return this.builder.getMesh();
  }

  /**
   * Rewrites all vertex positions from the given outline and rebuilds the mesh.
   * Expects exactly `numPoints` outline points centered on the local origin.
   */
  updatePositions(points: Point[]): void {
    // Vertex 0 is the shared fan hub at the local origin.
    this.builder.setVertexInterleaved(0, this.vertexData(0, 0));
    const count = Math.min(points.length, this.numPoints);
    for (let i = 0; i < count; i++) {
      const p = points[i];
      this.builder.setVertexInterleaved(1 + i, this.vertexData(p[0], p[1]));
    }
    this.builder.updateMesh();
  }

  // --- internal --------------------------------------------------------------

  private appendInitialVertices(): void {
    // Hub vertex + one per outline point, all at the origin until the first
    // updatePositions() call sets real geometry.
    const totalVerts = this.numPoints + 1;
    const verts = new Array<number>(totalVerts * FLOATS_PER_VERTEX).fill(0);
    // Normals must point along +Z even in the placeholder so lighting is valid.
    for (let v = 0; v < totalVerts; v++) {
      verts[v * FLOATS_PER_VERTEX + 5] = 1; // normal.z
    }
    this.builder.appendVerticesInterleaved(verts);
  }

  private appendFanIndices(): void {
    // Fan around hub vertex 0: triangle (0, 1+i, 1+next) for each edge, with the
    // outline closed back to the first point. CCW winding faces +Z.
    const indices: number[] = [];
    for (let i = 0; i < this.numPoints; i++) {
      const a = 1 + i;
      const b = 1 + ((i + 1) % this.numPoints);
      indices.push(0, a, b);
    }
    this.builder.appendIndices(indices);
  }

  private vertexData(x: number, y: number): number[] {
    const u = x / (this.uvHalfExtent * 2) + 0.5;
    const v = y / (this.uvHalfExtent * 2) + 0.5;
    return [x, y, 0, 0, 0, 1, u, v];
  }
}
