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
| `CityMarker.ts` | `@component` (light): an INVISIBLE logic-only selection target per city (collider + Interactable + gaze focus). The visible markers are drawn by `CardMarkerLayer`. |
| `CardGeo.ts` | Pure math (no engine deps): stable seeded scatter of cards around their city center, mile→degree conversion, and same-city in-scene-distance clustering. |
| `CardMarkerLayer.ts` | `@component`: textured billboard markers, one per CardStore card (merged with a count label when close in-scene). Re-mapped per frame onto the globe sphere or the docked table, so they pinpoint their coordinate through every zoom, pan, LOD step, and dive. |
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
python tools/generate_map_textures.py                  # all levels, all cities
python tools/generate_map_textures.py --only Tokyo     # one city
python tools/generate_map_textures.py --dry-run        # print the tile plan only

# Capture ONLY the wide L-1 handoff textures (skips L0..Ln, which are cached):
python tools/generate_map_textures.py --transition-only
python tools/generate_map_textures.py --transition-only --only Tokyo
python tools/generate_map_textures.py --transition-only --dry-run   # preview tiles
```

> The L-1 captures are large (4.5° span at `outSize 2048` ⇒ ~220–280 OSM tiles
> each; the tool warns past 256 but proceeds). With the polite ~1.5–4 s/tile pacing
> the first run takes a while; tiles are cached so re-runs are fast. Lower
> `transition.outSize` in `cityBounds.json` if you want fewer tiles.

The tool reads `cityBounds.json`, computes the Web-Mercator slippy-tile range for
each LOD's bbox at a zoom that meets `outSize`, fetches OSM tiles (descriptive
**User-Agent**), stitches, crops to the **exact** bounds, resizes to a
power-of-two PNG, and writes `Assets/Textures/Globe/<city>_L<n>.png`. It then
rewrites `cityBounds.ts` from the JSON.

- **Single source of truth — levels, degrees, sizes:** every span/size used by
  BOTH the capture and the in-lens math lives in `cityBounds.json` (mirrored to
  `cityBounds.ts` by the tool — never hand-edit the `.ts`). This includes the wide
  **handoff capture (L-1)**: the JSON's `transition` block (`spanMultiple`,
  `outSize`, `labelSuffix`) is the *one place* defining it. The tool derives each
  city's L-1 as a square of `spanMultiple × that city's L0 span`, centered on L0,
  captured at `outSize`, and writes `Assets/Textures/Globe/<city>_L-1.png` plus a
  `transition:` entry in `cityBounds.ts`. Change `spanMultiple` (e.g. 10 → 8) once
  and every city's handoff rescales — capture and runtime can't drift. Assign the
  generated `_L-1.png` to each city's **transition texture** input on `CityData`.
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
   (override only if you want a specific value). **Table size is set in ONE place
   — `GlobeController.tableSizeCm`** (pushed to `GlobeView` and `MapViewport` at
   startup); there is no per-component table-size field to keep in sync.
2. **Map table**: add `MapViewport` to an empty object. Leave `tableVisual`
   **empty** and the component **builds a flat quad by code** (sized from the
   controller's `tableSizeCm`, `windowUV` 0..1, lying in the local **XZ plane**
   with its face pointing **+Y**, so it reads as a horizontal table). Assign the table **material graph** (below)
   to `tableMaterial`. (You can still assign a pre-made `tableVisual` to opt out of
   code geometry.) Note: a flat table is edge-on from a head-on camera — tilt the
   editor camera **down** toward it, or place it lower/in front, to see its face.
3. **City markers (selection)**: leave `GlobeController.markers[]` **empty** and
   keep `autoCreateMarkers` on — the controller **creates and places one
   invisible logic-only marker per city** from its lat/lng
   (`GeoMath.lonLatToSpherePos`), parented to the globe so they ride its
   rotation. They carry the collider + Interactable for tap/gaze selection; the
   *visible* markers come from `CardMarkerLayer` (below). To place selection
   markers by hand instead, assign them to `markers[]` and turn
   `autoCreateMarkers` off.
