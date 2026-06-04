/**
 * Specs Inc. 2026
 * Runtime mesh builder for a single bubble contour band in the Bubble Morph
 * Mesh system.
 *
 * Wraps a Lens Studio MeshBuilder to turn TWO closed outlines (an outer and an
 * inner ring, each with N points around the local origin) into a filled band
 * (annulus) mesh. This replaces the earlier solid triangle-fan so bubbles read
 * as the prototype's hollow ring rather than a solid disc.
 *
 * The same builder serves both:
 *   - the ring fill   (outer = blob,  inner = slightly smaller "sub" blob), and
 *   - the edge stroke (outer = blob,  inner = blob inset by the stroke width).
 *
 * The index buffer is built once (topology never changes); only vertex
 * positions are rewritten each frame via setVertexInterleaved + updateMesh,
 * which is the cheap in-place update path.
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
  // Reused scratch for one interleaved vertex (pos.xyz, normal.xyz, uv.xy) so
  // the per-frame update never allocates. Normal is fixed at +Z; only x/y and
  // u/v are rewritten per vertex.
  private readonly scratch: number[] = [0, 0, 0, 0, 0, 1, 0, 0];

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
    this.appendBandIndices();
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
   * Rewrites all vertex positions from the given outer and inner outlines and
   * rebuilds the mesh. Both arrays are expected to hold exactly `numPoints`
   * points centered on the local origin. The filled area is the band between
   * them; when outer and inner coincide the band collapses to nothing (e.g. the
   * ring at full rounded-rect morph), which is the intended behavior.
   */
  updateBand(outer: Point[], inner: Point[]): void {
    const count = Math.min(outer.length, inner.length, this.numPoints);
    for (let i = 0; i < count; i++) {
      const o = outer[i];
      const n = inner[i];
      // Even index = outer ring vertex, odd index = matching inner ring vertex.
      this.writeVertex(2 * i, o[0], o[1]);
      this.writeVertex(2 * i + 1, n[0], n[1]);
    }
    this.builder.updateMesh();
  }

  // --- internal --------------------------------------------------------------

  private appendInitialVertices(): void {
    // Two vertices per outline point (outer + inner), all at the origin until
    // the first updateBand() call sets real geometry.
    const totalVerts = this.numPoints * 2;
    const verts = new Array<number>(totalVerts * FLOATS_PER_VERTEX).fill(0);
    // Normals must point along +Z even in the placeholder so lighting is valid.
    for (let v = 0; v < totalVerts; v++) {
      verts[v * FLOATS_PER_VERTEX + 5] = 1; // normal.z
    }
    this.builder.appendVerticesInterleaved(verts);
  }

  private appendBandIndices(): void {
    // For each segment i -> next, stitch a quad (two triangles) across the band:
    //   outer_i, inner_i, outer_next, inner_next.
    // Materials are rendered two-sided, so winding direction is not critical.
    const indices: number[] = [];
    for (let i = 0; i < this.numPoints; i++) {
      const next = (i + 1) % this.numPoints;
      const o0 = 2 * i;
      const n0 = 2 * i + 1;
      const o1 = 2 * next;
      const n1 = 2 * next + 1;
      indices.push(o0, n0, o1);
      indices.push(o1, n0, n1);
    }
    this.builder.appendIndices(indices);
  }

  private writeVertex(index: number, x: number, y: number): void {
    const s = this.scratch;
    s[0] = x;
    s[1] = y;
    // s[2..5] stay (z = 0, normal = 0,0,1).
    s[6] = x / (this.uvHalfExtent * 2) + 0.5;
    s[7] = y / (this.uvHalfExtent * 2) + 0.5;
    this.builder.setVertexInterleaved(index, s);
  }
}
