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
import { PlaneBasis, PlaneRect, unionVisualBounds, boundsToRect } from "./PlaneRect"

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

  constructor(private config: CardBackdropConfig) {}

  /** Returns false when the card is gone and this backdrop should be pruned. */
  update(): boolean {
    const basis = this.planeBasis()
    const bounds = unionVisualBounds(this.measuredVisuals(), basis)
    const rect = boundsToRect(bounds, this.config.padding)
    if (!rect) return true

    this.ensureBubble(rect.width, rect.height)
    this.applyRect(basis, rect)
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
  private measuredVisuals(): BaseMeshVisual[] {
    const visuals: BaseMeshVisual[] = [this.config.pictureVisual]
    if (this.captionShown()) visuals.push(this.config.captionVisual)
    return visuals
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
}