4. **Card markers (visuals)**: add `CardMarkerLayer` to an empty object under the
   globe scene root. Assign `markerTexture` (the pin icon) and an **Unlit
   transparent** `markerMaterial` (cloned at runtime; `baseTex` is replaced by
   the icon). The layer reads every card from `global.cropCardStore`, scatters
   each inside `scatterRangeMiles` of its city center (seeded by card id, so a
   card's spot **never moves**), and re-maps the markers every frame onto the
   live surface (globe in OVERVIEW + dives, table while DOCKED):
   - Markers closer than `mergeDistanceCm` **in-scene** merge into one marker at
     their average position, with a count label when more than one card merged
     (no label for a lone card). Merging never crosses cities, so the globe view
     always shows ≥ 3 markers (Tokyo / Seattle / Los Angeles — LA and Seattle
     can never merge), and `alwaysShowCityMarkers` pins a center marker for a
     city with no cards.
   - While docked, markers are clipped to the table's visible feathered circle
     (`visibleCircleFraction`): they disappear past the rim and reappear when
     panned back in.
   - New cards captured during the session appear automatically (the layer polls
     the store's count/version).
5. **CityData**: drop the generated PNGs onto `tokyoLevels` / `seattleLevels` /
   `losAngelesLevels` **in L0..L2 order**, and the base Earth texture onto
   `globeBaseTexture`.
6. **GlobeController**: wire `globeView`, `mapViewport`, `cityData`, and the
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
- **Continuous co-zoom handoff (the "critical level")**: when a city has a wide
  **L-1** capture (`transitionLevel`, 10× L0's span — see *Single source of truth*
  below), the table doesn't pop in at the final size; it **co-zooms with the globe**.
  The dive is timed around the *critical level* — the moment the globe's surface
  footprint span equals the L-1 span:
  - **Scale** runs the whole dive as one continuous curve (the footprint zoom
    never changes pace — that is what lets the table match the globe by span alone).
  - **Rotation + position finish *by* the critical level** (a hard deadline). Their
    `*Speed` knobs may finish them *earlier*, but **never later** — so after critical
    only the zoom is changing and the globe↔table match depends on span alone, with
    no extra matching math. *(This is a deliberate timing constraint.)*
  - The globe **fades out** while the table **fades in** (table opacity =
    `1 − globeAlpha`) over **[critical, L0-home]** — the fade **completes the instant
    L0 fills the table** (100% zoom), NOT at the end of the dive. Every frame the
    table is reframed to the globe's **live footprint span** (`GlobeView.spanForScale`):
    it rides the wide L-1 capture and **switches to sharp L0 the instant L0 fits the
    table** (where L0 is exactly in bounds). So at 100% the globe is gone and a
    fully-opaque sharp L0 is showing; the remaining dive is a real **100%→70%** L0
    zoom in to the `lodEnterZoom` enter framing — visible *before* the dive finishes,
    not revealed only at the end. *(Both the texture switch and the fade complete at
    100%; the fade window, not the texture crossfade, is what made L0 look late.)*
  - The swap is **direction-aware**: on the way out the table instead starts on
    sharp L0 and crossfades to the wide L-1 across a small band *above* home, so the
    return begins crisp (no blur pop) and only goes wide as it zooms back out.
  - If a city has **no** L-1 texture assigned, the dive falls back to the plain
    "table fades in at the final framing" behavior — nothing breaks.
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
- **Dive speed (per-channel)**: `positionSpeed` / `rotationSpeed` / `scaleSpeed` /
  `fadeSpeed` scale each channel's clock — `1` uses the full dive duration, `2`
  finishes in half the time (then holds at target), `<1` is slower. Bias only
  reshapes a channel; **speed** is what makes it actually finish sooner (e.g. raise
  `rotationSpeed` to snap the city to the top quickly while the zoom keeps gliding).
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
  pose captured at selection while the table co-zooms back **out** with it (sharp
  L0 → wide L-1 past home) and fades out against the reappearing globe. It mirrors
  the entry around the *reverse* critical level: the globe **fades back in by the
  critical level**, then **un-rotates / un-positions** outward (each channel uses
  the reversed curve, so the timing/feel mirror the way in). Without an L-1 capture
  it's a plain `1 - f(1 - t)` film-reverse with a table fade-out.

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

- `Tokyo_L-1.png`, `Tokyo_L0.png`, `Tokyo_L1.png`, `Tokyo_L2.png`
- `Seattle_L-1.png`, `Seattle_L0.png`, `Seattle_L1.png`, `Seattle_L2.png`
- `Los Angeles_L-1.png`, `Los Angeles_L0.png`, `Los Angeles_L1.png`, `Los Angeles_L2.png`

`_L-1.png` is the wide handoff capture (10× L0 span, `outSize` 2048) used only for
the globe↔table co-zoom; assign it to each city's transition texture on `CityData`.

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
