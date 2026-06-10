/**
 * Specs Inc. 2026
 * PingCardSpawner – spawns location-filtered cards on the ping wavefront.
 *
 * When the prayer gesture fires a PingController burst, the expanding scan shell
 * sweeps outward from the player's head. This spawner reveals a card exactly as
 * that wavefront reaches each card's position, so the cards "pop into being" in
 * step with the visible ping.
 *
 * Pipeline:
 *   1. Filter CARD_DECK_DATA down to the entries whose `location` matches the
 *      `location` field (case-insensitive). EVERY matching card is spawned.
 *   2. Scatter each card at a random point inside a cylindrical "pipe" around
 *      this object — the same spawn-area shape as BubbleField.
 *   3. For each card, schedule its reveal at distance(origin -> card) / speed,
 *      where speed is read from the linked PingController so reveals stay in
 *      lockstep with the on-screen wavefront.
 *   4. Each card is a PremadeCard prefab instance dressed as a CLOSED BUBBLE that
 *      expands into a card on gaze and STAYS OPEN (collapseWhenGazeLost = false).
 *   5. The bubble/border color comes from TopicColors, keyed by the card's
 *      primary topic.
 *
 * This is independent of CardDeckController (the floating cosmos): it neither
 * reads nor writes the CardStore, it just instantiates visuals on demand. Trigger
 * it by giving PrayerGestureBehavior a reference to this component, or call
 * spawnWave(origin) from any script.
 *
 * Instantiation + getComponent(getTypeName()) mirrors CardDeckController; the
 * cylinder scatter mirrors BubbleField.randomCylinderPosition().
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger"
import animate, { CancelSet } from "SpectaclesInteractionKit.lspkg/Utils/animate"
import { PremadeCard } from "../PremadeCard/PremadeCard"
import { PingController } from "../PingController"
import { CARD_DECK_DATA, CardDeckEntry } from "../Cards/cardDeckData"
import { colorForTopics } from "../Interests/TopicColors"
import { BubbleField } from "../Bubbles/BubbleField"

// Fallback wavefront speed (cm/s) used only when no PingController is linked and
// no override is set. Matches PingController.pingSpeed's default.
const DEFAULT_WAVEFRONT_SPEED = 250

// Scale the popping card starts from (a hair above zero so the PremadeCard's
// border auto-fit, which divides by the root's world scale, never sees a zero).
const POP_START_SCALE = 0.02

@component
export class PingCardSpawner extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">PingCardSpawner – reveals location-filtered cards on the ping wavefront</span><br/><span style="color: #94A3B8; font-size: 11px;">Call spawnWave(origin) (e.g. from PrayerGestureBehavior). Filters cardDeckData by Location, scatters PremadeCard bubbles in a cylinder, and pops each one when the wavefront reaches it.</span>')
  @ui.separator

  @ui.label('<span style="color: #60A5FA;">References</span>')
  @input
  @hint("The PremadeCard prefab, instantiated once per matching card as a child of this object.")
  cardPrefab: ObjectPrefab

  @input
  @hint("Camera the cards billboard toward + use for gaze. Forwarded to each spawned card.")
  @allowUndefined
  cameraObject: SceneObject

  @input
  @hint("PingController whose pingSpeed times the reveals so cards appear with the visible wavefront. Optional — falls back to Wavefront Speed Override.")
  @allowUndefined
  pingController: PingController

  @input
  @hint("Placeholder image textures, assigned to the spawned cards in order (cycled). Fill the real images in later.")
  @allowUndefined
  placeholderImages: Texture[]

  @input
  @hint("Optional: put spawned cards on THIS object's render layer (e.g. the camera or any visible content object). Leave empty to keep the PremadeCard prefab's own layer — required when this spawner sits on a World Mesh / non-rendered object, otherwise the cards inherit that hidden layer and never draw.")
  @allowUndefined
  renderLayerSource: SceneObject

  @input
  @hint("Optional BubbleField(s) (e.g. a child of this spawner). Each gets spawnWave(origin) forwarded so its bubbles pop in on the same wavefront as the cards.")
  @allowUndefined
  bubbleFields: BubbleField[]

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Selection</span>')
  @input
  @hint("Only cards whose location matches this are spawned (case-insensitive). e.g. \"Seattle\" | \"Los Angeles\" | \"Tokyo\".")
  location: string = "Seattle"

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Spawn area (cylindrical pipe around this object)</span>')
  @input
  @hint("Minimum horizontal distance (cm) from this object a card can spawn — the pipe's inner wall.")
  minDistance: number = 80

  @input
  @hint("Maximum horizontal distance (cm) from this object a card can spawn — the pipe's outer wall.")
  maxDistance: number = 220

  @input
  @hint("Floor height (cm, local Y) — the bottom of the spawn pipe. May be negative (below the origin).")
  floorHeight: number = -50

  @input
  @hint("Ceiling height (cm, local Y) — the top of the spawn pipe.")
  ceilingHeight: number = 100

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Front-of-camera concentration</span>')
  @input
  @hint("Bias the cards into an arc toward where the camera is looking instead of scattering them evenly all around. Needs a Camera Object. Off = full 360° ring.")
  concentrateTowardFront: boolean = true

  @input
  @hint("Half-angle (degrees) of the arc cards spawn within, centered on the camera's view direction. 180 = full ring, 90 = front half, smaller = a tight cone dead-ahead.")
  frontArcHalfAngleDeg: number = 90

  @input
  @hint("How hard cards cluster toward dead-center of the arc. 0 = spread evenly across the arc, higher = packed near the center of view.")
  frontBias: number = 1.0

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Wavefront timing</span>')
  @input
  @hint("Override the wavefront speed (cm/s). 0 = read pingSpeed from the linked PingController (recommended so reveals match the visible ping).")
  wavefrontSpeedOverride: number = 0

  @input
  @hint("Extra seconds added to every reveal time. Nudge to fine-tune cards popping right ON the band vs slightly behind it.")
  revealOffsetSec: number = 0

  @input
  @hint("Seconds of the bubble's pop-in scale animation when it is revealed.")
  revealPopDuration: number = 0.5

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Card behaviour</span>')
  @input
  @hint("Displayed image width (cm) for each card; height follows the image aspect. 0 = keep the prefab's authored width.")
  imageWidth: number = 0

  @input
  @hint("Seconds the player must gaze at a bubble before it expands into a card.")
  gazeDwellSec: number = 1.0

  @input
  @hint("Half-angle (degrees) of the gaze cone that counts as 'looking at' a bubble.")
  gazeConeAngleDeg: number = 12

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Behaviour</span>')
  @input
  @hint("Allow a later wave to clear the previous cards and spawn again. Off = the first wave wins and later calls are ignored.")
  allowRespawn: boolean = false

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Logging</span>')
  @input
  @hint("Enable general logging")
  enableLogging: boolean = false

  @input
  @hint("Enable lifecycle logging (onAwake, onStart, onUpdate, onDestroy)")
  enableLoggingLifecycle: boolean = false

  private logger: Logger
  private isEditor = global.deviceInfoSystem.isEditor()
  private spawned = false
  private spawnedObjects: SceneObject[] = []
  private popCancels: CancelSet[] = []
  // Local-space azimuth (radians) pointing toward the camera's view direction,
  // computed once per wave so every card in that wave shares the same "front".
  // null = no concentration this wave (no camera, feature off, or degenerate).
  private frontAzimuthForWave: number | null = null

  onAwake() {
    this.logger = new Logger("PingCardSpawner", this.enableLogging || this.enableLoggingLifecycle, true)
    if (this.enableLoggingLifecycle) this.logger.debug("LIFECYCLE: onAwake()")

    if (this.isEditor) {
      // No prayer/ping hand-tracking in the editor: tap anywhere to fire a wave
      // from the camera (the on-device ping origin is the player's head).
      this.createEvent("TouchStartEvent").bind(() => this.spawnWave(this.editorOrigin()))
    }
  }

  // --- public API ------------------------------------------------------------

  /**
   * Spawns the wave from `origin` (the ping origin — the player's head). Cards
   * are scheduled to pop as the wavefront passes them. Safe to call with no
   * origin (falls back to this object's world position).
   */
  spawnWave(origin: vec3): void {
    if (this.spawned && !this.allowRespawn) {
      this.logger.info("spawnWave ignored — already spawned (enable Allow Respawn to re-fire).")
      return
    }
    if (this.spawned && this.allowRespawn) this.clearSpawned()

    if (!this.cardPrefab) {
      this.logger.warn("No cardPrefab assigned; cannot spawn cards.")
      return
    }

    const from = origin ? new vec3(origin.x, origin.y, origin.z) : this.worldOrigin()
    // Bubbles ride the same wavefront origin; forward even when no cards match so
    // the bubble field still reacts to the ping.
    this.forwardWaveToBubbles(from)
    const entries = this.entriesForLocation()
    if (entries.length === 0) {
      this.logger.info("No cards match location \"" + this.location + "\"; nothing to spawn.")
      this.spawned = true
      return
    }

    const speed = this.wavefrontSpeed()
    const toWorld = this.getSceneObject().getTransform().getWorldTransform()
    // Resolve "front" once so all cards in this wave land in the same arc.
    this.frontAzimuthForWave = this.computeFrontAzimuth()

    for (let i = 0; i < entries.length; i++) {
      const localPos = this.randomCylinderPosition()
      const worldPos = toWorld.multiplyPoint(localPos)
      const dist = worldPos.distance(from)
      const delay = Math.max(0, dist / speed + this.revealOffsetSec)
      this.scheduleSpawn(entries[i], i, localPos, delay)
    }

    this.spawned = true
    this.logger.info("Wave: " + entries.length + " card(s) for \"" + this.location + "\" at " + speed.toFixed(0) + " cm/s.")
  }

  /** Destroys every spawned card and resets so a fresh wave can be fired. */
  clearSpawned(): void {
    for (const c of this.popCancels) c.cancel()
    this.popCancels = []
    for (const obj of this.spawnedObjects) {
      if (obj) obj.destroy()
    }
    this.spawnedObjects = []
    this.spawned = false
  }

  // --- internal --------------------------------------------------------------

  // Hands the wave origin to every linked BubbleField so its bubbles spawn out on
  // the same expanding wavefront as the cards.
  private forwardWaveToBubbles(origin: vec3): void {
    if (!this.bubbleFields) return
    for (const field of this.bubbleFields) {
      if (field) field.spawnWave(origin)
    }
  }

  // Defers the actual instantiate to the moment the wavefront arrives, so the
  // card literally comes into existence on the band. Delay 0 spawns immediately.
  private scheduleSpawn(entry: CardDeckEntry, index: number, localPos: vec3, delay: number): void {
    if (delay <= 0) {
      this.spawnOne(entry, index, localPos)
      return
    }
    const ev = this.createEvent("DelayedCallbackEvent")
    ev.bind(() => this.spawnOne(entry, index, localPos))
    ev.reset(delay)
  }

  private spawnOne(entry: CardDeckEntry, index: number, localPos: vec3): void {
    const parent = this.getSceneObject()
    const obj = this.cardPrefab.instantiate(parent)
    obj.name = "PingCard_" + entry.id
    // The prefab is authored from a DISABLED scene instance, so instances spawn
    // disabled. Force-enable on spawn so the card (and its PremadeCard lifecycle)
    // actually runs and renders.
    obj.enabled = true
    // Keep the prefab's authored (camera-rendered) layer by default. Only force a
    // layer when an explicit source is given. Inheriting the PARENT's layer breaks
    // when the spawner lives on a World Mesh object whose layer the display camera
    // does not draw as content (cards would spawn but stay invisible).
    if (this.renderLayerSource) obj.layer = this.renderLayerSource.layer

    const trans = obj.getTransform()
    trans.setLocalPosition(localPos)

    const card = obj.getComponent(PremadeCard.getTypeName()) as unknown as PremadeCard
    if (card) {
      this.dressCard(obj, card, entry, index)
    } else {
      this.logger.warn("Spawned card " + entry.id + " has no PremadeCard component.")
    }

    this.spawnedObjects.push(obj)
    this.popIn(trans)
  }

  // Configures a freshly-instantiated card: a closed bubble that expands on gaze
  // and STAYS OPEN once expanded, billboarding to the camera, colored by topic.
  private dressCard(obj: SceneObject, card: PremadeCard, entry: CardDeckEntry, index: number): void {
    card.billboard = true
    card.startExpanded = false
    card.gazeToExpand = true
    card.collapseWhenGazeLost = false // once opened, stays opened
    card.gazeDwell = this.gazeDwellSec
    card.gazeConeAngleDeg = this.gazeConeAngleDeg
    if (this.cameraObject) card.setCamera(this.cameraObject)

    // Apply content now AND again next frame. The prefab is authored disabled, so
    // its PremadeCard.onAwake (which resets currentImage/currentText to the prefab
    // defaults) runs on enable — possibly AFTER this call. Re-applying once the
    // lifecycle has settled guarantees the card shows this entry's image/text, not
    // the prefab defaults. Content is hidden until gaze-expand, so there is no flash.
    this.applyCardContent(card, entry, index)
    const ev = this.createEvent("DelayedCallbackEvent")
    ev.bind(() => {
      if (this.spawnedObjects.indexOf(obj) < 0) return // cleared/destroyed meanwhile
      this.applyCardContent(card, entry, index)
    })
    ev.reset(0)
  }

  private applyCardContent(card: PremadeCard, entry: CardDeckEntry, index: number): void {
    if (this.imageWidth > 0) card.setImageWidth(this.imageWidth)
    const tex = this.placeholderImageFor(index)
    if (tex) card.setImage(tex)
    card.setText(entry.text)
    card.setBorderColor(colorForTopics(entry.topics))
  }

  // Pops the card open from near-zero to its authored scale for a "spawn" feel.
  private popIn(trans: Transform): void {
    const fullScale = trans.getLocalScale()
    const start = fullScale.uniformScale(POP_START_SCALE)
    trans.setLocalScale(start)

    const cancel = new CancelSet()
    this.popCancels.push(cancel)
    animate({
      easing: "ease-out-elastic",
      duration: Math.max(0.01, this.revealPopDuration),
      update: (t: number) => {
        trans.setLocalScale(vec3.lerp(start, fullScale, t))
      },
      ended: null,
      cancelSet: cancel,
    })
  }

  private entriesForLocation(): CardDeckEntry[] {
    const key = (this.location ?? "").trim().toLowerCase()
    return CARD_DECK_DATA.filter((e) => e.location.trim().toLowerCase() === key)
  }

  private wavefrontSpeed(): number {
    if (this.wavefrontSpeedOverride > 0) return this.wavefrontSpeedOverride
    if (this.pingController && this.pingController.pingSpeed > 0) return this.pingController.pingSpeed
    return DEFAULT_WAVEFRONT_SPEED
  }

  private placeholderImageFor(i: number): Texture | undefined {
    const imgs = this.placeholderImages
    if (!imgs || imgs.length === 0) return undefined
    return imgs[i % imgs.length]
  }

  // Scatter within a vertical "pipe": a ring in the XZ plane between the inner
  // and outer wall, at a random height between floor and ceiling. sqrt(rand)
  // keeps the radial distribution area-uniform. Mirrors BubbleField.
  private randomCylinderPosition(): vec3 {
    const inner = Math.max(0, Math.min(this.minDistance, this.maxDistance))
    const outer = Math.max(this.minDistance, this.maxDistance)
    const theta = this.sampleAzimuth()
    const t = Math.sqrt(Math.random())
    const r = inner + (outer - inner) * t
    const low = Math.min(this.floorHeight, this.ceilingHeight)
    const high = Math.max(this.floorHeight, this.ceilingHeight)
    const y = low + Math.random() * (high - low)
    return new vec3(r * Math.cos(theta), y, r * Math.sin(theta))
  }

  // Picks a ring angle. With no front concentration this is a plain full-circle
  // random; otherwise it draws from an arc centered on the camera's view
  // direction, optionally clustered toward dead-center by `frontBias`.
  private sampleAzimuth(): number {
    const center = this.frontAzimuthForWave
    if (center === null) return Math.random() * Math.PI * 2
    const half = (Math.max(0, Math.min(180, this.frontArcHalfAngleDeg)) * Math.PI) / 180
    // u in [-1, 1]; raising |u| to a power >1 pulls samples toward 0 (the center
    // of the arc) so a higher bias packs cards in front of the viewer.
    const u = Math.random() * 2 - 1
    const sign = u < 0 ? -1 : 1
    const mag = Math.pow(Math.abs(u), 1 + Math.max(0, this.frontBias))
    return center + sign * mag * half
  }

  // Local-space azimuth (atan2(z, x), matching randomCylinderPosition) that points
  // toward where the camera is looking. The camera views along -forward in this
  // project, and the direction is expressed in this object's local frame so the
  // arc tracks the head regardless of how the spawner itself is oriented.
  private computeFrontAzimuth(): number | null {
    if (!this.concentrateTowardFront || !this.cameraObject) return null
    const worldFront = this.cameraObject.getTransform().forward.uniformScale(-1)
    const inv = this.getSceneObject().getTransform().getInvertedWorldTransform()
    const localFront = inv.multiplyDirection(worldFront)
    if (Math.sqrt(localFront.x * localFront.x + localFront.z * localFront.z) < 1e-4) {
      return null // camera looking straight up/down: no meaningful horizontal front
    }
    return Math.atan2(localFront.z, localFront.x)
  }

  private worldOrigin(): vec3 {
    return this.getSceneObject().getTransform().getWorldPosition()
  }

  private editorOrigin(): vec3 {
    if (this.cameraObject) return this.cameraObject.getTransform().getWorldPosition()
    return this.worldOrigin()
  }
}
