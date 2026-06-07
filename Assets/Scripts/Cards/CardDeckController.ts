/**
 * Specs Inc. 2026
 * CardDeckController – spawns and animates the premade "cosmos" deck.
 *
 * On start it instantiates the PremadeCard prefab once per CARD_DECK_DATA entry,
 * parents them under this object, dresses each as a collapsed BUBBLE (gaze is
 * arbitrated here, not per-card), gives it placeholder image + text, and
 * registers a record in the CardStore. SEED_CARDS are registered in the store
 * too but not spawned (e.g. the standalone PremadeCard already in the scene).
 *
 * The cards drift like space dust / orbiting satellites in a flat-ish dome a
 * set height above the globe's top: a slow azimuthal orbit on a horizontal ring
 * (independent of globe spin — the cards are siblings of the globe, not
 * children), a gentle vertical bob, and a subtle tumble. Height above the globe
 * and horizontal spread are separate, inspector-tunable knobs.
 *
 * Gaze is arbitrated centrally so AT MOST ONE card is expanded at a time: each
 * frame the controller scores every card by how centred it is in the gaze cone
 * (tie-broken toward the nearer one) and, after a short dwell, expands only the
 * single best card — collapsing it again when the user looks away. The expanded
 * card pauses its drift and billboards toward the camera so it is readable.
 *
 * Prefab instantiation + getComponent(getTypeName()) mirror GlobeController's
 * ensureMarkers(); the global-store lookup mirrors InterestStore's pattern.
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger";
import { PremadeCard } from "../PremadeCard/PremadeCard";
import { GlobeView } from "../Globe/GlobeView";
import { CARD_DECK_DATA, SEED_CARDS, CardDeckEntry } from "./cardDeckData";

const DEG2RAD = Math.PI / 180

/** Per-card animation state for the cosmos drift. */
interface DeckSlot {
  obj: SceneObject
  card: PremadeCard
  trans: Transform
  // Placement relative to the globe top: a horizontal ring radius + a height above it.
  hRadius: number // horizontal distance from the vertical axis through the top
  height: number  // base Y distance above the globe top
  phi: number     // azimuth, radians (advanced for the orbit)
  orbitSpeed: number
  // Vertical bob.
  bobAmp: number
  bobFreq: number
  bobPhase: number
  // Subtle tumble.
  flipAxis: vec3
  flipSpeed: number
  flipAngle: number
  // Per-card animation clock; only advances while the card is drifting.
  clock: number
  // True while this card is pulled out of the cosmos as a query result (laid out
  // in the front row, expanded, rendered in front). Cleared by clearQueryResults().
  isResult: boolean
}

