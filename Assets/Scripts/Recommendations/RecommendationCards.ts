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

/** A live direction arrow + its "XX m" distance label. */
interface RecArrow {
  obj: SceneObject;
  trans: Transform;
  target: vec3; // world-fixed point the arrow points at
  cardIndex: number; // which recommendation card this arrow is for
  screenX: number; // horizontal FoV fraction for head-locking (0 = centre)
  labelObj: SceneObject;
  labelText: Text;
  appliedScale: number; // world scale applied to the arrow mesh
  centerLocal: vec3; // arrow mesh's local AABB centre (pivot is off-centre) so the
  // label can sit under the arrow's VISIBLE centre, not its pivot.
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

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Arrow direction (per card)</span>')
  @input
  @hint("Per-card heading in degrees (yaw about world-up, relative to the user's forward at selection). One per card; the arrow points along this direction.")
  cardHeadings: number[] = [-40, 0, 40]

  @input
  @hint("Per-card pitch in degrees (positive tilts the arrow UP, e.g. toward an upper floor). One per card. Requires 'Keep arrow flat' off.")
  cardPitches: number[] = [0, 0, 0]

  @input
  @hint("Per-card distance in METRES. Drives how far out the world-fixed target sits AND the 'XX m' label beneath the arrow. One per card.")
  cardDistancesM: number[] = [100, 100, 100]

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Distance label</span>')
  @input
  @hint("Colour of the 'XX m' text beneath the arrow.")
  distanceLabelColor: vec4 = new vec4(1, 1, 1, 1)

  @input
  @hint("Font size of the 'XX m' label.")
  distanceLabelSize: number = 64

  @input
  @hint("Bold the 'XX m' label (faux-bold via a same-colour outline that thickens the strokes).")
  distanceLabelBold: boolean = true

  @input
  @hint("How far (cm) beneath the arrow the 'XX m' label sits. Smaller = closer to the arrow.")
  distanceLabelDropCm: number = 2

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Tuning</span>')
  @input
  @hint("When ON, skip the card flow and spawn all 3 arrows at once at launch so you can tune cardHeadings / cardPitches / cardDistancesM live in the inspector.")
  tuningMode: boolean = false

  @input
  @hint("Horizontal FoV fractions (-1 left .. +1 right) used to spread the 3 tuning arrows so they don't overlap. One per card.")
  tuningScreenX: number[] = [-0.5, 0, 0.5]

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
  @hint("Displayed image width (cm) for each card. The picture, caption wrap, auto-fit border, and collider all flow from this — the card stays at world scale 1. (This is the correct knob for a premade card; do NOT scale the whole card.)")
  cardImageWidthCm: number = 13.3

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

  // Arrow state. One entry in normal flow (the selected card), three in tuning mode.
  private arrows: RecArrow[] = []
  private selectedTarget: vec3 = vec3.zero() // captured at onSelect, used by cardToArrow
  // Tuning mode: spawn all 3 arrows at launch and re-aim them live from the inspector.
  private tuning: boolean = false
  private tuningBaseFwd: vec3 = vec3.zero() // frozen view direction at tuning start
  private tuningOrigin: vec3 = vec3.zero() // frozen head position at tuning start

  onAwake() {
    this.logger = new Logger("RecommendationCards", this.enableLogging, true)
    ;(global as any).recommendationCards = this
    this.createEvent("UpdateEvent").bind((ev) => this.update(ev.getDeltaTime()))
    if (this.tuningMode) {
      // Defer to the first frame so the camera transform is settled.
      const ev = this.createEvent("DelayedCallbackEvent")
      ev.bind(() => this.startTuning())
      ev.reset(0)
    }
  }

  // --- public API ------------------------------------------------------------

