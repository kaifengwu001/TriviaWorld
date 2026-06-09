/**
 * Specs Inc. 2026
 * Caption Behavior component for the Crop Spectacles lens.
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger";
import animate, {CancelSet} from "SpectaclesInteractionKit.lspkg/Utils/animate"
import { TypewriterText } from "./TypewriterText"
import { sanitizeCaption } from "./Cards/CardEditTools"

// World scale applied to the caption root. Defines the rendered text size and is
// also the conversion factor between world units and the text's local layout units.
const CAPTION_SCALE = 0.665

@component
export class CaptionBehavior extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">CaptionBehavior – displays AI caption text with scale-in animation</span><br/><span style="color: #94A3B8; font-size: 11px;">Receives caption text, a world position/rotation and the picture width, then wraps the text to that width and animates it into view.</span>')
  @ui.separator

  @ui.label('<span style="color: #60A5FA;">References</span>')
  @input
  @hint("Text component that displays the caption content")
  captionText: Text

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Layout</span>')
  @input
  @hint("Vertical gap (cm) between the picture's bottom edge and the top of the caption")
  gap: number = 1

  @input
  @hint("Horizontal padding (cm) inset on each side from the picture width")
  sidePadding: number = 1

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Logging</span>')
  @input
  @hint("Enable general logging")
  enableLogging: boolean = false;

  @input
  @hint("Enable lifecycle logging (onAwake, onStart, onUpdate, onDestroy)")
  enableLoggingLifecycle: boolean = false;

  private logger: Logger;

  private trans: Transform
  private textTrans: Transform

  private scaleCancel: CancelSet = new CancelSet()

  // The caption text currently shown, kept in sync with typewriter edits so the
  // voice agent can read it back when composing an append.
  private currentText: string = ""
  private typewriter: TypewriterText

  onAwake() {
    this.logger = new Logger("CaptionBehavior", this.enableLogging || this.enableLoggingLifecycle, true);
    if (this.enableLoggingLifecycle) this.logger.debug("LIFECYCLE: onAwake()");
    this.trans = this.getSceneObject().getTransform()
    this.textTrans = this.captionText.getSceneObject().getTransform()
    this.textTrans.setLocalScale(vec3.zero())

    // Typewriter for in-place caption edits (rewrite/append). It only mutates the
    // text string; the wrap width/position set in openCaption stay valid because the
    // text is top-anchored and grows downward. The host owns the update tick.
    this.typewriter = new TypewriterText({
      getText: () => this.captionText.text,
      setText: (s: string) => { this.captionText.text = s },
    })
    this.createEvent("UpdateEvent").bind((ev) => {
      this.typewriter.tick(ev.getDeltaTime())
    })
  }

  /** The caption text currently shown (reflects any typewriter edits in progress). */
  getText(): string {
    return this.currentText
  }

  /**
   * Animates the caption from its current text to `target` with a typewriter
   * "delete then type" effect. Used by the voice agent to rewrite a misread caption
   * or append an interesting detail surfaced in conversation.
   */
  animateTextTo(target: string): void {
    const clean = sanitizeCaption(target)
    this.currentText = clean
    this.typewriter.animateTo(clean)
  }

  openCaption(text: string, pos: vec3, rot: quat, pictureWidth: number) {
    this.captionText.text = text
    this.currentText = text

    // Wrap the caption to the picture width (minus side padding) and anchor it at the
    // top edge so it grows downward, keeping the gap above the caption constant.
    this.captionText.horizontalOverflow = HorizontalOverflow.Wrap
    this.captionText.verticalOverflow = VerticalOverflow.Overflow
    this.captionText.horizontalAlignment = HorizontalAlignment.Center
    this.captionText.verticalAlignment = VerticalAlignment.Top

    // worldSpaceRect is expressed in the text object's local units, so convert the
    // desired world width through CAPTION_SCALE. Top of the box sits at the origin.
    const worldHalfWidth = Math.max(0, pictureWidth * 0.5 - this.sidePadding)
    const localHalfWidth = worldHalfWidth / CAPTION_SCALE
    this.captionText.worldSpaceRect = Rect.create(-localHalfWidth, localHalfWidth, -10000, 0)
    print(
      "[CAPTION-DEBUG] openCaption: sidePadding=" + this.sidePadding +
      " pictureWidth=" + pictureWidth +
      " worldHalfWidth=" + worldHalfWidth +
      " localHalfWidth=" + localHalfWidth +
      " pos=" + pos.toString()
    )

    this.trans.setWorldPosition(pos)
    this.trans.setWorldRotation(rot)
    this.trans.setWorldScale(vec3.one().uniformScale(CAPTION_SCALE))

    //animate in caption
    if (this.scaleCancel) this.scaleCancel.cancel()
    animate({
      easing: "ease-out-elastic",
      duration: 1,
      update: (t: number) => {
        this.textTrans.setLocalScale(vec3.lerp(vec3.zero(), vec3.one(), t))
      },
      ended: null,
      cancelSet: this.scaleCancel
    })
  }
}
