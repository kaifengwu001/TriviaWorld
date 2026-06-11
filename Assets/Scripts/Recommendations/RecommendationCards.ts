/**
 * Specs Inc. 2026
 * RecommendationCards – the post-onboarding "I found a few cards for you" flow.
 *
 * When the user presses Start in the topic panel, TopicSelectionPanel.onStart()
 * calls show() on this component (looked up via global.recommendationCards, the
 * same global-registration pattern as agentSphere / globeController / topicPanel).
 *
 * show() instantiates the PremadeCard prefab three times, gives each a fixed image
 * + caption (RECOMMENDATION_TEXTS), and flies them in to a spread-out row anchored
 * on a frozen world frame in front of the user. Each card root gets an explicit-size
 * box collider + Interactable (mirrors CardDeckController.makeCardSelectable) so a
 * point-and-pinch selects it.
 *
 * On select: the chosen card eases to the row centre, the other two dissipate
 * (scale -> 0, destroyed). After selectHoldSeconds the chosen card dissipates as a
 * white arrow appears. The arrow is head-locked low in the FoV (its POSITION follows
 * the head each frame, like AgentSphere.fovPoint) but points toward a world-fixed
 * target captured at selection time (rotate the user's forward by the card's heading),
 * so turning the head does not change the pointed direction. The arrow dissipates
 * after arrowLifetimeSeconds, then the flow is idle.
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger";
import animate, { CancelSet } from "SpectaclesInteractionKit.lspkg/Utils/animate";
import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import { PremadeCard } from "../PremadeCard/PremadeCard";

const DEG2RAD = Math.PI / 180;

// Short labels for the three cards, index-aligned with RECOMMENDATION_TEXTS and
// cardHeadings. Used by the RecommendationVoiceAgent's select_card tool so the model
// can refer to a card by name ("the Snap one") and we map it back to an index.
export const RECOMMENDATION_LABELS: string[] = ["Art Festival", "Reality Hack", "Snap Lounge"];

// Fixed caption copy for the three recommendation cards, in inspector image order.
const RECOMMENDATION_TEXTS: string[] = [
  // 0 – AWE Art Festival
  "Visit Art Festival at AWE! Whether you are an independent creator or a high-end studio, this is where your work is seen by the people who matter—the producers, curators, and technologists building the next generation of digital storytelling. Showcase your vision and connect with the global creative community.",
  // 1 – Reality Hack
  "Reality Hack at AWE 2026 is inviting you to enhance how we learn with Spatial AI! Reality Hack, Spectacles, and AWE is inviting you to build the future of learning with Spatial AI and Extended Reality and create experiences that levels up how people learn by blending intelligent digital assistance with the physical world in an education context.",
  // 2 – Snap Lounge
  "Visit Snap Lounge on the 2nd floor! Snap Inc. is a technology company. We believe the camera presents the greatest opportunity to improve the way people live and communicate. We contribute to human progress by empowering people to express themselves, live in the moment, learn about the world, and have fun together.",
];

/** Per-card runtime state. */
interface RecCard {
  obj: SceneObject;
  card: PremadeCard;
  trans: Transform;
  slotPos: vec3;
  posCancel: CancelSet;
  scaleCancel: CancelSet;
}

