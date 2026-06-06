# Interactive Globe → Guided City Zoom

A guided zoom-in lens for Spectacles: a low/moderate-poly **Earth globe**
(rotate-to-aim + scale-to-zoom) that crossfades into a standalone **holodeck map
table** over **Tokyo, Seattle, and Los Angeles**, each with **3 baked LOD
levels**. No streaming, no model swap, no geometry morph, no geometry LOD — all
map detail lives in baked **textures** driven by `uvScale` / `uvOffset`.

The globe is **hidden** once docked; while docked you pan/zoom a fixed feathered
crop pane (the map dissolves into the background at the rim, implying it
continues beyond the crop).

---

## Files

| File | Responsibility |
|---|---|
| `cityBounds.json` | **SINGLE SOURCE OF TRUTH** for geo bounds (globe base + per-city LOD list). Read by BOTH the Python generator and `cityBounds.ts`. |
| `cityBounds.ts` | In-lens mirror of the JSON (Lens Studio TS can't import `.json`). **Generated/kept in sync** by the Python tool — edit the JSON, not this. |
| `GeoMath.ts` | Pure math (no engine deps): equirectangular UV, sphere position, aim euler, `boundsToUv`/`uvToBounds`, `clampPan`, `dockScaleForSpan`, easing/lerp. |
| `CityData.ts` | `@component`: binds the bounds (math) to the imported map **textures** (assigned per city in L0..Ln order) → resolved `City` / `LodLevel` objects. |
| `GlobeView.ts` | `@component`: the globe sphere. `aimAt` / `zoomTo` / `dockScaleForSpan` / `animate` / `animateToPose` / `setPose` / `show` / `hide` (world-pose dive + fade on a cloned material's `baseColor` alpha). |
| `MapViewport.ts` | `@component`: the holodeck table. Single fixed mesh; `setLevel` / `pan` / `zoom` / `show` / `hide`, UV math from bounds, LOD dissolve. |
| `GlobeController.ts` | `@component`: the guided state machine (OVERVIEW → ZOOMING_IN → DOCKED L0..L2 → ZOOMING_OUT). Wires gaze/pinch input to transitions. |
| `CityMarker.ts` | `@component` (light): a tappable pin per city; holds the city name + a gaze highlight. |
| `../../../tools/generate_map_textures.py` | Offline OSM-tile generator → `Assets/Textures/Globe/<city>_L<n>.png`. |

---

## Data flow

```
cityBounds.json ──► generate_map_textures.py ──► Assets/Textures/Globe/*.png
       │                      │
       │                      └─(regenerates)─► cityBounds.ts
       ▼                                              │
  (capture framing)                                   ▼
                                CityData (bounds + imported textures) → City[]
                                                      │
                       GlobeController (state machine, gaze+pinch)
                          ├─► GlobeView   (aim/zoom/fade; hidden while docked)
                          └─► MapViewport (uvOffset/uvScale under a fixed crop)
```

Capture and alignment are the **same problem solved from one source**: the bounds
that frame each PNG are the bounds that compute the in-lens UV/scale/orientation,
so framing and alignment can never drift (the generator even regenerates
`cityBounds.ts` to enforce it — verified identical).

---

## Generating the map textures (author-time, once)

```bash
pip install requests pillow
python tools/generate_map_textures.py            # all cities
python tools/generate_map_textures.py --only Tokyo
python tools/generate_map_textures.py --dry-run  # print the tile plan only
```

The tool reads `cityBounds.json`, computes the Web-Mercator slippy-tile range for
each LOD's bbox at a zoom that meets `outSize`, fetches OSM tiles (descriptive
**User-Agent**), stitches, crops to the **exact** bounds, resizes to a
power-of-two PNG, and writes `Assets/Textures/Globe/<city>_L<n>.png`. It then
rewrites `cityBounds.ts` from the JSON.

- **Provider-agnostic:** the tile URL template lives in `cityBounds.json`
  (`provider.urlTemplate`). OSM road tiles by default; swap for a keyed/satellite
  provider with no code change.
- **OSM usage policy:** the batch is tiny (one-time, 9 images, ~470 tiles total),
  a User-Agent is set, and the lens must show **"© OpenStreetMap contributors"**
  attribution (see `provider.attribution`). Reduce `outSize`/`spanDeg` if you want
  fewer tiles.
- **Shipped lens needs no network** — it bundles the static PNGs (no Internet
  Access capability required). Generator deps are author-time only.

---

## Lens Studio scene setup

The rig is mostly **self-assembling** — radius detection, the table quad, and the
markers are all created by code. You only hand-author the two things code cannot:
a textured globe mesh and the table's material graph.

1. **Globe sphere**: a moderate-poly sphere mesh + an **Unlit** material; assign
   an **equirectangular base Earth texture** (hand-imported, e.g.
   `Assets/Textures/Globe/earth_equirect.png`). Add `GlobeView` to it. Leave
   `globeRadiusCm` at **0** to **auto-detect** the radius from the mesh AABB
   (override only if you want a specific value); set `tableSizeCm` to your table
   size.
2. **Map table**: add `MapViewport` to an empty object. Leave `tableVisual`
   **empty** and the component **builds a flat quad by code** (size `tableSizeCm`,
   `windowUV` 0..1, lying in the local **XZ plane** with its face pointing **+Y**,
   so it reads as a horizontal table). Assign the table **material graph** (below)
   to `tableMaterial`. (You can still assign a pre-made `tableVisual` to opt out of
   code geometry.) Note: a flat table is edge-on from a head-on camera — tilt the
   editor camera **down** toward it, or place it lower/in front, to see its face.
3. **City markers**: leave `GlobeController.markers[]` **empty** and keep
   `autoCreateMarkers` on — the controller **creates and places one marker per
   city** from its lat/lng (`GeoMath.lonLatToSpherePos`), parented to the globe so
   they ride its rotation. Assign an optional `markerPrefab` for the visual (else
   markers are invisible logic-only objects); tune `markerScale` /
   `markerSurfaceOffset`. To place markers by hand instead, assign them to
   `markers[]` and turn `autoCreateMarkers` off.
4. **CityData**: drop the generated PNGs onto `tokyoLevels` / `seattleLevels` /
   `losAngelesLevels` **in L0..L2 order**, and the base Earth texture onto
   `globeBaseTexture`.
5. **GlobeController**: wire `globeView`, `mapViewport`, `cityData`, and the
   `cameraObject` (scene camera — needed for gaze **and** touch selection).
   Optionally set `tableObject` (defaults to the MapViewport's object) and a
   `labelText`.

### Material graph input properties (the table)

Create these as **Input Properties** in the Material Editor graph (right-click →
*Create Input Property*); the script sets them via `mat.mainPass.<name>`:

| Name | Type | Set by | Meaning |
|---|---|---|---|
| `mapTex` | Texture | `MapViewport` | slot A: the current/incoming LOD image |
| `uvOffset` | vec2 | `MapViewport` | slot A pan: `mapUV = windowUV * uvScale + uvOffset` |
| `uvScale` | vec2 | `MapViewport` | slot A zoom (1 = whole texture fills the pane) |
| `mapTexB` | Texture | `MapViewport` | slot B: the outgoing LOD image (only during a step) |
| `uvOffsetB` | vec2 | `MapViewport` | slot B pan: `mapUV_B = windowUV * uvScaleB + uvOffsetB` |
| `uvScaleB` | vec2 | `MapViewport` | slot B zoom |
| `crossfade` | float | `MapViewport` | `0` = show slot A, `1` = show slot B; tweened `1→0` on a LOD step |
| `baseColor` | vec4 | `MapViewport` | alpha is the table show/hide fade |

The graph samples **both** `mapTex` (at `mapUV`) and `mapTexB` (at `mapUV_B`) and
**lerps their rgb by `crossfade`** (`mix(A, B, crossfade)`), giving a true
dual-sampler crossfade for LOD steps with no black dip. The blended color is then
multiplied by a **fixed feathered crop mask** computed from `windowUV` (e.g.
`smoothstep`/rounded-rect on distance to pane center) so the map fades to
**background** at the rim. The crop mask is constant — it never moves with
pan/zoom — and is shared by both samples. At rest `crossfade = 0`, so slot B is
ignored.

---

## Interaction

Two input paths are **always active** — hands (device) and touch (editor + phone).

**Hands (Spectacles):**
- **Select a city** (OVERVIEW): gaze a `CityMarker` (it pops via `highlightScale`)
  and **pinch** to select.
- **Pan** (DOCKED): one-hand drag → `uvOffset` (clamped to the texture).
- **Zoom / step LOD** (DOCKED): two-hand pinch-stretch → `uvScale`. (Reuses the
  two-hand `thumbTip`-distance pattern from `../PictureBehavior.ts`.)

**Touch (editor + phone):**
- **Rotate the globe** (OVERVIEW): one-finger **drag** spins it (`touchRotateSpeed`).
- **Select a city** (OVERVIEW): **tap** a marker (nearest projected marker within a
  screen-distance threshold via `Camera.worldSpaceToScreenSpace`).
- **Pan the table** (DOCKED): one-finger **drag** → `uvOffset` (`touchPanGain`).
- **Zoom the table** (DOCKED): **two-finger pinch** → `uvScale`.
- **Step LOD** (DOCKED): **tap** steps **in** a LOD; tapping at the deepest level
  steps **out** / back.

**Shared flow:**
- **Approach (dive)**: a single world-pose tween makes the globe *become* the map
  — it rotates the city to its **top**, slides that top onto the **table center**,
  scales to `dockScaleForSpan(lodEnterZoom * L0.span)`, and **fades out** while the
  table **fades in** at the matched footprint (it reads as diving into the surface,
  not a swap to an unrelated place). L0 enters partly zoomed (`lodEnterZoom`) so
  there's pan room immediately, and the globe footprint is sized to that same span
  so the handoff lines up by construction.
- **Top-tip pivot**: position and scale pivot about the globe's **top tip** (its
  world-up-most surface point, independent of rotation), not its center. The dive
  animates that tip from the overview globe's top onto the **table center** while
  the (deep, huge) sphere center is derived from `tip − up·radius·scale`. This is
  what makes it read as *zooming into the top surface* — and prevents the small
  globe from being flung underground when channels ease at different rates.
- **Dive feel (per-channel bias)**: position / rotation / scale / fade each take a
  single signed knob in **[-1, +1]** (`positionBias` / `rotationBias` /
  `scaleBias` / `fadeBias` → `biasedEase`): **0** = smooth ease-in-out (natural),
  **+1** = front-loaded (fast start, gentle finish), **-1** = back-loaded (slow
  start, fast finish); magnitude is the strength. One intuitive number per channel
  instead of opaque mode codes.
- **`fadeOutGlobe`** (debug): turn OFF to keep the globe fully visible at the dock
  pose (it isn't faded or disabled) so you can verify the location lands on TOP
  with the correct orientation; turn back ON for the normal crossfade.
- Crossing the **min** zoom edge steps **in** a LOD (crossfade to the next baked
  image), crossing the **max** edge while zooming out steps **out** / back. The
  step-in edge is set so the next level loads partly zoomed (`lodEnterZoom`, ~0.7)
  instead of at its fully-zoomed-out home, leaving room to pan immediately; the
  previous level therefore zooms a bit deeper before the (seamless) switch.
- **Back (reverse dive)**: zoom out past L0 home → ZOOMING_OUT. The globe
  reappears matching the current table view, then un-dives back to the OVERVIEW
  pose captured at selection while the table fades out in place.

---

## Key technical decisions

- **Traditional model movement throughout** (rotate-to-aim + scale-to-zoom). The
  interaction model never changes with depth — only the detail shown does.
- **No runtime geometry/mesh LOD.** All detail is in the **texture**; zooming adds
  zero geometric demand. The table is a single fixed mesh; a flat quad has no
  faceting at all.
- **Alignment is mathematical, not hand-authored.** Every `LodLevel` is defined by
  `centerLatLng` + `spanDeg`; that single source drives capture, globe aim +
  `dockScaleForSpan`, the table's initial UV, pan clamping, and LOD continuity.
- **The globe is HIDDEN while docked.** It dives in (rotate-to-top + slide-to-table
  + scale + fade) so its surface patch coincides with the table as it fades OUT and
  the table fades IN; the feathered crop therefore fades to **background**.
- **A city's L0 covers a LARGE area** (`spanDeg = 0.45`), so the globe→table
  footprint handoff is forgiving.
- **Immutability:** `GeoMath` returns new objects; `CityData` copies bounds so the
  shared `cityBounds` data is never mutated; materials are **cloned before
  modify** (same pattern as `PictureBehavior` / `PingController`).

### Faceting notes (approach phase only)

The base globe's curved limb can facet at *mid* zoom. Solved once, statically:
an **Unlit** base material + **moderate base tessellation** (a static choice, not
a per-level swap). Once docked the globe is hidden entirely, so deep zoom never
stresses the sphere mesh. If limb faceting is still visible during the approach
tween, raise the sphere tessellation a step, or hide the limb behind a vignette
during the tween.

---

## Baked-asset list

Produced by `generate_map_textures.py` into `Assets/Textures/Globe/`:

- `Tokyo_L0.png`, `Tokyo_L1.png`, `Tokyo_L2.png`
- `Seattle_L0.png`, `Seattle_L1.png`, `Seattle_L2.png`
- `Los Angeles_L0.png`, `Los Angeles_L1.png`, `Los Angeles_L2.png`

Hand-imported (not generated):

- `earth_equirect.png` — the globe's equirectangular base Earth texture.

---

## Simplifications / future work

- **LOD crossfade is a true dual-sampler blend** (`mix(mapTex, mapTexB,
  crossfade)`) on a single quad: a step loads the new level into slot A and the
  old into slot B, sets `crossfade = 1`, and tweens it to `0` so the new LOD
  resolves in place over the old with no black dip, flash, or overdraw.
- **Mercator vs equirectangular:** city bboxes are small, so `boundsToUv` treats
  latitude linearly. Revisit only if a span grows very large.
- **Selection** is gaze + pinch (no SIK `Interactable` dependency); swap in a
  `PinchButton`/`Interactable` per marker if preferred.
