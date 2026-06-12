/**
 * Specs Inc. 2026
 * MapViewport – the standalone holodeck map table (globe hidden while it's up).
 *
 * A single FIXED mesh (flat quad / gently-curved cap) — NO geometry LOD. A
 * cloned material samples the current LOD texture at
 *     mapUV = windowUV * uvScale + uvOffset
 * with a FIXED feathered crop mask on windowUV (alpha -> background at the rim),
 * so the map dissolves into the world at the pane edge and the crop window never
 * moves. Pan = uvOffset, zoom = uvScale, LOD step = swap mapTex (with offset/
 * scale recomputed from bounds so the centered coordinate stays put).
 *
 * The material graph is expected to expose these script-set input properties
 * (documented in README.md): `mapTex` (Texture), `uvOffset` (vec2), `uvScale`
 * (vec2). The feathered crop mask lives entirely in the graph and is constant.
 *
 * All UV state is recomputed via GeoMath from the LOD bounds; nothing is
 * hand-aligned and no UV object is mutated in place.
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger";
import {
  GeoBounds,
  LatLng,
  UvTransform,
  Vec2Like,
  boundsToUv,
  uvToBounds,
  clampPan,
  clamp,
  clamp01,
  easeInOutCubic,
  lerp,
} from "./GeoMath";
import { LodLevel } from "./CityData";

@component
export class MapViewport extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">MapViewport – holodeck map table (UV pan/zoom under a fixed feathered crop)</span><br/><span style="color: #94A3B8; font-size: 11px;">Single fixed mesh. Material must expose mapTex / uvOffset (vec2) / uvScale (vec2). The feathered crop mask is constant in the graph.</span>')
  @ui.separator

  @ui.label('<span style="color: #60A5FA;">References</span>')
  @input
  @hint("OPTIONAL pre-made RenderMeshVisual of the table pane. Leave empty to BUILD a quad by code on this object. If set, its material is cloned.")
  @allowUndefined
  tableVisual: RenderMeshVisual

  @input
  @hint("Table material (the graph exposing mapTex / uvOffset / uvScale + a fixed crop mask). Required when the table is built by code; cloned at runtime.")
  @allowUndefined
  tableMaterial: Material

  // Edge length (cm) of the code-built table quad (ignored when a tableVisual is
  // assigned). NOT an @input: GlobeController owns the single authored value and
  // pushes it here via setTableSizeCm so the table size can never drift between
  // the globe, the table mesh, and panning.
  private tableSizeCm: number = 60

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Zoom limits (uvScale within a level)</span>')
  @input
  @hint("Smallest uvScale allowed while zoomed into a level (shows the least area / most detail). The controller lowers this at runtime (via setMinUvScale) so its deeper per-level step-in thresholds are reachable; this inspector value is just the authored default/floor.")
  minUvScale: number = 0.34

  @input
  @hint("Largest uvScale (1 = the whole LOD texture fills the pane = the level's home framing). Above this the controller should step out a LOD.")
  maxUvScale: number = 1.0

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Transitions</span>')
  @input
  @hint("Seconds for the show/hide table fade and the per-LOD crossfade.")
  fadeSec: number = 0.45

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Logging</span>')
  @input
  @hint("Enable general logging")
  enableLogging: boolean = false

  @input
  @hint("Enable lifecycle logging (onAwake, onStart, onUpdate, onDestroy)")
  enableLoggingLifecycle: boolean = false

  private logger: Logger
  private material: Material = null
  // True when the table quad was built by code (no tableVisual assigned), so a
  // later setTableSizeCm can rebuild it at the authored size.
  private builtOwnQuad: boolean = false
  private currentLevel: LodLevel | null = null
  private currentTex: Texture | null = null
  // Live UV transform applied as mapUV = windowUV * scale + offset.
  private uv: UvTransform = { offset: { x: 0, y: 0 }, scale: { x: 1, y: 1 } }
  private currentAlpha: number = 0

  // True dual-sampler crossfade on a SINGLE quad: the material samples two map
  // textures (A = incoming/resting level, B = outgoing level) and lerps between
  // them by `crossfade`. A LOD step loads the new level into slot A, the old one
  // into slot B, sets crossfade = 1 (fully old), and tweens it to 0 (fully new).
  // At rest crossfade = 0, so only slot A matters. No black dip, no flash, no
  // overdraw — the feathered crop alpha and baseColor opacity are shared.
  private crossfade: number = 0

  // A plain alpha tween for the quad's show/hide (table appear/disappear).
  private alphaTween: {
    from: number
    to: number
    duration: number
    elapsed: number
    onDone: (() => void) | null
  } | null = null

  // A separate tween that drives `crossfade` from 1 -> 0 during a LOD step.
  private transitionTween: {
    from: number
    duration: number
    elapsed: number
  } | null = null

  // --- globe<->table dive handoff state --------------------------------------
  // While the controller dives the globe in/out, the table is framed every frame
  // by geographic span (so it co-zooms with the globe). The L-1 -> L0 swap drives
  // the PRIMARY sampler (slot A) DIRECTLY by setting its texture at the switch
  // span — it does NOT rely on the dual-sampler crossfade (slot B), which only
  // renders transiently during LOD steps. Forward: ride wide L-1, then swap slot A
  // to sharp L0 the instant L0 fits the table (span <= L0 home). Reverse: start on
  // L0, swap to L-1 a little past home so the exit doesn't blur-pop immediately.
  private transitionActive: boolean = false
  private transitionWide: LodLevel | null = null // L-1 (shown while zoomed out past the switch span)
  private transitionSharp: LodLevel | null = null // L0 (shown once it fills the table)
  private transitionShowingSharp: boolean = false // which texture is currently on slot A
  private transitionSwitchSpan: number = 0.45 // span at/below which slot A shows sharp L0
  // Reverse keeps sharp L0 until a bit past home before swapping to wide L-1.
  private readonly REVERSE_SWITCH_RATIO = 1.3
  // The exact geographic bounds shown by the LAST dive-handoff framing (after
  // pan clamping), so marker overlays can pinpoint coordinates mid-dive. The
  // docked `this.uv` is stale during a dive, hence this separate record.
  private lastTransitionView: GeoBounds | null = null

  onAwake() {
    this.logger = new Logger("MapViewport", this.enableLogging || this.enableLoggingLifecycle, true)
    if (this.enableLoggingLifecycle) this.logger.debug("LIFECYCLE: onAwake()")

    this.setupVisual()
    this.setAlpha(0)
    this.getSceneObject().enabled = false

    this.createEvent("UpdateEvent").bind(() => this.update(getDeltaTime()))
  }

  // --- Public API ------------------------------------------------------------

  /**
   * Sets the shared table size (cm). Called by GlobeController at startup. If the
   * quad was built by code (no tableVisual assigned), it is rebuilt at the new
   * size; a pre-made tableVisual is left as-is.
   */
  setTableSizeCm(cm: number): void {
    this.tableSizeCm = Math.max(1, cm)
    if (this.builtOwnQuad) this.buildQuadVisual(this.tableSizeCm)
  }

  /**
   * Sets the active LOD. By default frames the level's whole texture (home
   * framing: scale 1, offset 0). If `keepView` is given, frames that exact
   * geographic view (center AND span) on the new level instead, so a LOD step is
   * CONTINUOUS: stepping IN lands near the new level's home (max) framing, while
   * stepping OUT lands near its min (zoomed-in) framing — never re-triggering the
   * edge that caused the step. The resulting scale is clamped to the level's
   * [minUvScale, maxUvScale] band. When `dissolve` is set, the incoming level is
   * crossfaded in over the outgoing one (overlay fade) instead of swapping hard.
   */
  setLevel(level: LodLevel, keepView?: GeoBounds, dissolve: boolean = false): void {
    if (!level || !level.mapTex) {
      this.logger.warn("setLevel called with no level/texture.")
      return
    }
    const prevLevel = this.currentLevel
    // Snapshot what is on screen RIGHT NOW (texture + framing) before we retarget
    // the main quad — this is what the crossfade overlay will show and fade out.
    const prevTex = this.currentTex
    const prevUv = this.uv

    this.currentLevel = level

    if (keepView) {
      // Frame the new level to show the same geographic view we were already
      // looking at, keeping the center fixed and clamping the scale into range.
      const t = boundsToUv(level.bounds, keepView)
      const s = clamp(t.scale.x, this.minUvScale, this.maxUvScale)
      const centerU = t.offset.x + t.scale.x / 2
      const centerV = t.offset.y + t.scale.y / 2
      const scale = { x: s, y: s }
      const offset = clampPan({ x: centerU - s / 2, y: centerV - s / 2 }, scale)
      this.uv = { offset, scale }
    } else {
      this.uv = { offset: { x: 0, y: 0 }, scale: { x: 1, y: 1 } }
    }

    if (dissolve && prevLevel && prevTex) {
      // Crossfade: slot B = the outgoing level at its outgoing framing, slot A =
      // the incoming level at its new framing, crossfade 1 (old) -> 0 (new).
      this.applyTextureB(prevTex)
      this.applyUvB(prevUv)
      this.applyUv()
      this.applyTexture(level.mapTex)
      this.beginCrossfade()
    } else {
      // No transition: slot A is the only one shown (crossfade pinned to 0).
      this.applyUv()
      this.applyTexture(level.mapTex)
      this.endCrossfade()
    }
  }

  private beginCrossfade(): void {
    this.setCrossfade(1)
    this.transitionTween = {
      from: 1,
      duration: Math.max(0.0001, this.fadeSec),
      elapsed: 0,
    }
  }

  private endCrossfade(): void {
    this.transitionTween = null
    this.setCrossfade(0)
  }

  /**
   * Pans the crop by a UV delta (clamped so the sample stays inside the
   * texture). Positive deltaUv.x scrolls the view east; positive y scrolls
   * south, matching texture-space directions.
   */
  pan(deltaUv: Vec2Like): void {
    const next = { x: this.uv.offset.x + deltaUv.x, y: this.uv.offset.y + deltaUv.y }
    this.uv = { offset: clampPan(next, this.uv.scale), scale: this.uv.scale }
    this.applyUv()
  }

  /**
   * Zooms about the current view center by `factor` (factor < 1 zooms IN: less
   * area, more detail). uvScale is clamped to [minUvScale, maxUvScale]; the
   * controller watches those edges to step LOD. Returns the clamped uvScale so
   * the controller can detect when a step is warranted.
   */
  zoom(factor: number): number {
    const f = Math.max(1e-3, factor)
    const centerX = this.uv.offset.x + this.uv.scale.x / 2
    const centerY = this.uv.offset.y + this.uv.scale.y / 2
    const s = clamp(this.uv.scale.x * f, this.minUvScale, this.maxUvScale)
    const newScale = { x: s, y: s }
    const newOffset = { x: centerX - s / 2, y: centerY - s / 2 }
    this.uv = { offset: clampPan(newOffset, newScale), scale: newScale }
    this.applyUv()
    return s
  }

  /** Current uvScale (x); equals 1 at a level's home framing. */
  getUvScale(): number {
    return this.uv.scale.x
  }

  /** Smallest uvScale allowed (deepest zoom within a level). */
  getMinUvScale(): number {
    return this.minUvScale
  }

  /**
   * Overrides the smallest allowed uvScale at runtime. The controller lowers this
   * so a deeper LOD step-in threshold (which loads the next level partly zoomed)
   * is reachable before the zoom clamps.
   */
  setMinUvScale(min: number): void {
    this.minUvScale = clamp(min, 0.01, this.maxUvScale)
  }

  /** The geographic bounds currently shown (for LOD continuity). */
  getViewBounds(): GeoBounds | null {
    if (!this.currentLevel) return null
    return uvToBounds(this.currentLevel.bounds, this.uv)
  }

  /**
   * The geographic bounds the table is showing RIGHT NOW, valid at every moment:
   * during a dive handoff this is the live transition framing (which bypasses the
   * docked uv state), otherwise the docked view bounds. Returns a NEW object.
   * Used by CardMarkerLayer to pin markers through pans, zooms, AND dives.
   */
  getLiveViewBounds(): GeoBounds | null {
    if (this.transitionActive && this.lastTransitionView) {
      const v = this.lastTransitionView
      return { centerLatLng: { lat: v.centerLatLng.lat, lng: v.centerLatLng.lng }, spanDeg: v.spanDeg }
    }
    return this.getViewBounds()
  }

  /** The table's current opacity (0..1), e.g. mid-crossfade against the globe. */
  getOpacity(): number {
    return this.currentAlpha
  }

  /** The active level, or null. */
  getCurrentLevel(): LodLevel | null {
    return this.currentLevel
  }

  /** Fades the table in (and enables it). Pass `duration` to override `fadeSec`. */
  show(onDone?: () => void, duration?: number): void {
    this.getSceneObject().enabled = true
    this.startAlphaTween(this.currentAlpha, 1, duration ?? this.fadeSec, onDone ?? null)
  }

  /** Fades the table out, then disables the object. Pass `duration` to override `fadeSec`. */
  hide(onDone?: () => void, duration?: number): void {
    this.endCrossfade()
    this.startAlphaTween(this.currentAlpha, 0, duration ?? this.fadeSec, () => {
      this.getSceneObject().enabled = false
      if (onDone) onDone()
    })
  }

  // --- Globe<->table dive handoff --------------------------------------------

  /**
   * Primes the table for the continuous globe<->table dive. The controller frames
   * the table each frame by geographic span (updateTransitionFraming) so it
   * co-zooms with the globe, and drives opacity (setOpacity) to crossfade it
   * against the globe.
   *
   * The L-1 -> L0 swap is done on the PRIMARY sampler (slot A) directly — NOT via
   * the dual-sampler crossfade (slot B), which only renders transiently during LOD
   * steps and does not hold a sustained second texture. Direction-aware:
   *   - `forward` (globe -> table): start on wide L-1; swap slot A to sharp L0 the
   *     instant L0 fits the table (span <= L0 home), then keep zooming on L0.
   *   - reverse (table -> globe): start on sharp L0; swap to wide L-1 a little past
   *     home (REVERSE_SWITCH_RATIO) so the exit doesn't blur-pop immediately.
   * Enables the object at alpha 0 (the controller owns opacity).
   */
  beginTransition(transitionLevel: LodLevel, l0Level: LodLevel, l0HomeSpan: number, forward: boolean): void {
    if (!transitionLevel || !transitionLevel.mapTex || !l0Level || !l0Level.mapTex) {
      this.logger.warn("beginTransition missing transition (L-1) or L0 texture.")
      return
    }
    this.transitionTween = null
    this.alphaTween = null
    this.transitionActive = true
    this.transitionWide = transitionLevel
    this.transitionSharp = l0Level
    this.lastTransitionView = null
    const home = Math.max(1e-4, l0HomeSpan)
    this.transitionSwitchSpan = forward ? home : home * this.REVERSE_SWITCH_RATIO
    this.getSceneObject().enabled = true
    this.setCrossfade(0) // primary sampler only; slot B unused during the dive
    this.setAlpha(0)
    // Start texture: forward begins wide (L-1), reverse begins sharp (L0).
    this.transitionShowingSharp = !forward
    const startLevel = forward ? transitionLevel : l0Level
    this.applyTexture(startLevel.mapTex)
    this.logger.info(
      "beginTransition " +
        (forward ? "FORWARD" : "REVERSE") +
        " wide=" +
        transitionLevel.label +
        " sharp=" +
        l0Level.label +
        " switchSpan=" +
        this.transitionSwitchSpan.toFixed(3) +
        " startTex=" +
        startLevel.label
    )
  }

  /**
   * Frames the table to show `(center, spanDeg)` on the PRIMARY sampler, swapping
   * its texture between wide L-1 and sharp L0 at the switch span so the footprint
   * tracks the globe's surface patch exactly. No-op unless beginTransition primed
   * it. Leaves the DOCKED pan/zoom state (`this.uv`) untouched.
   */
  updateTransitionFraming(center: LatLng, spanDeg: number): void {
    if (!this.transitionActive || !this.transitionWide || !this.transitionSharp) return
    const view: GeoBounds = { centerLatLng: { lat: center.lat, lng: center.lng }, spanDeg }
    const useSharp = spanDeg <= this.transitionSwitchSpan
    const level = useSharp ? this.transitionSharp : this.transitionWide
    if (useSharp !== this.transitionShowingSharp) {
      this.transitionShowingSharp = useSharp
      this.applyTexture(level.mapTex)
      this.logger.info(
        "transition SWAP -> " +
          level.label +
          " @span=" +
          spanDeg.toFixed(3) +
          " (switch=" +
          this.transitionSwitchSpan.toFixed(3) +
          ") alpha=" +
          this.currentAlpha.toFixed(2)
      )
    }
    const framed = this.framing(level.bounds, view)
    this.applyUvA(framed)
    // Record the EXACT displayed bounds (post pan-clamp) so getLiveViewBounds()
    // reports what is truly on screen, not just what was requested.
    this.lastTransitionView = uvToBounds(level.bounds, framed)
    this.setCrossfade(0)
  }

  /** Sets the table opacity directly (the controller crossfades it vs the globe). */
  setOpacity(a: number): void {
    this.alphaTween = null
    this.setAlpha(a)
  }

  /** Ends the dive handoff bookkeeping (the table is now a normally-docked LOD). */
  endTransition(): void {
    this.transitionActive = false
    this.transitionWide = null
    this.transitionSharp = null
    this.lastTransitionView = null
  }

  // boundsToUv for a view, pan-clamped into the texture (scale left as-is).
  private framing(texBounds: GeoBounds, view: GeoBounds): UvTransform {
    const t = boundsToUv(texBounds, view)
    return { offset: clampPan(t.offset, t.scale), scale: t.scale }
  }

  // Slot A uv from an explicit transform (handoff framing), without disturbing
  // `this.uv` — the DOCKED pan/zoom state we restore to after the dive.
  private applyUvA(uv: UvTransform): void {
    if (!this.material) return
    const pass = this.material.mainPass as any
    pass.uvOffset = new vec2(uv.offset.x, uv.offset.y)
    pass.uvScale = new vec2(uv.scale.x, uv.scale.y)
  }

  // --- Internal --------------------------------------------------------------

  // Builds the table visual (a code-generated quad) when none is assigned, then
  // clones a material onto it. A pre-made tableVisual is used as-is.
  private setupVisual(): void {
    if (!this.tableVisual) {
      this.tableVisual = this.buildQuadVisual(this.tableSizeCm)
      this.builtOwnQuad = true
    }

    // Prefer the explicit tableMaterial; fall back to whatever the visual carries.
    const src = this.tableMaterial ?? this.tableVisual.mainMaterial
    if (!src) {
      this.logger.warn("No table material (tableMaterial or tableVisual.mainMaterial); table will not render correctly.")
      return
    }
    this.material = src.clone()
    this.tableVisual.mainMaterial = this.material
    this.setCrossfade(0)
  }

  // Creates a RenderMeshVisual on this object with a centered, +Y-facing quad
  // that lies flat in the local XZ plane (edge length `sizeCm`), with windowUV
  // (texture0) in [0,1] across it — exactly what the crop-mask graph samples.
  // u runs along +X, v along +Z.
  private buildQuadVisual(sizeCm: number): RenderMeshVisual {
    const h = Math.max(1, sizeCm) / 2
    const builder = new MeshBuilder([
      { name: "position", components: 3 },
      { name: "normal", components: 3 },
      { name: "texture0", components: 2 },
    ])
    builder.topology = MeshTopology.Triangles
    builder.indexType = MeshIndexType.UInt16
    // position(xyz), normal(+Y), uv. Corners in the XZ plane; index order makes
    // the front face point +Y. v is mapped so the top of the map (v=1) is toward
    // -Z, the bottom (v=0) toward +Z.
    builder.appendVerticesInterleaved([
      -h, 0, -h, 0, 1, 0, 0, 1,
       h, 0, -h, 0, 1, 0, 1, 1,
       h, 0,  h, 0, 1, 0, 1, 0,
      -h, 0,  h, 0, 1, 0, 0, 0,
    ])
    builder.appendIndices([0, 2, 1, 0, 3, 2])
    builder.updateMesh()

    let rmv = this.sceneObject.getComponent("Component.RenderMeshVisual") as RenderMeshVisual
    if (!rmv) {
      rmv = this.sceneObject.createComponent("Component.RenderMeshVisual")
    }
    rmv.mesh = builder.getMesh()
    this.logger.info("Built map table quad (" + sizeCm + " cm).")
    return rmv
  }

  // Slot A: the incoming/resting level (what's shown when crossfade = 0).
  private applyTexture(tex: Texture): void {
    this.currentTex = tex
    if (!this.material || !tex) return
    const pass = this.material.mainPass as any
    pass.mapTex = tex
  }

  private applyUv(): void {
    if (!this.material) return
    const pass = this.material.mainPass as any
    pass.uvOffset = new vec2(this.uv.offset.x, this.uv.offset.y)
    pass.uvScale = new vec2(this.uv.scale.x, this.uv.scale.y)
  }

  // Slot B: the outgoing level shown only mid-crossfade (when crossfade > 0).
  private applyTextureB(tex: Texture): void {
    if (!this.material || !tex) return
    const pass = this.material.mainPass as any
    pass.mapTexB = tex
  }

  private applyUvB(uv: UvTransform): void {
    if (!this.material) return
    const pass = this.material.mainPass as any
    pass.uvOffsetB = new vec2(uv.offset.x, uv.offset.y)
    pass.uvScaleB = new vec2(uv.scale.x, uv.scale.y)
  }

  // 0 = show slot A (current level) only, 1 = show slot B (outgoing) only.
  private setCrossfade(t: number): void {
    this.crossfade = clamp01(t)
    if (!this.material) return
    const pass = this.material.mainPass as any
    pass.crossfade = this.crossfade
  }

  private setAlpha(a: number): void {
    this.currentAlpha = clamp01(a)
    if (!this.material) return
    const pass = this.material.mainPass as any
    const c = pass.baseColor as vec4
    if (c) {
      pass.baseColor = new vec4(c.r, c.g, c.b, this.currentAlpha)
    }
  }

  private startAlphaTween(from: number, to: number, duration: number, onDone: (() => void) | null): void {
    this.alphaTween = {
      from,
      to,
      duration: Math.max(0.0001, duration),
      elapsed: 0,
      onDone,
    }
    if (duration <= 0) {
      this.setAlpha(to)
      this.alphaTween = null
      if (onDone) onDone()
    }
  }

  private update(dt: number): void {
    this.updateCrossfade(dt)
    this.updateAlphaTween(dt)
  }

  // Drives the dual-sampler blend from the outgoing level (crossfade = 1) to the
  // incoming level (crossfade = 0), so the new LOD resolves in place over the old.
  private updateCrossfade(dt: number): void {
    const t = this.transitionTween
    if (!t) return
    t.elapsed += dt
    const k = easeInOutCubic(clamp01(t.elapsed / t.duration))
    this.setCrossfade(lerp(t.from, 0, k))
    if (t.elapsed >= t.duration) {
      this.endCrossfade()
    }
  }

  private updateAlphaTween(dt: number): void {
    const t = this.alphaTween
    if (!t) return
    t.elapsed += dt
    const raw = clamp01(t.elapsed / t.duration)
    const k = easeInOutCubic(raw)
    this.setAlpha(lerp(t.from, t.to, k))

    if (t.elapsed >= t.duration) {
      this.setAlpha(t.to)
      const done = t.onDone
      this.alphaTween = null
      if (done) done()
    }
  }
}
