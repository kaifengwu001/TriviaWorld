/**
 * Specs Inc. 2026
 * Card Caption layout for the Premade Card feature.
 *
 * Plays the same role CaptionBehavior plays for captured cards: given a picture
 * of ANY size, it wraps and positions the caption text directly beneath it,
 * keeping a constant vertical gap above the text and horizontal side padding
 * inset from the picture width. Unlike CaptionBehavior it does not animate itself
 * in (the Premade Card controls visibility via its morph); it is laid out from
 * picture geometry supplied by PremadeCard each time the content changes.
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger"

// Everything PremadeCard must hand over to place the caption under the picture.
export interface CaptionLayout {
  text: string
  // World position of the picture's bottom-centre edge.
  bottomCenter: vec3
  // Card plane up axis (unit, world); the caption hangs along -up.
  up: vec3
  // Card world rotation, so the caption stays coplanar with the picture.
  rotation: quat
  // Picture width in world centimetres (the wrap width before side padding).
  width: number
  // Card root uniform world scale — gap is authored in root-local cm and must be
  // converted to world cm when placing the caption (matches remeasureBorder).
  rootScale: number
}

@component
export class CardCaption extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">CardCaption – wraps & positions caption text under a picture of any size</span><br/><span style="color: #94A3B8; font-size: 11px;">Premade-card analog of CaptionBehavior: keeps a constant gap and side padding regardless of picture size.</span>')
  @ui.separator

  @ui.label('<span style="color: #60A5FA;">References</span>')
  @input
  @hint("Text component that displays the caption content.")
  captionText: Text

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Layout</span>')
  @input
  @hint("Vertical gap (cm) between the picture's bottom edge and the top of the caption.")
  gap: number = 1

  @input
  @hint("Horizontal padding (cm) inset on each side from the picture width.")
  sidePadding: number = 1

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Logging</span>')
  @input
  @hint("Enable general logging")
  enableLogging: boolean = false

  @input
  @hint("Enable lifecycle logging (onAwake, onStart, onUpdate, onDestroy)")
  enableLoggingLifecycle: boolean = false

  private logger: Logger
  private textTrans: Transform = null
  // The authored fill alpha, restored whenever the caption is shown.
  private fullAlpha = 1

  onAwake() {
    this.logger = new Logger("CardCaption", this.enableLogging || this.enableLoggingLifecycle, true)
    if (this.enableLoggingLifecycle) this.logger.debug("LIFECYCLE: onAwake()")
    if (this.captionText) {
      this.textTrans = this.captionText.getSceneObject().getTransform()
      this.fullAlpha = this.captionText.textFill.color.a
    }
  }

  /** The text visual, so callers can include it when measuring card bounds. */
  getTextVisual(): Text {
    return this.captionText
  }

  /** The vertical gap (cm) kept between the picture and the caption. */
  getGap(): number {
    return this.gap
  }

  /** The caption text object's world scale, for local-unit conversions. */
  getTextWorldScale(): vec3 {
    return this.textTrans ? this.textTrans.getWorldScale() : vec3.one()
  }

  /** Shows or hides the caption text object (restoring its fill alpha when shown). */
  setVisible(visible: boolean): void {
    if (!this.captionText) return
    if (visible) this.setFillAlpha(this.fullAlpha)
    this.captionText.getSceneObject().enabled = visible
  }

  /**
   * Puts the caption into a "laid out but invisible" state: enabled (so the text
   * engine wraps it and getBoundingBox is valid) with zero fill alpha (so it never
   * draws). Used to measure a collapsed card's true size without any flash.
   */
  beginMeasure(): void {
    if (!this.captionText) return
    this.setFillAlpha(0)
    this.captionText.getSceneObject().enabled = true
  }

  /**
   * The laid-out text bounds in the text's own local units, or (0,0) when empty.
   * Deterministic for a given string + font + wrap width; no rendering required.
   */
  getTextLocalSize(): vec2 {
    if (!this.captionText || this.captionText.text.length === 0) return vec2.zero()
    return this.captionText.getBoundingBox().getSize()
  }

  private setFillAlpha(alpha: number): void {
    const c = this.captionText.textFill.color
    this.captionText.textFill.color = new vec4(c.r, c.g, c.b, alpha)
  }

  /**
   * Wraps and positions the caption beneath a picture of arbitrary size. Mirrors
   * CaptionBehavior.openCaption (minus the scale-in animation): the wrap width is
   * the picture width inset by side padding, and the text is anchored at its top
   * edge a fixed gap below the picture so it grows downward.
   */
  apply(layout: CaptionLayout): void {
    if (!this.captionText || !this.textTrans) {
      this.logger.warn("CardCaption has no captionText; cannot lay out.")
      return
    }

    this.captionText.text = layout.text
    this.captionText.horizontalOverflow = HorizontalOverflow.Wrap
    this.captionText.verticalOverflow = VerticalOverflow.Overflow
    this.captionText.horizontalAlignment = HorizontalAlignment.Center
    this.captionText.verticalAlignment = VerticalAlignment.Top

    // worldSpaceRect is in the text's own local units, so convert the desired
    // world width through the text's world scale. Top of the box sits at the
    // origin so the text grows downward, keeping the gap above it constant.
    const textScale = this.textTrans.getWorldScale().x || 1
    const innerWidth = Math.max(0, layout.width - 2 * this.sidePadding)
    const localHalf = (innerWidth / textScale) * 0.5
    this.captionText.worldSpaceRect = Rect.create(-localHalf, localHalf, -10000, 0)

    // Position the caption ROOT (this component's object), mirroring CaptionBehavior.
    // Pinning the nested Text at a world position accumulated offset under the
    // prefab's scaled AI-Caption parent whenever root scale changed.
    const captionRoot = this.getSceneObject().getTransform()
    const gapWorld = this.gap * (layout.rootScale > 0 ? layout.rootScale : 1)
    const pos = layout.bottomCenter.sub(layout.up.uniformScale(gapWorld))
    captionRoot.setWorldPosition(pos)
    captionRoot.setWorldRotation(layout.rotation)
    this.textTrans.setLocalPosition(vec3.zero())
    this.textTrans.setLocalRotation(quat.quatIdentity())
  }
}
