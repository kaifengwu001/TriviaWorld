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
import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import { BubbleMesh } from "../Bubbles/BubbleMesh"
import { CardMorph } from "./CardMorph"
import { CardCaption } from "./CardCaption"
import { CardEditTarget } from "../Cards/CardEditTools"

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
  // Rotational deadzone (deg) for the billboard: the card holds its facing until the
  // direction to the camera has changed by more than this, then re-aims. 0 = re-aim
  // every frame. Set per-instance via setBillboardDeadzone (e.g. by PingCardSpawner).
  private billboardDeadzoneDeg = 0
  // Last rotation actually written by the billboard, for the deadzone comparison.
  private lastBillboardRot: quat | null = null
  private started = false
  private ownershipTaken = false
  private lastContentVisible = false
  // > 0 while a measure pass is pending. The text is laid out invisibly during
  // this window, so a collapsed card is measured without ever flashing.
  private measureCountdown = -1
  // While true the card draws nothing (picture + border + caption suppressed) but
  // still measures, so a deck can size + place it before it is ever shown. Cleared
  // by reveal(). See hideUntilReady().
  private hiddenUntilReady = false
  // Gaze dwell accumulator + precomputed cone cosine.
  private gazeTimer = 0
  private gazeCosThreshold = -1

  // Tap-to-engage (opt-in, used only by PingCardSpawner's discovered cards): once
  // the card has opened, a tap hands its caption to global.cardVoiceAgent. Gated so
  // the cosmos / CoverFlow PremadeCards (driven by CardQueryVoiceAgent) are unaffected.
  // The tap target is enabled ONLY while the card is the gaze-selected one, so an
  // open card sitting in the FOV never steals taps meant for other cards.
  private engageOnTap = false
  private cardTappable = false
  private tapCollider: ColliderComponent = null
  private tapInteractable: Interactable = null
  private tapEnabled = false

  private currentImage: Texture = null
  private currentText: string = ""

  // True card footprint in root-local cm (border width/height from the last
  // auto-fit). Scale-invariant: multiply by the card's world scale to get the
  // real world size. The CardDeckController reads these for accurate packing.
  private contentLocalW = 0
  private contentLocalH = 0
  // Centre of the border (and thus the visible card) in the card root's local cm.
  // The picture sits at the root origin and the caption hangs below it, so the
  // border is re-centred at a negative Y — anything placing UI off the card's
  // edges must offset by this centre, not by the root origin.
  private contentLocalCX = 0
  private contentLocalCY = 0
  private contentMeasured = false
  // Last root world scale we laid out at; triggers a re-sync when the deck animates
  // card scale (gaze boost, CoverFlow easeWorldScale) without calling setImageWidth.
  private lastLayoutRootScale = -1

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

  /**
   * The current image's aspect ratio (width / height), or 1 when no image / a
   * degenerate texture. Lets a caller size by HEIGHT (width = height * aspect)
   * since the card is sized via setImageWidth().
   */
  getImageAspect(): number {
    return this.imageAspect()
  }

  /** Sets the caption text and re-wraps + re-fits around it. */
  setText(text: string): void {
    this.currentText = text
    if (this.started) this.relayoutContent()
  }

  /** The card's current caption text (for the voice agent / card buttons). */
  getText(): string {
    return this.currentText
  }

  /**
   * Holds the card fully invisible (picture + border + caption) while it keeps
   * measuring, so a deck can size + place it before it ever draws — avoiding a flash
   * at the default transform. Call reveal() once the card is positioned. Safe before
   * onStart: the flag is honoured when onStart establishes the base visibility.
   */
  hideUntilReady(): void {
    this.hiddenUntilReady = true
    if (this.started) this.applyContentVisibility(this.lastContentVisible)
  }

  /** Reveals a card held by hideUntilReady(), showing it at its current transform. */
  reveal(): void {
    if (!this.hiddenUntilReady) return
    this.hiddenUntilReady = false
    if (this.borderBubble) this.borderBubble.setVisible(true)
    this.applyContentVisibility(this.morph ? this.morph.contentVisible : this.lastContentVisible)
  }

  /**
   * Opt this card into tap-to-engage: once it has opened (gaze-expanded) a tap
   * hands its caption to the CardVoiceAgent for a conversation. Called by
   * PingCardSpawner for prayer-gesture-discovered cards only; cosmos / CoverFlow
   * cards never call this, so they stay non-engageable.
   */
  enableTapToEngage(): void {
    this.engageOnTap = true
  }

  /**
   * The card's top-left corner + plane basis (world space), so AgentSphere can
   * perch the orb on it (duck-typed: AgentSphere only needs getCardFrame). Built
   * from the billboarded transform and the measured footprint; returns null until
   * the border has been auto-fit at least once (footprint unknown before then).
   * Corner is the top-left; normal points toward the camera. Mirrors the role of
   * PictureBehavior.getCardFrame for captured cards.
   */
  getCardFrame(): { corner: vec3; right: vec3; up: vec3; normal: vec3; width: number; height: number } | null {
    if (!this.trans || !this.contentMeasured) return null
    const wp = this.trans.getWorldPosition()
    const right = this.trans.right
    const up = this.trans.up
    const normal = this.camTrans
      ? this.camTrans.getWorldPosition().sub(wp).normalize()
      : right.cross(up).normalize()
    const s = this.trans.getWorldScale()
    const center = wp
      .add(right.uniformScale(this.contentLocalCX * s.x))
      .add(up.uniformScale(this.contentLocalCY * s.y))
    const halfW = this.contentLocalW * 0.5 * s.x
    const halfH = this.contentLocalH * 0.5 * s.y
    const corner = center.sub(right.uniformScale(halfW)).add(up.uniformScale(halfH))
    // World-space dimensions so AgentSubtitle can cap its width to the card.
    return { corner, right, up, normal, width: halfW * 2, height: halfH * 2 }
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
   * Linear morph value in [0, 1]: 0 = a fully-closed bubble, 1 = a fully-open
   * card. Anything above 0 means the bubble has begun (or finished) transforming.
   */
  getMorphProgress(): number {
    return this.morph ? this.morph.progress : 0
  }

  /**
   * The card's true footprint (width, height) in root-local cm, taken from the
   * last auto-fit border pass. Scale-invariant — multiply by the card's world
   * scale to get the real world size. Valid only after isContentMeasured().
   */
  getContentLocalSize(): vec2 {
    return new vec2(this.contentLocalW, this.contentLocalH)
  }

  /**
   * The centre of the visible card (border) in root-local cm. The picture sits
   * at the root origin and the caption hangs below, so this Y is usually
   * negative. Combine with getContentLocalSize() to find the card's true edges
   * (e.g. top-right corner = centre + size/2). Valid after isContentMeasured().
   */
  getContentLocalCenter(): vec2 {
    return new vec2(this.contentLocalCX, this.contentLocalCY)
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
   * Sets the billboard's rotational deadzone (degrees): the card stops re-aiming
   * every frame and instead holds its facing until the direction to the camera has
   * changed by more than this angle. Generous values (8-20) make a field of cards
   * visually steady and skip the per-frame quat write. 0 = re-aim every frame.
   */
  setBillboardDeadzone(deg: number): void {
    this.billboardDeadzoneDeg = Math.max(0, deg)
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

    // Root scale changes (gaze boost, CoverFlow easeWorldScale) without a setImageWidth
    // call used to leave caption + picture on diverging world-space anchors; re-sync.
    this.syncLayoutIfScaleChanged()

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
      // The card just opened: if it opted into tap-to-engage, make it a tap target
      // now (closed bubbles stay non-tappable — gaze still opens them).
      if (visible && this.engageOnTap && !this.cardTappable) this.makeCardTappable()
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
    const gazing = cosAngle >= this.gazeCosThreshold
    if (gazing) {
      this.gazeTimer += dt
      if (this.gazeTimer >= this.gazeDwell) this.morph.expand()
    } else {
      this.gazeTimer = 0
      if (this.collapseWhenGazeLost) this.morph.collapse()
    }
    // Only the gaze-selected card is a live tap target, so an open card lingering
    // in the FOV never intercepts pinches meant for a captured card elsewhere.
    if (this.cardTappable) this.setTapEnabled(gazing)
  }

  // Adds an explicit-size box collider + Interactable on the card ROOT so a
  // pinch/point-tap engages the voice agent. Sized from the measured footprint
  // (NOT fitVisual on a nested mesh — SIK rays miss tiny/far/nested colliders;
  // an explicit box on the root mirrors GlobeController.addBoxCollider). The box
  // is centred on the root origin but grown to cover the caption that hangs below.
  private makeCardTappable(): void {
    if (this.cardTappable) return
    this.cardTappable = true

    const obj = this.getSceneObject()
    this.tapCollider = obj.getComponent("Physics.ColliderComponent") as ColliderComponent
    if (!this.tapCollider) {
      this.tapCollider = obj.createComponent("Physics.ColliderComponent") as ColliderComponent
      const shape = Shape.createBoxShape()
      const w = this.contentLocalW > 0 ? this.contentLocalW : this.imageWidth
      const h = (this.contentLocalH > 0 ? this.contentLocalH : this.imageWidth) +
        2 * Math.abs(this.contentLocalCY)
      shape.size = new vec3(w, h, 1)
      this.tapCollider.shape = shape
      this.tapCollider.fitVisual = false
    }

    this.tapInteractable = obj.getComponent(Interactable.getTypeName()) as Interactable
    if (!this.tapInteractable) {
      this.tapInteractable = obj.createComponent(Interactable.getTypeName()) as Interactable
    }
    // Direct (near-field) + Indirect (far-field ray) so it works hand-near and pointed-at.
    this.tapInteractable.targetingMode = 3
    this.tapInteractable.allowMultipleInteractors = false
    this.tapInteractable.onTriggerEnd.add(() => this.engage())
    // Live now (the card was just gaze-opened); updateGaze gates it from here on.
    this.setTapEnabled(true)
    this.logger.info("Discovered card is now tappable to engage the voice agent")
  }

  // Enables/disables this card's tap target. Toggling the collider (not just the
  // Interactable) ensures the SIK ray passes straight through to whatever is behind
  // it when the card isn't the gaze-selected one.
  private setTapEnabled(on: boolean): void {
    if (on === this.tapEnabled) return
    this.tapEnabled = on
    if (this.tapCollider) this.tapCollider.enabled = on
    if (this.tapInteractable) this.tapInteractable.enabled = on
  }

  // Hands this card's caption to the voice agent (global.cardVoiceAgent) and sends
  // the agent's orb to perch on it. Conversation-only: getCardId returns null so
  // any spoken caption edit stays visual (not persisted to the store). Mirrors
  // PictureBehavior.engageAgent for captured cards.
  private engage(): void {
    const agent = (global as any).cardVoiceAgent
    if (agent && typeof agent.engageCard === "function") {
      this.logger.info("Engaging voice agent for discovered card")
      const target: CardEditTarget = {
        getCardId: () => null,
        getText: () => this.getText(),
        setTextAnimated: (t: string) => this.setText(t),
      }
      agent.engageCard(this.getText(), target)
    } else {
      this.logger.warn("No cardVoiceAgent is registered (is the component enabled?).")
    }

    const sphere = (global as any).agentSphere
    if (sphere && typeof sphere.perchOnCard === "function") sphere.perchOnCard(this)
  }

  // Resizes the picture to the image aspect, re-lays the caption beneath it, and
  // queues a border re-fit. Called whenever image, width, or text changes.
  private relayoutContent(): void {
    this.resizePicture()
    if (this.caption) this.caption.apply(this.pictureGeometryToCaption())
    if (this.started) this.lastLayoutRootScale = this.trans.getWorldScale().x
    this.scheduleMeasure()
  }

  private resizePicture(): void {
    if (!this.pictureVisual || !this.trans) return
    const aspect = this.imageAspect()
    const width = this.imageWidth > 0 ? this.imageWidth : 1
    const height = width / aspect
    const pObj = this.pictureVisual.getSceneObject()
    const pTrans = pObj.getTransform()
    const anchorObj = pObj.getParent()
    const anchorTrans = anchorObj ? anchorObj.getTransform() : null

    // Pin the picture center on the card root in ROOT-LOCAL space (origin). Reset the
    // anchor chain each time so repeated setImageWidth / scale changes never accumulate
    // world-space offsets (the old setWorldPosition approach drifted when root scale
    // changed because picture and caption sit under different parent scales).
    if (anchorTrans) {
      anchorTrans.setLocalPosition(vec3.zero())
      anchorTrans.setLocalRotation(quat.quatIdentity())
    }
    pTrans.setLocalPosition(vec3.zero())
    pTrans.setLocalRotation(quat.quatIdentity())
    pTrans.setLocalScale(new vec3(width, height, 1))
  }

  private imageAspect(): number {
    const tex = this.currentImage
    if (!tex) return 1
    const w = tex.getWidth()
    const h = tex.getHeight()
    return w > 0 && h > 0 ? w / h : 1
  }

  // Builds the picture geometry CardCaption needs. Derived from the card root and
  // measured root-local footprint — NOT from the picture transform's world position,
  // which drifts when root scale changes without a matching caption re-sync.
  private pictureGeometryToCaption() {
    const pic = this.pictureLocalSize()
    const halfH = pic.y * 0.5
    const rootPos = this.trans.getWorldPosition()
    const up = this.trans.up
    const rootScale = this.trans.getWorldScale().x
    // pic is root-local cm; convert vertical offsets to world cm along the card up axis.
    return {
      text: this.currentText,
      bottomCenter: rootPos.sub(up.uniformScale(halfH * rootScale)),
      up,
      rotation: this.trans.getWorldRotation(),
      width: pic.x * rootScale,
      rootScale,
    }
  }

  // Re-lays picture + caption when the card root's world scale changes without a
  // setImageWidth call (gaze boost, CoverFlow root-scale animation).
  private syncLayoutIfScaleChanged(): void {
    if (!this.started) return
    const s = this.trans.getWorldScale().x
    if (this.lastLayoutRootScale < 0) {
      this.lastLayoutRootScale = s
      return
    }
    if (Math.abs(s - this.lastLayoutRootScale) < 0.004) return
    this.lastLayoutRootScale = s
    this.relayoutContent()
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
    // Record the true footprint + centre (root-local cm) for the deck's packing
    // and for off-edge UI (e.g. the card action buttons).
    this.contentLocalW = width
    this.contentLocalH = height
    this.contentLocalCX = centerX
    this.contentLocalCY = centerY
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

  // Orients the card so its +Z NORMAL points AT the camera position (a TRUE
  // billboard). dir = camPos - cardPos — NOT the camera's forward axis, which only
  // faces the viewer dead-ahead and skews cards placed off to the sides. A generous
  // deadzone holds the facing until the camera direction has moved past it.
  private billboardNow(): void {
    if (!this.billboard || !this.camTrans || !this.trans) return
    const dir = this.camTrans.getWorldPosition().sub(this.trans.getWorldPosition())
    if (dir.length < 1e-4) return
    const target = quat.lookAt(dir.normalize(), vec3.up())
    const dz = this.billboardDeadzoneDeg
    if (dz > 0 && this.lastBillboardRot && this.quatAngleDeg(this.lastBillboardRot, target) <= dz) {
      return // within the deadzone: hold the current facing, skip the write
    }
    this.trans.setWorldRotation(target)
    this.lastBillboardRot = target
  }

  // Angle (degrees) between two rotations, for the billboard deadzone test.
  private quatAngleDeg(a: quat, b: quat): number {
    let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w
    dot = Math.min(1, Math.abs(dot))
    return (2 * Math.acos(dot) * 180) / Math.PI
  }

  private applyContentVisibility(visible: boolean): void {
    if (this.hiddenUntilReady) {
      // Held invisible until the deck has measured + placed this card. Keep the
      // caption enabled-but-transparent (beginMeasure) so the text still lays out and
      // getBoundingBox measures; suppress the picture + border entirely.
      this.setPictureEnabled(false)
      if (this.borderBubble) this.borderBubble.setVisible(false)
      if (this.caption) this.caption.beginMeasure()
      return
    }
    this.setPictureEnabled(visible)
    if (this.caption) this.caption.setVisible(visible)
  }

  // Toggles the picture visual's object, skipping the write when already in that
  // state so a redundant call never re-fires the RenderMeshVisual lifecycle.
  private setPictureEnabled(enabled: boolean): void {
    if (!this.pictureVisual) return
    const obj = this.pictureVisual.getSceneObject()
    if (obj.enabled !== enabled) obj.enabled = enabled
  }
}
