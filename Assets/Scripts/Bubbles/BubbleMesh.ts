/**
 * Specs Inc. 2026
 * Bubble Mesh component for the Bubble Morph Mesh system.
 *
 * Renders a single bubble: an organic Perlin-noise blob that morphs into a
 * rounded rectangle as `progress` goes 0 -> 1. Each bubble owns its own
 * RenderMeshVisual and a cloned material so it can carry its own color.
 *
 * Can be used two ways:
 *   - dropped onto an object in the editor (configured via the @input fields), or
 *   - created at runtime by BubbleField, which calls configure() to set it up.
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger";
import { PerlinNoise } from "./PerlinNoise";
import { BubbleMeshBuilder } from "./BubbleMeshBuilder";
import {
  Point,
  buildRimDirections,
  getBubblePointsInto,
  getRoundedRectRing,
  morphInPlace,
  allocPointBuffer,
  easeInOutQuad,
  DEFAULT_REFERENCE_RADIUS,
} from "./ShapeGeometry";

// Runtime configuration accepted by configure(). All fields optional; anything
// omitted keeps the value already set on the component (its @input default).
export interface BubbleConfig {
  baseMaterial?: Material;
  color?: vec4;
  radius?: number;
  targetWidth?: number;
  targetHeight?: number;
  targetCornerRadius?: number;
  noiseScale?: number;
  distortion?: number;
  numPoints?: number;
  referenceRadius?: number;
  undulateSpeed?: number;
  progress?: number;
  innerFraction?: number;
  rectLineWidth?: number;
  fillOpacity?: number;
}

@component
export class BubbleMesh extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">BubbleMesh – morphs a Perlin blob into a rounded rectangle</span><br/><span style="color: #94A3B8; font-size: 11px;">Builds a runtime mesh on its own RenderMeshVisual and interpolates blob &lt;-&gt; rounded rect by the progress value (0..1).</span>')
  @ui.separator

  @ui.label('<span style="color: #60A5FA;">Material</span>')
  @input
  @hint("Base material cloned per-bubble. baseColor is overwritten with this bubble's color. Use an unlit, two-sided material for a flat colored shape.")
  @allowUndefined
  baseMaterial: Material

  @input
  @hint("Fill color (RGBA) applied to the cloned material's baseColor")
  color: vec4 = new vec4(0.2, 0.6, 1.0, 1.0)

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Ring</span>')
  @input
  @hint("BLOB ring thickness as a fraction of the radius (the prototype's SUB_FRACTION). Sets the inner rim at radius*(1-fraction); since radius varies per bubble, the blob band varies per bubble. The rect band uses Rect Line Width instead. Small = thin rim ring; 1 = solid disc.")
  innerFraction: number = 0.1

  @input
  @hint("RECT ring thickness in cm. Uniform across every bubble, so all morphed rounded rects share the same line width regardless of bubble size.")
  rectLineWidth: number = 0.4

  @input
  @hint("Opacity multiplier applied to the ring fill (needs a translucent material to show; an opaque material stays solid). Matches the prototype's 0.9 fill opacity.")
  fillOpacity: number = 0.9

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Blob Shape</span>')
  @input
  @hint("Blob radius in cm (local). Drives the bubble's resting size before morphing.")
  radius: number = 4

  @input
  @hint("Perlin sampling scale – higher values give more, tighter wobbles around the rim")
  noiseScale: number = 0.48

  @input
  @hint("How far the noise pushes the rim in/out, in reference-radius units")
  distortion: number = 4.0

  @input
  @hint("Points per RIM (one outline). The ring mesh uses 2x this many vertices (outer rim + inner rim). On the rounded rect every point goes to the corners (none on the straight edges), so each corner gets ~numPoints/4 points. Raise for denser corners.")
  numPoints: number = 64

  @input
  @hint("Reference radius used to normalize distortion (matches the source example)")
  referenceRadius: number = DEFAULT_REFERENCE_RADIUS

  @input
  @hint("Wobble animation speed (noise offset advanced per second)")
  undulateSpeed: number = 0.15

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Target Rounded Rectangle</span>')
  @input
  @hint("Target rectangle width in cm. Arbitrary; corner radius stays fixed.")
  targetWidth: number = 12

  @input
  @hint("Target rectangle height in cm. Arbitrary aspect ratio is supported.")
  targetHeight: number = 8

  @input
  @hint("Fixed corner radius in cm (clamped to half the shorter side)")
  targetCornerRadius: number = 2

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Morph</span>')
  @input
  @hint("Debug morph amount: 0 = blob, 1 = rounded rectangle")
  progress: number = 0

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Logging</span>')
  @input
  @hint("Enable general logging")
  enableLogging: boolean = false

  @input
  @hint("Enable lifecycle logging (onAwake, onStart, onUpdate, onDestroy)")
  enableLoggingLifecycle: boolean = false

  private logger: Logger
  private noise: PerlinNoise = null
  private builder: BubbleMeshBuilder = null
  private rmv: RenderMeshVisual = null
  private material: Material = null

  // Precomputed rim direction cos/sin (constant per bubble) keep trig out of the
  // per-frame blob update. Reusable scratch buffers hold the two ring contours
  // so the hot path never allocates.
  private cosDir: number[] = []
  private sinDir: number[] = []
  private outerBuf: Point[] = []
  private innerBuf: Point[] = []

  // The ring's two morph targets: the outer rounded rect and an inner rounded
  // rect inset by the line weight, so the band keeps its width at full morph.
  private rectOuter: Point[] = []
  private rectInner: Point[] = []
  private timeOffset: number = 0
  private undulateDir: number = 1
  private initialized: boolean = false
  // Once the bubble has settled on the (static) full-morph rect we push the ring
  // once and skip further per-frame work until it animates back.
  private restingAtRect: boolean = false
  // When driven by BubbleField the field owns the update cadence (alternate-frame
  // + FOV culling + billboarding), so the bubble must NOT also self-tick.
  private externallyDriven: boolean = false

  onAwake() {
    this.ensureLogger()
    if (this.enableLoggingLifecycle) this.logger.debug("LIFECYCLE: onAwake()")

    // Self-driving update for editor-placed bubbles. Bound manually (rather than
    // via a decorator) so it works reliably for components created at runtime.
    // BubbleField calls configure(), which flips externallyDriven and silences
    // this so the field can update each bubble on its own schedule.
    this.createEvent("UpdateEvent").bind(() => {
      if (!this.externallyDriven) this.tick(getDeltaTime())
    })
  }

  // Logger is created in onAwake, but configure()/initialize() may run first for
  // runtime-spawned bubbles depending on lifecycle ordering, so make it lazy.
  private ensureLogger(): void {
    if (!this.logger) {
      this.logger = new Logger("BubbleMesh", this.enableLogging || this.enableLoggingLifecycle, true)
    }
  }

  onStart() {
    // Standalone (editor-placed) path: if nobody configured us yet, set up from
    // the inspector values.
    if (!this.initialized) {
      this.initialize()
    }
  }

  // --- Public API ------------------------------------------------------------

  /**
   * Applies runtime configuration and (re)builds the bubble. Called by
   * BubbleField right after createComponent so setup never depends on event
   * ordering.
   */
  configure(config: BubbleConfig): void {
    if (config.baseMaterial !== undefined) this.baseMaterial = config.baseMaterial
    if (config.color !== undefined) this.color = config.color
    if (config.radius !== undefined) this.radius = config.radius
    if (config.targetWidth !== undefined) this.targetWidth = config.targetWidth
    if (config.targetHeight !== undefined) this.targetHeight = config.targetHeight
    if (config.targetCornerRadius !== undefined) this.targetCornerRadius = config.targetCornerRadius
    if (config.noiseScale !== undefined) this.noiseScale = config.noiseScale
    if (config.distortion !== undefined) this.distortion = config.distortion
    if (config.numPoints !== undefined) this.numPoints = config.numPoints
    if (config.referenceRadius !== undefined) this.referenceRadius = config.referenceRadius
    if (config.undulateSpeed !== undefined) this.undulateSpeed = config.undulateSpeed
    if (config.progress !== undefined) this.progress = config.progress
    if (config.innerFraction !== undefined) this.innerFraction = config.innerFraction
    if (config.rectLineWidth !== undefined) this.rectLineWidth = config.rectLineWidth
    if (config.fillOpacity !== undefined) this.fillOpacity = config.fillOpacity

    // The field drives updates; stop the self-tick so work isn't done twice.
    this.externallyDriven = true
    this.initialize(true)
  }

  /** Sets the morph amount (clamped to [0, 1]). */
  setProgress(p: number): void {
    this.progress = Math.max(0, Math.min(1, p))
  }

  getProgress(): number {
    return this.progress
  }

  /**
   * Advances the bubble's animation/mesh by `dt` seconds. Called by BubbleField
   * for externally-driven bubbles (so the field can throttle to alternate frames
   * and skip off-screen bubbles). `dt` is the time since THIS bubble last
   * advanced, which may span several frames when it was culled or half-rated.
   */
  advance(dt: number): void {
    this.tick(dt)
  }

  /** Updates the target rectangle and recomputes its (static) ring outlines. */
  setTargetSize(width: number, height: number, cornerRadius?: number): void {
    this.targetWidth = width
    this.targetHeight = height
    if (cornerRadius !== undefined) this.targetCornerRadius = cornerRadius
    if (this.initialized) {
      this.buildRectRing()
    }
  }

  // Builds the outer/inner rounded-rect morph targets. The rect band width is a
  // uniform cm value (rectLineWidth), independent of this bubble's radius, so
  // every morphed rect shares the same line width regardless of bubble size.
  private buildRectRing(): void {
    const ring = getRoundedRectRing(
      this.numPoints,
      this.targetWidth,
      this.targetHeight,
      this.targetCornerRadius,
      this.rectLineWidth
    )
    this.rectOuter = ring.outer
    this.rectInner = ring.inner
  }

  /** Updates the bubble color on its cloned material. */
  setColor(color: vec4): void {
    this.color = color
    if (this.material) {
      ;(this.material.mainPass as any).baseColor = this.fillColor()
    }
  }

  /**
   * Draws this border on top of everything else (depthTest off + raised render
   * order) when `enabled`, restoring normal depth-sorted drawing when off. Used
   * to keep query-result cards in front of the still-drifting cosmos.
   */
  setRenderInFront(enabled: boolean, order: number = 100): void {
    if (this.rmv) (this.rmv as any).renderOrder = enabled ? order : 0
    if (this.material) (this.material.mainPass as any).depthTest = !enabled
  }

  // The ring fill carries the bubble color with the fill-opacity multiplier
  // folded into its alpha.
  private fillColor(): vec4 {
    const a = Math.max(0, Math.min(1, this.fillOpacity))
    return new vec4(this.color.r, this.color.g, this.color.b, this.color.a * a)
  }

  // --- Internal --------------------------------------------------------------

  private initialize(force: boolean = false): void {
    if (this.initialized && !force) return
    this.ensureLogger()

    // Sanitize numeric inputs. @input field-initializer defaults are not
    // reliably applied to components created at runtime via createComponent, so
    // anything BubbleField doesn't pass explicitly (notably referenceRadius)
    // could arrive as 0/undefined and break the blob math.
    if (!(this.referenceRadius > 0)) this.referenceRadius = DEFAULT_REFERENCE_RADIUS
    if (!(this.radius > 0)) this.radius = 4
    if (!(this.numPoints > 0)) this.numPoints = 64
    // Clamp the ring band fraction to [0, 1]; 1 collapses the inner contour to
    // the origin (a solid disc), small values give a thin rim ring.
    if (!(this.innerFraction >= 0)) this.innerFraction = 0.1
    this.innerFraction = Math.min(this.innerFraction, 1)
    if (!(this.rectLineWidth >= 0)) this.rectLineWidth = 0.4
    if (!(this.fillOpacity >= 0)) this.fillOpacity = 0.9

    const points = Math.max(8, Math.floor(this.numPoints))
    this.numPoints = points
    this.noise = this.noise ?? new PerlinNoise()
    // Random starting phase and direction so a field of bubbles never pulses in
    // lockstep.
    this.timeOffset = Math.random() * 9999
    this.undulateDir = Math.random() < 0.5 ? -1 : 1

    const dirs = buildRimDirections(points)
    this.cosDir = dirs.cos
    this.sinDir = dirs.sin
    this.outerBuf = allocPointBuffer(points)
    this.innerBuf = allocPointBuffer(points)
    this.buildRectRing()

    this.ensureRenderMesh()
    this.applyMaterial()

    // The UV normalization extent must cover the largest shape we morph through.
    const uvHalfExtent = Math.max(this.radius, this.targetWidth * 0.5, this.targetHeight * 0.5)
    this.builder = new BubbleMeshBuilder(points, uvHalfExtent)
    if (this.rmv) {
      this.rmv.mesh = this.builder.getMesh()
    }

    this.initialized = true
    // Render an initial frame immediately so the bubble is visible before the
    // first UpdateEvent fires.
    this.tick(0)
  }

  private ensureRenderMesh(): void {
    let rmv = this.sceneObject.getComponent("Component.RenderMeshVisual") as RenderMeshVisual
    if (!rmv) {
      rmv = this.sceneObject.createComponent("Component.RenderMeshVisual")
    }
    this.rmv = rmv
  }

  private applyMaterial(): void {
    if (!this.baseMaterial) {
      this.logger.warn("No baseMaterial assigned; bubble mesh will build but not render.")
      return
    }
    // Clone so each bubble owns its color and the shared asset is never mutated.
    this.material = this.baseMaterial.clone()
    const pass = this.material.mainPass as any
    pass.baseColor = this.fillColor()
    // Defensive: a flat 2D shape should not be backface-culled. Harmless if the
    // material doesn't expose these.
    pass.twoSided = true
    if (this.rmv) {
      this.rmv.mainMaterial = this.material
    }
  }

  private tick(dt: number): void {
    if (!this.initialized || !this.builder) return

    const eased = easeInOutQuad(Math.max(0, Math.min(1, this.progress)))

    // Full morph: the ring is the static outer/inner rounded-rect band (a
    // constant-width rounded rect, NOT collapsed). Push it once, then skip the
    // noise/morph each frame until the bubble animates back off the rect.
    if (eased >= 0.9999) {
      if (!this.restingAtRect) {
        this.builder.updateBand(this.rectOuter, this.rectInner)
        this.restingAtRect = true
      }
      return
    }
    this.restingAtRect = false

    this.timeOffset += this.undulateSpeed * this.undulateDir * dt

    // Outer rim and a slightly smaller inner rim (the prototype's "sub" blob),
    // each sampled with its own noise so the two rims undulate independently
    // rather than as a parallel offset. Mirrors getCirclePoints/subCirclePts.
    const f = this.innerFraction
    getBubblePointsInto(this.outerBuf, this.noise, this.cosDir, this.sinDir, this.radius, this.timeOffset, this.noiseScale, this.distortion, this.referenceRadius)
    getBubblePointsInto(this.innerBuf, this.noise, this.cosDir, this.sinDir, this.radius * (1 - f), this.timeOffset, this.noiseScale * (1 - f), this.distortion * (1 - f), this.referenceRadius)

    // Each rim morphs toward its OWN rounded rect (outer rim -> outer rect,
    // inner rim -> inset rect) so the band keeps its line weight. In place.
    if (eased > 0.0001) {
      morphInPlace(this.outerBuf, this.rectOuter, eased)
      morphInPlace(this.innerBuf, this.rectInner, eased)
    }

    this.builder.updateBand(this.outerBuf, this.innerBuf)
  }
}
