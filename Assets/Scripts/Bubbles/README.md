# Bubble Morph Mesh (Option A)

Runtime-generated mesh system that renders organic, Perlin-distorted "bubble"
blobs and morphs them into dynamically-sized, fixed-corner rounded rectangles.
Each bubble renders as a **hollow ring** (a thin band hugging the rim) plus a
crisp **outline stroke**, matching the SVG/React prototype's look rather than a
solid disc. Each bubble is colored independently. Ported from the prototype in
[`../ExampleBubbleScript.js`](../ExampleBubbleScript.js), replacing its SVG
`<path>` renderer (ring via even-odd fill + a separate stroke) with Lens Studio
`MeshBuilder` band geometry.

Scope of this pass: **rendering + morph only**. A `progress` value `0..1` drives
each bubble from blob (`0`) to rounded rectangle (`1`). No activation, push-away,
or indicator logic yet (see [Out of scope](#out-of-scope--future-work)).

---

## Architecture

Five small, feature-grouped files:

| File | Responsibility |
|---|---|
| [`PerlinNoise.ts`](PerlinNoise.ts) | Classic 2D Perlin noise (verbatim math port). Pure, no engine deps. |
| [`ShapeGeometry.ts`](ShapeGeometry.ts) | Pure geometry: blob outline, rounded-rect outline, morph lerp, radial inset (stroke), easing. |
| [`BubbleMeshBuilder.ts`](BubbleMeshBuilder.ts) | Wraps `MeshBuilder`: two-contour **band** (annulus) mesh, static index buffer, per-frame vertex updates. |
| [`BubbleMesh.ts`](BubbleMesh.ts) | `@component` per bubble: owns a ring `RenderMeshVisual` + optional stroke child, cloned material(s), drives its own morph. |
| [`BubbleField.ts`](BubbleField.ts) | `@component` spawner/manager: creates N bubbles, assigns colors/sizes, drives shared progress. |

### Data flow

```
BubbleField (spawns N, assigns color/size/pos, drives progress)
   └─> BubbleMesh (per bubble; progress + timeOffset)
          ├─> PerlinNoise ─> ShapeGeometry (outer + inner blob, rounded-rect, morph, inset)
          ├─> BubbleMeshBuilder (ring band: outer↔inner contours) ─> RenderMeshVisual.mesh + cloned fill Material
          └─> BubbleMeshBuilder (stroke band: outer↔inset) ─> child RenderMeshVisual.mesh + cloned stroke Material
```

---

## Key technical decisions

- **Per-bubble rendering.** Each bubble is its own `SceneObject` +
  `RenderMeshVisual` + cloned material, so it carries its own color via
  `material.mainPass.baseColor`. Matches the clone pattern used elsewhere
  (`PictureBehavior`, `PingController`).
- **Local 2D geometry.** Outlines are built in the bubble's local XY plane
  (z = 0, +Z normals). World placement is handled by the `SceneObject` transform,
  so the same mesh code works regardless of where the field is positioned.
- **Fixed corners under any size/aspect.** The rounded rectangle is generated
  from real `width`/`height`/`cornerRadius` (cm); the corner radius is held
  constant (clamped to half the shorter side) rather than scaling a unit quad,
  so corners never distort.
- **Corner-weighted point budget (perf).** The two shapes share a point count
  `N` and morph by index, but distribute those points differently:
  - the **blob** keeps an **even angular distribution** (point `i` at a uniform
    angle), so the resting bubble at morph `0` is uniform — unchanged;
  - the **rounded rect** spends most of its points on the **corner arcs** (high
    curvature) and very few on the straight edges (which only need their
    endpoints). Each boundary segment gets points ∝ its weight, with corners
    weighted `cornerWeight`× their arc length; a straight edge that wins no extra
    points simply renders as one straight span between its corners.

  This is the key optimization: a small `N` (default `40`, was `64`) still
  renders smooth corners because points are no longer wasted on the flats. Raise
  `cornerWeight` to push `N` lower still. Correspondence is therefore **no longer
  strictly radial**; the rect points are walked CCW and rotated so index `0`
  lands near the blob's start angle, so the index-based morph still slides
  cleanly (much like the original prototype's perimeter-ordered rect).
- **Two-contour band, in-place vertex updates.** Each visual is an annulus
  stitched between an outer and an inner contour (`2N` vertices, `2N` triangles,
  even index = outer, odd = inner). The index buffer is built **once** (topology
  never changes); each frame only rewrites vertex positions via
  `setVertexInterleaved` + `updateMesh()` (the cheap path). The rounded-rect
  outline is precomputed once per size change; only the wobbling blobs are
  recomputed each frame.
- **Hollow ring + outline stroke (matches the prototype).** The fill is the band
  between the outer blob and a slightly smaller "sub" blob
  (`radius*(1-innerFraction)`, with `noiseScale`/`distortion` scaled the same way
  — a direct port of `subCirclePts`). **Both contours morph toward the same
  rounded rect**, so the ring thins to zero exactly at full morph, just like the
  prototype's even-odd ring path. The stroke is a second band hugging the outer
  rim (rim minus a fixed-width radial inset), on its own child object so it can
  render in front of the fill (small `+Z` nudge + higher render order) with the
  bubble's full-alpha color. `innerFraction = 1` collapses the inner contour to
  the origin for a solid disc if ever needed.
- **Manual `UpdateEvent` binding.** Each component binds its update loop in
  `onAwake` via `createEvent("UpdateEvent")` rather than the `@bindUpdateEvent`
  decorator, which is more reliable for components created at runtime.

---

## MeshBuilder API (verification spike)

Confirmed against `Support/StudioLib.d.ts`:

- `new MeshBuilder([{ name: "position", components: 3 }, { name: "normal", components: 3 }, { name: "texture0", components: 2 }])`
- `topology = MeshTopology.Triangles` (also `TriangleFan` available);
  `indexType = MeshIndexType.UInt16`
- Build once: `appendVerticesInterleaved(number[])`, `appendIndices(number[])`,
  `updateMesh()`
- Update per frame: `setVertexInterleaved(index, number[])` then `updateMesh()`
  (in-place; no rebuild needed)
- `getMesh(): RenderMesh` stays linked to the builder, so later `updateMesh()`
  calls update what is rendered. Assign to `RenderMeshVisual.mesh`.
- `RenderMeshVisual` (extends `MaterialMeshVisual`) exposes `mainMaterial`,
  `mainPass`, `mesh`. `Pass.baseColor` is a `vec4`.
- Runtime object/component creation: `global.scene.createSceneObject(name)`,
  `obj.setParent(...)`, `obj.createComponent("Component.RenderMeshVisual")`,
  `obj.createComponent(BubbleMesh.getTypeName())`.

---

## Debugging revelations

### 1. Only the rounded rectangle rendered; blobs were invisible (root cause)

**Symptom:** With auto-animate on, a filled rectangle flashed for a single frame
per loop; everything else was invisible. Scrubbing `progress` manually confirmed:
`0` (blob) and `0.5` (mid-morph) showed nothing, `1.0` (rect) rendered stably.

**Root cause:** The blob outline divides by `referenceRadius`
(`radiusRatio = radius / referenceRadius`). `BubbleField.configure()` passed every
blob parameter *except* `referenceRadius`, which relied on the `@input` default of
`40`. **TypeScript `@input` field-initializer defaults are not reliably applied to
components created at runtime via `createComponent`** — the value arrived as `0`,
so `radius / 0 = Infinity` made every blob vertex `Infinity`/`NaN` and collapsed
the mesh. The rounded-rect path never touches `referenceRadius`, so it alone
rendered. This is why the symptom looked shape-specific even though both shapes
share the identical `updateBand` → `setVertexInterleaved` → `updateMesh` path.

**Fix:** Guard against a non-positive reference radius in two places:
`getBubblePoints` (the pure function falls back to `DEFAULT_REFERENCE_RADIUS`) and
`BubbleMesh.initialize()` (sanitizes `referenceRadius`, `radius`, `numPoints`).
General lesson: **don't rely on `@input` defaults for runtime-created components —
pass values explicitly or sanitize on init.**

### 2. A single editor-placed BubbleMesh rendered nothing

A `RenderMeshVisual` created at runtime (via `createComponent`) starts with **no
material**. A `BubbleMesh` dropped on an object in the editor must have its
`Base Material` input assigned; otherwise the mesh builds but never draws. (The
`BubbleField` path is unaffected because it passes a base material through
`configure()`.)

### 3. Render-layer inheritance for spawned objects

Objects created with `createSceneObject` can land on a layer the camera doesn't
render. `BubbleField` sets `obj.layer = this.sceneObject.layer` on each spawned
bubble so the camera actually draws them.

### 4. From solid fill to ring + stroke

The first rendering pass drew a solid triangle-fan disc, which read very
differently from the prototype's **ring** (outer minus inner contour, even-odd
fill) plus a separate stroke. The current pass replaces the fan with a
two-contour band so the fill is a hollow ring, and adds the outer stroke as a
second band on a child object. A solid disc is still reachable by setting
`innerFraction = 1` (inner contour collapses to the origin).

---

## Testing

1. Let Lens Studio import the scripts; confirm no compile errors in the Logger.
2. Create a **two-sided Unlit material** (`baseColor` tint). Name it e.g.
   `BubbleMat`. An opaque material renders the ring/stroke as fully solid color;
   use an **alpha-blend/translucent** material if you want the `fillOpacity`
   (default `0.9`) to actually show through.
3. Create an empty `SceneObject` in front of the camera (camera sits at `z = 40`
   looking toward the origin; place the field at `z = 0`). Add the **BubbleField**
   component.
4. Assign **Base Material**, optionally a **Palette**; leave other defaults.
5. Preview: colored **rings** (hollow center) with a crisp outline wobble and
   morph `0 <-> 1` into rounded rectangles (Auto Animate on); the ring fill thins
   out into the outline at full morph, each keeping a fixed corner radius across
   varied sizes.
6. To isolate the morph, turn Auto Animate off and scrub **Global Progress**, or
   add a single **BubbleMesh** to an object and scrub its **Progress** (remember to
   assign its **Base Material**). Tune **Inner Fraction** (band thickness),
   **Show Stroke** / **Stroke Width**, and **Fill Opacity** to taste.
7. Perf: lower **Num Points** (default `40`) and/or raise **Corner Weight**
   (default `6`). Corners stay smooth at low counts because points are packed
   into the corner arcs; the straight edges cost almost nothing. Watch the rect
   corners at full morph (Global Progress = 1) as you push Num Points down.

---

## Out of scope / future work

- Per-element opacity parity (the prototype uses `fillOpacity 0.9` + `stroke
  opacity 1.0`; here that depends on the assigned material's blend mode).
- Interaction layer from the prototype: activation-by-proximity, push-away of
  neighboring bubbles, indicator radial wipe.
- Batching/instancing for hundreds of bubbles (current path is per-bubble:
  one `RenderMeshVisual` and draw call each).