  /** Spawns the three cards and flies them into a row in front of the user. */
  show(): void {
    if (this.tuning) return // tuning mode owns the arrows; skip the card flow
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
    // POSITION ONLY. World scale stays at 1 the whole time — card size is driven
    // by PremadeCard.imageWidth (cm), so the picture, caption wrap, auto-fit
    // border, and collider all measure in real cm. Animating scale during the
    // fly-in corrupts the auto-fit border measurement (it measures a few frames
    // after layout), which made the caption overflow the card.
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

      // Keep the card at world scale 1 + a fixed rotation BEFORE the card's onStart
      // lays out its caption, so the border auto-fit measures at steady state in cm.
      trans.setWorldScale(vec3.one())
      trans.setWorldPosition(startPos)
      trans.setWorldRotation(faceRot)

      const card = obj.getComponent(PremadeCard.getTypeName()) as unknown as PremadeCard
      if (card) {
        card.billboard = false
        card.gazeToExpand = false
        card.startExpanded = true
        card.setCamera(this.cameraObject)
        // Drive size via the image width (cm). onStart's relayout reads this field,
        // so set it before the card lays out and measures its border.
        card.setImageWidth(this.cardImageWidthCm)
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
    if (this.tuning) return // tuning mode: arrows are spawned upfront, not by selection
    if (this.selected || !this.shown) return
    if (index < 0 || index >= this.cards.length) return
    this.selected = true

    // Capture a world-fixed target along the card's heading + pitch, at its distance.
    this.selectedTarget = this.targetFor(
      index,
      this.camTrans.getWorldPosition(),
      this.camTrans.forward.uniformScale(-1)
    )

    const chosen = this.cards[index]
    // Centre the chosen card.
    this.tweenPos(chosen, chosen.trans.getWorldPosition(), this.anchor, 0.4, "ease-out-cubic")

    // Dissipate the other two.
    for (let i = 0; i < this.cards.length; i++) {
      if (i === index) continue
      const rec = this.cards[i]
      this.tweenScale(rec, rec.trans.getWorldScale().x, 0, 0.3, "ease-in-quad", () => this.destroyObj(rec.obj))
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

    // Spawn the arrow (centred, screenX 0) as the card dissipates, then schedule its dismiss.
    const arrow = this.spawnArrow(index, 0, this.selectedTarget)
    if (arrow) {
      const life = this.createEvent("DelayedCallbackEvent")
      life.bind(() => this.dismissArrows())
      life.reset(this.arrowLifetimeSeconds)
    }
  }

  // Instantiates the arrow prefab + a white "XX m" distance label, sized and registered
  // for per-frame head-locking in update(). Returns the entry, or null if no prefab.
  private spawnArrow(cardIndex: number, screenX: number, target: vec3): RecArrow | null {
    if (!this.arrowPrefab) {
      this.logger.error("arrowPrefab not assigned")
      return null
    }
    const obj = this.arrowPrefab.instantiate(this.getSceneObject())
    obj.name = "RecArrow_" + cardIndex
    const trans = obj.getTransform()
    // Scale the arrow so its largest dimension ≈ arrowSizeCm, derived from the mesh's
    // local AABB (same approach as GlobeView.getLocalRadiusCm). This makes the on-screen
    // size predictable regardless of the imported model's units.
    const appliedScale = this.scaleForArrowSize(obj)
    trans.setWorldScale(new vec3(appliedScale, appliedScale, appliedScale))
    const centerLocal = this.arrowCenterLocal(obj)

    // The "XX m" label is a SEPARATE object (not a child of the arrow) so it doesn't
    // inherit the arrow's pointing rotation — update() positions + billboards it.
    const labelObj = global.scene.createSceneObject("RecArrowLabel_" + cardIndex)
    labelObj.layer = obj.layer
    const labelText = labelObj.createComponent("Component.Text") as Text
    labelText.horizontalAlignment = HorizontalAlignment.Center
    labelText.verticalAlignment = VerticalAlignment.Center
    labelText.size = Math.max(1, Math.round(this.distanceLabelSize))
    labelText.textFill.color = this.distanceLabelColor
    if (this.distanceLabelBold) {
      // Faux-bold: a same-colour outline thickens the glyph strokes (the Text component
      // has no weight/bold property — real bold needs a bold font asset).
      labelText.outlineSettings.enabled = true
      labelText.outlineSettings.fill.color = this.distanceLabelColor
      labelText.outlineSettings.size = 0.4
    }
    labelText.text = this.distanceLabelFor(cardIndex)

    const arrow: RecArrow = {
      obj, trans, target, cardIndex, screenX, labelObj, labelText, appliedScale, centerLocal,
    }
    this.arrows.push(arrow)
    return arrow
  }

  // Tween every live arrow (+ its label) to scale 0 and destroy. Used by the normal-flow
  // lifetime timer; tuning-mode arrows have no timer and persist.
  private dismissArrows(): void {
    const arrows = this.arrows
    this.arrows = []
    for (const a of arrows) {
      const from = a.appliedScale
      const trans = a.trans
      const obj = a.obj
      const labelObj = a.labelObj
      const cancel = new CancelSet()
      animate({
        easing: "ease-in-quad",
        duration: 0.4,
        update: (t: number) => {
          const s = from * (1 - t)
          trans.setWorldScale(new vec3(s, s, s))
        },
        ended: () => {
          this.destroyObj(obj)
          this.destroyObj(labelObj)
        },
        cancelSet: cancel,
      })
    }
  }

  // --- per-frame: head-lock the arrow ---------------------------------------

  private update(_dt: number): void {
    if (this.arrows.length === 0 || !this.camTrans) return

    const camPos = this.camTrans.getWorldPosition()
    const viewDir = this.camTrans.forward.uniformScale(-1)
    const up = this.camTrans.up
    const right = this.camTrans.right
    const halfV = this.arrowDistanceCm * Math.tan(this.fovRad() * 0.5)
    const halfH = halfV * this.aspect()
    // Labels face the camera, upright (same expression the cards use).
    const labelRot = quat.lookAt(this.camTrans.forward, vec3.up())
    const yawOffset = quat.angleAxis(this.arrowYawOffsetDeg * DEG2RAD, vec3.up())

    for (const a of this.arrows) {
      // In tuning mode, re-aim every frame from the (frozen) base so live inspector
      // edits to heading/pitch/distance move the arrow immediately.
      if (this.tuning) {
        a.target = this.targetFor(a.cardIndex, this.tuningOrigin, this.tuningBaseFwd)
      }

      // Position: low in the FoV, spread by screenX, sticking to the head.
      const pos = camPos
        .add(viewDir.uniformScale(this.arrowDistanceCm))
        .add(up.uniformScale(this.arrowScreenY * halfV))
        .add(right.uniformScale(a.screenX * halfH))
      a.trans.setWorldPosition(pos)

      // Rotation: aim the arrow's tip straight at the world-fixed target with a single
      // lookAt on the FULL 3D direction. Because lookAt points the tip exactly along the
      // given vector, the arrow's heading equals the target's azimuth by construction —
      // pitch (the target's elevation, set per card via dirFor) can never leak into
      // left/right. The target is world-fixed, so the aim stays put as the head turns.
      const dir = a.target.sub(pos)
      if (dir.length > 1e-4) {
        const look = quat.lookAt(dir.normalize(), vec3.up())
        a.trans.setWorldRotation(yawOffset.multiply(look))
      }

      // Label: centred under the arrow's VISIBLE centre (the mesh pivot is off-centre,
      // so use the rotated+scaled AABB centre), billboarded upright; text refreshed so
      // tuning edits to cardDistancesM update the number live.
      const visibleCentre = pos.add(
        a.trans.getWorldRotation().multiplyVec3(a.centerLocal.uniformScale(a.appliedScale))
      )
      const labelTrans = a.labelObj.getTransform()
      labelTrans.setWorldPosition(visibleCentre.add(up.uniformScale(-this.distanceLabelDropCm)))
      labelTrans.setWorldRotation(labelRot)
      a.labelText.text = this.distanceLabelFor(a.cardIndex)
    }
  }

  /** Spawns all 3 arrows at once for inspector-driven tuning (no card flow, no lifetime). */
  private startTuning(): void {
    this.resolveCamera()
    if (!this.camTrans) {
      this.logger.error("cameraObject not assigned (tuning mode)")
      return
    }
    this.tuning = true
    this.tuningOrigin = this.camTrans.getWorldPosition()
    this.tuningBaseFwd = this.camTrans.forward.uniformScale(-1)
    for (let i = 0; i < 3; i++) {
      const screenX = this.tuningScreenX && this.tuningScreenX.length > i ? this.tuningScreenX[i] : 0
      const target = this.targetFor(i, this.tuningOrigin, this.tuningBaseFwd)
      this.spawnArrow(i, screenX, target)
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

  // The arrow mesh's local AABB centre. The imported Arrowgeo pivot is off-centre, so
  // the visible arrow sits offset from its SceneObject position; this lets update()
  // place the label under the arrow's centre rather than its pivot. vec3.zero() if no mesh.
  private arrowCenterLocal(obj: SceneObject): vec3 {
    const visual = this.findRenderMesh(obj)
    if (visual) {
      const min = visual.localAabbMin()
      const max = visual.localAabbMax()
      return min.add(max).uniformScale(0.5)
    }
    return vec3.zero()
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

  // Horizontal:vertical FoV ratio, used to spread the tuning arrows across the view.
  private aspect(): number {
    const a = this.camComp ? (this.camComp as any).aspect : 0
    return a && a > 1e-3 ? a : 1.4
  }

  // Direction along a heading (yaw about world-up) then a pitch (about the horizontal
  // axis perpendicular to that heading; positive pitch tilts up), from a base forward.
  private dirFor(headingDeg: number, pitchDeg: number, baseForward: vec3): vec3 {
    const flat = new vec3(baseForward.x, 0, baseForward.z)
    const base = flat.length > 1e-4 ? flat.normalize() : baseForward
    const yaw = quat.angleAxis(headingDeg * DEG2RAD, vec3.up())
    const dirH = yaw.multiplyVec3(base).normalize()
    const pitchAxis = dirH.cross(vec3.up()).normalize() // horizontal right of dirH
    const pitch = quat.angleAxis(pitchDeg * DEG2RAD, pitchAxis)
    return pitch.multiplyVec3(dirH).normalize()
  }

  // World-fixed target for card i: origin + dir(heading,pitch) * distance(m → cm).
  private targetFor(i: number, originPos: vec3, baseForward: vec3): vec3 {
    const h = this.cardHeadings && this.cardHeadings.length > i ? this.cardHeadings[i] : 0
    const p = this.cardPitches && this.cardPitches.length > i ? this.cardPitches[i] : 0
    const dM = this.cardDistancesM && this.cardDistancesM.length > i ? this.cardDistancesM[i] : 100
    const dir = this.dirFor(h, p, baseForward)
    return originPos.add(dir.uniformScale(Math.max(1, dM) * 100))
  }

  // The "XX m" label text for card i, from its inspector distance.
  private distanceLabelFor(i: number): string {
    const dM = this.cardDistancesM && this.cardDistancesM.length > i ? this.cardDistancesM[i] : 100
    return Math.round(dM) + " m"
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
  // The card sits at world scale 1, so this box is sized in real cm: a rough cover
  // derived from the image width (the fly-in settle re-fits it to the measured
  // footprint via resizeCollider). Picture ≈ image width; caption hangs below, so the
  // box is ~2× wide and ~3× tall, matching the old proportions.
  private makeSelectable(obj: SceneObject, index: number): void {
    if (!obj) return
    if (!obj.getComponent("Physics.ColliderComponent")) {
      const collider = obj.createComponent("Physics.ColliderComponent") as ColliderComponent
      const shape = Shape.createBoxShape()
      const w = this.cardImageWidthCm * 2
      const h = this.cardImageWidthCm * 3
      shape.size = new vec3(w, h, Math.max(2, w * 0.1))
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
