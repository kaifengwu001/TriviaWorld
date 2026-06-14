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
 *   1. Build a list of spawn items from ONE of two content sources (toggle
 *      `useCustomContent`):
 *        a. cardDeckData — filter CARD_DECK_DATA to entries whose `location`
 *           matches (case-insensitive); text+topics come from the deck, images
 *           from the positional `placeholderImages` list (cycled).
 *        b. Custom arrays — `customImages` / `customTexts` / `customTopics`,
 *           paired BY INDEX and edited right here in Lens Studio.
 *   2. Apply the spawn-count mode: spawn each item once (default); OR, with
 *      `singleRepeat`, repeat just the card at `singleRepeatIndex`
 *      `targetSpawnCount` times; OR, with `randomizeRepeats`, draw at random
 *      (with repetition) until `targetSpawnCount` cards are produced.
 *   3. Scatter each card at a random point inside a cylindrical "pipe" around
 *      this object — the same spawn-area shape as BubbleField.
 *   4. For each card, schedule its reveal at distance(origin -> card) / speed,
 *      where speed is read from the linked PingController so reveals stay in
 *      lockstep with the on-screen wavefront.
 *   5. Each card is a PremadeCard prefab instance dressed as a CLOSED BUBBLE that
 *      expands into a card on gaze and STAYS OPEN (collapseWhenGazeLost = false).
 *   6. The bubble/border color is auto-detected from the card's primary topic via
 *      TopicColors, OR (with `randomizeBorderColors`) a random preset-topic color
 *      that ignores the card's real topic.
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
import { colorForTopic, colorForTopics } from "../Interests/TopicColors"
import { DEFAULT_TOPICS } from "../Interests/InterestTopics"
import { BubbleField } from "../Bubbles/BubbleField"

// Fallback wavefront speed (cm/s) used only when no PingController is linked and
// no override is set. Matches PingController.pingSpeed's default.
const DEFAULT_WAVEFRONT_SPEED = 250

// Scale the popping card starts from (a hair above zero so the PremadeCard's
// border auto-fit, which divides by the root's world scale, never sees a zero).
const POP_START_SCALE = 0.02

// Rejection-sampling budget per card when enforcing a minimum angular gap. After
// this many tries we keep the most-separated candidate so spawning never stalls.
const SEPARATION_MAX_ATTEMPTS = 24

// One per spawned card: the "Look to Open" + distance label hung under the
// closed bubble. It billboards/pops with the card (it is a child of the root)
// and is dropped from updates the moment the card expands.
interface CardLabel {
  obj: SceneObject
  text: Text
  card: PremadeCard
  cardTrans: Transform
}

// Raw, pre-resolved content for one card, sourced from either cardDeckData or the
// custom arrays, BEFORE the spawn-count mode and border color are applied.
interface RawItem {
  id: string
  image?: Texture
  text: string
  topics: string[]
}

