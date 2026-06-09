/**
 * Specs Inc. 2026
 * Card Backdrop – wraps one scanner card (picture + caption) in a rounded rect.
 *
 * Owns a single BubbleMesh driven at full morph (progress = 1, i.e. a rounded
 * rectangle) parented to the scanner so it shares the card's lifetime. It appears
 * immediately around the picture while the user is still cropping, then grows to
 * also enclose the caption text once that has animated in. Every frame it measures
 * the plane extents of whatever is currently shown and resizes the rect to wrap
 * it. The wrapping object is kept at unit (1.0) world scale so the rect's
 * centimetre dimensions render 1:1.
 *
 * BubbleMesh itself is never modified: this only calls its public API
 * (configure / setTargetSize / setProgress / advance).
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger"
import { BubbleMesh } from "../Bubbles/BubbleMesh"
import { easeInOutQuad } from "../Bubbles/ShapeGeometry"
import { colorForTopics, rainbowColor } from "../Interests/TopicColors"
import { PlaneBasis, PlaneBounds, PlaneRect, newBounds, accumulateLocalBox, boundsToRect } from "./PlaneRect"

export interface CardBackdropConfig {
  scannerRoot: SceneObject
  picAnchor: Transform
  pictureVisual: BaseMeshVisual
  captionVisual: BaseMeshVisual
  // Transform whose world scale rises from zero as the caption animates in; used
  // to know when the card is finished and ready to be wrapped.
  captionScaleTransform: Transform
  baseMaterial: Material
  color: vec4
  cornerRadius: number
  padding: number
  backOffset: number
  numPoints: number
  rectLineWidth: number
  innerFraction: number
  fillOpacity: number
  // Returns the card's topics once the AI caption has resolved them, or null
  // while the topic is still unknown. Drives the border color (see updateColor).
  topicsProvider: () => string[] | null
  // Hue cycles per second for the rainbow (and the script-only fallback color).
  rainbowFlowSpeed: number
  // Seconds to cross-fade the border from rainbow to the resolved topic color.
  topicRevealSeconds: number
  // Name of the shader-graph float parameter (0 = rainbow, 1 = solid topic
  // color) on the rainbow material. Empty disables the uniform (script color
  // cycling still drives a plain material). See the graph recipe in this folder.
  revealParam: string
  logger: Logger
}

// The caption is treated as "shown" once its text object has scaled up from zero.
const CAPTION_VISIBLE_SCALE = 0.02
// Re-push the (otherwise static) rect only when its size changes by more than
// this many centimetres, so a settled card costs nothing per frame.
const SIZE_EPSILON = 0.05

export class CardBackdrop {
  private bubble: BubbleMesh = null
  private backdropObj: SceneObject = null
  private lastWidth = 0
  private lastHeight = 0

  // Border color state machine: flow a rainbow while the topic is unknown, then
  // cross-fade once to the resolved topic color and stop.
  private rainbowPhase = 0
  private lastColor: vec4 = null   // most recent color pushed (seeds the fade)
  private transitionT = -1         // <0 = not started; ramps 0->1 during the fade
  private topicColorApplied = false

  constructor(private config: CardBackdropConfig) {}

  /** Returns false when the card is gone and this backdrop should be pruned. */
  update(): boolean {
    const basis = this.planeBasis()
    const bounds = this.measureBounds(basis)
    const rect = boundsToRect(bounds, this.config.padding)
    if (!rect) return true

    this.ensureBubble(rect.width, rect.height)
    this.applyRect(basis, rect)
    this.updateColor(getDeltaTime())
    return true
  }

  destroy(): void {
    if (this.backdropObj) {
      // The backdrop is parented to the scanner root, so when the scanner is
      // destroyed this child dies with it. In that case its native handle is
      // already gone and destroy() throws "Object is null" — guard against it.
      try {
        this.backdropObj.destroy()
      } catch (e) {
        // Already destroyed alongside its parent scanner; nothing to do.
      }
      this.backdropObj = null
      this.bubble = null
    }
  }

  // --- internal --------------------------------------------------------------

  // Always wrap the picture; fold in the caption only once it has animated in.
  // Before that the caption object still sits at its off-screen spawn position,
  // so including it early would stretch the rect far off the card.
  //
  // The picture is measured from its local mesh AABB. The caption is measured from
  // its LIVE getBoundingBox() rather than localAabb: a Text's localAabb does not
  // refresh when its `.text` changes after layout, so a voice-edited caption that
  // grew/shrank would otherwise leave the frame the wrong size. getBoundingBox()
  // reflects the current glyphs (in the text's local units), which the caption's
  // world transform then maps onto the card plane exactly like any other box.
  private measureBounds(basis: PlaneBasis): PlaneBounds {
    const acc = newBounds()

    const pic = this.config.pictureVisual
    const picMatrix = pic.getSceneObject().getTransform().getWorldTransform()
    accumulateLocalBox(acc, pic.localAabbMin(), pic.localAabbMax(), picMatrix, basis)

    if (this.captionShown()) {
      const text = this.config.captionVisual as unknown as Text
      const box = text.getBoundingBox()
      const min = new vec3(box.left, box.bottom, 0)
      const max = new vec3(box.right, box.top, 0)
      const capMatrix = this.config.captionScaleTransform.getWorldTransform()
      accumulateLocalBox(acc, min, max, capMatrix, basis)
    }

    return acc
  }

  private captionShown(): boolean {
    return this.config.captionScaleTransform.getWorldScale().length > CAPTION_VISIBLE_SCALE
  }

  private planeBasis(): PlaneBasis {
    const t = this.config.picAnchor
    return { origin: t.getWorldPosition(), right: t.right, up: t.up }
  }

  // Spawns the wrapping object + BubbleMesh on first ready frame. Parented to the
  // scanner root (which is unit-scaled) so the rect renders at 1:1 centimetres.
  private ensureBubble(width: number, height: number): void {
    if (this.bubble) return

    const obj = global.scene.createSceneObject("CardBackdrop")
    obj.setParent(this.config.scannerRoot)
    obj.layer = this.config.scannerRoot.layer
    this.backdropObj = obj

    const bubble = obj.createComponent(BubbleMesh.getTypeName()) as unknown as BubbleMesh
    bubble.configure({
      baseMaterial: this.config.baseMaterial,
      color: this.config.color,
      progress: 1,
      numPoints: this.config.numPoints,
      radius: Math.max(width, height) * 0.5,
      targetWidth: width,
      targetHeight: height,
      targetCornerRadius: this.config.cornerRadius,
      rectLineWidth: this.config.rectLineWidth,
      innerFraction: this.config.innerFraction,
      fillOpacity: this.config.fillOpacity,
    })

    this.bubble = bubble
    this.lastWidth = width
    this.lastHeight = height
    this.config.logger.info("Spawned card backdrop (" + width.toFixed(1) + " x " + height.toFixed(1) + " cm)")
  }

  private applyRect(basis: PlaneBasis, rect: PlaneRect): void {
    // Place the unit-scaled rect on the shared plane, nudged behind the card
    // along the plane normal so it never z-fights the picture or text.
    const t = this.config.picAnchor
    const center = basis.origin
      .add(basis.right.uniformScale(rect.centerU))
      .add(basis.up.uniformScale(rect.centerV))
      .add(t.forward.uniformScale(this.config.backOffset))

    const trans = this.backdropObj.getTransform()
    trans.setWorldRotation(t.getWorldRotation())
    trans.setWorldPosition(center)
    trans.setWorldScale(vec3.one())

    if (this.sizeChanged(rect.width, rect.height)) {
      this.bubble.setTargetSize(rect.width, rect.height, this.config.cornerRadius)
      this.refreshAtFullMorph()
      this.lastWidth = rect.width
      this.lastHeight = rect.height
    }
  }

  private sizeChanged(width: number, height: number): boolean {
    return (
      Math.abs(width - this.lastWidth) > SIZE_EPSILON ||
      Math.abs(height - this.lastHeight) > SIZE_EPSILON
    )
  }

  // BubbleMesh stops doing per-frame work once it settles on the full-morph rect,
  // so setTargetSize alone won't re-push the resized band. Nudge it off the rest
  // state and straight back within a single frame (the mesh is rebuilt twice
  // before the frame renders, so only the final rect is ever seen) using nothing
  // but BubbleMesh's public API.
  private refreshAtFullMorph(): void {
    this.bubble.setProgress(0)
    this.bubble.advance(0)
    this.bubble.setProgress(1)
    this.bubble.advance(0)
  }

  // Border color, per frame. The signal is whether the AI caption has arrived
  // yet (topicsProvider returns null until it does):
  //   - caption NOT arrived (null) -> flow a rainbow. This is RESERVED for the
  //     capture phase. The script cycles the fill color and, on the rainbow
  //     shader graph, drives reveal=0 so the graph paints a spatially-flowing
  //     rainbow instead of a flat hue.
  //   - caption arrived with a topic -> cross-fade once to the topic color.
  //   - caption arrived but NO topic could be decided ([]) -> cross-fade once to
  //     plain white (never rainbow — rainbow means "still capturing").
  // The fade ramps reveal 0->1 so the graph dissolves the rainbow into the solid
  // final color, then we stop touching the color.
  private updateColor(dt: number): void {
    if (!this.bubble || this.topicColorApplied) return
    const topics = this.config.topicsProvider ? this.config.topicsProvider() : null

    // null = caption still in flight (capturing) -> rainbow is allowed here only.
    if (topics === null) {
      this.rainbowPhase += dt * this.config.rainbowFlowSpeed
      const c = rainbowColor(this.rainbowPhase, this.config.color.a)
      this.lastColor = c
      this.bubble.setColor(c)
      this.setReveal(0)
      return
    }

    // Caption resolved: settle on the topic color, or plain white if no topic.
    this.advanceFinalFade(dt, topics)
  }

  private advanceFinalFade(dt: number, topics: string[]): void {
    const hasTopic = topics.length > 0
    const target = hasTopic
      ? colorForTopics(topics, this.config.color.a)
      : new vec4(1, 1, 1, this.config.color.a) // undecided -> plain white
    if (this.transitionT < 0) {
      // Seed the fade from whatever color we last showed (rainbow during capture,
      // or the target itself if the caption was already present on first frame).
      this.lastColor = this.lastColor ?? target
      this.transitionT = 0
      this.config.logger.info(
        hasTopic
          ? "Card topic resolved: " + topics[0] + " — fading border to topic color."
          : "Card caption arrived with no decidable topic — fading border to white."
      )
    }

    const dur = Math.max(0.0001, this.config.topicRevealSeconds)
    this.transitionT = Math.min(1, this.transitionT + dt / dur)
    const k = easeInOutQuad(this.transitionT)
    this.bubble.setColor(this.lerpColor(this.lastColor, target, k))
    this.setReveal(k)

    if (this.transitionT >= 1) {
      this.bubble.setColor(target)
      this.setReveal(1)
      this.topicColorApplied = true
    }
  }

  // Drives the rainbow material's reveal parameter when present. A plain
  // (non-graph) material has no such parameter; writing it is then a harmless
  // no-op, so the script-side color cycling above still themes the border.
  private setReveal(value: number): void {
    if (!this.config.revealParam) return
    const mat = this.bubble.getMaterial()
    if (!mat) return
    try {
      ;(mat.mainPass as any)[this.config.revealParam] = value
    } catch (e) {
      // Material isn't the rainbow graph (parameter absent); ignore.
    }
  }

  private lerpColor(a: vec4, b: vec4, t: number): vec4 {
    return new vec4(
      a.r + (b.r - a.r) * t,
      a.g + (b.g - a.g) * t,
      a.b + (b.b - a.b) * t,
      a.a + (b.a - a.a) * t
    )
  }
}
