/**
 * Specs Inc. 2026
 * CardDeckController – the premade card cloud above the globe.
 *
 * On start it instantiates the PremadeCard prefab once per CARD_DECK_DATA entry,
 * parents them under this object, gives each placeholder image + text, and
 * registers a record in the CardStore. SEED_CARDS are registered too but not
 * spawned (e.g. the standalone PremadeCard already in the scene).
 *
 * REST MODE: every card is ALWAYS expanded (never a bubble). The cards wrap on a
 * CYLINDER around the user's head at roughly the globe's distance, centred
 * slightly above the globe, spanning ~3x the camera FoV horizontally so the edge
 * cards sit off to the sides (you turn your head to see them). Each card's size is
 * its displayed IMAGE WIDTH (cardImageWidthCm x a per-card variety multiplier); the
 * cylinder DISTANCE is an independent knob.
 * Positions come from a relevance-clustered, non-overlapping layout (topic-
 * primary, location + date as tie-breakers) solved once in angular space. Each
 * card billboards individually to face the user and sways gently; nothing orbits.
 *
 * CAPTURED CARDS: cards captured this session live in the persistent CardStore
 * (capture and deck-view are separate SceneSwitcher scenes, never enabled at the
 * same time, so the always-on store is their only shared state). Each visible
 * frame the deck polls CardStore.getCapturedVersion(); when it changes it spawns a
 * slot for every captured record it lacks and re-solves the WHOLE layout once via
 * buildWrappedLayout(), so captured cards cluster in among their relatives instead
 * of being patched into a leftover gap. Because update() only ticks while the deck
 * is shown, this fires the moment the deck scene is switched on (and live too, if
 * both ever run together). A re-shuffle requested while a query result deck is up
 * is deferred until clearQueryResults() so it never disrupts the results.
 *
 * QUERY MODE (driven by QueryOrchestrator / CardQueryVoiceAgent): the matching
 * cards fly out into an iPod-style CoverFlow deck in front of the user
 * (showQueryResults): one card is centred and faces the user ("in selection"),
 * while the rest fold toward centre, shrink, and recede with distance. The user
 * pinch-drags to scrub through them (snap-to-nearest on release); getFocusedResultId
 * reports the centred card so the agent's context follows the selection. The deck is
 * snapshot onto a frozen world frame so it stays put when the head turns. The rest of
 * the plane holds still; clearQueryResults eases them back to their plane spot. Cards
 * stay expanded throughout — they never collapse.
 *
 * Prefab instantiation + getComponent(getTypeName()) mirror GlobeController's
 * ensureMarkers(); the global-store lookup mirrors InterestStore's pattern.
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger";
import { SIK } from "SpectaclesInteractionKit.lspkg/SIK";
import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import { PremadeCard } from "../PremadeCard/PremadeCard";
import { GlobeView } from "../Globe/GlobeView";
import { PinchDragTracker } from "../Globe/PinchDragTracker";
import { CARD_DECK_DATA, SEED_CARDS, CardDeckEntry } from "./cardDeckData";
import { CardRecord } from "./CardStore";
import { colorForTopics } from "../Interests/TopicColors";

const DEG2RAD = Math.PI / 180

// A PremadeCard composes correctly (image contained, caption below it, border auto-fit
// around both) at its AUTHORED root scale — exactly what PingCardSpawner.popIn keeps. So
// the deck never shrinks the card root: every card stays at world scale 1, and its size is
// set the supported way, via setImageWidth() (the picture, caption wrap, and border all
// follow). The cylinder DISTANCE is then an independent knob.
const AUTHORED_WORLD_SCALE = 1

/** Per-card state for the flat-plane layout. */
interface DeckSlot {
  obj: SceneObject
  card: PremadeCard
  trans: Transform
  entry: CardDeckEntry
  // Per-card random size multiplier (variety); scales the angular size + footprint.
  sizeScale: number
  // Settled angular position on the cylinder (degrees): azimuth + elevation.
  azDeg: number
  elDeg: number
  // Fixed world position for this card on the cylinder; set on build.
  base: vec3
  // Gentle in-place sway.
  clock: number
  swayPhase: number
  swayPhase2: number
  swayFreq: number
  swayAmp: number
  // True while this card is pulled out as a query result (front row, in front).
  isResult: boolean
  // Last render order pushed to the card while it's a CoverFlow result (-1 = unset),
  // so we only re-push on change instead of every frame.
  renderOrder: number
}

