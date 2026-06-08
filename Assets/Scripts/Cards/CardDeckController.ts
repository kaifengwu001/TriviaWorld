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
 * cards sit off to the sides (you turn your head to see them). Sizes are angular
 * (degrees), so the on-screen size is independent of how close the cylinder is.
 * Positions come from a relevance-clustered, non-overlapping layout (topic-
 * primary, location + date as tie-breakers) solved once in angular space. Each
 * card billboards individually to face the user and sways gently; nothing orbits.
 *
 * QUERY MODE (driven by QueryOrchestrator / CardQueryVoiceAgent): the matching
 * cards fly out to a readable row in front of the user (showQueryResults); the
 * rest of the plane holds still. clearQueryResults eases them back to their
 * plane spot. The cards stay expanded throughout — they never collapse.
 *
 * Prefab instantiation + getComponent(getTypeName()) mirror GlobeController's
 * ensureMarkers(); the global-store lookup mirrors InterestStore's pattern.
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger";
import { PremadeCard } from "../PremadeCard/PremadeCard";
import { GlobeView } from "../Globe/GlobeView";
import { CARD_DECK_DATA, SEED_CARDS, CardDeckEntry } from "./cardDeckData";

const DEG2RAD = Math.PI / 180

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
  @hint("Radius (cm) of the cylinder the cards wrap on = how far the cards are from your head. 0 = auto (the globe's distance). Cards have a minimum on-screen size, so DISTANCE is the real 'make them smaller' knob — push this out to shrink them.")
  cardDistanceCm: number = 0

  @input
  @hint("How far (cm) ABOVE the globe top the field is vertically centred.")
  verticalCenterRiseCm: number = 20

  @ui.label('<span style="color: #60A5FA;">Cylinder wall (wraps around the head, above the globe)</span>')
  @input
  @hint("Fixed HEIGHT (cm) of the cylinder-wall band. Vertical extent is fixed; cards spread sideways as needed to avoid overlap.")
  canvasHeightCm: number = 20

  @input
  @hint("Minimum gap (cm) kept between cards. A little touching is fine; this prevents heavy overlap.")
  cardGapCm: number = 0

  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Card size = uniform WORLD SCALE of the whole card (predictable; bypasses the prefab x10 ImageAnchor + parent scale).</span>')
  @input
  @hint("Overall card size — the world scale applied to a scale-1 card. THE size knob. Smaller = smaller cards. NOTE: set this in the Inspector (editing the code default does nothing once the component is in the scene).")
  cardSizeBase: number = 0.3

  @input
  @hint("Smallest per-card size multiplier (variety). Each card picks a random scale between this and the max.")
  cardSizeMinScale: number = 0.3

  @input
  @hint("Largest per-card size multiplier (variety).")
  cardSizeMaxScale: number = 1.0

  @input
  @hint("Card footprint WIDTH (cm) — the real card width used for the non-overlap packing.")
  cardWidthCm: number = 10

  @input
  @hint("Card footprint HEIGHT (cm) — the real card height used for the non-overlap packing.")
  cardHeightCm: number = 15

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
  @hint("Horizontal gap (cm) between adjacent cards in the result row laid out in front of the user.")
  resultRowSpacingCm: number = 16

  @input
  @hint("Distance (cm) in front of the camera the result row is placed. Keep this CLOSER than the plane so results read in front.")
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

  // Cylinder layout, built once on the first frame the camera is available.
  private layoutBuilt: boolean = false
  private anchor: vec3 = vec3.zero()       // field-centre point (for gaze aim)
  private rightW: vec3 = new vec3(1, 0, 0) // basis for the gentle in-place sway
  private upW: vec3 = vec3.up()

  // Query-result / search state (driven by the CardQueryVoiceAgent).
  private idToSlot: { [id: string]: number } = {}  // store id -> slot index
  private slotIds: string[] = []                   // slot index -> store id
  private searchActive: boolean = false   // sway faster while the agent searches
  private resultsActive: boolean = false  // a result row is laid out in front
  private resultIndices: number[] = []    // slot indices currently in the row (row order)
  private driftFrozen: boolean = false    // plane cards hold still while showing results
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
        card.setText(entry.text)
        // Visual size is set in buildWrappedLayout (angular → world width at radius R).
      } else {
        this.logger.warn("Spawned card " + entry.id + " has no PremadeCard component.")
      }

      const slot = this.makeSlot(obj, card, entry, sizeScale)
      this.idToSlot[entry.id] = this.slots.length
      this.slotIds.push(entry.id)
      this.slots.push(slot)

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
    }
  }

  // --- per-frame --------------------------------------------------------------

  private update(dt: number): void {
    if (this.slots.length === 0) return
    if (!this.layoutBuilt) {
      if (!this.camTrans) return // need the camera to orient + anchor the cylinder
      this.buildWrappedLayout()
      if (!this.layoutBuilt) return
    }
    if (this.resultsActive) this.updateResultFocus(dt)

    const swaySpeed = this.searchActive ? this.searchSpinMultiplier : 1
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]

      // Result cards fly out to a readable row in front of the user.
      if (slot.isResult) {
        this.layoutResultSlot(slot, dt)
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
    }
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
    const R = this.cardDistanceCm > 0 ? this.cardDistanceCm : Math.max(1, horizDist)
    const centerH = fieldCenter.y - head.y // band-centre height relative to the head

    // Basis for the gentle in-place sway.
    this.rightW = rightN
    this.upW = vec3.up()

    // Cards inherit this parent's scale — convert a target WORLD scale to a local
    // scale by dividing it out (this is the hidden multiplier that blew cards up).
    const parentScale = this.getSceneObject().getTransform().getWorldScale()

    // Per-card footprint radius (cm) from the REAL card size; band half-height (cm).
    const radius: number[] = []
    let sumR = 0
    for (let i = 0; i < n; i++) {
      const s = this.slots[i].sizeScale
      const w = this.cardWidthCm * s
      const h = this.cardHeightCm * s
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
      const targetWorld = this.cardSizeBase * slot.sizeScale
      slot.trans.setLocalScale(new vec3(
        parentScale.x > 1e-4 ? targetWorld / parentScale.x : targetWorld,
        parentScale.y > 1e-4 ? targetWorld / parentScale.y : targetWorld,
        parentScale.z > 1e-4 ? targetWorld / parentScale.z : targetWorld,
      ))
      const az = u[i] / R // arc-length -> radians around world up
      const horiz = Fh.uniformScale(Math.cos(az)).add(rightN.uniformScale(Math.sin(az)))
      slot.base = head.add(horiz.uniformScale(R)).add(vec3.up().uniformScale(centerH + v[i]))
      slot.azDeg = az / DEG2RAD
      slot.elDeg = v[i]
      slot.trans.setWorldPosition(slot.base)
      this.billboardSlot(slot)
      if (u[i] < minU) minU = u[i]
      if (u[i] > maxU) maxU = u[i]
    }
    this.layoutBuilt = true

    // Diagnostic: live inputs + resulting band footprint + a sample card.
    const c0 = this.slots[0]
    const card0Dist = c0 ? c0.base.sub(head).length : 0
    const card0Scale = c0 ? c0.trans.getWorldScale().x : 0
    this.logger.info(
      "[layout] cards=" + n +
      " R=" + R.toFixed(0) + "cm band=" + (maxU - minU).toFixed(0) + "x" + (halfV * 2).toFixed(0) + "cm" +
      " cardSizeBase(in)=" + this.cardSizeBase +
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

  // --- External drive (CardQueryVoiceAgent) ----------------------------------

  /** Speeds the gentle sway up (or back) to signal the agent is searching. */
  setSearchActive(active: boolean): void {
    this.searchActive = active
  }

  /**
   * Pulls the cards with the given store ids out of the plane into a camera-
   * facing row in front of the user: freezes the plane sway, renders the results
   * in front (they are already expanded). Ids that aren't part of the spawned
   * plane (captured/seed cards) are skipped. Returns how many were shown.
   */
  showQueryResults(ids: string[]): number {
    this.clearResultSlots()

    const indices: number[] = []
    for (const id of ids ?? []) {
      const idx = this.idToSlot[id]
      if (idx === undefined) continue       // not a plane card (captured/seed) — can't show
      if (indices.indexOf(idx) >= 0) continue
      indices.push(idx)
    }

    this.resultIndices = indices
    this.resultsActive = indices.length > 0
    this.searchActive = false
    this.driftFrozen = true
    this.focusCandidate = -1
    this.focusDwell = 0
    this.focusedResultIndex = -1

    for (const idx of indices) {
      const slot = this.slots[idx]
      slot.isResult = true
      if (slot.card) slot.card.setRenderInFront(true) // already expanded
    }
    this.logger.info("Showing " + indices.length + " result card(s) of " + (ids ? ids.length : 0) + " requested.")
    return indices.length
  }

  /**
   * Returns the result cards to the plane and re-enables sway. Safe to call when
   * no results are showing. Cards stay expanded — they never collapse.
   */
  clearQueryResults(): void {
    this.clearResultSlots()
    this.resultIndices = []
    this.resultsActive = false
    this.driftFrozen = false
    this.searchActive = false
    this.focusCandidate = -1
    this.focusDwell = 0
    this.focusedResultIndex = -1
  }

  /**
   * The store id of the result card the user is currently looking at (after a
   * short dwell), or null when none / no results shown.
   */
  getFocusedResultId(): string | null {
    if (!this.resultsActive || this.focusedResultIndex < 0) return null
    return this.slotIds[this.focusedResultIndex] ?? null
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

  // Un-fronts every current result card and clears its flag (stays expanded).
  private clearResultSlots(): void {
    for (const idx of this.resultIndices) {
      const slot = this.slots[idx]
      if (!slot) continue
      slot.isResult = false
      if (slot.card) slot.card.setRenderInFront(false)
    }
  }

  // Eases a result card toward its slot in the front row and faces the user.
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
    slot.trans.setWorldPosition(vec3.lerp(cur, target, Math.min(1, 6 * dt)))
    slot.trans.setWorldRotation(quat.lookAt(this.camTrans.forward, vec3.up()))
  }

  // Tracks which result card is most centred in the gaze, with a dwell.
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
