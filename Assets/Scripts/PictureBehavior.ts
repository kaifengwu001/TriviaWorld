/**
 * Specs Inc. 2026
 * Picture Behavior component for the Crop Spectacles lens.
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger";
import {SIK} from "SpectaclesInteractionKit.lspkg/SIK"
import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {CaptionBehavior} from "./CaptionBehavior"
import {ChatGPT} from "./ChatGPT"
import {CropRegion} from "./CropRegion"
import {topicsFromHashtags} from "./Interests/TopicFromText"
import {CardEditTarget} from "./Cards/CardEditTools"

const BOX_MIN_SIZE = 8 //min size in cm for image capture

@component
export class PictureBehavior extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">PictureBehavior – positions crop area and triggers image capture</span><br/><span style="color: #94A3B8; font-size: 11px;">Tracks hand pinch positions to define the crop rectangle and sends the image to ChatGPT on release.</span>')
  @ui.separator

  @ui.label('<span style="color: #60A5FA;">Scene References</span>')
  @input
  @hint("Corner objects defining the four crop boundary points")
  circleObjs: SceneObject[]

  @input
  @hint("Camera object used for positioning in editor preview mode")
  editorCamObj: SceneObject

  @input
  @hint("Anchor transform that frames and scales the captured image")
  picAnchorObj: SceneObject

  @input
  @hint("Loading indicator shown while awaiting AI response")
  loadingObj: SceneObject

  @input
  @hint("Render mesh visual that displays the captured crop image")
  captureRendMesh: RenderMeshVisual

  @input
  @hint("Camera crop texture that provides the cropped region feed")
  screenCropTexture: Texture

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Dependencies</span>')
  @input
  @hint("CropRegion component that controls the crop rectangle texture")
  cropRegion: CropRegion

  @input
  @hint("ChatGPT component that sends the captured image for AI analysis")
  chatGPT: ChatGPT

  @input
  @hint("CaptionBehavior component that displays the AI response text")
  caption: CaptionBehavior

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Logging</span>')
  @input
  @hint("Enable general logging")
  enableLogging: boolean = false;

  @input
  @hint("Enable lifecycle logging (onAwake, onStart, onUpdate, onDestroy)")
  enableLoggingLifecycle: boolean = false;

  private logger: Logger;

  private isEditor = global.deviceInfoSystem.isEditor()

  private camTrans: Transform
  private loadingTrans: Transform

  private circleTrans: Transform[]

  private rightHand = SIK.HandInputData.getHand("right")
  private leftHand = SIK.HandInputData.getHand("left")

  private picAnchorTrans = null

  private leftDown = true
  private rightDown = true
  private rotMat = new mat3()

  private updateEvent = null

  // The finished card's caption text, handed to the voice agent on tap.
  private captionText: string = ""
  private cardTappable = false

  // This card's id in the CardStore, captured when it's stored. Lets the voice
  // agent persist caption edits back to the store (null until storeCard runs).
  private storedCardId: string | null = null

  // The card's topics, derived from the caption's hashtags once the AI response
  // arrives. null until then — the CardBackdrop reads this (getResolvedTopics)
  // to know when to stop the rainbow border and settle on the topic color.
  private resolvedTopics: string[] = null

  onAwake() {
    this.logger = new Logger("PictureBehavior", this.enableLogging || this.enableLoggingLifecycle, true);
    if (this.enableLoggingLifecycle) this.logger.debug("LIFECYCLE: onAwake()");
    this.loadingObj.enabled = false
    this.loadingTrans = this.loadingObj.getTransform()
    this.captureRendMesh.mainMaterial = this.captureRendMesh.mainMaterial.clone()

    this.camTrans = this.editorCamObj.getTransform()

    this.picAnchorTrans = this.picAnchorObj.getTransform()
    this.circleTrans = this.circleObjs.map((obj) => obj.getTransform())

    this.rightHand.onPinchUp.add(this.rightPinchUp)
    this.rightHand.onPinchDown.add(this.rightPinchDown)
    this.leftHand.onPinchUp.add(this.leftPinchUp)
    this.leftHand.onPinchDown.add(this.leftPinchDown)

    if (this.isEditor) {
      //place this transform in front of camera for testing
      const trans = this.getSceneObject().getTransform()
      trans.setWorldPosition(this.camTrans.getWorldPosition().add(this.camTrans.forward.uniformScale(-60)))
      trans.setWorldRotation(quat.lookAt(this.camTrans.forward, vec3.up()))
      //wait for small delay and capture image
      const delayedEvent = this.createEvent("DelayedCallbackEvent")
      delayedEvent.bind(() => {
        this.loadingObj.enabled = true
        this.cropRegion.enabled = false
        this.captureRendMesh.mainPass.captureImage = ProceduralTextureProvider.createFromTexture(this.screenCropTexture)
        this.chatGPT.makeImageRequest(this.captureRendMesh.mainPass.captureImage, (response) => {
          this.loadingObj.enabled = false
          this.loadCaption(response)
        })
      })
      delayedEvent.reset(0.1)
    } else {
      //send offscreen
      this.getSceneObject().getTransform().setWorldPosition(vec3.up().uniformScale(1000))
      this.updateEvent = this.createEvent("UpdateEvent")
      this.updateEvent.bind(this.update.bind(this))
    }
  }

  private leftPinchDown = () => {
    this.logger.debug("LEFT Pinch down")
    this.leftDown = true
  }

  private leftPinchUp = () => {
    this.logger.debug("LEFT Pinch up")
    this.leftDown = false
    if (!this.rightDown) {
      this.processImage()
    }
  }

  private rightPinchDown = () => {
    this.logger.debug("RIGHT Pinch down")
    this.rightDown = true
  }

  private rightPinchUp = () => {
    this.logger.debug("RIGHT Pinch up")
    this.rightDown = false
    if (!this.leftDown) {
      this.processImage()
    }
  }

  private loadCaption(text: string) {
    //position caption under the picture, centered on the bottom edge of the box
    const bottomCenterPos = this.circleTrans[2]
      .getWorldPosition()
      .add(this.circleTrans[3].getWorldPosition())
      .uniformScale(0.5)
    const pictureWidth = this.picAnchorTrans.getWorldScale().x
    const captionPos = bottomCenterPos.sub(this.picAnchorTrans.up.uniformScale(this.caption.gap))
    const captionRot = this.picAnchorTrans.getWorldRotation()
    print(
      "[CAPTION-DEBUG] loadCaption: gap=" + this.caption.gap +
      " pictureWidth=" + pictureWidth +
      " bottomCenter=" + bottomCenterPos.toString() +
      " captionPos=" + captionPos.toString()
    )
    this.caption.openCaption(text, captionPos, captionRot, pictureWidth)

    // The card is now finished: remember its text + topics, make it tappable,
    // and proactively engage the voice agent so it speaks an opener right away.
    // (Tapping the card later re-engages it.) Topics are resolved here so the
    // backdrop's rainbow border can settle onto the card's topic color.
    this.captionText = text
    // ONLY the topics we can actually decide from the caption's hashtags. Stays
    // empty (not null) when nothing maps to a preset topic, so the backdrop
    // shows plain white instead of the rainbow (rainbow is reserved for capture,
    // i.e. while this is still null). The interest fallback is for STORAGE only.
    this.resolvedTopics = topicsFromHashtags(this.parseHashtags(text))
    this.makeCardTappable()
    this.engageAgent()
    this.storeCard(text)
  }

  /**
   * The topics decided from the AI caption, or null until the caption arrives.
   * Read by the CardBackdrop to drive its border:
   *   - null  -> still capturing            -> rainbow
   *   - []    -> caption in, no topic found -> plain white
   *   - [..]  -> caption in, topic decided  -> that topic's color
   */
  getResolvedTopics(): string[] | null {
    return this.resolvedTopics ? this.resolvedTopics.slice() : null
  }

  /** Extracts every "#Tag" from text, returning the tags without the '#'. */
  private parseHashtags(text: string): string[] {
    const out: string[] = []
    const re = /#(\w+)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text ?? "")) !== null) out.push(m[1])
    return out
  }

  /** Adds the finished card to the session CardStore (global.cropCardStore). */
  private storeCard(text: string) {
    const cardStore = (global as any).cropCardStore
    if (!cardStore || typeof cardStore.addCard !== "function") return
    const record = cardStore.addCard({
      image: this.captureRendMesh.mainPass.captureImage as Texture,
      text: text,
      hashtags: cardStore.parseHashtags(text),
      topics: this.topicsForStorage(),
      location: "Long Beach, California",
      // captureDate omitted -> CardStore stamps today's date.
    })
    // Remember the id so the voice agent can persist caption edits to this record.
    this.storedCardId = record && record.id ? record.id : null
  }

  /**
   * Topics to FILE the card under. Prefers the caption-decided topics; when none
   * were decidable, falls back to the user's selected interests so the card is
   * still queryable. This fallback intentionally does NOT affect the border color
   * (the border uses resolvedTopics directly, so an undecidable card stays white).
   */
  private topicsForStorage(): string[] {
    if (this.resolvedTopics && this.resolvedTopics.length > 0) return this.resolvedTopics
    const interestStore = (global as any).cropInterestStore
    return interestStore && typeof interestStore.getInterests === "function"
      ? interestStore.getInterests()
      : []
  }

  /** Hands this card's caption to the voice agent (global.cardVoiceAgent). */
  private engageAgent() {
    const agent = (global as any).cardVoiceAgent
    if (agent && typeof agent.engageCard === "function") {
      this.logger.info("Engaging voice agent for card")
      // Hand the agent a live handle to this card so spoken corrections/additions
      // can rewrite or append the caption in place. getCardId reads the field
      // lazily (storeCard runs right after engageAgent on first capture).
      const target: CardEditTarget = {
        getCardId: () => this.storedCardId,
        getText: () => this.caption.getText(),
        setTextAnimated: (t: string) => this.caption.animateTextTo(t),
      }
      agent.engageCard(this.captionText, target)
    } else {
      this.logger.warn("No cardVoiceAgent is registered (is the component enabled?).")
    }

    // Send the agent's visual presence (the orb) to this card's peripheral area.
    const sphere = (global as any).agentSphere
    if (sphere && typeof sphere.perchOnCard === "function") {
      sphere.perchOnCard(this)
    }
  }

  /**
   * Returns this card's top-right corner and basis vectors so the AgentSphere can
   * perch on its periphery. The crop corners (circleTrans) hold the captured
   * rectangle and stop updating once processImage() removes the update loop, so
   * they remain stable for the life of the card. Corners: [0]=TL [1]=TR [2]=BR [3]=BL.
   */
  getCardFrame() {
    const tr = this.circleTrans[1].getWorldPosition()
    const tl = this.circleTrans[0].getWorldPosition()
    const br = this.circleTrans[2].getWorldPosition()
    const right = tr.sub(tl).normalize()
    const up = tr.sub(br).normalize()
    // right x up points toward the camera (matches picAnchor's forward column).
    const normal = right.cross(up).normalize()
    return {corner: tr, right, up, normal}
  }

  /**
   * Adds an SIK Interactable + collider to the card's image so a pinch/tap hands
   * the card's caption to the voice agent (global.cardVoiceAgent). Mirrors the
   * makeInteractable/collider pattern in Globe/GlobeController.ts.
   */
  private makeCardTappable() {
    if (this.cardTappable) return
    this.cardTappable = true

    // Attach to the actual image-mesh object (the RenderMeshVisual lives on a
    // CHILD of picAnchorObj with its own transform), and auto-fit the collider to
    // the rendered image so the tap target matches exactly what the user sees.
    const obj = this.captureRendMesh.getSceneObject()
    this.logger.info("Making card tappable on: " + obj.name)
    if (!obj.getComponent("Physics.ColliderComponent")) {
      const collider = obj.createComponent("Physics.ColliderComponent") as ColliderComponent
      const shape = Shape.createBoxShape()
      collider.shape = shape
      collider.fitVisual = true
    }

    let interactable = obj.getComponent(Interactable.getTypeName()) as Interactable
    if (!interactable) {
      interactable = obj.createComponent(Interactable.getTypeName()) as Interactable
    }
    // Direct (near-field) + Indirect (far-field ray) so it works hand-near and pointed-at.
    interactable.targetingMode = 3
    interactable.allowMultipleInteractors = false
    interactable.onTriggerEnd.add(() => this.onCardTapped())
  }

  private onCardTapped() {
    this.logger.info("Card tapped")
    this.engageAgent()
  }

  private processImage() {
    if (this.updateEvent != null) {
      //remove all events
      this.removeEvent(this.updateEvent)
      this.updateEvent = null
      this.rightHand.onPinchUp.remove(this.rightPinchUp)
      this.rightHand.onPinchDown.remove(this.rightPinchDown)
      this.leftHand.onPinchUp.remove(this.leftPinchUp)
      this.leftHand.onPinchDown.remove(this.leftPinchDown)
      //make sure image area is above threshold
      if (this.getHeight() < BOX_MIN_SIZE || this.getWidth() < BOX_MIN_SIZE) {
        this.logger.warn("too small, destroying.")
        this.getSceneObject().destroy()
        return
      }
      //remove update loop and process image
      this.loadingObj.enabled = true
      this.cropRegion.enabled = false

      this.chatGPT.makeImageRequest(this.captureRendMesh.mainPass.captureImage, (response) => {
        this.loadingObj.enabled = false
        this.loadCaption(response)
      })
    }
  }

  localTopLeft() {
    return this.camTrans.getInvertedWorldTransform().multiplyPoint(this.circleTrans[0].getWorldPosition())
  }

  localBottomRight() {
    return this.camTrans.getInvertedWorldTransform().multiplyPoint(this.circleTrans[2].getWorldPosition())
  }

  getWidth() {
    return Math.abs(this.localBottomRight().x - this.localTopLeft().x)
  }

  getHeight() {
    return Math.abs(this.localBottomRight().y - this.localTopLeft().y)
  }

  update() {
    if (this.rightDown || this.leftDown) {
      //have to do this or else it wont show up in capture
      if (this.screenCropTexture.getColorspace() == 3) {
        this.captureRendMesh.mainPass.captureImage = ProceduralTextureProvider.createFromTexture(this.screenCropTexture)
      }

      // The two pinch points form a diagonal of the crop rectangle, but we don't
      // know which diagonal (top-left/bottom-right vs top-right/bottom-left).
      // Instead of assuming a fixed hand-to-corner mapping, build the rectangle
      // from a basis that always faces the user upright.
      const pinchA = this.leftHand.thumbTip.position
      const pinchB = this.rightHand.thumbTip.position
      const centerPos = pinchA.add(pinchB).uniformScale(0.5)
      const camPos = this.camTrans.getWorldPosition()

      // forward points back toward the user so the surface normal never flips.
      const forward = camPos.sub(centerPos).normalize()
      // Lock the horizontal axis to WORLD up (not the camera's up) so head roll
      // never tilts the crop; the rectangle stays upright relative to the world.
      let right = vec3.up().cross(forward)
      if (right.length < 1e-4) {
        // Looking straight up/down: world up is parallel to forward, so fall
        // back to the camera's right to keep a valid (non-degenerate) basis.
        right = this.camTrans.right
      }
      right = right.normalize()
      const up = forward.cross(right).normalize()

      // Project the diagonal onto the camera right/up axes to get the half extents.
      const toCorner = pinchA.sub(centerPos)
      const halfWidth = Math.abs(toCorner.dot(right))
      const halfHeight = Math.abs(toCorner.dot(up))
      const rightOffset = right.uniformScale(halfWidth)
      const upOffset = up.uniformScale(halfHeight)

      const topLeftPos = centerPos.sub(rightOffset).add(upOffset)
      const topRightPos = centerPos.add(rightOffset).add(upOffset)
      const bottomRightPos = centerPos.add(rightOffset).sub(upOffset)
      const bottomLeftPos = centerPos.sub(rightOffset).sub(upOffset)

      // Assign corners by their true camera-space position, not by which hand pinched.
      this.circleTrans[0].setWorldPosition(topLeftPos) // Top left
      this.circleTrans[1].setWorldPosition(topRightPos) // Top right
      this.circleTrans[2].setWorldPosition(bottomRightPos) // Bottom right
      this.circleTrans[3].setWorldPosition(bottomLeftPos) // Bottom left

      // Align the picAnchorTrans with the camera-facing rectangle.
      this.picAnchorTrans.setWorldPosition(bottomRightPos)
      this.picAnchorTrans.setWorldScale(new vec3(halfWidth * 2, halfHeight * 2, 1))
      this.rotMat.column0 = right
      this.rotMat.column1 = up
      this.rotMat.column2 = forward
      const rectRotation = quat.fromRotationMat(this.rotMat)
      this.picAnchorTrans.setWorldRotation(rectRotation)

      //set loader position to center of rectangle
      this.loadingTrans.setWorldPosition(centerPos.add(forward.uniformScale(0.2)))
      this.loadingTrans.setWorldRotation(rectRotation)
    }
  }
}
