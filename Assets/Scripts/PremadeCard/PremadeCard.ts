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

// Frames to wait after content changes before reading the text bounds, so the
// text engine has laid the (invisibly-enabled) text out before it is measured.
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
  // > 0 while a measure pass is pending. The text is laid out invisibly during
  // this window, so a collapsed card is measured without ever flashing.
  private measureCountdown = -1
  // Gaze dwell accumulator + precomputed cone cosine.
  private gazeTimer = 0
  private gazeCosThreshold = -1

  private currentImage: Texture = null
  private currentText: string = ""

  // True card footprint in root-local cm (border width/height from the last
  // auto-fit). Scale-invariant: multiply by the card's world scale to get the
  // real world size. The CardDeckController reads these for accurate packing.
  private contentLocalW = 0
  private contentLocalH = 0
  private contentMeasured = false

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
    // Establish the base visibility, then lay out + measure. Because the text is
    // measured invisibly and the picture size is computed, the border target is
    // known before the first morph, so the bubble -> card animation never snaps.
    this.applyContentVisibility(this.lastContentVisible)
    this.relayoutContent()
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
   * The card's true footprint (width, height) in root-local cm, taken from the
   * last auto-fit border pass. Scale-invariant — multiply by the card's world
   * scale to get the real world size. Valid only after isContentMeasured().
   */
  getContentLocalSize(): vec2 {
    return new vec2(this.contentLocalW, this.contentLocalH)
  }

  /** True once the border has been auto-fit at least once (footprint is known). */
  isContentMeasured(): boolean {
    return this.contentMeasured
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

  /**
   * Sets an explicit draw order on every visual sub-part of the card, keeping
   * depthTest off so it stays above the depth-tested cosmos shell. Used by the
   * CoverFlow deck to layer overlapping result cards by distance from centre
   * (cards nearer the centre get a higher order so they draw in front).
   */
  setRenderOrder(order: number): void {
    if (this.pictureVisual) {
      ;(this.pictureVisual as any).renderOrder = order
      ;(this.pictureVisual.mainPass as any).depthTest = false
    }
    if (this.borderBubble) this.borderBubble.setRenderInFront(true, order)
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

    // While a measure pass is pending, the text is laid out invisibly. Once it
    // has settled, read its bounds, fit the border, and apply real visibility.
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
    if (!this.pictureVisual || !this.trans) return
    const aspect = this.imageAspect()
    const width = this.imageWidth > 0 ? this.imageWidth : 1
    const height = width / aspect
    const pTrans = this.pictureVisual.getSceneObject().getTransform()
    pTrans.setLocalScale(new vec3(width, height, 1))
    // Center the picture on the card root in WORLD space. The picture may sit
    // under a scaled/offset anchor in the prefab; setting world position here
    // neutralizes that anchor offset so the picture (and the caption hung below
    // it) are centered on the card instead of drifting to one side.
    pTrans.setWorldPosition(this.trans.getWorldPosition())
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
    if (!this.autoFitBorder || !this.borderBubble) return
    // If the content is already visible (open card), it's laid out and measures
    // live. If it's hidden (bubble), enable the caption invisibly so its bounds
    // are valid without anything flashing. The picture never needs enabling: its
    // size is computed from the image aspect.
    if (!this.lastContentVisible && this.caption) this.caption.beginMeasure()
    this.measureCountdown = MEASURE_DELAY_FRAMES
  }

  // Fits the border by taking the picture's true footprint (from its world
  // scale, centered on the root) and unioning it with the invisibly-measured
  // text rect placed a gap below. No content ever has to become visible.
  private remeasureBorder(): void {
    if (!this.autoFitBorder || !this.borderBubble || !this.trans) return

    const picture = this.pictureLocalSize()
    const halfPW = picture.x * 0.5
    const halfPH = picture.y * 0.5

    let left = -halfPW
    let right = halfPW
    let top = halfPH
    let bottom = -halfPH

    const text = this.textLocalSize()
    if (text.y > 0) {
      const halfTW = text.x * 0.5
      left = Math.min(left, -halfTW)
      right = Math.max(right, halfTW)
      // Text hangs a gap below the picture and grows downward.
      bottom = -halfPH - this.captionGap() - text.y
    }

    const pad = this.borderPadding
    const width = right - left + 2 * pad
    const height = top - bottom + 2 * pad
    const centerX = (left + right) * 0.5
    const centerY = (top + bottom) * 0.5

    const borderTrans = this.borderBubble.getSceneObject().getTransform()
    borderTrans.setLocalPosition(new vec3(centerX, centerY, -this.backOffset))
    borderTrans.setLocalRotation(quat.quatIdentity())
    borderTrans.setLocalScale(vec3.one())

    this.borderBubble.setTargetSize(width, height)
    this.refreshBorderAtCurrentProgress()
    // Record the true footprint (root-local cm) for the deck's packing.
    this.contentLocalW = width
    this.contentLocalH = height
    this.contentMeasured = true
    this.logger.info("Fit border to " + width.toFixed(1) + " x " + height.toFixed(1) + " cm")
  }

  // Picture footprint in the card root's local cm. Derived from the picture's
  // actual world scale (which already includes any parent anchor scale, e.g. the
  // prefab's x10 ImageAnchor) divided by the root scale, so the border wraps the
  // truly-displayed picture rather than the raw imageWidth. The picture is a unit
  // quad, so its world scale equals its world size.
  private pictureLocalSize(): vec2 {
    const fallback = this.imageWidth > 0 ? this.imageWidth : 1
    if (!this.pictureVisual || !this.trans) return new vec2(fallback, fallback / this.imageAspect())
    const pScale = this.pictureVisual.getSceneObject().getTransform().getWorldScale()
    const rootScale = this.trans.getWorldScale()
    const w = rootScale.x !== 0 ? pScale.x / rootScale.x : pScale.x
    const h = rootScale.y !== 0 ? pScale.y / rootScale.y : pScale.y
    return new vec2(w, h)
  }

  private captionGap(): number {
    return this.caption ? this.caption.getGap() : 0
  }

  // Converts the caption's text bounds (text-local units) into the card root's
  // local cm via the text's scale relative to the root. Returns (0,0) if absent.
  private textLocalSize(): vec2 {
    if (!this.caption) return vec2.zero()
    const local = this.caption.getTextLocalSize()
    if (local.x <= 0 || local.y <= 0) return vec2.zero()
    const rootScale = this.trans.getWorldScale()
    const textScale = this.caption.getTextWorldScale()
    const fx = rootScale.x !== 0 ? textScale.x / rootScale.x : 1
    const fy = rootScale.y !== 0 ? textScale.y / rootScale.y : 1
    return new vec2(local.x * fx, local.y * fy)
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
