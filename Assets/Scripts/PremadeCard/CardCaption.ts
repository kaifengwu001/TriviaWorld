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

  onAwake() {
    this.logger = new Logger("CardCaption", this.enableLogging || this.enableLoggingLifecycle, true)
    if (this.enableLoggingLifecycle) this.logger.debug("LIFECYCLE: onAwake()")
    if (this.captionText) this.textTrans = this.captionText.getSceneObject().getTransform()
  }

  /** The text visual, so callers can include it when measuring card bounds. */
  getTextVisual(): Text {
    return this.captionText
  }

  /** Shows or hides the caption text object. */
  setVisible(visible: boolean): void {
    if (this.captionText) this.captionText.getSceneObject().enabled = visible
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

    const pos = layout.bottomCenter.sub(layout.up.uniformScale(this.gap))
    this.textTrans.setWorldPosition(pos)
    this.textTrans.setWorldRotation(layout.rotation)
  }
}