@component
export class CardDeckController extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">CardDeckController – the floating premade-card cosmos</span><br/><span style="color: #94A3B8; font-size: 11px;">Spawns the PremadeCard prefab per cardDeckData entry, registers each in global.cropCardStore, and drifts them above the globe top.</span>')
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
  @hint("GlobeView whose top surface point is the centre of the cosmos shell. If unset, Center Object (or this object) is used.")
  @allowUndefined
  globeView: GlobeView

  @input
  @hint("Fallback centre for the cosmos shell when no GlobeView is set.")
  @allowUndefined
  centerObject: SceneObject

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Cosmos shape</span>')
  @input
  @hint("Height (cm) the cards float ABOVE the top of the globe — the vertical (Y) distance. LOWER = closer to the globe. This is the main knob.")
  heightAboveGlobe: number = 8

  @input
  @hint("Random +/- vertical variation (cm) so the cards sit at slightly different heights instead of one flat layer.")
  heightSpread: number = 6

  @input
  @hint("How far (cm) the cloud spreads out horizontally around the point above the globe's top.")
  horizontalRadius: number = 22

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Cosmos motion</span>')
  @input
  @hint("Slowest azimuthal orbit speed (radians/sec).")
  orbitSpeedMin: number = 0.04

  @input
  @hint("Fastest azimuthal orbit speed (radians/sec).")
  orbitSpeedMax: number = 0.16

  @input
  @hint("Vertical bob amplitude (cm).")
  bobAmplitude: number = 1.5

  @input
  @hint("Slowest bob frequency (radians/sec).")
  bobFreqMin: number = 0.3

  @input
  @hint("Fastest bob frequency (radians/sec).")
  bobFreqMax: number = 0.8

  @input
  @hint("Slowest tumble speed (radians/sec).")
  flipSpeedMin: number = 0.1

  @input
  @hint("Fastest tumble speed (radians/sec).")
  flipSpeedMax: number = 0.35

  @input
  @hint("Pause a card's drift and billboard it toward the camera while it is expanded by gaze.")
  pauseDriftWhenExpanded: boolean = true

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Gaze (at most one card expands)</span>')
  @input
  @hint("Half-angle (degrees) of the cone around the gaze centre a card must enter to become the expand candidate. Smaller = must look more directly at a card.")
  enterConeAngleDeg: number = 10

  @input
  @hint("Wider half-angle (degrees) the expanded card may stay within before it collapses (hysteresis against flicker). Should be >= Enter Cone Angle.")
  keepConeAngleDeg: number = 16

  @input
  @hint("Seconds the most-centred card must stay the best candidate before it expands.")
  expandDwellSec: number = 0.6

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Query results (driven by CardQueryVoiceAgent)</span>')
  @input
  @hint("While the agent is searching, the cosmos orbit speed is multiplied by this so the cards visibly spin faster.")
  searchSpinMultiplier: number = 3.5

  @input
  @hint("Horizontal gap (cm) between adjacent cards in the result row laid out in front of the user.")
  resultRowSpacingCm: number = 16

  @input
  @hint("Distance (cm) in front of the camera the result row is placed. Keep this CLOSER than the cosmos so results read in front.")
  resultRowDepthCm: number = 45

  @input
  @hint("Vertical offset (cm) of the result row relative to the camera's eye line (positive = up).")
  resultRowRiseCm: number = 0

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Logging</span>')
  @input
  enableLogging: boolean = false
  @input
  enableLoggingLifecycle: boolean = false

  private logger: Logger
  private slots: DeckSlot[] = []
  private camTrans: Transform = null

  // Single-card gaze arbitration state.
  private expandedIndex: number = -1   // the one card currently driven open (-1 = none)
  private candidateIndex: number = -1  // best enter-cone card this dwell window
  private dwellTimer: number = 0
  private enterCos: number = -2        // cos(enterConeAngleDeg); precomputed in onStart
  private keepCos: number = -2         // cos(keepConeAngleDeg)

  // Query-result / search state (driven by the CardQueryVoiceAgent).
  private idToSlot: { [id: string]: number } = {}  // store id -> slot index
  private slotIds: string[] = []                   // slot index -> store id
  private searchActive: boolean = false   // spin faster while the agent searches
  private resultsActive: boolean = false  // a result row is laid out in front
  private resultIndices: number[] = []    // slot indices currently in the row (row order)
  private gazeFrozen: boolean = false     // skip gaze arbitration while showing results
  private driftFrozen: boolean = false    // non-result cards hold position while showing results
  // Which result the user is gazing at, with a short dwell so it doesn't flicker.
  private focusCandidate: number = -1
  private focusDwell: number = 0
  private focusedResultIndex: number = -1
  private static readonly FOCUS_DWELL_SEC = 0.4

  onAwake() {
    this.logger = new Logger("CardDeckController", this.enableLogging || this.enableLoggingLifecycle, true)
    if (this.enableLoggingLifecycle) this.logger.debug("LIFECYCLE: onAwake()")
    this.createEvent("OnStartEvent").bind(() => this.onStart())
    this.createEvent("UpdateEvent").bind(() => this.update(getDeltaTime()))
  }

  private onStart(): void {
    if (this.cameraObject) this.camTrans = this.cameraObject.getTransform()
    // keep cone is the wider one; ensure keepCos <= enterCos even if mis-set.
    const enterDeg = Math.max(1, this.enterConeAngleDeg)
    const keepDeg = Math.max(enterDeg, this.keepConeAngleDeg)
    this.enterCos = Math.cos(enterDeg * DEG2RAD)
    this.keepCos = Math.cos(keepDeg * DEG2RAD)
    const store = (global as any).cropCardStore

    this.spawnDeck(store)
    this.registerSeeds(store)

    if (store) {
      this.logger.info("Spawned " + this.slots.length + " deck cards; store now holds " + store.count() + " cards.")
    } else {
      this.logger.warn("No cropCardStore registered; spawned " + this.slots.length + " cards without storing them.")
    }
  }

  // --- spawning ---------------------------------------------------------------

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

      const card = obj.getComponent(PremadeCard.getTypeName()) as unknown as PremadeCard
      if (card) {
        // Dress as a drifting bubble: no billboard (we own rotation). Gaze is
        // arbitrated centrally (updateGazeSelection), so the card must NOT
        // self-expand — we drive expand()/collapse() on the single winner.
        card.billboard = false
        card.gazeToExpand = false
        card.startExpanded = false
        if (this.cameraObject) card.setCamera(this.cameraObject)
        const tex = this.placeholderImageFor(i)
        if (tex) card.setImage(tex)
        card.setText(entry.text)
      } else {
        this.logger.warn("Spawned card " + entry.id + " has no PremadeCard component.")
      }

      const slot = this.makeSlot(obj, card)
      this.idToSlot[entry.id] = this.slots.length
      this.slotIds.push(entry.id)
      this.slots.push(slot)
      this.placeSlot(slot, this.cosmosCenter())

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

  // Builds a card's randomized cosmos slot: a point on a horizontal ring a set
  // height above the globe top. sqrt(rand) spreads cards evenly across the disc
  // rather than clustering near the centre.
  private makeSlot(obj: SceneObject, card: PremadeCard): DeckSlot {
    const flipAxis = new vec3(this.rand(-1, 1), this.rand(-1, 1), this.rand(-1, 1))
    return {
      obj,
      card,
      trans: obj.getTransform(),
      hRadius: this.horizontalRadius * Math.sqrt(Math.random()),
      height: this.heightAboveGlobe + this.rand(-this.heightSpread, this.heightSpread),
      phi: this.rand(0, 2 * Math.PI),
      orbitSpeed: this.rand(this.orbitSpeedMin, this.orbitSpeedMax) * (Math.random() < 0.5 ? -1 : 1),
      bobAmp: this.bobAmplitude * this.rand(0.5, 1),
      bobFreq: this.rand(this.bobFreqMin, this.bobFreqMax),
      bobPhase: this.rand(0, 2 * Math.PI),
      flipAxis: flipAxis.length > 1e-3 ? flipAxis.normalize() : vec3.up(),
      flipSpeed: this.rand(this.flipSpeedMin, this.flipSpeedMax) * (Math.random() < 0.5 ? -1 : 1),
      flipAngle: this.rand(0, 2 * Math.PI),
      clock: this.rand(0, 10),
      isResult: false,
    }
  }

  // --- animation --------------------------------------------------------------

  private update(dt: number): void {
    if (this.slots.length === 0) return
    // Gaze-to-expand is suppressed while a result row is shown so the user can
    // focus on the pulled-out cards; otherwise it arbitrates as usual.
    if (!this.gazeFrozen) this.updateGazeSelection(dt)
    if (this.resultsActive) this.updateResultFocus(dt)

    // While searching, the whole cosmos orbits faster to signal "working on it".
    const spin = this.searchActive ? this.searchSpinMultiplier : 1
    const center = this.cosmosCenter()
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]

      // Result cards fly out of the cosmos into a camera-facing row in front.
      if (slot.isResult) {
        this.layoutResultSlot(slot, dt)
        continue
      }

      // The single expanded card freezes in place and faces the camera so it is
      // stable + readable. Everything else keeps drifting.
      if (this.pauseDriftWhenExpanded && i === this.expandedIndex) {
        this.billboardSlot(slot)
        continue
      }

      // While a result row is up, the remaining cosmos holds still (no orbit
      // advance) so it doesn't distract — it just keeps its gentle bob/tumble.
      if (!this.driftFrozen) slot.phi += slot.orbitSpeed * spin * dt
      slot.clock += dt
      slot.flipAngle += slot.flipSpeed * dt
      this.placeSlot(slot, center)
      slot.trans.setWorldRotation(quat.angleAxis(slot.flipAngle, slot.flipAxis))
    }
  }

  // Picks the single card the user is most clearly looking at and expands only
  // it (after a short dwell). The expanded card is kept while it stays within a
  // wider "keep" cone; when nothing is in the keep cone the open card collapses
  // (zero-or-one expanded at any time).
  private updateGazeSelection(dt: number): void {
    if (!this.camTrans) return
    const camPos = this.camTrans.getWorldPosition()
    const viewDir = this.camTrans.forward.uniformScale(-1) // camera looks along -forward

    let best = -1
    let bestScore = -2
    let bestDist = Infinity
    let expandedInKeep = false

    for (let i = 0; i < this.slots.length; i++) {
      const toCard = this.slots[i].trans.getWorldPosition().sub(camPos)
      const dist = toCard.length
      if (dist < 1e-3) continue
      const cos = toCard.dot(viewDir) / dist // 1 = dead-centre, lower = off to the side

      if (i === this.expandedIndex && cos >= this.keepCos) expandedInKeep = true

      if (cos >= this.enterCos) {
        // Most-centred wins; tie-break toward the nearer card ("closest in that direction").
        if (cos > bestScore + 1e-4 || (Math.abs(cos - bestScore) <= 1e-4 && dist < bestDist)) {
          best = i
          bestScore = cos
          bestDist = dist
        }
      }
    }

    // Dwell on a stable best candidate before promoting it.
    if (best === this.candidateIndex) {
      this.dwellTimer += dt
    } else {
      this.candidateIndex = best
      this.dwellTimer = 0
    }

    // Collapse the open card once it leaves the keep cone (and isn't the new winner).
    if (this.expandedIndex >= 0 && !expandedInKeep && best !== this.expandedIndex) {
      this.collapseCurrent()
    }

    // Promote the dwelled candidate to the single expanded card.
    if (best >= 0 && best !== this.expandedIndex && this.dwellTimer >= this.expandDwellSec) {
      this.setExpandedSlot(best)
    }
  }

  private setExpandedSlot(index: number): void {
    if (this.expandedIndex === index) return
    this.collapseCurrent()
    const slot = this.slots[index]
    if (slot && slot.card) slot.card.expand()
    this.expandedIndex = index
  }

  private collapseCurrent(): void {
    if (this.expandedIndex < 0) return
    const slot = this.slots[this.expandedIndex]
    if (slot && slot.card) slot.card.collapse()
    this.expandedIndex = -1
  }

  // --- External drive (CardQueryVoiceAgent) ----------------------------------

  /**
   * Spins the cosmos faster (or back to normal) to signal the agent is searching.
   * No-op visually once a result row is shown (drift is frozen then).
   */
  setSearchActive(active: boolean): void {
    this.searchActive = active
  }

  /**
   * Pulls the cards with the given store ids out of the cosmos into a camera-
   * facing row in front of the user: freezes the cosmos drift + gaze, expands the
   * result cards and renders them in front. Ids that aren't part of the spawned
   * cosmos (captured/seed cards) are skipped. Returns how many were actually shown
   * so the agent can tell the user if some matches can't be displayed.
   */
  showQueryResults(ids: string[]): number {
    // Start from a clean slate so a re-query while results are up re-lays out.
    this.clearResultSlots()
    this.collapseCurrent()

    const indices: number[] = []
    for (const id of ids ?? []) {
      const idx = this.idToSlot[id]
      if (idx === undefined) continue       // not a cosmos card (captured/seed) — can't show
      if (indices.indexOf(idx) >= 0) continue
      indices.push(idx)
    }

    this.resultIndices = indices
    this.resultsActive = indices.length > 0
    this.searchActive = false
    this.driftFrozen = true
    this.gazeFrozen = true
    this.focusCandidate = -1
    this.focusDwell = 0
    this.focusedResultIndex = -1

    for (const idx of indices) {
      const slot = this.slots[idx]
      slot.isResult = true
      if (slot.card) {
        slot.card.expand()
        slot.card.setRenderInFront(true)
      }
    }
    this.logger.info("Showing " + indices.length + " result card(s) of " + (ids ? ids.length : 0) + " requested.")
    return indices.length
  }

  /**
   * Returns the result cards to the cosmos and re-enables drift + gaze. Safe to
   * call when no results are showing.
   */
  clearQueryResults(): void {
    this.clearResultSlots()
    this.resultIndices = []
    this.resultsActive = false
    this.driftFrozen = false
    this.gazeFrozen = false
    this.searchActive = false
    this.focusCandidate = -1
    this.focusDwell = 0
    this.focusedResultIndex = -1
  }

  /**
   * The store id of the result card the user is currently looking at (after a
   * short dwell), or null when none / no results shown. The query agent polls
   * this to ground its answers in the focused card.
   */
  getFocusedResultId(): string | null {
    if (!this.resultsActive || this.focusedResultIndex < 0) return null
    return this.slotIds[this.focusedResultIndex] ?? null
  }

  /**
   * True when the user's gaze points at the cosmos cloud (within `coneDeg` of the
   * direction to the cosmos centre above the globe). The query agent polls this to
   * re-arm itself after a captured-card chat handed the session to CardVoiceAgent.
   */
  isUserGazingAtCosmos(coneDeg: number = 22): boolean {
    if (!this.camTrans) return false
    const camPos = this.camTrans.getWorldPosition()
    const viewDir = this.camTrans.forward.uniformScale(-1)
    const toCenter = this.cosmosCenter().sub(camPos)
    const dist = toCenter.length
    if (dist < 1e-3) return false
    const cos = toCenter.dot(viewDir) / dist
    return cos >= Math.cos(Math.max(1, coneDeg) * DEG2RAD)
  }

  // Collapses + un-fronts every current result card and clears its flag.
  private clearResultSlots(): void {
    for (const idx of this.resultIndices) {
      const slot = this.slots[idx]
      if (!slot) continue
      slot.isResult = false
      if (slot.card) {
        slot.card.collapse()
        slot.card.setRenderInFront(false)
      }
    }
  }

  // Eases a result card from wherever it is toward its slot in the front row and
  // billboards it to face the user. k = its position in resultIndices, n = count.
  private layoutResultSlot(slot: DeckSlot, dt: number): void {
    if (!this.camTrans) return
    const n = this.resultIndices.length
    const k = this.resultIndices.indexOf(this.slots.indexOf(slot))
    const camPos = this.camTrans.getWorldPosition()
    const viewDir = this.camTrans.forward.uniformScale(-1) // camera looks along -forward
    const right = this.camTrans.right
    const up = this.camTrans.up

    const offsetIndex = k - (n - 1) / 2
    const target = camPos
      .add(viewDir.uniformScale(this.resultRowDepthCm))
      .add(right.uniformScale(offsetIndex * this.resultRowSpacingCm))
      .add(up.uniformScale(this.resultRowRiseCm))

    const cur = slot.trans.getWorldPosition()
    const t = Math.min(1, 6 * dt) // ease in so the card visibly flies out
    slot.trans.setWorldPosition(vec3.lerp(cur, target, t))
    slot.trans.setWorldRotation(quat.lookAt(this.camTrans.forward, vec3.up()))
  }

  // Tracks which result card is most centred in the gaze, with a dwell to avoid
  // flicker; updates focusedResultIndex (read by getFocusedResultId).
  private updateResultFocus(dt: number): void {
    if (!this.camTrans || this.resultIndices.length === 0) return
    const camPos = this.camTrans.getWorldPosition()
    const viewDir = this.camTrans.forward.uniformScale(-1)

    let best = -1
    let bestScore = -2
    for (const idx of this.resultIndices) {
      const toCard = this.slots[idx].trans.getWorldPosition().sub(camPos)
      const dist = toCard.length
      if (dist < 1e-3) continue
      const cos = toCard.dot(viewDir) / dist
      if (cos > bestScore) {
        bestScore = cos
        best = idx
      }
    }

    if (best === this.focusCandidate) {
      this.focusDwell += dt
      if (this.focusDwell >= CardDeckController.FOCUS_DWELL_SEC) this.focusedResultIndex = best
    } else {
      this.focusCandidate = best
      this.focusDwell = 0
    }
  }

  // Positions a slot on its horizontal ring above the globe top, plus the bob.
  // height is the vertical (Y) distance above the top; hRadius the horizontal spread.
  private placeSlot(slot: DeckSlot, center: vec3): void {
    const bob = slot.bobAmp * Math.sin(slot.bobFreq * slot.clock + slot.bobPhase)
    const pos = new vec3(
      center.x + slot.hRadius * Math.cos(slot.phi),
      center.y + slot.height + bob,
      center.z + slot.hRadius * Math.sin(slot.phi)
    )
    slot.trans.setWorldPosition(pos)
  }

  private billboardSlot(slot: DeckSlot): void {
    if (!this.camTrans) return
    slot.trans.setWorldRotation(quat.lookAt(this.camTrans.forward, vec3.up()))
  }

  // Centre of the cosmos shell: the globe's top surface point if available.
  private cosmosCenter(): vec3 {
    if (this.globeView) return this.globeView.getTopTip()
    if (this.centerObject) return this.centerObject.getTransform().getWorldPosition()
    return this.getSceneObject().getTransform().getWorldPosition()
  }

  private rand(min: number, max: number): number {
    return min + Math.random() * (max - min)
  }
}
