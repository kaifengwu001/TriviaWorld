/**
 * Specs Inc. 2026
 * Premade Card for the Crop Spectacles lens.
 *
 * A self-contained demo card that looks exactly like a captured card (it reuses
 * the same CaptureVisual picture material and the same BubbleMesh border) but is
 * populated manually instead of by capture/AI. A future CardPrefabController can
 * drive a few dozen of these by calling the public API: setImage / setImageWidth
 * / setText / setBorderColor, plus expand / collapse / toggle.
 *
 * Behaviour:
 *   - The border is a BubbleMesh. Driving its morph 0..1 transforms a bubble
 *     (blob) into the card (rounded rect). The picture and text are shown once
 *     the morph is open enough, and hidden as it shrinks back to a bubble.
 *   - The picture is shown at the image's true aspect ratio for a configurable
 *     width (CardCaption re-wraps the text to whatever width results).
 *   - With Auto Fit Border on, the border is sized to wrap the picture + text.
 *   - The card billboards toward the camera, and (optionally) starts as a bubble
 *     and expands when the player gazes at it for a dwell time.
 *
 * BubbleMesh is reused unchanged through its public API. The CaptureVisual
 * material is cloned per card so each card carries its own image.
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger"
import { BubbleMesh } from "../Bubbles/BubbleMesh"
import { CardMorph } from "./CardMorph"
import { CardCaption } from "./CardCaption"
import { measureLocalRect } from "./CardLayout"

// Frames to wait after content changes before measuring, so the text component
// has a chance to lay out before its bounds are read.
const MEASURE_DELAY_FRAMES = 2

// Render order applied to a card's visuals while it is pulled to the front as a
// query result (cosmos cards keep the default order 0), so results draw on top.
const RESULT_RENDER_ORDER = 100

@component
export class PremadeCard extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">PremadeCard – a manually-populated card that morphs to/from a bubble</span><br/><span style="color: #94A3B8; font-size: 11px;">Reuses the CaptureVisual material and the BubbleMesh border. Assign image / text / border color via the inspector or the public API.</span>')
  @ui.separator

  @ui.label('<span style="color: #60A5FA;">References</span>')
  @input
  @hint("The BubbleMesh that draws the border. Must be a DIRECT child of this card root. Its blob <-> rect morph is what becomes the bubble/card.")
  borderBubble: BubbleMesh

  @input
  @hint("Picture quad RenderMeshVisual using the CaptureVisual material. Its material is cloned per card so each shows its own image.")
  pictureVisual: RenderMeshVisual

  @input
  @hint("CardCaption that wraps and positions the caption text under the picture.")
  caption: CardCaption

  @input
  @hint("Camera the card billboards toward and uses for gaze detection. If unset, billboarding and gaze are disabled.")
  @allowUndefined
  cameraObject: SceneObject

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Content (defaults)</span>')
  @input
  @hint("Image shown on the picture quad (assigned to the cloned material's captureImage). Displayed at its true aspect ratio.")
  @allowUndefined
  defaultImage: Texture

  @input
  @hint("Displayed image width in cm. Height follows from the image's aspect ratio. Settable at runtime with setImageWidth().")
  imageWidth: number = 13.3

  @input
  @hint("Caption text shown under the picture.")
  defaultText: string = "Premade card caption."

  @input
  @hint("Border color (RGBA) applied to the BubbleMesh border.")
  borderColor: vec4 = new vec4(1.0, 1.0, 1.0, 1.0)

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Border Fit</span>')
  @input
  @hint("Size the border to wrap the picture + text automatically. Turn off to use the size authored on the BubbleMesh component.")
  autoFitBorder: boolean = true

  @input
  @hint("Padding (cm) added around the picture + text when Auto Fit Border is on.")
  borderPadding: number = 1.5

  @input
  @hint("Distance (cm) to push the border behind the content so it never z-fights the picture or text.")
  backOffset: number = 0.3

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Morph</span>')
  @input
  @hint("Start as an open card (true) or a collapsed bubble (false). Forced to bubble when Gaze To Expand is on.")
  startExpanded: boolean = true

  @input
  @hint("Seconds for a full bubble <-> card morph.")
  morphDuration: number = 0.5

  @input
  @hint("Morph value (0..1) at/above which the picture and text are shown.")
  showThreshold: number = 0.9

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Gaze To Expand</span>')
  @input
  @hint("Start as a bubble and expand into a card after the player gazes at it for the dwell time.")
  gazeToExpand: boolean = true

  @input
  @hint("Seconds the player must gaze at the bubble before it expands.")
  gazeDwell: number = 1.0

  @input
  @hint("Half-angle (degrees) of the gaze cone around the camera's view centre that counts as 'looking at' the card.")
  gazeConeAngleDeg: number = 12

  @input
  @hint("Collapse back into a bubble when the player looks away.")
  collapseWhenGazeLost: boolean = false

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Billboard</span>')
  @input
  @hint("Rotate the card to face the camera every frame.")
  billboard: boolean = true

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Logging</span>')
  @input
  @hint("Enable general logging")
  enableLogging: boolean = false

  @input
  @hint("Enable lifecycle logging (onAwake, onStart, onUpdate, onDestroy)")
  enableLoggingLifecycle: boolean = false

  private logger: Logger
  private trans: Transform = null
  private camTrans: Transform = null
  private morph: CardMorph = null
  private started = false
  private ownershipTaken = false
  private lastContentVisible = false
  // > 0 while a measure pass is pending (content forced visible until it fires).
  private measureCountdown = -1
  // Auto-fit bookkeeping: only measure while content is genuinely shown, so a
  // card that starts (or sits) as a bubble never flashes its content.
  private measuredOnce = false
  private needsMeasure = false
  // Gaze dwell accumulator + precomputed cone cosine.
  private gazeTimer = 0
  private gazeCosThreshold = -1

  private currentImage: Texture = null
  private currentText: string = ""

  onAwake() {
    this.logger = new Logger("PremadeCard", this.enableLogging || this.enableLoggingLifecycle, true)
    if (this.enableLoggingLifecycle) this.logger.debug("LIFECYCLE: onAwake()")

    this.trans = this.getSceneObject().getTransform()
    if (this.cameraObject) this.camTrans = this.cameraObject.getTransform()

    // Clone the shared CaptureVisual material so this card owns its own image,
    // then stash the inspector defaults. Layout waits for onStart so the other
    // components (BubbleMesh, CardCaption) have finished their own onAwake.
    this.clonePictureMaterial()
    this.currentImage = this.defaultImage
    this.currentText = this.defaultText
    this.applyImageMaterial(this.currentImage)

    this.createEvent("OnStartEvent").bind(() => this.onStart())
    this.createEvent("UpdateEvent").bind(() => this.update(getDeltaTime()))
  }

  private onStart(): void {
    const startExpanded = this.gazeToExpand ? false : this.startExpanded
    this.gazeCosThreshold = Math.cos((Math.max(0, this.gazeConeAngleDeg) * Math.PI) / 180)

    this.takeBorderOwnership(startExpanded)
    this.morph = new CardMorph(startExpanded ? 1 : 0, this.morphDuration, this.showThreshold)
    this.lastContentVisible = this.morph.contentVisible
    this.started = true

    this.billboardNow()
    this.relayoutContent()
    this.applyContentVisibility(this.lastContentVisible)
    // Measure now only if content is already shown; otherwise defer to first open
    // so a collapsed card never flashes its content.
    if (this.lastContentVisible) this.beginMeasurePass()
    else this.needsMeasure = true
  }

  // --- public API ------------------------------------------------------------

  /** Sets the card image; the picture resizes to the image's aspect ratio. */
  setImage(texture: Texture): void {
    this.currentImage = texture
    this.applyImageMaterial(texture)
    if (this.started) this.relayoutContent()
  }

  /** Sets the displayed image width (cm); height follows the aspect ratio. */
  setImageWidth(width: number): void {
    this.imageWidth = width
    if (this.started) this.relayoutContent()
  }

  /** Sets the caption text and re-wraps + re-fits around it. */
  setText(text: string): void {
    this.currentText = text
    if (this.started) this.relayoutContent()
  }

  /** Sets the border color on the BubbleMesh border. */
  setBorderColor(color: vec4): void {
    this.borderColor = color
    if (this.borderBubble) this.borderBubble.setColor(color)
  }

  /** Animate open into a card. */
  expand(): void {
    if (this.morph) this.morph.expand()
  }

  /** Animate closed into a bubble. */
  collapse(): void {
    if (this.morph) this.morph.collapse()
  }

  /** Toggle between card and bubble. */
  toggle(): void {
    if (this.morph) this.morph.toggle()
  }

  setExpanded(expanded: boolean): void {
    if (this.morph) this.morph.setExpanded(expanded)
  }

  /** True once the card has morphed open enough to be showing its content. */
  isExpanded(): boolean {
    return !!this.morph && this.morph.contentVisible
  }

  /**
   * (Re)assigns the camera used for billboarding + gaze. Useful for cards
   * instantiated from a prefab at runtime, whose baked camera reference may not
   * resolve; the controller can pass the live camera in after instantiate.
   */
  setCamera(camera: SceneObject): void {
    this.cameraObject = camera
    this.camTrans = camera ? camera.getTransform() : null
  }

  /**
   * Forces this whole card (picture + border + caption) to draw on top of the
   * rest of the scene (depthTest off + raised render order) when `enabled`, and
   * restores normal depth sorting when off. The CardDeckController turns this on
   * for query-result cards so they stay readable in front of the drifting cosmos,
   * and off again when they return to the shell.
   */
  setRenderInFront(enabled: boolean): void {
    const order = enabled ? RESULT_RENDER_ORDER : 0
    if (this.pictureVisual) {
      ;(this.pictureVisual as any).renderOrder = order
      ;(this.pictureVisual.mainPass as any).depthTest = !enabled
    }
    if (this.borderBubble) this.borderBubble.setRenderInFront(enabled, order)
    const textVisual = this.caption ? this.caption.getTextVisual() : null
    if (textVisual) (textVisual as any).renderOrder = order
  }

  /** Jump to the card/bubble end state with no animation. */
  snapExpanded(expanded: boolean): void {
    if (!this.morph) return
    this.morph.snap(expanded)
    this.lastContentVisible = this.morph.contentVisible
    this.applyContentVisibility(this.lastContentVisible)
  }

  // --- internal --------------------------------------------------------------

  private update(dt: number): void {
    this.billboardNow()
    if (!this.morph) return

    if (this.gazeToExpand && this.camTrans) this.updateGaze(dt)

    this.morph.step(dt)
    if (this.borderBubble && this.ownershipTaken) {
      this.borderBubble.setProgress(this.morph.progress)
      this.borderBubble.advance(dt)
    }

    // While a measure pass is pending, keep content forced-visible (set in
    // beginMeasurePass) so the text lays out, then measure and restore.
    if (this.measureCountdown > 0) {
      this.measureCountdown--
      if (this.measureCountdown === 0) {
        this.remeasureBorder()
        this.lastContentVisible = this.morph.contentVisible
        this.applyContentVisibility(this.lastContentVisible)
      }
      return
    }

    const visible = this.morph.contentVisible
    if (visible !== this.lastContentVisible) {
      this.applyContentVisibility(visible)
      this.lastContentVisible = visible
      // Now that content is genuinely shown, fit the border if it's pending.
      if (visible && (this.needsMeasure || !this.measuredOnce)) this.beginMeasurePass()
    }
  }

  // Expands after the camera's view centre has stayed within the gaze cone of the
  // card for the dwell time. The project's camera looks along -forward.
  private updateGaze(dt: number): void {
    const camPos = this.camTrans.getWorldPosition()
    const viewDir = this.camTrans.forward.uniformScale(-1)
    const toCard = this.trans.getWorldPosition().sub(camPos)
    const dist = toCard.length
    if (dist < 1e-3) return

    const cosAngle = toCard.dot(viewDir) / dist
    if (cosAngle >= this.gazeCosThreshold) {
      this.gazeTimer += dt
      if (this.gazeTimer >= this.gazeDwell) this.morph.expand()
    } else {
      this.gazeTimer = 0
      if (this.collapseWhenGazeLost) this.morph.collapse()
    }
  }

  // Resizes the picture to the image aspect, re-lays the caption beneath it, and
  // queues a border re-fit. Called whenever image, width, or text changes.
  private relayoutContent(): void {
    this.resizePicture()
    if (this.caption) this.caption.apply(this.pictureGeometryToCaption())
    this.scheduleMeasure()
  }

  private resizePicture(): void {
    if (!this.pictureVisual) return
    const aspect = this.imageAspect()
    const width = this.imageWidth > 0 ? this.imageWidth : 1
    const height = width / aspect
    const pTrans = this.pictureVisual.getSceneObject().getTransform()
    pTrans.setLocalPosition(vec3.zero())
    pTrans.setLocalScale(new vec3(width, height, 1))
  }

  private imageAspect(): number {
    const tex = this.currentImage
    if (!tex) return 1
    const w = tex.getWidth()
    const h = tex.getHeight()
    return w > 0 && h > 0 ? w / h : 1
  }

  // Builds the world-space picture geometry CardCaption needs to place the text.
  private pictureGeometryToCaption() {
    const pTrans = this.pictureVisual.getSceneObject().getTransform()
    const pScale = pTrans.getWorldScale()
    const up = this.trans.up
    const bottomCenter = pTrans.getWorldPosition().sub(up.uniformScale(pScale.y * 0.5))
    return {
      text: this.currentText,
      bottomCenter,
      up,
      rotation: this.trans.getWorldRotation(),
      width: pScale.x,
    }
  }

  private clonePictureMaterial(): void {
    if (this.pictureVisual && this.pictureVisual.mainMaterial) {
      this.pictureVisual.mainMaterial = this.pictureVisual.mainMaterial.clone()
    }
  }

  private applyImageMaterial(texture: Texture): void {
    if (texture && this.pictureVisual) {
      ;(this.pictureVisual.mainPass as any).captureImage = texture
    }
  }

  // Takes control of the border BubbleMesh so it stops self-ticking and we drive
  // its morph. Omits size so the BubbleMesh's authored width/height/cornerRadius/
  // line width are kept; auto-fit (if on) resizes it afterwards.
  private takeBorderOwnership(startExpanded: boolean): void {
    if (!this.borderBubble) {
      this.logger.warn("No borderBubble assigned; card cannot morph.")
      return
    }
    this.borderBubble.configure({
      progress: startExpanded ? 1 : 0,
      color: this.borderColor,
    })
    this.ownershipTaken = true
  }

  private scheduleMeasure(): void {
    if (!this.autoFitBorder) return
    if (this.lastContentVisible) this.beginMeasurePass()
    else this.needsMeasure = true
  }

  private beginMeasurePass(): void {
    if (!this.autoFitBorder || !this.borderBubble) return
    // Force content visible so the text lays out, then measure a few frames later.
    this.applyContentVisibility(true)
    this.measureCountdown = MEASURE_DELAY_FRAMES
  }

  private remeasureBorder(): void {
    if (!this.autoFitBorder || !this.borderBubble || !this.trans) return
    const textVisual = this.caption ? this.caption.getTextVisual() : null
    const rootInv = this.trans.getInvertedWorldTransform()
    const rect = measureLocalRect([this.pictureVisual, textVisual], rootInv, this.borderPadding)
    if (!rect) return

    const borderTrans = this.borderBubble.getSceneObject().getTransform()
    borderTrans.setLocalPosition(new vec3(rect.centerX, rect.centerY, -this.backOffset))
    borderTrans.setLocalRotation(quat.quatIdentity())
    borderTrans.setLocalScale(vec3.one())

    this.borderBubble.setTargetSize(rect.width, rect.height)
    this.refreshBorderAtCurrentProgress()
    this.measuredOnce = true
    this.needsMeasure = false
    this.logger.info("Fit border to " + rect.width.toFixed(1) + " x " + rect.height.toFixed(1) + " cm")
  }

  // BubbleMesh skips per-frame work once settled on the full-morph rect, so a
  // resize won't show until it's nudged off the rest state. Rebuild it twice in
  // one frame (only the final shape is ever rendered) via the public API.
  private refreshBorderAtCurrentProgress(): void {
    const p = this.morph ? this.morph.progress : 1
    this.borderBubble.setProgress(0)
    this.borderBubble.advance(0)
    this.borderBubble.setProgress(p)
    this.borderBubble.advance(0)
  }

  private billboardNow(): void {
    if (this.billboard && this.camTrans && this.trans) {
      this.trans.setWorldRotation(quat.lookAt(this.camTrans.forward, vec3.up()))
    }
  }

  private applyContentVisibility(visible: boolean): void {
    if (this.pictureVisual) this.pictureVisual.getSceneObject().enabled = visible
    if (this.caption) this.caption.setVisible(visible)
  }
}