@component
export class CardDeckController extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">CardDeckController – the flat plane of premade cards above the globe</span><br/><span style="color: #94A3B8; font-size: 11px;">Spawns the PremadeCard prefab per cardDeckData entry, registers each in global.cropCardStore, and lays them out clustered by relevance.</span>')
  @ui.separator

  @ui.label('<span style="color: #60A5FA;">References</span>')
  @input
  @hint("The PremadeCard prefab, instantiated once per deck entry as a child of this object.")
  cardPrefab: ObjectPrefab

  @input
  @hint("Placeholder image textures, assigned to the cards in order (cycled if fewer than the deck size). Fill the real images in later.")
  @allowUndefined
  placeholderImages: Texture[]

  @input
  @hint("Camera the cards billboard toward + use for gaze. Forwarded to each spawned card.")
  @allowUndefined
  cameraObject: SceneObject

  @input
  @hint("GlobeView whose top surface point anchors the plane. If unset, Center Object (or this object) is used.")
  @allowUndefined
  globeView: GlobeView

  @input
  @hint("Fallback anchor for the plane when no GlobeView is set.")
  @allowUndefined
  centerObject: SceneObject

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Wrap placement (cylinder around the head)</span>')
  @input
  @hint("Radius (cm) of the cylinder the cards wrap on = how far the cards are from your head. 0 = auto (the globe's distance). Independent of card size now — size is the image width below; push this out to move the whole field farther away.")
  cardDistanceCm: number = 0

  @input
  @hint("Per-card depth spread (cm) by size: the BIGGEST card sits this much CLOSER than the cylinder radius and the SMALLEST this much FARTHER (a card mid-range stays on the radius). 0 = every card on the same cylinder. Size = its image-width multiplier (min/max below).")
  cardDistanceVariationCm: number = 30

  @input
  @hint("How far (cm) ABOVE the globe top the field is vertically centred.")
  verticalCenterRiseCm: number = 20

  @ui.label('<span style="color: #60A5FA;">Cylinder wall (wraps around the head, above the globe)</span>')
  @input
  @hint("Fixed HEIGHT (cm) of the cylinder-wall band. Vertical extent is fixed; cards spread sideways as needed to avoid overlap.")
  canvasHeightCm: number = 20

  @input
  @hint("Extra spacing (cm) kept between cards on top of each card's REAL measured footprint. THE spacing knob now — raise it to spread cards apart, 0 = cards packed just shy of touching.")
  cardGapCm: number = 0

  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Card size = the displayed IMAGE WIDTH; the picture, caption wrap, and auto-fit border all follow from it. The card root stays at its authored scale (no root shrinking).</span>')
  @input
  @hint("Base displayed image width for each card; height follows the image aspect, and the caption + auto-fit border size around it. THE size knob (smaller = smaller cards). The prefab's ImageAnchor scales the picture ~10x, so the on-screen card is larger than this raw number. Each card varies by its random multiplier (min/max below). NOTE: set this in the Inspector (editing the code default does nothing once the component is in the scene).")
  cardImageWidthCm: number = 3

  @input
  @hint("Smallest per-card size multiplier (variety): multiplies the base image width. Each card picks a random factor between this and the max.")
  cardSizeMinScale: number = 0.3

  @input
  @hint("Largest per-card size multiplier (variety): multiplies the base image width.")
  cardSizeMaxScale: number = 1.0

  @input
  @hint("FALLBACK card footprint WIDTH (cm), used only for a card that hasn't measured its real size (e.g. border auto-fit off). Measured cards ignore this.")
  cardWidthCm: number = 10

  @input
  @hint("FALLBACK card footprint HEIGHT (cm), used only for a card that hasn't measured its real size. Measured cards ignore this.")
  cardHeightCm: number = 15

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Gaze focus (cards near your view centre grow)</span>')
  @input
  @hint("Grow resting cards that fall within a cone around the camera's view centre, biggest at the centre.")
  gazeScaleEnabled: boolean = true

  @input
  @hint("Half-angle (degrees) of the gaze cone around the view centre. Cards inside it grow; cards outside stay at their resting size.")
  gazeScaleConeDeg: number = 18

  @input
  @hint("Scale multiplier applied to the card EXACTLY at the view centre (1 = no growth). Falls off smoothly to 1 at the cone edge.")
  gazeScaleMaxBoost: number = 1.6

  @input
  @hint("How quickly a card eases to its gaze-target size (higher = snappier).")
  gazeScaleEaseRate: number = 8

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Relevance (clustering)</span>')
  @input
  @hint("Weight of shared topics in the relevance score (primary signal).")
  topicWeight: number = 0.7

  @input
  @hint("Weight of same-location in the relevance score.")
  locationWeight: number = 0.2

  @input
  @hint("Weight of capture-date closeness in the relevance score.")
  dateWeight: number = 0.1

  @input
  @hint("Date span (days) over which closeness fades to zero — dates farther apart than this count as unrelated in time.")
  dateRangeDays: number = 120

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Gentle motion</span>')
  @input
  @hint("In-place sway amplitude (cm). Keep small so cards never drift into each other.")
  swayAmplitudeCm: number = 1.2

  @input
  @hint("Slowest sway frequency (radians/sec).")
  swayFreqMin: number = 0.3

  @input
  @hint("Fastest sway frequency (radians/sec).")
  swayFreqMax: number = 0.7

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Query results (driven by CardQueryVoiceAgent)</span>')
  @input
  @hint("While the agent is searching, the gentle sway is sped up by this factor to signal 'working on it'.")
  searchSpinMultiplier: number = 3.5

  @input
  @hint("HORIZONTAL CoverFlow: distance (cm) in front of the camera the result row is placed. Keep this CLOSER than the plane so results read in front.")
  resultRowDepthCm: number = 45

  @input
  @hint("VERTICAL browse deck: distance (cm) in front of the camera the column is placed. Independent of the horizontal row's depth.")
  resultRowDepthVerticalCm: number = 100

  @input
  @hint("Vertical offset (cm) of the result row relative to the camera's eye line (positive = up).")
  resultRowRiseCm: number = 0

  @input
  @hint("Uniform WORLD SCALE the CENTRED result card renders at; side cards shrink from this. (Overrides each card's varied deck size; restored when it returns to the cosmos.)")
  resultCardSize: number = 0.5

  @input
  @hint("Horizontal CoverFlow: every card is re-sized to this uniform IMAGE WIDTH (cm) while in the deck (height follows the image aspect), so the varied cosmos sizes don't show. Restored to its cosmos width on return. 0 = keep each card's cosmos width.")
  coverHorizontalImageWidthCm: number = 3

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">CoverFlow (result navigation)</span>')
  @input
  @hint("Horizontal gap (cm) from the centred card to the FIRST card on each side.")
  coverCenterGapCm: number = 14
  @input
  @hint("Horizontal spacing (cm) between successive side cards as they stack outward.")
  coverSideSpacingCm: number = 6
  @input
  @hint("How far back (cm) each step from centre recedes — gives the side cards parallax depth.")
  coverDepthStepCm: number = 6
  @input
  @hint("Fold angle (deg) of the FIRST card on each side, turned toward the centre.")
  coverFoldStartDeg: number = 45
  @input
  @hint("Extra fold (deg) added per further step away from centre.")
  coverFoldStepDeg: number = 12
  @input
  @hint("Maximum fold angle (deg) any side card reaches.")
  coverMaxFoldDeg: number = 75
  @input
  @hint("Per-step scale falloff for side cards (0..1): each step from centre multiplies size by this.")
  coverSideScaleFalloff: number = 0.82
  @input
  @hint("Smallest scale fraction a far side card shrinks to (× the centred size).")
  coverMinScaleFrac: number = 0.4
  @input
  @hint("Cards farther than this many steps from centre stack at the edge instead of spreading further.")
  coverMaxVisiblePerSide: number = 6
  @input
  @hint("Hand travel (cm) along the row required to scrub one card while pinch-dragging.")
  coverScrubStepCm: number = 12
  @input
  @hint("How crisply the deck settles to the centred card after release (higher = snappier).")
  coverSnapRate: number = 12
  @input
  @hint("Release hand speed (cm/s) above which a quick flick advances one extra card in that direction.")
  coverFlickThreshold: number = 25
  @input
  @hint("Invert the pinch-drag direction (which way you move your hand for next vs. previous).")
  coverInvertScrub: boolean = false
  @input
  @hint("Invert the side-card fold direction (which way left/right cards tilt).")
  coverInvertFold: boolean = false
  @input
  @hint("Vertical browse deck: top/bottom card centre offset as a FRACTION of the centred card's height. Lower = more tucked/overlapping (deck); higher = more separated.")
  coverVGapFrac: number = 0.5
  @input
  @hint("Vertical browse deck: extra offset (fraction of card height) for the transient incoming card beyond the edge.")
  coverVStepFrac: number = 0.6
  @input
  @hint("Vertical browse deck: resting tilt (deg) of the top/bottom card. Steep so it foreshortens into a peeking sliver (Cover Flow look).")
  coverVFoldDeg: number = 65

  @input
  @hint("Vertical browse deck: every card is re-sized to this uniform IMAGE HEIGHT (cm) while in the deck; the width is computed from the image aspect (width = height x aspect) since size is assigned by width. Restored to its cosmos width on return. 0 = keep each card's cosmos width.")
  coverVerticalImageHeightCm: number = 4

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Logging</span>')
  @input
  enableLogging: boolean = false
  @input
  enableLoggingLifecycle: boolean = false

  private logger: Logger
  private slots: DeckSlot[] = []
  private camTrans: Transform = null

  // Premade deck + seeds are spawned exactly once (in onStart, which fires the
  // first frame this scene is switched on).
  private deckSpawned: boolean = false
  // Cylinder layout, built once the camera is available AND every card has
  // measured its real footprint (or the wait below times out).
  private layoutBuilt: boolean = false
  private layoutWaitFrames: number = 0
  // Set when a re-shuffle is wanted but a query result deck is currently up; the
  // re-solve is deferred until clearQueryResults() so it never disrupts results.
  private relayoutPending: boolean = false
  // Last CardStore.getCapturedVersion() we folded in. -1 forces a sync on the
  // first visible frame (catching cards captured before the deck was ever shown).
  private lastSyncedVersion: number = -1
  // Frames to wait for cards to auto-fit before packing with fallback sizes
  // (covers cards whose border auto-fit is off and never measures).
  private static readonly MAX_LAYOUT_WAIT_FRAMES = 60
  private anchor: vec3 = vec3.zero()       // field-centre point (for gaze aim)
  private rightW: vec3 = new vec3(1, 0, 0) // basis for the gentle in-place sway
  private upW: vec3 = vec3.up()

  // Query-result / search state (driven by the CardQueryVoiceAgent).
  private idToSlot: { [id: string]: number } = {}  // store id -> slot index
  private slotIds: string[] = []                   // slot index -> store id
  private searchActive: boolean = false   // sway faster while the agent searches
  private resultsActive: boolean = false  // a result row is laid out in front
  private resultIndices: number[] = []    // slot indices currently in the row (row order)
  // Frozen world-space frame the CoverFlow deck is laid out on, snapshot once when
  // the row appears (so the cards stay put in the world instead of following the head).
  private resultRowAnchor: vec3 = vec3.zero()
  private resultRowRight: vec3 = new vec3(1, 0, 0)
  private resultRowFaceForward: vec3 = new vec3(0, 0, -1) // away-from-user, side cards recede along this
  private resultRowFaceRot: quat = quat.quatIdentity()    // stable facing of the centred card
  private driftFrozen: boolean = false    // plane cards hold still while showing results
  // CoverFlow selection: which card (index WITHIN resultIndices) is centred. scrubPos
  // is the same value when idle, but slides as a float during a pinch-drag.
  private selectedPos: number = 0
  private scrubPos: number = 0
  // Pinch-drag scrub state (SIK hand input).
  private rightHand = SIK.HandInputData.getHand("right")
  private leftHand = SIK.HandInputData.getHand("left")
  private pinching: boolean = false
  private pinchIsRight: boolean = false
  private dragTracker = new PinchDragTracker()
  private dragAccumCm: number = 0
  private scrubStartPos: number = 0
  private scrubVelCmPerSec: number = 0 // smoothed hand speed along the row, for flick
  // Base render order for the centred result card; side cards step down from here.
  // Stays well above the cosmos plane (order 0) for any sane maxVisiblePerSide.
  private static readonly COVER_BASE_ORDER = 100

  // --- Vertical pinch-select deck (point-and-pinch a cosmos card to browse relatives) ---
  // Mutually exclusive with the horizontal result deck (resultsActive). EXACTLY 3 cards
  // are ever materialised, role-ordered [top, center, bottom]; scrolling regenerates the
  // chain one relevance-linked card at a time.
  private verticalActive: boolean = false
  private verticalSlots: number[] = []          // slot indices, role order [top, center, bottom]
  private vScrub: number = 0                     // fractional drag offset (0 settled; clamped [-1,1])
  private vPinching: boolean = false             // a vertical drag is in progress
  private vPinchIsRight: boolean = false
  private vDragTracker = new PinchDragTracker()
  private vDragAccumCm: number = 0
  private vScrubVelCmPerSec: number = 0          // smoothed hand speed along up, for flick
  // Chronological list of slot indices that have appeared in the deck, oldest->newest.
  // The last 4 are excluded when picking the next card (no repeat within any 5-window).
  private vAppeared: number[] = []
  // Continuous-scrub snap state (mirrors the horizontal scrubPos/selectedPos pair). vScrub
  // is the live offset; vSettleTarget is the integer (-1/0/+1) it eases to after release.
  private vScrubStart: number = 0
  private vSettleTarget: number = 0
  private vDragSign: number = 0            // which way this drag is going (-1 up, +1 down, 0 undecided)
  // Transient 4th card that slides in from the drag edge so the snap reads continuous; it
  // is promoted to a role (or released) when the scrub settles. -1 when none.
  private vIncoming: number = -1
  private vIncomingK: number = 0           // its slot offset from centre (-2 entering top, +2 entering bottom)

  onAwake() {
    this.logger = new Logger("CardDeckController", this.enableLogging || this.enableLoggingLifecycle, true)
    if (this.enableLoggingLifecycle) this.logger.debug("LIFECYCLE: onAwake()")
    this.createEvent("OnStartEvent").bind(() => this.onStart())
    this.createEvent("UpdateEvent").bind(() => this.update(getDeltaTime()))
  }

  private onStart(): void {
    if (this.cameraObject) this.camTrans = this.cameraObject.getTransform()

    // CoverFlow navigation: pinch-drag scrubs through the result deck. Either hand
    // works; the handlers no-op unless a result deck is currently showing.
    this.rightHand.onPinchDown.add(() => this.onPinchDown(true))
    this.rightHand.onPinchUp.add(() => this.onPinchUp(true))
    this.leftHand.onPinchDown.add(() => this.onPinchDown(false))
    this.leftHand.onPinchUp.add(() => this.onPinchUp(false))

    this.initDeckIfNeeded()
  }

  // --- spawning ---------------------------------------------------------------

  // Spawns the premade deck + registers seeds exactly once.
  private initDeckIfNeeded(): void {
    if (this.deckSpawned) return
    this.deckSpawned = true
    const store = (global as any).cropCardStore
    this.spawnDeck(store)
    this.registerSeeds(store)
    if (store) {
      this.logger.info("Spawned " + this.slots.length + " deck cards; store now holds " + store.count() + " cards.")
    } else {
      this.logger.warn("No cropCardStore registered; spawned " + this.slots.length + " cards without storing them.")
    }
  }

  private spawnDeck(store: any): void {
    if (!this.cardPrefab) {
      this.logger.warn("No cardPrefab assigned; cannot spawn the deck.")
      return
    }
    const parent = this.getSceneObject()

    for (let i = 0; i < CARD_DECK_DATA.length; i++) {
      const entry = CARD_DECK_DATA[i]
      const obj = this.cardPrefab.instantiate(parent)
      obj.name = "DeckCard_" + entry.id
      obj.layer = parent.layer

      const sizeScale = this.rand(this.cardSizeMinScale, this.cardSizeMaxScale)

      const card = obj.getComponent(PremadeCard.getTypeName()) as unknown as PremadeCard
      if (card) {
        // Always an open card: no self-gaze, no billboard (we own position and
        // billboard each card ourselves), start expanded so it never shows as a bubble.
        card.billboard = false
        card.gazeToExpand = false
        card.startExpanded = true
        if (this.cameraObject) card.setCamera(this.cameraObject)
        const tex = this.placeholderImageFor(i)
        if (tex) card.setImage(tex)
        // Size the card the supported way: set its image width (picture + caption +
        // auto-fit border all follow). sizeScale gives per-card size variety.
        if (this.cardImageWidthCm > 0) card.setImageWidth(this.cardImageWidthCm * sizeScale)
        card.setText(entry.text)
        // Color the border by the card's primary topic (mirrors PingCardSpawner).
        card.setBorderColor(colorForTopics(entry.topics))
        // Stay invisible (but keep measuring) until buildWrappedLayout has sized +
        // placed this card, so the deck never flashes huge unpositioned cards.
        card.hideUntilReady()
        // Visual size is set in buildWrappedLayout (angular → world width at radius R).
      } else {
        this.logger.warn("Spawned card " + entry.id + " has no PremadeCard component.")
      }

      const slot = this.makeSlot(obj, card, entry, sizeScale)
      const slotIndex = this.slots.length
      this.idToSlot[entry.id] = slotIndex
      this.slotIds.push(entry.id)
      this.slots.push(slot)
      this.makeCardSelectable(obj, slotIndex)

      this.registerEntry(store, entry, this.placeholderImageFor(i))
    }
  }

  private registerSeeds(store: any): void {
    if (!store) return
    for (const entry of SEED_CARDS) this.registerEntry(store, entry, undefined)
  }

  private registerEntry(store: any, entry: CardDeckEntry, image: Texture | undefined): void {
    if (!store || typeof store.addPremade !== "function") return
    store.addPremade({
      id: entry.id,
      image: image,
      text: entry.text,
      hashtags: entry.hashtags,
      topics: entry.topics,
      location: entry.location,
      captureDate: entry.captureDate,
    })
  }

  private placeholderImageFor(i: number): Texture | undefined {
    const imgs = this.placeholderImages
    if (!imgs || imgs.length === 0) return undefined
    return imgs[i % imgs.length]
  }

  private makeSlot(obj: SceneObject, card: PremadeCard, entry: CardDeckEntry, sizeScale: number): DeckSlot {
    return {
      obj,
      card,
      trans: obj.getTransform(),
      entry,
      sizeScale,
      azDeg: 0,
      elDeg: 0,
      base: obj.getTransform().getWorldPosition(),
      clock: this.rand(0, 10),
      swayPhase: this.rand(0, 2 * Math.PI),
      swayPhase2: this.rand(0, 2 * Math.PI),
      swayFreq: this.rand(this.swayFreqMin, this.swayFreqMax),
      swayAmp: this.swayAmplitudeCm * this.rand(0.6, 1),
      isResult: false,
      renderOrder: -1,
    }
  }

  // --- captured-card sync (driven by the persistent store) --------------------

  // Polled every visible frame. The store bumps a version on each capture; when it
  // differs from what we last folded in, spawn the new cards and re-shuffle once.
  // Because update() only runs while the deck is shown, this naturally happens the
  // moment the deck scene is switched on (capture happens in a separate scene).
  private syncCapturedFromStore(): void {
    const store = (global as any).cropCardStore
    if (!store || typeof store.getCapturedVersion !== "function") return
    const version = store.getCapturedVersion()
    if (version === this.lastSyncedVersion) return
    this.lastSyncedVersion = version
    const added = this.syncCapturedCards(store)
    if (added > 0) this.scheduleRelayout()
  }

  // Spawns a deck slot for every captured (non-premade) store record we don't yet
  // have. Returns how many were newly added. Idempotent across repeated enables,
  // and does NOT re-register the records (the capture flow already stored them).
  private syncCapturedCards(store: any): number {
    if (!store || typeof store.getCards !== "function" || !this.cardPrefab) return 0
    const cards: CardRecord[] = store.getCards()
    let added = 0
    for (const rec of cards) {
      if (rec.premade) continue                       // premade deck spawned at startup
      if (this.idToSlot[rec.id] !== undefined) continue // already have a slot for it
      this.spawnCapturedCard(rec)
      added++
    }
    if (added > 0) {
      this.logger.info("Synced " + added + " captured card(s) into the deck (now " + this.slots.length + " cards).")
    }
    return added
  }

  // Instantiates one captured card, mirroring spawnDeck()'s per-entry setup but
  // sourcing image/text/metadata from the store record instead of CARD_DECK_DATA.
  private spawnCapturedCard(rec: CardRecord): void {
    const parent = this.getSceneObject()
    const obj = this.cardPrefab.instantiate(parent)
    obj.name = "CapturedCard_" + rec.id
    obj.layer = parent.layer

    const sizeScale = this.rand(this.cardSizeMinScale, this.cardSizeMaxScale)
    const entry = this.recordToEntry(rec)

    const card = obj.getComponent(PremadeCard.getTypeName()) as unknown as PremadeCard
    if (card) {
      card.billboard = false
      card.gazeToExpand = false
      card.startExpanded = true
      if (this.cameraObject) card.setCamera(this.cameraObject)
      if (rec.image) card.setImage(rec.image)
      // Size by image width (see spawnDeck); sizeScale gives per-card variety.
      if (this.cardImageWidthCm > 0) card.setImageWidth(this.cardImageWidthCm * sizeScale)
      card.setText(rec.text)
      // Color the border by the card's primary topic (mirrors PingCardSpawner).
      card.setBorderColor(colorForTopics(entry.topics))
      // Hidden until the next layout sizes + places it (see spawnDeck).
      card.hideUntilReady()
    } else {
      this.logger.warn("Captured card " + rec.id + " has no PremadeCard component.")
    }

    const slot = this.makeSlot(obj, card, entry, sizeScale)
    const slotIndex = this.slots.length
    this.idToSlot[rec.id] = slotIndex
    this.slotIds.push(rec.id)
    this.slots.push(slot)
    this.makeCardSelectable(obj, slotIndex)
  }

  // Adds an SIK Interactable + EXPLICIT-size box collider to a card's ROOT object so a
  // point-and-pinch selects it into the vertical browse deck. Mirrors GlobeController's
  // makeInteractable/addBoxCollider (collider on the root with fitVisual=false and a real
  // size — auto-fit on these tiny, far, nested-scale cards yields a degenerate box the SIK
  // ray never hits). The box is in ROOT-LOCAL units (so root world scale gives the world
  // footprint, matching buildWrappedLayout's `ls.x * worldScale`); a provisional size is
  // set here and refined to each card's measured footprint in buildWrappedLayout.
  // slotIndex is baked by value (slots are append-only, so a card's index is stable).
  private makeCardSelectable(obj: SceneObject, slotIndex: number): void {
    if (!obj) return
    if (!obj.getComponent("Physics.ColliderComponent")) {
      const collider = obj.createComponent("Physics.ColliderComponent") as ColliderComponent
      const shape = Shape.createBoxShape()
      // Provisional root-local size from the fallback footprint. Cards sit at world
      // scale 1, so root-local units equal world cm; refined to the measured size later.
      shape.size = new vec3(this.cardWidthCm, this.cardHeightCm, 4)
      collider.shape = shape
      collider.fitVisual = false
    }
    let interactable = obj.getComponent(Interactable.getTypeName()) as Interactable
    if (!interactable) {
      interactable = obj.createComponent(Interactable.getTypeName()) as Interactable
      // Direct (near-field) + Indirect (far-field ray) so a card off to the side can be
      // pointed at and pinched, not just grabbed up close. Wire the trigger once, only on
      // creation, so a relayout never stacks duplicate handlers.
      interactable.targetingMode = 3
      interactable.allowMultipleInteractors = false
      interactable.onTriggerEnd.add(() => this.selectCard(slotIndex))
    }
  }

  // Refits a card's root selection collider to its measured content footprint (root-local
  // units), so the tap target matches what the user sees. Called from buildWrappedLayout
  // once cards have measured. No-op if the collider isn't present yet.
  private resizeSelectCollider(obj: SceneObject, localW: number, localH: number): void {
    if (!obj || !(localW > 0) || !(localH > 0)) return
    const collider = obj.getComponent("Physics.ColliderComponent") as ColliderComponent
    if (!collider) return
    const shape = Shape.createBoxShape()
    shape.size = new vec3(localW, localH, Math.max(2, localW * 0.1))
    collider.shape = shape
  }

  // Projects a store CardRecord onto the CardDeckEntry shape the layout + relevance
  // clustering consume (topics, location, captureDate). Copies arrays (no mutation).
  private recordToEntry(rec: CardRecord): CardDeckEntry {
    return {
      id: rec.id,
      text: rec.text,
      hashtags: rec.hashtags ? rec.hashtags.slice() : [],
      topics: rec.topics ? rec.topics.slice() : [],
      location: rec.location,
      captureDate: rec.captureDate,
    }
  }

  // Wants a re-shuffle: re-solve now, unless a query result deck is up — in which
  // case defer it (clearQueryResults applies it) so results are never disrupted.
  private scheduleRelayout(): void {
    if (this.resultsActive) {
      this.relayoutPending = true
      return
    }
    this.requestRelayout()
  }

  // Forces a single full re-solve of the cylinder layout on the next update via the
  // NATIVE build path (buildWrappedLayout): it re-clusters ALL cards together so a
  // freshly captured card lands among its relatives rather than in a leftover gap.
  // buildWrappedLayout waits for the new cards to measure their footprint first.
  private requestRelayout(): void {
    this.relayoutPending = false
    this.layoutBuilt = false
    this.layoutWaitFrames = 0
  }

  // --- per-frame --------------------------------------------------------------

  private update(dt: number): void {
    if (this.slots.length === 0) return
    // This only ticks while the deck is actually visible (UpdateEvent is gated by
    // hierarchy-enabled state), so polling here is how the deck "reads" the
    // persistent store on show — folding in cards captured while it was switched
    // off (and live, if both ever run together). Cheap version compare; the work
    // runs only when a capture has happened since the last sync.
    this.syncCapturedFromStore()
    if (!this.layoutBuilt) {
      if (!this.camTrans) return // need the camera to orient + anchor the cylinder
      // Hold off until every card has measured its real footprint, so the packing
      // uses true sizes. Fall back to authored sizes if it takes too long.
      if (!this.allCardsMeasured() && this.layoutWaitFrames++ < CardDeckController.MAX_LAYOUT_WAIT_FRAMES) return
      this.buildWrappedLayout()
      if (!this.layoutBuilt) return
    }
    if (this.resultsActive) {
      if (this.pinching) this.updateScrub()
      else this.settleScrub(dt) // ease to the snapped card after release
    } else if (this.verticalActive) {
      // Gate on the ACTUAL pinch state each frame: if the pinch-up event was missed (hand
      // left tracking, etc.) a latched flag would let plain hand-sway keep scrolling.
      if (this.vPinching && !this.handIsPinching(this.vPinchIsRight)) this.endVerticalDrag()
      if (this.vPinching) this.updateVerticalScrub()
      else this.settleVerticalScrub(dt) // ease the scrub to its snapped target after release
    }

    const swaySpeed = this.searchActive ? this.searchSpinMultiplier : 1
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]

      // Front cards fly out to a readable deck in front of the user (horizontal
      // CoverFlow for query results, vertical for a point-and-pinch selection).
      if (slot.isResult) {
        if (this.verticalActive) this.layoutVerticalSlot(slot, dt)
        else this.layoutResultSlot(slot, dt)
        continue
      }

      // Plane card: ease toward its fixed spot (+ a little sway) and face the user.
      // While a result row is up the plane holds still (no sway).
      slot.clock += dt * swaySpeed
      let target = slot.base
      if (!this.driftFrozen) {
        const su = slot.swayAmp * Math.sin(slot.swayFreq * slot.clock + slot.swayPhase)
        const sv = slot.swayAmp * Math.cos(slot.swayFreq * slot.clock + slot.swayPhase2)
        target = slot.base.add(this.rightW.uniformScale(su)).add(this.upW.uniformScale(sv))
      }
      const cur = slot.trans.getWorldPosition()
      slot.trans.setWorldPosition(vec3.lerp(cur, target, Math.min(1, 5 * dt)))
      this.billboardSlot(slot)

      // Gaze focus: grow cards near the view centre (biggest dead-centre), easing back
      // to resting size as the gaze moves off them. Held at resting size while a front
      // deck is up so the frozen background never pulses.
      if (this.gazeScaleEnabled) {
        const targetScale = this.driftFrozen ? AUTHORED_WORLD_SCALE : this.gazeScaleFor(slot)
        this.easeWorldScale(slot, targetScale, Math.min(1, this.num(this.gazeScaleEaseRate, 8) * dt))
      }
    }
  }

  // Resting world scale for a card given the user's gaze: AUTHORED_WORLD_SCALE outside the
  // cone, growing to AUTHORED_WORLD_SCALE * gazeScaleMaxBoost dead-centre, with a smooth
  // (smoothstep) falloff to the cone edge. The project's camera looks along -forward.
  private gazeScaleFor(slot: DeckSlot): number {
    if (!this.camTrans) return AUTHORED_WORLD_SCALE
    const camPos = this.camTrans.getWorldPosition()
    const viewDir = this.camTrans.forward.uniformScale(-1)
    const toCard = slot.trans.getWorldPosition().sub(camPos)
    const dist = toCard.length
    if (dist < 1e-3) return AUTHORED_WORLD_SCALE
    const cosAngle = toCard.dot(viewDir) / dist
    const coneCos = Math.cos(Math.max(1, this.gazeScaleConeDeg) * DEG2RAD)
    if (cosAngle <= coneCos) return AUTHORED_WORLD_SCALE // outside the cone
    let t = (cosAngle - coneCos) / Math.max(1e-4, 1 - coneCos) // 0 at edge -> 1 at centre
    t = t * t * (3 - 2 * t) // smoothstep for a soft falloff
    const boost = Math.max(1, this.gazeScaleMaxBoost)
    return AUTHORED_WORLD_SCALE * (1 + (boost - 1) * t)
  }

  // True once every spawned card has auto-fit its border, so getContentLocalSize()
  // returns each card's real footprint for the packing.
  private allCardsMeasured(): boolean {
    for (let i = 0; i < this.slots.length; i++) {
      const card = this.slots[i].card
      if (!card || !card.isContentMeasured()) return false
    }
    return true
  }

  // --- cylinder (head-wrapped) layout -----------------------------------------

  // Builds the wrap frame + relevance-clustered angular scatter, then sizes and
  // places each card on the cylinder around the user's head.
  private buildWrappedLayout(): void {
    const n = this.slots.length
    if (n === 0) { this.layoutBuilt = true; return }

    // Cylinder frame: horizontal forward toward the globe; head is the cylinder axis.
    // We lay cards out on the UNWRAPPED wall in cm — u = horizontal arc-length,
    // v = vertical height about the band centre — then wrap u onto the cylinder.
    const head = this.camTrans.getWorldPosition()
    const fieldCenter = this.cosmosCenter().add(vec3.up().uniformScale(this.verticalCenterRiseCm))
    const toField = fieldCenter.sub(head)
    const fhFlat = new vec3(toField.x, 0, toField.z)
    const horizDist = fhFlat.length
    const Fh = horizDist > 1e-3 ? fhFlat.normalize() : new vec3(0, 0, -1)
    const rightRaw = vec3.up().cross(Fh)
    const rightN = rightRaw.length > 1e-3 ? rightRaw.normalize() : new vec3(1, 0, 0)
    // Card size is driven by each card's image width, not by shrinking the root, so the
    // cylinder radius is simply the requested distance (no hidden size-coupled multiplier).
    const R = this.cardDistanceCm > 0 ? this.cardDistanceCm : Math.max(1, horizDist)
    const centerH = fieldCenter.y - head.y // band-centre height relative to the head

    // Basis for the gentle in-place sway.
    this.rightW = rightN
    this.upW = vec3.up()

    // Cards inherit this parent's scale — convert a target WORLD scale to a local
    // scale by dividing it out (this is the hidden multiplier that blew cards up).
    const parentScale = this.getSceneObject().getTransform().getWorldScale()

    // Per-card footprint radius (cm) from each card's REAL measured size; band
    // half-height (cm). Every card sits at world scale 1, so its measured root-local
    // size IS its world footprint (per-card image width already baked the variety in).
    // Cards that haven't measured fall back to the authored cardWidth/HeightCm.
    const radius: number[] = []
    let sumR = 0
    for (let i = 0; i < n; i++) {
      const slot = this.slots[i]
      const worldScale = AUTHORED_WORLD_SCALE
      let w: number, h: number
      if (slot.card && slot.card.isContentMeasured()) {
        const ls = slot.card.getContentLocalSize()
        w = ls.x * worldScale
        h = ls.y * worldScale
        // Refit the selection collider (root-local units) to the real footprint.
        this.resizeSelectCollider(slot.obj, ls.x, ls.y)
      } else {
        w = this.cardWidthCm
        h = this.cardHeightCm
      }
      const r = 0.5 * Math.sqrt(w * w + h * h) + this.cardGapCm * 0.5
      radius.push(r); sumR += r
    }
    const avgR = n > 0 ? sumR / n : 10
    const halfV = Math.max(10, this.canvasHeightCm * 0.5)

    // Seed a wide, centre-dense ellipse (cm) + similarity matrix.
    const u: number[] = [] // horizontal arc-length, cm
    const v: number[] = [] // vertical height, cm
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 2 * Math.PI + this.rand(-0.3, 0.3)
      const rad = halfV * Math.sqrt(Math.random()) // centre-dense radial
      u.push(Math.cos(a) * rad * 3) // start ~3x wider than tall
      v.push(Math.sin(a) * rad)
    }
    const sim: number[][] = []
    for (let i = 0; i < n; i++) {
      sim.push([])
      for (let j = 0; j < n; j++) sim[i].push(i === j ? 0 : this.similarity(i, j))
    }

    // Relevance clustering (force-directed, in cm). Related cards (sim=1) pull to ~near,
    // unrelated (sim=0) to ~far; v is clamped to the fixed-height band each iteration.
    const near = 2.1 * avgR
    const far = 4.2 * avgR
    const ITER = 240
    for (let it = 0; it < ITER; it++) {
      const step = 0.02 + 0.1 * (1 - it / ITER)
      const du: number[] = []
      const dv: number[] = []
      for (let i = 0; i < n; i++) { du.push(0); dv.push(0) }
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          let ex = u[j] - u[i]
          let ey = v[j] - v[i]
          let d = Math.sqrt(ex * ex + ey * ey)
          if (d < 1e-3) { ex = this.rand(-1, 1); ey = this.rand(-1, 1); d = Math.sqrt(ex * ex + ey * ey) + 1e-3 }
          const ux = ex / d
          const uy = ey / d
          const ideal = far + (near - far) * sim[i][j]
          const f = (d - ideal) * 0.5
          du[i] += ux * f; dv[i] += uy * f
          du[j] -= ux * f; dv[j] -= uy * f
        }
      }
      for (let i = 0; i < n; i++) {
        u[i] += du[i] * step
        v[i] = Math.max(-halfV, Math.min(halfV, v[i] + dv[i] * step))
      }
    }

    // Pack to non-overlap inside the fixed-height strip (spreads sideways as needed),
    // then centre horizontally.
    this.packStrip(u, v, radius, halfV)
    this.recenterU(u)

    // Commit: uniform world scale for size; arc-length u -> azimuth around the head.
    this.anchor = head.add(Fh.uniformScale(R)).add(vec3.up().uniformScale(centerH))
    let minU = 0, maxU = 0
    for (let i = 0; i < n; i++) {
      const slot = this.slots[i]
      const targetWorld = AUTHORED_WORLD_SCALE
      slot.trans.setLocalScale(new vec3(
        parentScale.x > 1e-4 ? targetWorld / parentScale.x : targetWorld,
        parentScale.y > 1e-4 ? targetWorld / parentScale.y : targetWorld,
        parentScale.z > 1e-4 ? targetWorld / parentScale.z : targetWorld,
      ))
      // Azimuth uses the common radius R so the packed arc-length spacing is preserved;
      // only the RADIAL distance varies per card (bigger = closer) for a depth effect.
      const az = u[i] / R // arc-length -> radians around world up
      const Ri = this.cardRadius(R, slot.sizeScale)
      const horiz = Fh.uniformScale(Math.cos(az)).add(rightN.uniformScale(Math.sin(az)))
      slot.base = head.add(horiz.uniformScale(Ri)).add(vec3.up().uniformScale(centerH + v[i]))
      slot.azDeg = az / DEG2RAD
      slot.elDeg = v[i]
      slot.trans.setWorldPosition(slot.base)
      this.billboardSlot(slot)
      if (u[i] < minU) minU = u[i]
      if (u[i] > maxU) maxU = u[i]
    }
    this.layoutBuilt = true

    // Every card is now sized + placed, so reveal any held invisible at spawn
    // (hideUntilReady). Idempotent: already-visible cards are left as-is.
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i].card) this.slots[i].card.reveal()
    }

    // Diagnostic: live inputs + resulting band footprint + a sample card.
    const c0 = this.slots[0]
    const card0Dist = c0 ? c0.base.sub(head).length : 0
    const card0Scale = c0 ? c0.trans.getWorldScale().x : 0
    this.logger.info(
      "[layout] cards=" + n +
      " R=" + R.toFixed(0) + "cm band=" + (maxU - minU).toFixed(0) + "x" + (halfV * 2).toFixed(0) + "cm" +
      " cardImageWidthCm(in)=" + this.cardImageWidthCm +
      " cardDistanceCm(in)=" + this.cardDistanceCm +
      " parentScale=" + parentScale.x.toFixed(2) + "/" + parentScale.y.toFixed(2) + "/" + parentScale.z.toFixed(2) +
      " card0WorldScale=" + card0Scale.toFixed(3) +
      " card0Dist=" + card0Dist.toFixed(0) + "cm"
    )
  }

  // Non-overlap packing inside a fixed-height strip: overlapping pairs are pushed apart,
  // and v is clamped to the band every pass so resolution happens horizontally (the band
  // widens as needed) — this guarantees no heavily-overlapping cards.
  private packStrip(u: number[], v: number[], radius: number[], halfV: number): void {
    const n = u.length
    for (let pass = 0; pass < 300; pass++) {
      let moved = false
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          let ex = u[j] - u[i]
          let ey = v[j] - v[i]
          let d = Math.sqrt(ex * ex + ey * ey)
          const minD = radius[i] + radius[j]
          if (d < 1e-3) { ex = this.rand(-1, 1); ey = this.rand(-1, 1); d = Math.sqrt(ex * ex + ey * ey) + 1e-3 }
          if (d < minD) {
            const push = (minD - d) * 0.5
            const ux = ex / d
            const uy = ey / d
            u[i] -= ux * push; v[i] -= uy * push
            u[j] += ux * push; v[j] += uy * push
            moved = true
          }
        }
      }
      for (let i = 0; i < n; i++) v[i] = Math.max(-halfV, Math.min(halfV, v[i]))
      if (!moved) break
    }
  }

  private recenterU(u: number[]): void {
    const n = u.length
    if (n === 0) return
    let c = 0
    for (let i = 0; i < n; i++) c += u[i]
    c /= n
    for (let i = 0; i < n; i++) u[i] -= c
  }

  // Per-card cylinder radius: bigger cards (higher sizeScale) sit CLOSER than the base
  // radius R, smaller cards farther, spread by cardDistanceVariationCm. The card's size
  // is normalized within [cardSizeMinScale, cardSizeMaxScale] so a mid-range card stays
  // on R. Returns R unchanged when variation is off or there is no size range. Clamped
  // to stay safely in front of the head.
  private cardRadius(R: number, sizeScale: number): number {
    const variation = this.cardDistanceVariationCm
    if (!(variation > 0)) return R
    const min = this.cardSizeMinScale
    const max = this.cardSizeMaxScale
    let t = 0.5 // no size range -> everyone on the radius
    if (max > min) t = Math.max(0, Math.min(1, (sizeScale - min) / (max - min)))
    // t=1 (biggest) -> R - variation (closer); t=0 (smallest) -> R + variation (farther).
    const Ri = R - (t - 0.5) * 2 * variation
    return Math.max(R * 0.2, Ri)
  }

  // Relevance in [0,1]: topic Jaccard (primary) + same-location + date closeness.
  private similarity(i: number, j: number): number {
    const a = this.slots[i].entry
    const b = this.slots[j].entry
    const topic = this.jaccard(a.topics, b.topics)
    const loc = a.location === b.location ? 1 : 0
    const dd = Math.abs(this.dateToDays(a.captureDate) - this.dateToDays(b.captureDate))
    const date = 1 - Math.min(1, dd / Math.max(1, this.dateRangeDays))
    const wSum = this.topicWeight + this.locationWeight + this.dateWeight
    const s = this.topicWeight * topic + this.locationWeight * loc + this.dateWeight * date
    return wSum > 0 ? s / wSum : 0
  }

  private jaccard(a: string[], b: string[]): number {
    if ((!a || a.length === 0) && (!b || b.length === 0)) return 0
    let inter = 0
    for (const t of a) if (b.indexOf(t) >= 0) inter++
    const uni = a.length + b.length - inter
    return uni > 0 ? inter / uni : 0
  }

  // "YYYY-MM-DD" -> a monotonic day index (approximate; only differences matter).
  private dateToDays(s: string): number {
    const parts = (s ?? "").split("-")
    if (parts.length < 3) return 0
    const y = parseInt(parts[0]) || 0
    const m = parseInt(parts[1]) || 1
    const d = parseInt(parts[2]) || 1
    return y * 365 + (m - 1) * 31 + d
  }

  // --- Front-deck size standardization ----------------------------------------

  // While a card is in a front deck we override its varied cosmos image width with a
  // uniform deck size, so the CoverFlow reads as a tidy stack rather than mixed sizes.
  // Sizing is always assigned via image WIDTH; the vertical deck derives that width from
  // a target HEIGHT using the image aspect. Restored to the cosmos width on return.

  // Horizontal CoverFlow: every card to one uniform image width.
  private applyHorizontalDeckSize(slot: DeckSlot): void {
    if (!slot || !slot.card) return
    if (this.coverHorizontalImageWidthCm > 0) slot.card.setImageWidth(this.coverHorizontalImageWidthCm)
  }

  // Vertical browse: every card to one uniform image HEIGHT (width = height * aspect).
  private applyVerticalDeckSize(slot: DeckSlot): void {
    if (!slot || !slot.card) return
    const h = this.coverVerticalImageHeightCm
    if (h > 0) slot.card.setImageWidth(h * slot.card.getImageAspect())
  }

  // Returns a card to its varied cosmos image width when it leaves a front deck.
  private restoreCosmosCardSize(slot: DeckSlot): void {
    if (!slot || !slot.card) return
    if (this.cardImageWidthCm > 0) slot.card.setImageWidth(this.cardImageWidthCm * slot.sizeScale)
  }

  // --- External drive (CardQueryVoiceAgent) ----------------------------------

  /** Speeds the gentle sway up (or back) to signal the agent is searching. */
  setSearchActive(active: boolean): void {
    this.searchActive = active
  }

  // Snapshots a frozen, level world frame `depthCm` in front of the camera that the front
  // deck (horizontal CoverFlow or vertical browse) is laid out on, so it stays put in the
  // world instead of following the head. Each mode passes its own depth. Flattens the look
  // dir, mirroring buildWrappedLayout's Fh/rightN basis. Needs the camera; no-ops without it.
  private snapshotResultFrame(depthCm: number): void {
    if (!this.camTrans) return
    const camPos = this.camTrans.getWorldPosition()
    const look = this.camTrans.forward.uniformScale(-1) // camera looks along -forward
    const fFlat = new vec3(look.x, 0, look.z)
    const f = fFlat.length > 1e-3 ? fFlat.normalize() : new vec3(0, 0, -1)
    this.resultRowRight = vec3.up().cross(f).normalize()
    this.resultRowAnchor = camPos
      .add(f.uniformScale(depthCm))
      .add(vec3.up().uniformScale(this.resultRowRiseCm))
    // Side cards recede along f (away from the user); the centred card faces back
    // toward the user along -f. Freeze that facing so the deck stays world-stable.
    this.resultRowFaceForward = f
    this.resultRowFaceRot = quat.lookAt(f.uniformScale(-1), vec3.up())
  }

  /**
   * Pulls the cards with the given store ids out of the plane into a camera-
   * facing row in front of the user: freezes the plane sway, renders the results
   * in front (they are already expanded). Captured cards are eligible once the
   * deck has synced them (see syncCapturedFromStore); ids with no spawned slot (e.g. unspawned
   * SEED_CARDS) are skipped. Returns how many were shown.
   */
  showQueryResults(ids: string[]): number {
    // A new query supersedes a vertical browse deck: return its cards to the plane first.
    if (this.verticalActive) this.clearVerticalDeck()
    this.clearResultSlots()

    const indices: number[] = []
    for (const id of ids ?? []) {
      const idx = this.idToSlot[id]
      if (idx === undefined) continue       // no spawned slot (unspawned SEED_CARD) — can't show
      if (indices.indexOf(idx) >= 0) continue
      indices.push(idx)
    }

    this.resultIndices = indices
    this.resultsActive = indices.length > 0
    this.searchActive = false
    this.driftFrozen = true
    // Start centred on the MIDDLE of the result array (not an end card).
    this.selectedPos = Math.floor(indices.length / 2)
    this.scrubPos = this.selectedPos
    this.pinching = false

    // Snapshot the deck's world frame ONCE from the camera's current pose so it stays
    // put in the world (it must not follow the head).
    if (this.resultsActive) this.snapshotResultFrame(this.num(this.resultRowDepthCm, 45))

    for (const idx of indices) {
      const slot = this.slots[idx]
      slot.isResult = true
      slot.renderOrder = -1 // force the first layout frame to push the distance-based order
      this.applyHorizontalDeckSize(slot) // uniform width across the row
      if (slot.card) slot.card.setRenderInFront(true) // already expanded; scale eased per-frame
    }
    this.logger.info(
      "[coverflow] frozen anchor=" + this.resultRowAnchor +
      " depth=" + this.resultRowDepthCm + "cm n=" + indices.length
    )
    this.logger.info("Showing " + indices.length + " result card(s) of " + (ids ? ids.length : 0) + " requested.")
    return indices.length
  }

  /**
   * Returns the result cards to the plane and re-enables sway. Safe to call when
   * no results are showing. Cards stay expanded — they never collapse.
   */
  clearQueryResults(): void {
    // "clear" also dissolves a vertical browse deck (it can be up without a result row).
    this.clearVerticalDeck()
    this.clearResultSlots()
    this.resultIndices = []
    this.resultsActive = false
    this.driftFrozen = false
    this.searchActive = false
    this.selectedPos = 0
    this.scrubPos = 0
    this.pinching = false
    // A capture arrived while results were up; re-shuffle now that they're gone.
    if (this.relayoutPending) this.requestRelayout()
  }

  /**
   * The store id of the card the user currently has CENTRED, or null when none.
   * Covers both front decks: the vertical pinch-select browse (centre = role
   * index 1) and the horizontal CoverFlow result row (centre = round(scrubPos)).
   * The query agent calls this on demand so it can answer about whichever card
   * the user has selected or scrubbed to.
   */
  getFocusedResultId(): string | null {
    // Vertical browse deck: the centred card is always role index 1 (roles are
    // reassigned synchronously on each committed scroll), so focus is stable.
    if (this.verticalActive && this.verticalSlots.length === 3) {
      const idx = this.verticalSlots[1]
      return idx === undefined ? null : (this.slotIds[idx] ?? null)
    }
    if (!this.resultsActive || this.resultIndices.length === 0) return null
    const pos = Math.round(this.scrubPos)
    const idx = this.resultIndices[pos]
    return idx === undefined ? null : (this.slotIds[idx] ?? null)
  }

  /**
   * True when the user's gaze points at the card plane (within `coneDeg` of the
   * direction to the plane anchor). The query agent polls this to re-arm itself.
   */
  isUserGazingAtCosmos(coneDeg: number = 22): boolean {
    if (!this.camTrans) return false
    const camPos = this.camTrans.getWorldPosition()
    const viewDir = this.camTrans.forward.uniformScale(-1)
    const aim = this.layoutBuilt ? this.anchor : this.cosmosCenter()
    const toCenter = aim.sub(camPos)
    const dist = toCenter.length
    if (dist < 1e-3) return false
    const cos = toCenter.dot(viewDir) / dist
    return cos >= Math.cos(Math.max(1, coneDeg) * DEG2RAD)
  }

  // Un-fronts every current result card, restores its varied deck size, and clears
  // its flag (stays expanded).
  private clearResultSlots(): void {
    for (const idx of this.resultIndices) {
      const slot = this.slots[idx]
      if (!slot) continue
      slot.isResult = false
      this.applyWorldScale(slot, AUTHORED_WORLD_SCALE) // back to the resting (authored) scale
      this.restoreCosmosCardSize(slot) // relayout at resting scale (after scale is restored)
      if (slot.card) slot.card.setRenderInFront(false)
    }
  }

  // --- Vertical pinch-select deck --------------------------------------------

  /**
   * Brings a cosmos card to the front as a vertical browse deck: the chosen card
   * centred (faces the user, full size) with its 2 highest-relevance cards folded in
   * above and below. Pinch-drag up/down then scrolls a relevance-linked chain. No-ops
   * if a deck is already up, the cylinder isn't solved yet, or there are < 3 cards.
   * Wired from each card's Interactable.onTriggerEnd (see makeCardSelectable).
   */
  selectCard(slotIndex: number): void {
    if (this.resultsActive || this.verticalActive) return // ignore while any front deck is up
    if (!this.layoutBuilt) return                         // positions invalid before the solve
    if (slotIndex < 0 || slotIndex >= this.slots.length) return
    if (this.slots.length < 3) return                     // a 3-card deck is impossible

    this.snapshotResultFrame(this.num(this.resultRowDepthVerticalCm, 100))

    const pair = this.topTwoNeighbours(slotIndex)
    const above = pair[0]
    const below = pair[1]
    if (above === undefined || below === undefined) return
    this.verticalSlots = [above, slotIndex, below]

    for (const idx of this.verticalSlots) {
      const s = this.slots[idx]
      if (!s) continue
      s.isResult = true
      s.renderOrder = -1 // force the first layout frame to push the distance-based order
      this.applyVerticalDeckSize(s) // uniform height across the column
      if (s.card) s.card.setRenderInFront(true)
    }

    this.verticalActive = true
    this.driftFrozen = true
    this.searchActive = false
    this.vScrub = 0
    this.vScrubStart = 0
    this.vSettleTarget = 0
    this.vScrubVelCmPerSec = 0
    this.vDragAccumCm = 0
    this.vDragSign = 0
    this.vIncoming = -1
    this.vPinching = false
    // Seed the anti-repeat chain with the initial 3 so the first generated card differs.
    this.vAppeared = [above, slotIndex, below]

    this.logger.info(
      "[vertical] select center=" + (this.slotIds[slotIndex] ?? slotIndex) +
      " top=" + (this.slotIds[above] ?? above) + " bottom=" + (this.slotIds[below] ?? below)
    )
  }

  // The 2 distinct cards most relevant to `center` (by the same similarity used for
  // clustering), highest first. Caller guarantees slots.length >= 3 so both exist.
  private topTwoNeighbours(center: number): number[] {
    const ranked = this.rankBySimilarity(center)
    return [ranked[0], ranked[1]]
  }

  // All slot indices except `anchor`, sorted by similarity(anchor, j) descending.
  private rankBySimilarity(anchor: number): number[] {
    const ranked: number[] = []
    for (let j = 0; j < this.slots.length; j++) if (j !== anchor) ranked.push(j)
    ranked.sort((a, b) => this.similarity(anchor, b) - this.similarity(anchor, a))
    return ranked
  }

  // Picks the next card to fold into the deck: highest relevance to `anchor`, excluding
  // the 3 currently-visible cards and (the 5-window rule) the last 4 cards that appeared.
  // Returns -1 when no valid card exists (pool too small) so the caller keeps the deck.
  private pickNext(anchor: number): number {
    const visible: { [k: number]: boolean } = {}
    for (const idx of this.verticalSlots) visible[idx] = true
    const recent: { [k: number]: boolean } = {}
    for (const idx of this.vAppeared.slice(-4)) recent[idx] = true

    const ranked = this.rankBySimilarity(anchor)
    // Strict: not visible AND not in the last 4 appeared.
    for (const j of ranked) if (!visible[j] && !recent[j]) return j
    // Relax the anti-repeat (small pool) but never duplicate a currently-visible card.
    for (const j of ranked) if (!visible[j]) return j
    return -1
  }

  // True if the given hand is currently pinching (and tracked). Used to verify the drag
  // is real every frame, so a missed pinch-up can't leave plain hand-sway scrolling.
  private handIsPinching(isRight: boolean): boolean {
    const hand = isRight ? this.rightHand : this.leftHand
    if (!hand || (hand.isTracked && !hand.isTracked())) return false
    return !!(hand.isPinching && hand.isPinching())
  }

  // Ends a vertical drag (real pinch-up OR a lost pinch): picks the snap target the same
  // way the horizontal deck does — a flick, or a drag past half a card, advances one card
  // in that direction; otherwise it settles back to centre. settleVerticalScrub then eases
  // vScrub to the target and rebases the roles when it arrives.
  private endVerticalDrag(): void {
    this.vPinching = false
    this.vDragTracker.end()
    const flick = this.num(this.coverFlickThreshold, 25)
    let target = 0
    if (Math.abs(this.vScrubVelCmPerSec) > flick) target = this.vScrubVelCmPerSec > 0 ? 1 : -1
    else if (this.vScrub > 0.5) target = 1
    else if (this.vScrub < -0.5) target = -1
    // Can only commit toward an edge that actually materialised an incoming card.
    if (target !== 0 && this.vIncoming < 0) target = 0
    this.vSettleTarget = target
  }

  // Materialises the transient 4th card entering from the drag edge so the snap reads
  // continuous (it slides in as vScrub approaches ±1). sign < 0 = entering the TOP (the
  // user is dragging up, top->centre); sign > 0 = entering the BOTTOM. The incoming is the
  // card most relevant to whichever card will become the new centre. No-op (leaves
  // vIncoming = -1) when the pool can't supply one — the drag then can't commit that way.
  private materializeIncoming(sign: number): void {
    if (this.verticalSlots.length !== 3) return
    // New centre after a commit in this direction: dragging up -> old top; down -> old bottom.
    const newCenter = sign < 0 ? this.verticalSlots[0] : this.verticalSlots[2]
    const pick = this.pickNext(newCenter)
    if (pick < 0) { this.vIncoming = -1; return }
    this.vIncoming = pick
    this.vIncomingK = sign < 0 ? -2 : 2 // one slot beyond the top/bottom role
    const inc = this.slots[pick]
    if (inc) {
      inc.isResult = true
      inc.renderOrder = -1
      this.applyVerticalDeckSize(inc) // match the column's uniform height
      if (inc.card) inc.card.setRenderInFront(true)
      this.seedIncomingAtEdge(pick, sign < 0)
    }
  }

  // Drops the transient incoming card (drag reversed or settled back to centre): returns it
  // to the cosmos plane. No-op if there is none.
  private releaseIncoming(): void {
    if (this.vIncoming < 0) return
    const inc = this.slots[this.vIncoming]
    if (inc) {
      inc.isResult = false
      this.applyWorldScale(inc, AUTHORED_WORLD_SCALE) // back to the resting (authored) scale
      this.restoreCosmosCardSize(inc) // relayout at resting scale (after scale is restored)
      if (inc.card) inc.card.setRenderInFront(false)
    }
    this.vIncoming = -1
  }

  // Commits a settled scroll: the incoming card (now at the top/bottom edge) becomes a role,
  // the role it displaced shifts toward centre, and the card that fell off the far edge is
  // released to the plane. Index/scrub co-shift means resetting vScrub to 0 is seamless.
  // sign < 0 = scrolled up (top -> centre); sign > 0 = scrolled down (bottom -> centre).
  private rebaseVertical(sign: number): void {
    if (this.verticalSlots.length !== 3 || this.vIncoming < 0) { this.vScrub = 0; return }
    const top = this.verticalSlots[0]
    const center = this.verticalSlots[1]
    const bottom = this.verticalSlots[2]
    const incoming = this.vIncoming

    let outgoing: number
    if (sign < 0) {
      // top -> centre; incoming becomes new top; old bottom falls off.
      this.verticalSlots = [incoming, top, center]
      outgoing = bottom
    } else {
      // bottom -> centre; incoming becomes new bottom; old top falls off.
      this.verticalSlots = [center, bottom, incoming]
      outgoing = top
    }
    this.vIncoming = -1

    // Release the card that fell off: the plane loop eases it home with billboard + sway.
    const out = this.slots[outgoing]
    if (out) {
      out.isResult = false
      this.applyWorldScale(out, AUTHORED_WORLD_SCALE) // back to the resting (authored) scale
      this.restoreCosmosCardSize(out) // relayout at resting scale (after scale is restored)
      if (out.card) out.card.setRenderInFront(false)
    }

    // Record the newly-added card in the chronological chain (bounded) for the 5-window rule.
    this.vAppeared.push(incoming)
    if (this.vAppeared.length > 64) this.vAppeared = this.vAppeared.slice(-16)

    // Co-shift: roles moved by one and vScrub resets to 0 -> no visual jump.
    this.vScrub = 0
    this.vSettleTarget = 0
    this.vScrubVelCmPerSec = 0
    this.vDragAccumCm = 0
  }

  // Parks the incoming card one step beyond the top/bottom edge so its first
  // layoutVerticalSlot frame slides it inward to its role pose.
  private seedIncomingAtEdge(slotIndex: number, fromTop: boolean): void {
    const slot = this.slots[slotIndex]
    if (!slot) return
    const centerSize = this.num(this.resultCardSize, 0.5)
    const cardH = this.verticalCardHeight(slot, centerSize)
    const depthStep = this.num(this.coverDepthStepCm, 6)
    const off = (fromTop ? 1 : -1) * cardH * (this.num(this.coverVGapFrac, 0.5) + this.num(this.coverVStepFrac, 0.6))
    slot.trans.setWorldPosition(
      this.resultRowAnchor
        .add(vec3.up().uniformScale(off))
        .add(this.resultRowFaceForward.uniformScale(2 * depthStep))
    )
  }

  // Returns the vertical deck's cards to the plane and clears its state. Safe to call
  // when no vertical deck is up. driftFrozen is left to the caller (clearQueryResults
  // unfreezes; showQueryResults re-freezes for its own deck).
  private clearVerticalDeck(): void {
    if (!this.verticalActive && this.verticalSlots.length === 0 && this.vIncoming < 0) return
    this.releaseIncoming()
    for (const idx of this.verticalSlots) {
      const s = this.slots[idx]
      if (!s) continue
      s.isResult = false
      this.applyWorldScale(s, AUTHORED_WORLD_SCALE) // back to the resting (authored) scale
      this.restoreCosmosCardSize(s) // relayout at resting scale (after scale is restored)
      if (s.card) s.card.setRenderInFront(false)
    }
    this.verticalSlots = []
    this.vAppeared = []
    this.verticalActive = false
    this.vPinching = false
    this.vScrub = 0
    this.vScrubStart = 0
    this.vSettleTarget = 0
    this.vDragSign = 0
    this.vScrubVelCmPerSec = 0
    this.vDragAccumCm = 0
    this.vDragTracker.end()
  }

  // World height (cm) of a card at the given world scale: the measured footprint when
  // available, else the authored cardHeightCm converted to this scale. Drives the
  // height-relative vertical offsets so the deck tucks correctly for any card size.
  private verticalCardHeight(slot: DeckSlot, worldScale: number): number {
    if (slot.card && slot.card.isContentMeasured()) {
      const h = slot.card.getContentLocalSize().y * worldScale
      if (h > 1e-3 && isFinite(h)) return h
    }
    return this.cardHeightCm * worldScale
  }

  // Vertical analogue of layoutResultSlot: lays the 3 cards along the up axis and folds
  // them about the horizontal axis (resultRowRight) instead of world-up. Only roles
  // -1/0/+1 exist; r slides with vScrub during a drag so cards ease through smoothly.
  private layoutVerticalSlot(slot: DeckSlot, dt: number): void {
    const slotIndex = this.slots.indexOf(slot)
    // k is the card's settled slot offset from centre: -1 top, 0 centre, +1 bottom for the
    // 3 roles, or ±2 for the transient incoming card sliding in from an edge.
    let k: number
    const role = this.verticalSlots.indexOf(slotIndex)
    if (role >= 0) k = role - 1
    else if (slotIndex === this.vIncoming) k = this.vIncomingK
    else return

    // Cover Flow rotated 90°: the top/bottom card tucks BEHIND the centre and peeks out by a
    // sliver. Offsets are a FRACTION of the centred card's height (self-scaling vs card size)
    // so the cards always overlap into a deck instead of floating apart; the fold is steep so
    // each side card foreshortens into that sliver.
    const centerSize = this.num(this.resultCardSize, 0.5)
    const cardH = this.verticalCardHeight(slot, centerSize)
    const centerGap = cardH * this.num(this.coverVGapFrac, 0.5)
    const sideSpacing = cardH * this.num(this.coverVStepFrac, 0.6)
    const depthStep = this.num(this.coverDepthStepCm, 6)
    const foldStart = this.num(this.coverVFoldDeg, 65)
    const foldStep = this.num(this.coverFoldStepDeg, 12)
    const maxFold = this.num(this.coverMaxFoldDeg, 75)
    const falloff = this.num(this.coverSideScaleFalloff, 0.82)
    const minFrac = this.num(this.coverMinScaleFrac, 0.4)
    const maxVis = this.num(this.coverMaxVisiblePerSide, 6)

    const r = k - this.vScrub
    const a = Math.abs(r)
    const sgn = r === 0 ? 0 : (r > 0 ? 1 : -1)
    const aC = Math.min(a, maxVis)

    // Vertical displacement: higher role index (k) sits LOWER, so offset = -sgn*vMag.
    const vMag = aC <= 1 ? centerGap * aC : centerGap + (aC - 1) * sideSpacing
    const target = this.resultRowAnchor
      .add(vec3.up().uniformScale(-sgn * vMag))
      .add(this.resultRowFaceForward.uniformScale(aC * depthStep))

    // Fold about the HORIZONTAL axis into a concave gallery: the top card leans back so its
    // BOTTOM edge tucks toward the centre, the bottom card leans forward so its TOP edge tucks
    // in — both side cards angling inward (not a conveyor belt). Negate sgn to match the
    // horizontal deck's about-up convention. The sign is empirical on device; coverInvertFold
    // flips it.
    const foldSign = this.coverInvertFold ? 1 : -1
    const foldMag = a <= 1 ? foldStart * a : Math.min(maxFold, foldStart + (a - 1) * foldStep)
    const targetRot = quat.angleAxis(-sgn * foldSign * foldMag * DEG2RAD, this.resultRowRight)
      .multiply(this.resultRowFaceRot)

    const worldScale = centerSize * Math.max(minFrac, Math.pow(falloff, a))

    const cur = slot.trans.getWorldPosition()
    slot.trans.setWorldPosition(vec3.lerp(cur, target, Math.min(1, 8 * dt)))
    slot.trans.setWorldRotation(quat.slerp(slot.trans.getWorldRotation(), targetRot, Math.min(1, 12 * dt)))
    this.easeWorldScale(slot, worldScale, Math.min(1, 10 * dt))

    const order = Math.round(CardDeckController.COVER_BASE_ORDER - aC)
    if (slot.card && order !== slot.renderOrder) {
      slot.card.setRenderOrder(order)
      slot.renderOrder = order
    }
  }

  // Maps smoothed vertical hand travel to the live scroll offset and tracks hand speed for
  // the flick test. As soon as the drag direction is known it materialises the incoming
  // card on that edge so the deck slides continuously (mirrors the horizontal scrub).
  private updateVerticalScrub(): void {
    // Belt-and-suspenders: never advance the scrub on a frame where the hand isn't actually
    // pinching, so plain hand-sway can't scroll even if a pinch-up event was dropped.
    if (!this.handIsPinching(this.vPinchIsRight)) return
    const point = this.handPoint(this.vPinchIsRight)
    if (!point) return
    const dCm = this.vDragTracker.update(point).dot(vec3.up())
    this.vDragAccumCm += dCm
    const step = this.num(this.coverScrubStepCm, 12)
    // Drag DOWN (negative up-travel) -> vScrub negative -> TOP card eases toward centre;
    // drag UP -> BOTTOM card eases toward centre (direct-manipulation, grab-and-pull).
    const dir = this.coverInvertScrub ? -1 : 1
    let raw = this.vScrubStart + dir * this.vDragAccumCm / step

    // Lock in the drag direction the first time the user moves off centre, and prepare the
    // incoming card for that edge. If they reverse across centre, swap to the other edge.
    const sign = raw < -0.04 ? -1 : raw > 0.04 ? 1 : 0
    if (sign !== 0 && sign !== this.vDragSign) {
      this.releaseIncoming()
      this.vDragSign = sign
      this.materializeIncoming(sign)
    }
    // Only allow scrolling toward an edge that produced an incoming card; otherwise hold.
    let lo = -1, hi = 1
    if (this.vIncoming < 0 || this.vDragSign >= 0) lo = 0
    if (this.vIncoming < 0 || this.vDragSign <= 0) hi = 0
    this.vScrub = Math.max(lo, Math.min(hi, raw))

    const dt = getDeltaTime()
    const inst = dt > 1e-4 ? (dir * dCm) / dt : 0
    this.vScrubVelCmPerSec = this.vScrubVelCmPerSec * 0.7 + inst * 0.3
  }

  // Eases vScrub to its snapped target (mirrors settleScrub), then rebases the roles when it
  // lands on an edge so the next drag starts from a clean centred deck. Snapping back to 0
  // drops the transient incoming card.
  private settleVerticalScrub(dt: number): void {
    const diff = this.vSettleTarget - this.vScrub
    if (Math.abs(diff) < 0.01) {
      this.vScrub = this.vSettleTarget
      if (this.vSettleTarget !== 0) this.rebaseVertical(this.vSettleTarget) // commit the step
      else if (this.vIncoming >= 0) this.releaseIncoming()                  // snapped back to centre
      return
    }
    const rate = this.num(this.coverSnapRate, 12)
    this.vScrub += diff * Math.min(1, rate * dt)
  }

  // Eases a result card toward its CoverFlow pose, computed against the frozen deck
  // frame (so the whole deck stays put in the world). The centred card faces the user
  // full size; side cards fold toward centre, shrink, and recede with distance from
  // the current scrub position.
  private layoutResultSlot(slot: DeckSlot, dt: number): void {
    const k = this.resultIndices.indexOf(this.slots.indexOf(slot))
    if (k < 0) return

    // Defensive @input fallbacks: a component placed before these fields existed reads
    // them as 0/undefined, which would collapse the layout. Fall back to the defaults.
    const centerGap = this.num(this.coverCenterGapCm, 14)
    const sideSpacing = this.num(this.coverSideSpacingCm, 6)
    const depthStep = this.num(this.coverDepthStepCm, 6)
    const foldStart = this.num(this.coverFoldStartDeg, 45)
    const foldStep = this.num(this.coverFoldStepDeg, 12)
    const maxFold = this.num(this.coverMaxFoldDeg, 75)
    const falloff = this.num(this.coverSideScaleFalloff, 0.82)
    const minFrac = this.num(this.coverMinScaleFrac, 0.4)
    const maxVis = this.num(this.coverMaxVisiblePerSide, 6)
    const centerSize = this.num(this.resultCardSize, 0.5)

    const r = k - this.scrubPos          // signed offset from centre (<0 left, >0 right)
    const a = Math.abs(r)
    const sgn = r === 0 ? 0 : (r > 0 ? 1 : -1)
    const aC = Math.min(a, maxVis)        // distant cards stack at the edge

    // Everything below is CONTINUOUS and ODD in r, so a card eases smoothly through
    // the centre as scrubPos moves (no jump / 90° flip at the crossover).
    // Horizontal: 0 at centre -> centerGap at |r|=1 -> +sideSpacing per further step.
    const xMag = aC <= 1 ? centerGap * aC : centerGap + (aC - 1) * sideSpacing
    const x = sgn * xMag
    // Depth: recede along faceForward (away from the user) for parallax; 0 at centre.
    const target = this.resultRowAnchor
      .add(this.resultRowRight.uniformScale(x))
      .add(this.resultRowFaceForward.uniformScale(aC * depthStep))

    // Fold about world up: 0 at centre -> foldStart at |r|=1 -> +foldStep per step,
    // capped. Odd in r so the outgoing card turns aside while the incoming one turns
    // to face the user, both landing exactly on their pose when scrubPos settles.
    const foldSign = this.coverInvertFold ? 1 : -1
    const foldMag = a <= 1 ? foldStart * a : Math.min(maxFold, foldStart + (a - 1) * foldStep)
    const targetRot = quat.angleAxis(-sgn * foldSign * foldMag * DEG2RAD, vec3.up())
      .multiply(this.resultRowFaceRot)

    // Scale: centre full size, sides shrink geometrically toward minFrac.
    const worldScale = centerSize * Math.max(minFrac, Math.pow(falloff, a))

    const cur = slot.trans.getWorldPosition()
    slot.trans.setWorldPosition(vec3.lerp(cur, target, Math.min(1, 8 * dt)))
    slot.trans.setWorldRotation(quat.slerp(slot.trans.getWorldRotation(), targetRot, Math.min(1, 12 * dt)))
    this.easeWorldScale(slot, worldScale, Math.min(1, 10 * dt))

    // Layer by distance from centre: nearer cards draw in front (higher order). These
    // are unlit billboards with depthTest off, so render order — not Z — decides
    // overlap. Re-push only on change to avoid per-frame material writes.
    const order = Math.round(CardDeckController.COVER_BASE_ORDER - aC)
    if (slot.card && order !== slot.renderOrder) {
      slot.card.setRenderOrder(order)
      slot.renderOrder = order
    }
  }

  // Converts a target WORLD scale to a local scale by dividing out the parent's
  // world scale (mirrors buildWrappedLayout's per-card sizing).
  private applyWorldScale(slot: DeckSlot, worldScale: number): void {
    if (!(worldScale > 0) || !isFinite(worldScale)) return // never NaN-corrupt the transform
    const p = this.getSceneObject().getTransform().getWorldScale()
    slot.trans.setLocalScale(new vec3(
      p.x > 1e-4 ? worldScale / p.x : worldScale,
      p.y > 1e-4 ? worldScale / p.y : worldScale,
      p.z > 1e-4 ? worldScale / p.z : worldScale,
    ))
  }

  // --- CoverFlow pinch-drag scrub ---------------------------------------------

  private onPinchDown(isRight: boolean): void {
    // Vertical browse deck takes priority and scrubs along the up axis.
    if (this.verticalActive) {
      if (this.vPinching) return
      const vp = this.handPoint(isRight)
      if (!vp) return
      this.vPinching = true
      this.vPinchIsRight = isRight
      this.vScrubStart = this.vScrub // resume from where it currently rests (usually 0)
      this.vDragAccumCm = 0
      this.vScrubVelCmPerSec = 0
      this.vDragSign = 0
      this.vDragTracker.begin(vp)
      return
    }
    if (!this.resultsActive || this.pinching) return // only scrub while a deck is up
    const point = this.handPoint(isRight)
    if (!point) return
    this.pinching = true
    this.pinchIsRight = isRight
    this.scrubStartPos = this.scrubPos // resume from where it currently rests
    this.dragAccumCm = 0
    this.scrubVelCmPerSec = 0
    this.dragTracker.begin(point)
  }

  private onPinchUp(isRight: boolean): void {
    if (this.verticalActive) {
      if (!this.vPinching || isRight !== this.vPinchIsRight) return
      this.endVerticalDrag()
      return
    }
    if (!this.pinching || isRight !== this.pinchIsRight) return
    this.pinching = false
    this.dragTracker.end()
    // Pick the card to settle on. A slow release snaps to the nearest; a quick flick
    // advances one card in the flick direction. scrubPos is NOT set here — settleScrub
    // eases it to selectedPos so the motion reads as one crisp settle.
    const n = this.resultIndices.length
    const flick = this.num(this.coverFlickThreshold, 25)
    let target: number
    if (Math.abs(this.scrubVelCmPerSec) > flick) {
      target = this.scrubVelCmPerSec > 0 ? Math.floor(this.scrubPos) + 1 : Math.ceil(this.scrubPos) - 1
    } else {
      target = Math.round(this.scrubPos)
    }
    this.selectedPos = Math.max(0, Math.min(n - 1, target))
  }

  // Maps smoothed horizontal hand travel to a fractional scrub position so the deck
  // slides continuously under the pinch, and tracks hand speed for the flick test.
  private updateScrub(): void {
    const point = this.handPoint(this.pinchIsRight)
    if (!point) return
    const dCm = this.dragTracker.update(point).dot(this.resultRowRight)
    this.dragAccumCm += dCm
    const step = this.num(this.coverScrubStepCm, 12)
    const dir = this.coverInvertScrub ? 1 : -1
    const n = this.resultIndices.length
    this.scrubPos = Math.max(0, Math.min(n - 1, this.scrubStartPos + dir * this.dragAccumCm / step))

    // Smoothed scrub-direction speed (cm/s); +ve means scrubPos is increasing.
    const dt = getDeltaTime()
    const inst = dt > 1e-4 ? (dir * dCm) / dt : 0
    this.scrubVelCmPerSec = this.scrubVelCmPerSec * 0.7 + inst * 0.3
  }

  // After release, eases scrubPos to the chosen card with an ease-out, snapping
  // exactly when close so it lands precisely on the integer pose.
  private settleScrub(dt: number): void {
    const diff = this.selectedPos - this.scrubPos
    if (Math.abs(diff) < 0.01) {
      this.scrubPos = this.selectedPos
      return
    }
    const rate = this.num(this.coverSnapRate, 12)
    this.scrubPos += diff * Math.min(1, rate * dt)
  }

  // World position of the pinching hand (thumb tip), or null if not tracked.
  private handPoint(isRight: boolean): vec3 | null {
    const hand = isRight ? this.rightHand : this.leftHand
    const tip = hand && hand.thumbTip ? hand.thumbTip.position : null
    return tip ?? null
  }

  // Eases the slot's LOCAL scale toward the target WORLD scale (dividing out the
  // parent's world scale, mirroring applyWorldScale) so size animates on navigation.
  private easeWorldScale(slot: DeckSlot, worldScale: number, t: number): void {
    if (!(worldScale > 0) || !isFinite(worldScale)) return
    const p = this.getSceneObject().getTransform().getWorldScale()
    const target = new vec3(
      p.x > 1e-4 ? worldScale / p.x : worldScale,
      p.y > 1e-4 ? worldScale / p.y : worldScale,
      p.z > 1e-4 ? worldScale / p.z : worldScale,
    )
    slot.trans.setLocalScale(vec3.lerp(slot.trans.getLocalScale(), target, t))
  }

  // Resolves an @input number, falling back when a stale scene component reads it
  // as 0/undefined (a field added after the component was placed).
  private num(v: number, fallback: number): number {
    return (v !== undefined && v !== null && isFinite(v) && v > 0) ? v : fallback
  }

  private billboardSlot(slot: DeckSlot): void {
    if (!this.camTrans) return
    slot.trans.setWorldRotation(quat.lookAt(this.camTrans.forward, vec3.up()))
  }

  // Anchor point: the globe's top surface point if available.
  private cosmosCenter(): vec3 {
    if (this.globeView) return this.globeView.getTopTip()
    if (this.centerObject) return this.centerObject.getTransform().getWorldPosition()
    return this.getSceneObject().getTransform().getWorldPosition()
  }

  private rand(min: number, max: number): number {
    return min + Math.random() * (max - min)
  }
}
