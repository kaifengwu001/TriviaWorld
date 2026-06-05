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

  @input
  @hint("Edge length (cm) of the code-built table quad. Ignored if a tableVisual is assigned. Match GlobeView.tableSizeCm.")
  tableSizeCm: number = 60

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Zoom limits (uvScale within a level)</span>')
  @input
  @hint("Smallest uvScale allowed while zoomed into a level (shows the least area / most detail). Below this the controller should step to the next LOD.")
  minUvScale: number = 0.34

  @input
  @hint("Largest uvScale (1 = the whole LOD texture fills the pane = the level's home framing). Above this the controller should step out a LOD.")
  maxUvScale: number = 1.0

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Transitions</span>')
  @input
  @hint("Seconds for the show/hide table fade and the per-LOD texture dissolve.")
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
  private currentLevel: LodLevel | null = null
  // Live UV transform applied as mapUV = windowUV * scale + offset.
  private uv: UvTransform = { offset: { x: 0, y: 0 }, scale: { x: 1, y: 1 } }
  private currentAlpha: number = 0

  // A small alpha tween used for show/hide and the LOD dissolve. The dissolve
  // fades out, swaps the texture at the midpoint, then fades back in.
  private alphaTween: {
    from: number
    to: number
    duration: number
    elapsed: number
    // Dissolve: alpha dips from `from` to 0 over the first half, swaps the
    // texture, then rises 0 -> `to` over the second half (reads as a crossfade
    // without a dual-sampler shader).
    dissolve: boolean
    pendingTex: Texture | null
    swapped: boolean
    onDone: (() => void) | null
  } | null = null

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
   * Sets the active LOD. By default frames the level's whole texture (home
   * framing: scale 1, offset 0). If `keepCenter` is given, frames that
   * coordinate at the level's home span instead, so a LOD step keeps the
   * centered point put. `dissolve` does a fade-out/swap/fade-in transition.
   */
  setLevel(level: LodLevel, keepCenter?: LatLng, dissolve: boolean = false): void {
    if (!level || !level.mapTex) {
      this.logger.warn("setLevel called with no level/texture.")
      return
    }
    const prevLevel = this.currentLevel
    this.currentLevel = level

    if (keepCenter) {
      // Frame the new level at its home span, centered on the kept coordinate so
      // a LOD step keeps the focused point put.
      const view: GeoBounds = {
        centerLatLng: { lat: keepCenter.lat, lng: keepCenter.lng },
        spanDeg: level.bounds.spanDeg,
      }
      const t = boundsToUv(level.bounds, view)
      this.uv = { offset: clampPan(t.offset, t.scale), scale: t.scale }
    } else {
      this.uv = { offset: { x: 0, y: 0 }, scale: { x: 1, y: 1 } }
    }
    this.applyUv()

    if (dissolve && prevLevel) {
      // Fade out, swap texture at the midpoint, fade back in.
      this.alphaTween = {
        from: this.currentAlpha,
        to: 1,
        duration: this.fadeSec,
        elapsed: 0,
        dissolve: true,
        pendingTex: level.mapTex,
        swapped: false,
        onDone: null,
      }
    } else {
      this.applyTexture(level.mapTex)
    }
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

  /** The geographic bounds currently shown (for LOD continuity). */
  getViewBounds(): GeoBounds | null {
    if (!this.currentLevel) return null
    return uvToBounds(this.currentLevel.bounds, this.uv)
  }

  /** The active level, or null. */
  getCurrentLevel(): LodLevel | null {
    return this.currentLevel
  }

  /** Fades the table in (and enables it) over `fadeSec`. */
  show(onDone?: () => void): void {
    this.getSceneObject().enabled = true
    this.startAlphaTween(this.currentAlpha, 1, this.fadeSec, onDone ?? null)
  }

  /** Fades the table out over `fadeSec`, then disables the object. */
  hide(onDone?: () => void): void {
    this.startAlphaTween(this.currentAlpha, 0, this.fadeSec, () => {
      this.getSceneObject().enabled = false
      if (onDone) onDone()
    })
  }

  // --- Internal --------------------------------------------------------------

  // Builds the table visual (a code-generated quad) when none is assigned, then
  // clones a material onto it. A pre-made tableVisual is used as-is.
  private setupVisual(): void {
    if (!this.tableVisual) {
      this.tableVisual = this.buildQuadVisual(this.tableSizeCm)
    }

    // Prefer the explicit tableMaterial; fall back to whatever the visual carries.
    const src = this.tableMaterial ?? this.tableVisual.mainMaterial
    if (!src) {
      this.logger.warn("No table material (tableMaterial or tableVisual.mainMaterial); table will not render correctly.")
      return
    }
    this.material = src.clone()
    this.tableVisual.mainMaterial = this.material
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

  private applyTexture(tex: Texture): void {
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
      dissolve: false,
      pendingTex: null,
      swapped: false,
      onDone,
    }
    if (duration <= 0) {
      this.setAlpha(to)
      this.alphaTween = null
      if (onDone) onDone()
    }
  }

  private update(dt: number): void {
    const t = this.alphaTween
    if (!t) return
    t.elapsed += dt
    const raw = clamp01(t.elapsed / t.duration)

    if (t.dissolve) {
      // First half: fade `from` -> 0. Second half: swap, then 0 -> `to`.
      if (raw < 0.5) {
        const k = easeInOutCubic(raw / 0.5)
        this.setAlpha(lerp(t.from, 0, k))
      } else {
        if (!t.swapped && t.pendingTex) {
          this.applyTexture(t.pendingTex)
          t.swapped = true
        }
        const k = easeInOutCubic((raw - 0.5) / 0.5)
        this.setAlpha(lerp(0, t.to, k))
      }
    } else {
      const k = easeInOutCubic(raw)
      this.setAlpha(lerp(t.from, t.to, k))
    }

    if (t.elapsed >= t.duration) {
      this.setAlpha(t.to)
      const done = t.onDone
      this.alphaTween = null
      if (done) done()
    }
  }
}