// A fully-resolved card ready to spawn: image + text + a FROZEN border color
// (resolved once so the closed bubble never flickers between content-apply passes).
interface SpawnItem {
  id: string
  image?: Texture
  text: string
  borderColor: vec4
}

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
  @hint("cardDeckData path only (Use Custom Content OFF): image textures assigned to the spawned cards in order (cycled). Fill the real images in later.")
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
  @ui.label('<span style="color: #60A5FA;">Content source</span>')
  @input
  @hint("OFF = spawn from cardDeckData filtered by Location (text + topics from the deck, images from Placeholder Images). ON = spawn from the Custom Content arrays below, edited right here in Lens Studio.")
  useCustomContent: boolean = false

  @input
  @hint("cardDeckData path only (Use Custom Content OFF): only cards whose location matches this are spawned (case-insensitive). e.g. \"Seattle\" | \"Los Angeles\" | \"Tokyo\".")
  location: string = "Seattle"

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Custom content (Use Custom Content ON)</span>')
  @input
  @hint("One image texture per card, paired BY INDEX with Custom Texts (card 0 -> image 0 + text 0). Drag the real textures here.")
  @allowUndefined
  customImages: Texture[]

  @input
  @hint("One caption per card, paired BY INDEX with Custom Images. End each with a #hashtag line if you also want topic-based border colors.")
  customTexts: string[]

  @input
  @hint("OPTIONAL topic per card (same index), e.g. \"Space\", used ONLY to pick the border color in auto-by-topic mode. Leave blank for a neutral border. Ignored when Randomize Border Colors is ON.")
  customTopics: string[]

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Spawn count</span>')
  @input
  @hint("OFF = spawn each item in the content list exactly once. ON = randomly draw from the list (WITH repeats) until Target Spawn Count cards have spawned.")
  randomizeRepeats: boolean = false

  @input
  @hint("OFF = use the whole list. ON = ignore the list and repeat ONLY the card (image+text pair) at Single Repeat Index, Target Spawn Count times. Takes priority over Randomize Repeats, and works with both border color modes.")
  singleRepeat: boolean = false

  @input
  @hint("Single Repeat ON only: 0-based index in the content list of the card (image+text pair) to repeat. Clamped to the list range.")
  singleRepeatIndex: number = 0

  @input
  @hint("How many cards to spawn for Randomize Repeats (random sampling with repetition) OR Single Repeat (copies of one card). Ignored when both are OFF.")
  targetSpawnCount: number = 12

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Border color</span>')
  @input
  @hint("OFF = border color is auto-detected from the card's primary topic. ON = each card gets a RANDOM topic color from the preset palette, ignoring its real topic.")
  randomizeBorderColors: boolean = false

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

  @input
  @hint("Minimum angular gap (degrees, as seen from the camera) kept between any two spawned bubbles so they spread out on screen instead of bunching. 0 = no spacing. Best-effort: relaxed when there isn't room for every card.")
  minAngularSeparationDeg: number = 0

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

  @input
  @hint("Rotational DEADZONE (degrees) for each spawned card's billboard: a card holds its facing until the direction to the camera has changed by more than this, then re-aims. Generous values (8-20) keep the scattered field visually steady and skip the per-frame quat write. 0 = re-aim every frame.")
  billboardDeadzoneDeg: number = 12

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Distance label</span>')
  @input
  @hint("Attach a two-line label under each closed bubble (1st line = the prompt, 2nd = live distance to the camera). It vanishes when the bubble expands into a card.")
  showDistanceLabel: boolean = true

  @input
  @hint("First line of the label (the call-to-action shown above the distance).")
  labelLine1: string = "Look to Open"

  @input
  @hint("Font size (points) for the label text.")
  labelFontSize: number = 36

  @input
  @hint("How far below the bubble the label sits, in the card's local units. Increase to push it further down.")
  labelVerticalOffset: number = 8

  @input
  @hint("Label text color (RGBA).")
  labelColor: vec4 = new vec4(1, 1, 1, 1)

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
  // Active distance labels, ticked every frame. Expanded cards' labels are
  // hidden and removed from this list so they stop updating.
  private labels: CardLabel[] = []
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

    // Refresh each label's distance text and drop it once its card expands.
    this.createEvent("UpdateEvent").bind(() => this.updateLabels())
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
    const items = this.buildSpawnItems()
    if (items.length === 0) {
      this.logger.info("No content to spawn (" + this.contentSourceLabel() + ").")
      this.spawned = true
      return
    }

    const speed = this.wavefrontSpeed()
    const toWorld = this.getSceneObject().getTransform().getWorldTransform()
    // Resolve "front" once so all cards in this wave land in the same arc.
    this.frontAzimuthForWave = this.computeFrontAzimuth()

    // Spread is measured from the camera (falls back to the ping origin), and the
    // accepted view directions accumulate so each new card avoids the earlier ones.
    const camPos = this.cameraObject ? this.cameraObject.getTransform().getWorldPosition() : from
    const acceptedDirs: vec3[] = []

    for (let i = 0; i < items.length; i++) {
      const localPos = this.sampleSeparatedPosition(toWorld, camPos, acceptedDirs)
      const worldPos = toWorld.multiplyPoint(localPos)
      const dist = worldPos.distance(from)
      const delay = Math.max(0, dist / speed + this.revealOffsetSec)
      this.scheduleSpawn(items[i], localPos, delay)
    }

    this.spawned = true
    this.logger.info("Wave: " + items.length + " card(s) (" + this.contentSourceLabel() + ") at " + speed.toFixed(0) + " cm/s.")
  }

  /** Destroys every spawned card and resets so a fresh wave can be fired. */
  clearSpawned(): void {
    for (const c of this.popCancels) c.cancel()
    this.popCancels = []
    for (const obj of this.spawnedObjects) {
      if (obj) obj.destroy()
    }
    this.spawnedObjects = []
    // Label objects are children of the destroyed cards, so just drop the refs.
    this.labels = []
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
  private scheduleSpawn(item: SpawnItem, localPos: vec3, delay: number): void {
    if (delay <= 0) {
      this.spawnOne(item, localPos)
      return
    }
    const ev = this.createEvent("DelayedCallbackEvent")
    ev.bind(() => this.spawnOne(item, localPos))
    ev.reset(delay)
  }

  private spawnOne(item: SpawnItem, localPos: vec3): void {
    const parent = this.getSceneObject()
    const obj = this.cardPrefab.instantiate(parent)
    obj.name = "PingCard_" + item.id
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
      this.dressCard(obj, card, item)
      this.attachDistanceLabel(obj, card)
    } else {
      this.logger.warn("Spawned card " + item.id + " has no PremadeCard component.")
    }

    this.spawnedObjects.push(obj)
    this.popIn(trans)
  }

  // Hangs a centered two-line label under the closed bubble. Parenting it to the
  // card root means it inherits the card's billboard + pop-in for free and is
  // destroyed with the card; the layer is matched so it draws wherever the card
  // does. The distance line is filled in (and refreshed) by updateLabels().
  private attachDistanceLabel(obj: SceneObject, card: PremadeCard): void {
    if (!this.showDistanceLabel) return

    const labelObj = global.scene.createSceneObject("PingCardLabel")
    labelObj.setParent(obj)
    labelObj.layer = obj.layer
    labelObj.getTransform().setLocalPosition(new vec3(0, -this.labelVerticalOffset, 0))

    const text = labelObj.createComponent("Component.Text") as Text
    text.horizontalAlignment = HorizontalAlignment.Center
    text.verticalAlignment = VerticalAlignment.Center
    text.size = Math.max(1, Math.round(this.labelFontSize))
    text.textFill.color = this.labelColor
    text.text = this.labelLine1 + "\n--"

    this.labels.push({ obj: labelObj, text, card, cardTrans: obj.getTransform() })
  }

  // Per-frame: rewrites each label's distance line and removes labels whose card
  // has expanded (those are hidden permanently — cards here stay open).
  private updateLabels(): void {
    if (this.labels.length === 0) return
    const camTrans = this.cameraObject ? this.cameraObject.getTransform() : null
    const camPos = camTrans ? camTrans.getWorldPosition() : null

    const survivors: CardLabel[] = []
    for (const label of this.labels) {
      if (!label.obj) continue
      // Drop the label the instant the bubble begins morphing (progress leaves 0),
      // not when it finishes opening.
      if (label.card && label.card.getMorphProgress() > 0) {
        label.obj.enabled = false
        continue
      }
      if (camPos) {
        const meters = label.cardTrans.getWorldPosition().distance(camPos) / 100
        label.text.text = this.labelLine1 + "\n" + meters.toFixed(1) + " m"
      }
      survivors.push(label)
    }
    this.labels = survivors
  }

  // Configures a freshly-instantiated card: a closed bubble that expands on gaze
  // and STAYS OPEN once expanded, billboarding to the camera, colored by topic.
  private dressCard(obj: SceneObject, card: PremadeCard, item: SpawnItem): void {
    card.billboard = true
    card.setBillboardDeadzone(this.billboardDeadzoneDeg) // generous deadzone: hold facing, skip per-frame re-aim
    card.startExpanded = false
    card.gazeToExpand = true
    card.collapseWhenGazeLost = false // once opened, stays opened
    card.gazeDwell = this.gazeDwellSec
    card.gazeConeAngleDeg = this.gazeConeAngleDeg
    if (this.cameraObject) card.setCamera(this.cameraObject)
    // Discovered cards are tappable once opened: a tap hands the caption to the
    // CardVoiceAgent for a conversation (cosmos / CoverFlow cards never opt in).
    card.enableTapToEngage()

    // Apply content now AND again next frame. The prefab is authored disabled, so
    // its PremadeCard.onAwake (which resets currentImage/currentText to the prefab
    // defaults) runs on enable — possibly AFTER this call. Re-applying once the
    // lifecycle has settled guarantees the card shows this entry's image/text, not
    // the prefab defaults. Content is hidden until gaze-expand, so there is no flash.
    this.applyCardContent(card, item)
    const ev = this.createEvent("DelayedCallbackEvent")
    ev.bind(() => {
      if (this.spawnedObjects.indexOf(obj) < 0) return // cleared/destroyed meanwhile
      this.applyCardContent(card, item)
    })
    ev.reset(0)
  }

  private applyCardContent(card: PremadeCard, item: SpawnItem): void {
    if (this.imageWidth > 0) card.setImageWidth(this.imageWidth)
    if (item.image) card.setImage(item.image)
    card.setText(item.text)
    card.setBorderColor(item.borderColor)
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

  // Builds the final, ready-to-spawn list from whichever content source is
  // selected, applies the spawn-count mode, then freezes a stable border color +
  // unique id on each card.
  private buildSpawnItems(): SpawnItem[] {
    const raw = this.useCustomContent ? this.customRawItems() : this.deckRawItems()
    const expanded = this.applyCountMode(raw)
    // Single repeat and random repeats both reuse ids, so suffix them to keep
    // scene-object names unique. The border color is resolved per FINAL card, so
    // random-color mode still gives each repeated copy its own hue.
    const suffix = this.singleRepeat || this.randomizeRepeats
    return expanded.map((r, i) => ({
      id: suffix ? r.id + "_" + i : r.id,
      image: r.image,
      text: r.text,
      borderColor: this.resolveBorderColor(r.topics),
    }))
  }

  // Applies the spawn-count mode to the raw list. Single Repeat wins over
  // Randomize Repeats; with both off the list is spawned once each.
  private applyCountMode(raw: RawItem[]): RawItem[] {
    if (raw.length === 0) return raw
    if (this.singleRepeat) return this.repeatSingle(raw, this.singleRepeatIndex, this.targetSpawnCount)
    if (this.randomizeRepeats) return this.expandByRandomSampling(raw, this.targetSpawnCount)
    return raw
  }

  // Repeats ONLY the card at `index` (clamped to the list) `count` times.
  private repeatSingle(base: RawItem[], index: number, count: number): RawItem[] {
    const idx = Math.max(0, Math.min(Math.floor(index), base.length - 1))
    const n = Math.max(0, Math.floor(count))
    const item = base[idx]
    const out: RawItem[] = []
    for (let i = 0; i < n; i++) out.push(item)
    return out
  }

  // cardDeckData path: every entry for this Location, image pulled from the
  // positional Placeholder Images list (cycled) — unchanged from before.
  private deckRawItems(): RawItem[] {
    return this.entriesForLocation().map((e, i) => ({
      id: e.id,
      image: this.placeholderImageFor(i),
      text: e.text,
      topics: e.topics,
    }))
  }

  // Custom path: paired BY INDEX from the Lens-Studio-editable arrays. Length is
  // driven by whichever of images/texts is longer; a missing entry is tolerated.
  private customRawItems(): RawItem[] {
    const images = this.customImages ?? []
    const texts = this.customTexts ?? []
    const topics = this.customTopics ?? []
    const count = Math.max(images.length, texts.length)
    const out: RawItem[] = []
    for (let i = 0; i < count; i++) {
      const topic = (topics[i] ?? "").trim()
      out.push({
        id: "custom_" + (i + 1),
        image: images[i],
        text: texts[i] ?? "",
        topics: topic.length > 0 ? [topic] : [],
      })
    }
    return out
  }

  // Draws `count` items at random (WITH repetition) from the base list, so a small
  // authored list can fill a large wave.
  private expandByRandomSampling(base: RawItem[], count: number): RawItem[] {
    const n = Math.max(0, Math.floor(count))
    const out: RawItem[] = []
    for (let i = 0; i < n; i++) {
      out.push(base[Math.floor(Math.random() * base.length)])
    }
    return out
  }

  // Resolves a card's border color: by topic (auto) or a random preset-topic color
  // that ignores the card's real topic. Called once per card so the closed bubble's
  // color never flickers between the two content-apply passes.
  private resolveBorderColor(topics: string[]): vec4 {
    if (this.randomizeBorderColors) return colorForTopic(this.randomPresetTopic())
    return colorForTopics(topics)
  }

  private randomPresetTopic(): string {
    const list = DEFAULT_TOPICS
    if (!list || list.length === 0) return ""
    return list[Math.floor(Math.random() * list.length)]
  }

  private contentSourceLabel(): string {
    return this.useCustomContent ? "custom content" : 'deck "' + this.location + '"'
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

  // Draws a cylinder position whose direction-from-camera stays at least
  // `minAngularSeparationDeg` away from every already-accepted card. Rejection
  // sampling with a fixed budget: if no clear spot is found we keep the candidate
  // that sat furthest from its nearest neighbour, so a packed wave still spawns.
  private sampleSeparatedPosition(toWorld: mat4, camPos: vec3, acceptedDirs: vec3[]): vec3 {
    if (this.minAngularSeparationDeg <= 0) {
      return this.randomCylinderPosition()
    }
    const minCos = Math.cos((Math.min(180, this.minAngularSeparationDeg) * Math.PI) / 180)

    let bestPos: vec3 = null
    let bestDir: vec3 = null
    let bestMaxDot = Infinity // smaller max-dot = further from the nearest neighbour

    for (let attempt = 0; attempt < SEPARATION_MAX_ATTEMPTS; attempt++) {
      const localPos = this.randomCylinderPosition()
      const dir = toWorld.multiplyPoint(localPos).sub(camPos).normalize()

      let maxDot = -Infinity
      for (const d of acceptedDirs) {
        const dot = dir.dot(d)
        if (dot > maxDot) maxDot = dot
      }

      if (maxDot <= minCos) {
        acceptedDirs.push(dir)
        return localPos
      }
      if (maxDot < bestMaxDot) {
        bestMaxDot = maxDot
        bestPos = localPos
        bestDir = dir
      }
    }

    acceptedDirs.push(bestDir)
    return bestPos
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
