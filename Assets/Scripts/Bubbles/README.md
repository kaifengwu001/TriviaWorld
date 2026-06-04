# Bubble Morph Mesh (Option A)

Runtime-generated mesh system that renders organic, Perlin-distorted "bubble"
blobs and morphs them into dynamically-sized, fixed-corner rounded rectangles.
Each bubble renders as a single **hollow ring** — a filled band whose **outer
rim and inner rim undulate independently** (each driven by its own noise, not a
parallel offset) — rather than a solid disc. Each bubble is colored
independently. Ported from the SVG/React prototype in
[`../ExampleBubbleScript.js`](../ExampleBubbleScript.js), replacing its SVG
`<path>` renderer with a single Lens Studio `MeshBuilder` band (annulus).

Scope of this pass: **rendering + morph only**. A `progress` value `0..1` drives
each bubble from blob (`0`) to rounded rectangle (`1`). No activation, push-away,
or indicator logic yet (see [Out of scope](#out-of-scope--future-work)).

---

## Architecture

Five small, feature-grouped files:

| File | Responsibility |
|---|---|
| [`PerlinNoise.ts`](PerlinNoise.ts) | Classic 2D Perlin noise (verbatim math port). Pure, no engine deps. |
| [`ShapeGeometry.ts`](ShapeGeometry.ts) | Geometry: precomputed rim directions, in-place blob fill, corner-weighted rounded-rect outline, in-place morph lerp, easing. |
| [`BubbleMeshBuilder.ts`](BubbleMeshBuilder.ts) | Wraps `MeshBuilder`: two-contour **band** (annulus) mesh, static index buffer, per-frame vertex updates (reused scratch). |
| [`BubbleMesh.ts`](BubbleMesh.ts) | `@component` per bubble: owns one ring `RenderMeshVisual` + cloned material, reusable point buffers, drives its own morph. |
| [`BubbleField.ts`](BubbleField.ts) | `@component` spawner/manager: creates N bubbles, assigns colors/sizes, drives shared progress. |

### Data flow

```
BubbleField (spawns N, assigns color/size/pos, drives progress)
   └─> BubbleMesh (per bubble; progress + timeOffset; reusable outer/inner buffers)
          ├─> PerlinNoise ─> ShapeGeometry (outer rim + inner rim into buffers, morph in place)
          └─> BubbleMeshBuilder (ring band: outer↔inner rims) ─> RenderMeshVisual.mesh + cloned Material
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
  - the **rounded rect** puts **all** of its points on the **corner arcs** (the
    only curved part) and **none** on the straight edges. A straight edge is
    geometrically exact between its two corner endpoints, so it needs zero
    interior vertices and simply renders as one straight span between its corners.

  The allocation is **deterministic, not weight-based**: all `numPoints` are
  split as evenly as possible across the four corners, so a corner gets exactly
  ~`numPoints / 4` points (`numPoints` is **per rim** — the ring mesh is `2N`
  vertices). E.g. `N = 16` → `[4,4,4,4]` corners and `[0,0,0,0]` edges; the
  default `N = 64` → 16 points per corner. Lower `N` for cheaper corners, raise
  for denser ones. Each corner arc **owns its two endpoint vertices** (the
  corner-edge junctions), so there are never stray midpoints on the flats and no
  junction artifacts. (Sharp corners, `targetCornerRadius ≈ 0`, are the one
  exception: with no arc to sample, each corner gets a single vertex and the rest
  spread along the edges by length.) Correspondence is therefore **no longer
  strictly radial**; the rect points are walked CCW and rotated so index `0`
  lands near the blob's start angle, so the index-based morph still slides
  cleanly (like the prototype's perimeter-ordered rect).
- **Single hollow ring; two independently-undulating rims.** Exactly one mesh
  per bubble: an annulus stitched between an **outer rim** (the blob) and an
  **inner rim** — a slightly smaller "sub" blob (`radius*(1-innerFraction)`, with
  `noiseScale`/`distortion` scaled the same way, a direct port of `subCirclePts`).
  Because each rim is its own noise sample, the rims wobble against each other
  rather than as a parallel offset. Each rim morphs toward its **own** rounded
  rect: the outer rim onto the target rect, the inner rim onto that rect **inset
  by `rectLineWidth`** (a uniform cm value, *not* derived from the per-bubble
  radius — so every morphed rect shares the same line width), so the band keeps a
  constant width at full morph instead of collapsing (there is no separate
  outline stroke to fall back on). Note the *blob* band still scales per bubble
  (`radius*innerFraction`); only the rect band is uniform. The outer/inner rects
  share one point allocation and one
  start-angle rotation, so they stay index-aligned and the band never twists. The
  band is `2N` vertices / `2N` triangles, even index = outer rim, odd = inner rim;
  the index buffer is built **once** and each frame only rewrites positions via
  `setVertexInterleaved` + `updateMesh()`. Both rects are precomputed once per
  size change. `innerFraction = 1` collapses the inner rim to the origin for a
  solid disc if ever needed. (An earlier pass also drew a separate stroke band —
  a redundant third outline — which was removed.)
- **Allocation-free per-frame hot path.** Rim cos/sin are precomputed once per
  bubble (no trig per frame); the two rims are written into reusable buffers and
  morphed in place; the mesh builder reuses a single interleaved-vertex scratch
  array. When a bubble settles on the (static) full-morph rect, the ring band is
  pushed once and per-frame mesh writes are skipped until it animates back. Net
  per-bubble per-frame cost is two Perlin samples per point (intrinsic to two
  independent rims) plus the `setVertexInterleaved` writes — no array/trig churn.
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
`getBubblePointsInto` (falls back to `DEFAULT_REFERENCE_RADIUS`) and
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

### 4. Solid fill → ring; and the redundant third outline

The first rendering pass drew a solid triangle-fan disc. It was replaced with a
two-contour **band** so the fill is a hollow ring (outer rim + inner rim). A
follow-up pass had *also* added a separate stroke band hugging the outer rim —
which, on top of the ring band's own two edges, produced **three** visible
outlines per bubble. Since the ring band's outer and inner edges already are the
"outer ring" and "inner ring," the stroke was pure redundancy (and a second
SceneObject + material + draw call per bubble). It was removed: one band, two
rims. A solid disc is still reachable via `innerFraction = 1` (inner rim
collapses to the origin).

---

## Testing

1. Let Lens Studio import the scripts; confirm no compile errors in the Logger.
2. Create a **two-sided Unlit material** (`baseColor` tint). Name it e.g.
   `BubbleMat`. An opaque material renders the ring as fully solid color; use an
   **alpha-blend/translucent** material if you want the `fillOpacity`
   (default `0.9`) to actually show through.
3. Create an empty `SceneObject` in front of the camera (camera sits at `z = 40`
   looking toward the origin; place the field at `z = 0`). Add the **BubbleField**
   component.
4. Assign **Base Material**, optionally a **Palette**; leave other defaults.
5. Preview: colored **rings** (hollow center) whose outer and inner rims wobble
   independently, morphing `0 <-> 1` into rounded rectangles (Auto Animate on);
   the ring stays a constant-width rounded-rect band at full morph, each keeping
   a fixed corner radius across varied sizes.
6. To isolate the morph, turn Auto Animate off and scrub **Global Progress**, or
   add a single **BubbleMesh** to an object and scrub its **Progress** (remember to
   assign its **Base Material**). Tune **Inner Fraction** (blob band thickness),
   **Rect Line Width** (uniform rect band, cm), and **Fill Opacity** to taste.
7. Perf: lower **Num Points** (default `64`, *per rim*). Every rect point goes to
   the corners (none on the straight edges), so a corner gets exactly
   ~`numPoints / 4` points (`N = 16` → 4 per corner). Watch the rect corners at
   full morph (Global Progress = 1) as you push Num Points down.

---

## Out of scope / future work

- Fill opacity only shows on a translucent/alpha-blend material (it folds into
  the cloned material's `baseColor` alpha); an opaque material stays solid.
- Interaction layer from the prototype: activation-by-proximity, push-away of
  neighboring bubbles, indicator radial wipe.
- Batching/instancing for hundreds of bubbles (current path is per-bubble:
  one `RenderMeshVisual` and draw call each). With the stroke removed and the
  hot path allocation-free, the remaining per-bubble cost is two Perlin samples
  per outline point per frame.