@component
export class RecommendationCards extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">RecommendationCards – fly-in cards → pinch-select → direction arrow</span>')
  @ui.separator

  @ui.label('<span style="color: #60A5FA;">References</span>')
  @input
  @hint("The PremadeCard prefab, instantiated once per recommendation card.")
  cardPrefab: ObjectPrefab

  @input
  @hint("Camera object – used for row placement, billboarding, and head-locking the arrow.")
  cameraObject: SceneObject

  @input
  @hint("The white arrow prefab (Arrowgeo.obj with an unlit white material).")
  arrowPrefab: ObjectPrefab

  @input
  @hint("Three card images, in order: 0 Art Festival, 1 Reality Hack, 2 Snap Lounge.")
  @allowUndefined
  cardImages: Texture[]

  @input
  @hint("Per-card heading in degrees (yaw about world-up, relative to the user's forward at selection). One per card; the arrow points along this direction.")
  cardHeadings: number[] = [-40, 0, 40]

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Layout</span>')
  @input
  @hint("Distance (cm) in front of the user where the card row settles.")
  rowDepthCm: number = 60

  @input
  @hint("Vertical offset (cm) of the card row relative to eye level.")
  rowRiseCm: number = 0

  @input
  @hint("Horizontal gap (cm) between adjacent cards in the row.")
  cardSpacingCm: number = 22

  @input
  @hint("World scale applied to each card.")
  cardSize: number = 0.5

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Timing (seconds)</span>')
  @input
  @hint("Fly-in animation duration.")
  flyInDuration: number = 0.8

  @input
  @hint("How long the selected card stays before turning into the arrow.")
  selectHoldSeconds: number = 3

  @input
  @hint("How long the arrow stays before dissipating.")
  arrowLifetimeSeconds: number = 10

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Arrow placement</span>')
  @input
  @hint("Vertical FoV fraction for the arrow: -1 bottom .. +1 top. Keep low to avoid blocking the view.")
  arrowScreenY: number = -0.6

  @input
  @hint("Distance (cm) in front of the head where the arrow sits. Larger = farther away and smaller on screen.")
  arrowDistanceCm: number = 100

  @input
  @hint("On-screen arrow size: its largest dimension in centimetres. Auto-scaled from the mesh bounds, so it's predictable regardless of the imported model's native units.")
  arrowSizeCm: number = 8

  @input
  @hint("Yaw correction (deg) for the imported arrow mesh's natural axis. Tune so the arrow tip points along the heading.")
  arrowYawOffsetDeg: number = 0

  @input
  @hint("Keep the arrow flat (yaw-only): project the pointing direction onto the horizontal plane.")
  arrowKeepFlat: boolean = true

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Logging</span>')
  @input
  enableLogging: boolean = false

  private logger: Logger
  private camTrans: Transform | null = null
  private camComp: Camera | null = null

  // Frozen world frame for the card row, captured at show().
  private anchor: vec3 = vec3.zero()
  private rightW: vec3 = vec3.zero()

  private cards: RecCard[] = []
  private selected: boolean = false
  private shown: boolean = false

  // Arrow state.
  private arrowObj: SceneObject | null = null
  private arrowTrans: Transform | null = null
  private arrowTarget: vec3 = vec3.zero()
  private arrowActive: boolean = false
  // World scale actually applied to the arrow (derived from arrowSizeCm + mesh bounds).
  private arrowAppliedScale: number = 1

  onAwake() {
    this.logger = new Logger("RecommendationCards", this.enableLogging, true)
    ;(global as any).recommendationCards = this
    this.createEvent("UpdateEvent").bind((ev) => this.update(ev.getDeltaTime()))
  }

  // --- public API ------------------------------------------------------------

  /** Spawns the three cards and flies them into a row in front of the user. */
  show(): void {
    if (this.shown) return
    if (!this.cardPrefab) {
      this.logger.error("cardPrefab not assigned")
      return
    }
    this.resolveCamera()
    if (!this.camTrans) {
      this.logger.error("cameraObject not assigned")
      return
    }
    this.shown = true

    // Freeze a world frame from the current head pose so the row stays put when the
    // head turns. In Lens Studio transform.forward points BEHIND the camera, so the
    // view direction (toward the cards) is -forward.
    const camPos = this.camTrans.getWorldPosition()
    const viewDir = this.camTrans.forward.uniformScale(-1)
    this.rightW = this.camTrans.right
    this.anchor = camPos
      .add(viewDir.uniformScale(this.rowDepthCm))
      .add(vec3.up().uniformScale(this.rowRiseCm))

    // Cards start clustered further away (along the view dir), then fly in by
    // POSITION ONLY. Scale stays fixed at cardSize the whole time: animating scale
    // during the fly-in corrupts PremadeCard's auto-fit border measurement (it
    // measures a few frames after layout), which made the caption overflow the card.
    const startPos = camPos.add(viewDir.uniformScale(this.rowDepthCm + 35))
    const parent = this.getSceneObject()

    // One fixed facing rotation for all cards (they do NOT billboard / track the
    // head — they stay put). Matches PremadeCard.billboardNow's expression.
    const faceRot = quat.lookAt(this.camTrans.forward, vec3.up())

    for (let i = 0; i < 3; i++) {
      const obj = this.cardPrefab.instantiate(parent)
      obj.name = "RecCard_" + i
      obj.layer = parent.layer
      const trans = obj.getTransform()

      // Spawn at the final scale + fixed rotation BEFORE the card's onStart lays out
      // its caption, so the border auto-fit measures at steady state.
      trans.setWorldScale(new vec3(this.cardSize, this.cardSize, this.cardSize))
      trans.setWorldPosition(startPos)
      trans.setWorldRotation(faceRot)

      const card = obj.getComponent(PremadeCard.getTypeName()) as unknown as PremadeCard
      if (card) {
        card.billboard = false
        card.gazeToExpand = false
        card.startExpanded = true
        card.setCamera(this.cameraObject)
        const tex = this.cardImages && this.cardImages[i] ? this.cardImages[i] : null
        if (tex) card.setImage(tex)
        card.setText(RECOMMENDATION_TEXTS[i])
        card.setRenderInFront(true)
      }

      const offset = (i - 1) * this.cardSpacingCm
      const slotPos = this.anchor.add(this.rightW.uniformScale(offset))

      const rec: RecCard = {
        obj,
        card,
        trans,
        slotPos,
        posCancel: new CancelSet(),
        scaleCancel: new CancelSet(),
      }
      this.cards.push(rec)
      this.makeSelectable(obj, i)

      // Fly in: position only, with a small per-card stagger. On settle, force a
      // re-fit at steady scale and snap the collider to the measured footprint.
      this.tweenPos(rec, startPos, slotPos, this.flyInDuration, "ease-out-cubic", () => {
        if (rec.card) {
          rec.card.setText(RECOMMENDATION_TEXTS[i])
          if (rec.card.isContentMeasured()) {
            const ls = rec.card.getContentLocalSize()
            this.resizeCollider(rec.obj, ls.x, ls.y)
          }
        }
      })
    }
  }

  /**
   * Select a card by index on the user's behalf (called by the RecommendationVoiceAgent
   * once the model resolves "the Snap one" to an index). Runs the exact same flow as a
   * manual pinch — onSelect's selected/bounds guards make it safe and idempotent.
   * Returns false if the index is out of range or a card is already selected.
   */
  selectByVoice(index: number): boolean {
    if (this.selected || !this.shown) return false;
    if (index < 0 || index >= this.cards.length) return false;
    this.onSelect(index);
    return true;
  }

  // --- selection -------------------------------------------------------------

  private onSelect(index: number): void {
    if (this.selected || !this.shown) return
    if (index < 0 || index >= this.cards.length) return
    this.selected = true

    // Capture a world-fixed target along the card's heading (yaw about world-up
    // from the user's current forward), pushed far out so it reads as a direction.
    const heading = this.cardHeadings && this.cardHeadings.length > index ? this.cardHeadings[index] : 0
    const viewDir = this.camTrans.forward.uniformScale(-1)
    const flat = new vec3(viewDir.x, 0, viewDir.z)
    const baseDir = flat.length > 1e-4 ? flat.normalize() : viewDir
    const rot = quat.angleAxis(heading * DEG2RAD, vec3.up())
    const dir = rot.multiplyVec3(baseDir).normalize()
    this.arrowTarget = this.camTrans.getWorldPosition().add(dir.uniformScale(500))

    const chosen = this.cards[index]
    // Centre the chosen card.
    this.tweenPos(chosen, chosen.trans.getWorldPosition(), this.anchor, 0.4, "ease-out-cubic")

    // Dissipate the other two.
    for (let i = 0; i < this.cards.length; i++) {
      if (i === index) continue
      const rec = this.cards[i]
      this.tweenScale(rec, this.cardSize, 0, 0.3, "ease-in-quad", () => this.destroyObj(rec.obj))
    }

    // Hold, then turn the chosen card into the arrow.
    const hold = this.createEvent("DelayedCallbackEvent")
    hold.bind(() => this.cardToArrow(index))
    hold.reset(this.selectHoldSeconds)
  }

  private cardToArrow(index: number): void {
    const chosen = this.cards[index]
    if (chosen) {
      this.tweenScale(chosen, chosen.trans.getWorldScale().x, 0, 0.35, "ease-in-quad", () =>
        this.destroyObj(chosen.obj)
      )
    }

    // Spawn the arrow as the card dissipates.
    if (this.arrowPrefab) {
      this.arrowObj = this.arrowPrefab.instantiate(this.getSceneObject())
      this.arrowObj.name = "RecArrow"
      this.arrowTrans = this.arrowObj.getTransform()
      // Scale the arrow so its largest dimension ≈ arrowSizeCm, derived from the
      // mesh's local AABB (same approach as GlobeView.getLocalRadiusCm). This makes
      // the on-screen size predictable regardless of the imported model's units.
      this.arrowAppliedScale = this.scaleForArrowSize(this.arrowObj)
      this.arrowTrans.setWorldScale(
        new vec3(this.arrowAppliedScale, this.arrowAppliedScale, this.arrowAppliedScale)
      )
      this.arrowActive = true

      const life = this.createEvent("DelayedCallbackEvent")
      life.bind(() => this.dismissArrow())
      life.reset(this.arrowLifetimeSeconds)
    } else {
      this.logger.error("arrowPrefab not assigned")
    }
  }

  private dismissArrow(): void {
    if (!this.arrowTrans || !this.arrowObj) return
    const from = this.arrowAppliedScale
    const obj = this.arrowObj
    const trans = this.arrowTrans
    const cancel = new CancelSet()
    animate({
      easing: "ease-in-quad",
      duration: 0.4,
      update: (t: number) => {
        const s = from * (1 - t)
        trans.setWorldScale(new vec3(s, s, s))
      },
      ended: () => this.destroyObj(obj),
      cancelSet: cancel,
    })
    this.arrowActive = false
    this.arrowObj = null
    this.arrowTrans = null
  }

  // --- per-frame: head-lock the arrow ---------------------------------------

  private update(_dt: number): void {
    if (!this.arrowActive || !this.arrowTrans || !this.camTrans) return

    // Position: low in the FoV, sticking to the head (recomputed each frame).
    const camPos = this.camTrans.getWorldPosition()
    const viewDir = this.camTrans.forward.uniformScale(-1)
    const halfV = this.arrowDistanceCm * Math.tan(this.fovRad() * 0.5)
    const pos = camPos
      .add(viewDir.uniformScale(this.arrowDistanceCm))
      .add(this.camTrans.up.uniformScale(this.arrowScreenY * halfV))
    this.arrowTrans.setWorldPosition(pos)

    // Rotation: point toward the world-fixed target (stable as the head turns).
    let dir = this.arrowTarget.sub(pos)
    if (this.arrowKeepFlat) dir = new vec3(dir.x, 0, dir.z)
    if (dir.length > 1e-4) {
      const look = quat.lookAt(dir.normalize(), vec3.up())
      const offset = quat.angleAxis(this.arrowYawOffsetDeg * DEG2RAD, vec3.up())
      this.arrowTrans.setWorldRotation(offset.multiply(look))
    }
  }

  // --- helpers ---------------------------------------------------------------

  // World scale that makes the arrow's largest dimension ≈ arrowSizeCm, computed
  // from the mesh's local AABB (mirrors GlobeView.getLocalRadiusCm). Falls back to
  // arrowSizeCm directly if no mesh / degenerate bounds, so the arrow is never huge.
  private scaleForArrowSize(obj: SceneObject): number {
    const visual = this.findRenderMesh(obj)
    if (visual) {
      const min = visual.localAabbMin()
      const max = visual.localAabbMax()
      const nativeDim = Math.max(max.x - min.x, max.y - min.y, max.z - min.z)
      if (nativeDim > 1e-4) return this.arrowSizeCm / nativeDim
    }
    return this.arrowSizeCm
  }

  // Finds the first RenderMeshVisual on this object or any descendant (an imported
  // .obj prefab may carry the mesh on a child rather than the root).
  private findRenderMesh(obj: SceneObject): RenderMeshVisual | null {
    const here = obj.getComponent("Component.RenderMeshVisual") as RenderMeshVisual
    if (here) return here
    const n = obj.getChildrenCount()
    for (let i = 0; i < n; i++) {
      const found = this.findRenderMesh(obj.getChild(i))
      if (found) return found
    }
    return null
  }

  private resolveCamera(): void {
    if (this.camTrans) return
    if (!this.cameraObject) return
    this.camTrans = this.cameraObject.getTransform()
    this.camComp = this.cameraObject.getComponent("Component.Camera") as Camera
  }

  private fovRad(): number {
    return this.camComp ? this.camComp.fov : 1.109
  }

  private tweenPos(
    rec: RecCard,
    from: vec3,
    to: vec3,
    duration: number,
    easing: string,
    onEnded?: (() => void) | null
  ): void {
    if (rec.posCancel) rec.posCancel.cancel()
    animate({
      easing: easing as any,
      duration,
      update: (t: number) => {
        rec.trans.setWorldPosition(vec3.lerp(from, to, t))
      },
      ended: onEnded || null,
      cancelSet: rec.posCancel,
    })
  }

  private tweenScale(
    rec: RecCard,
    from: number,
    to: number,
    duration: number,
    easing: string,
    onEnded: (() => void) | null
  ): void {
    if (rec.scaleCancel) rec.scaleCancel.cancel()
    animate({
      easing: easing as any,
      duration,
      update: (t: number) => {
        const s = from + (to - from) * t
        rec.trans.setWorldScale(new vec3(s, s, s))
      },
      ended: onEnded,
      cancelSet: rec.scaleCancel,
    })
  }

  // Explicit-size box collider + Interactable on the card ROOT so a point-and-pinch
  // selects it. Mirrors CardDeckController.makeCardSelectable: fitVisual=false with a
  // real size, because auto-fit on a nested-scale card yields a box the SIK ray misses.
  // The size is in root-local units (root world scale gives the world footprint).
  private makeSelectable(obj: SceneObject, index: number): void {
    if (!obj) return
    if (!obj.getComponent("Physics.ColliderComponent")) {
      const collider = obj.createComponent("Physics.ColliderComponent") as ColliderComponent
      const shape = Shape.createBoxShape()
      shape.size = new vec3(28, 40, 6)
      collider.shape = shape
      collider.fitVisual = false
    }
    let interactable = obj.getComponent(Interactable.getTypeName()) as Interactable
    if (!interactable) {
      interactable = obj.createComponent(Interactable.getTypeName()) as Interactable
      interactable.targetingMode = 3
      interactable.allowMultipleInteractors = false
      interactable.onTriggerEnd.add(() => this.onSelect(index))
    }
  }

  private resizeCollider(obj: SceneObject, localW: number, localH: number): void {
    if (!obj || !(localW > 0) || !(localH > 0)) return
    const collider = obj.getComponent("Physics.ColliderComponent") as ColliderComponent
    if (!collider) return
    const shape = Shape.createBoxShape()
    shape.size = new vec3(localW, localH, Math.max(2, localW * 0.1))
    collider.shape = shape
  }

  private destroyObj(obj: SceneObject | null): void {
    if (obj) obj.destroy()
  }
}
