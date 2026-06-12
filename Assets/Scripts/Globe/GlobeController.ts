/**
 * Specs Inc. 2026
 * GlobeController – the guided state machine for the Interactive Globe lens.
 *
 * States: OVERVIEW -> ZOOMING_IN -> DOCKED (L0..Ln) -> ZOOMING_OUT -> OVERVIEW.
 *
 *   OVERVIEW    full globe + city markers; gaze a marker, pinch to select.
 *   ZOOMING_IN  the globe DIVES into the city: one world-pose tween rotates the
 *               city to its top, slides that top onto the table center, scales to
 *               dockScaleForSpan(L0 enter span), and fades OUT while the table
 *               fades IN at the matched footprint — so the globe "becomes" the map.
 *   DOCKED      globe hidden; the table pans (one-hand drag -> uvOffset) and
 *               zooms (two-hand pinch -> uvScale). Crossing a zoom edge steps
 *               the baked LOD (swap mapTex, recompute UV from bounds).
 *   ZOOMING_OUT the reverse dive: the globe reappears matching the current table
 *               view, then un-dives back to the captured OVERVIEW pose as the
 *               table fades out.
 *
 * Two input paths, both always active:
 *   - SIK hands (device): pinch to select; one-hand drag to pan; two-hand pinch
 *     to zoom/step LOD (the proven pattern from PictureBehavior).
 *   - Touch (editor + phone): drag the GLOBE to rotate and tap a marker to
 *     select; drag the TABLE to pan, two-finger pinch to zoom, tap to step LOD.
 *
 * City markers are created and placed by code from each city's lat/lng (no hand
 * placement), parented to the globe so they ride its rotation. The globe radius
 * is auto-detected from its mesh. Alignment is entirely math-driven (GeoMath).
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger";
import { SIK } from "SpectaclesInteractionKit.lspkg/SIK";
import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import { Interactor } from "SpectaclesInteractionKit.lspkg/Core/Interactor/Interactor";
import { InteractorEvent, DragInteractorEvent } from "SpectaclesInteractionKit.lspkg/Core/Interactor/InteractorEvent";
import { GlobeView, PoseEasing } from "./GlobeView";
import { MapViewport } from "./MapViewport";
import { CityData, City, LodLevel } from "./CityData";
import { CityMarker } from "./CityMarker";
import { lonLatToSpherePos, LatLng, biasedEase, clamp01 } from "./GeoMath";
import { PinchDragTracker } from "./PinchDragTracker";

interface Vec2 {
  x: number;
  y: number;
}

type State = "OVERVIEW" | "ZOOMING_IN" | "DOCKED" | "ZOOMING_OUT";

@component
export class GlobeController extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">GlobeController – guided globe -> city-zoom state machine</span><br/><span style="color: #94A3B8; font-size: 11px;">Wires gaze/pinch input to globe aim+zoom, the dock crossfade, and table pan/zoom/LOD. Alignment is math-driven from cityBounds.</span>')
  @ui.separator

  @ui.label('<span style="color: #60A5FA;">Components</span>')
  @input
  @hint("The globe (rotate-to-aim + scale-to-zoom, hidden while docked).")
  globeView: GlobeView

  @input
  @hint("The holodeck map table (UV pan/zoom under a fixed feathered crop).")
  mapViewport: MapViewport

  @input
  @hint("CityData component that resolves geo bounds + imported map textures.")
  cityData: CityData

  @input
  @hint("OPTIONAL pre-placed markers (one per city). Leave empty to AUTO-CREATE + place them by code from each city's lat/lng.")
  markers: CityMarker[]

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Markers (auto-created)</span>')
  @input
  @hint("Create + place a marker per city from its lat/lng (parented to the globe). Markers are INVISIBLE logic-only selection targets (collider + Interactable); the visible textured markers are drawn by CardMarkerLayer from the CardStore. Turn off to use only the markers assigned above.")
  autoCreateMarkers: boolean = true

  @input
  @hint("How far above the globe surface to place markers, as a fraction of the globe radius (1 = on the surface).")
  markerSurfaceOffset: number = 1.04

  @input
  @hint("Uniform local scale applied to each auto-created marker object.")
  markerScale: number = 1.0

  @input
  @hint("Longitude offset in degrees added to every city before placing its marker AND aiming the globe. Use this to line cities up with the globe base texture when the texture can't be shifted in Lens Studio (+ rotates cities east, - west).")
  textureLonOffsetDeg: number = 0

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Scene</span>')
  @input
  @hint("Camera/head object, used for gaze selection and to size pan deltas.")
  cameraObject: SceneObject

  @input
  @hint("The table's transform object; its right/up axes convert hand drags into UV pan. Defaults to the MapViewport's object if unset.")
  @allowUndefined
  tableObject: SceneObject

  @input
  @hint("Optional Text label showing the current LOD's name.")
  @allowUndefined
  labelText: Text

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Tuning</span>')
  @input
  @hint("Seconds for the OVERVIEW->dock approach tween.")
  approachSec: number = 1.1

  @input
  @hint("Seconds for the globe-out / table-in crossfade.")
  crossfadeSec: number = 0.5

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Dive feel (per-channel bias)</span><br/><span style="color: #94A3B8; font-size: 11px;">One knob per channel, range -1..+1.<br/><b>0</b> = smooth ease-in-out (natural). <b>+1</b> = front-loaded (fast start, gentle finish). <b>-1</b> = back-loaded (slow start, fast finish). Magnitude = strength.</span>')
  @input
  @widget(new SliderWidget(-1, 1, 0.05))
  @hint("POSITION feel: how the top tip travels to the table. +1 darts over early then eases in; -1 creeps then rushes.")
  positionBias: number = 0

  @input
  @widget(new SliderWidget(-1, 1, 0.05))
  @hint("ROTATION feel: how the city swings up to the top. +1 snaps the turn early; -1 holds then whips around.")
  rotationBias: number = 0

  @input
  @widget(new SliderWidget(-1, 1, 0.05))
  @hint("SCALE feel: how the zoom-into-the-surface accelerates. +1 grows fast then settles; -1 eases in then surges.")
  scaleBias: number = 0

  @input
  @widget(new SliderWidget(-1, 1, 0.05))
  @hint("FADE feel: the globe's alpha out (on dock) / in (on return).")
  fadeBias: number = 0

  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Speed = how fast a channel finishes RELATIVE to the dive time. 1 = uses the full dive; 2 = done in half the time (then holds); &lt;1 = slower. Bias only reshapes a channel; speed is what makes it finish sooner.</span>')
  @input
  @widget(new SliderWidget(0.25, 5, 0.05))
  @hint("POSITION speed multiplier (1 = full dive duration, higher = arrives sooner).")
  positionSpeed: number = 1

  @input
  @widget(new SliderWidget(0.25, 5, 0.05))
  @hint("ROTATION speed multiplier (1 = full dive duration, higher = swings up sooner). Raise this if the turn feels too slow even at max bias.")
  rotationSpeed: number = 2

  @input
  @widget(new SliderWidget(0.25, 5, 0.05))
  @hint("SCALE speed multiplier (1 = full dive duration, higher = zooms in sooner).")
  scaleSpeed: number = 1

  @input
  @widget(new SliderWidget(0.25, 5, 0.05))
  @hint("FADE speed multiplier (1 = full dive duration, higher = fades sooner).")
  fadeSpeed: number = 1

  @input
  @hint("Fade the globe out as it docks (and back in on return). Turn OFF to keep the globe fully visible at the dock pose, so you can verify the selected location ends up on TOP with the correct orientation.")
  fadeOutGlobe: boolean = true

  @input
  @hint("Cosine-threshold half-angle (degrees) of the gaze cone for marker selection.")
  gazeHalfAngleDeg: number = 12

  @input
  @hint("SINGLE authored on-screen table size in cm. Pushed to GlobeView (footprint match) and MapViewport (quad mesh) at startup, and used here for the table collider + pan scaling — set it in this one place.")
  tableSizeCm: number = 60

  @input
  @hint("Pan speed multiplier for one-hand drag -> uvOffset.")
  panSpeed: number = 0.3

  @input
  @hint("Two-hand pinch zoom sensitivity (>1 = faster). Applies to both hand and two-finger touch zoom.")
  zoomSpeed: number = 1.0

  @input
  @hint("uvScale a newly-entered deeper LOD loads at (1 = fully zoomed out/home; lower = more zoomed in). ~0.7 leaves room to pan and zoom right after a step-in, and makes the step happen a bit later/deeper on the previous level.")
  lodEnterZoom: number = 0.7

  @input
  @hint("Globe rotation gain for a one-hand pinch-drag in OVERVIEW (radians of spin per cm of smoothed hand movement).")
  handRotateSpeed: number = 0.03

  @input
  @hint("How strongly the globe springs back to upright (poles vertical) after you release a drag in OVERVIEW. Higher = snappier; 0 disables self-righting and lets the globe stay tilted.")
  globeRightingSpeed: number = 6.0

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Touch input</span>')
  @input
  @hint("Globe rotation speed for a one-finger drag in OVERVIEW (radians per full-screen drag).")
  touchRotateSpeed: number = 3.0

  @input
  @hint("Table pan gain for a one-finger drag in DOCKED (multiplies the normalized screen delta).")
  touchPanGain: number = 1.2

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Logging</span>')
  @input
  @hint("Enable general logging")
  enableLogging: boolean = false

  @input
  @hint("Enable lifecycle logging (onAwake, onStart, onUpdate, onDestroy)")
  enableLoggingLifecycle: boolean = false

  private logger: Logger

  private state: State = "OVERVIEW"
  private cities: City[] = []
  private activeCity: City | null = null
  private activeLevelIndex: number = 0

  private rightHand = SIK.HandInputData.getHand("right")
  private leftHand = SIK.HandInputData.getHand("left")
  private leftDown = false
  private rightDown = false
  // Two-hand zoom tracking.
  private pinchDistPrev: number = -1
  private pinchDistSmoothed: number = -1
  private camTransform: Transform = null
  private camComponent: Camera = null
  private tableTransform: Transform = null
  private gazedMarker: CityMarker | null = null

  // The globe's OVERVIEW pose, captured the instant a city is selected so the
  // return trip (back) reverses the exact same dive, landing the globe back where
  // (and how) the user left it — including any overview spin. Position is stored
  // as the TOP TIP (the dive's pivot), matching GlobeView's pose semantics.
  private preDockTopPos: vec3 = vec3.zero()
  private preDockRot: quat = quat.quatIdentity()

  // Active while a dive (ZOOMING_IN/OUT) drives the table by the globe's live
  // footprint span so the two co-zoom seamlessly. `diveCenter` is the geographic
  // point both keep centered: the city on the way in, the current view on the way
  // out. Only set when the active city has a wide L-1 handoff capture; otherwise
  // the dive falls back to a plain table fade.
  private diveMapActive: boolean = false
  private diveCenter: LatLng = { lat: 0, lng: 0 }
  // Dive logging throttle + one-shot milestone flags (gated by enableLogging).
  private diveLogT: number = 0
  private diveLoggedMapOn: boolean = false
  private diveLoggedHome: boolean = false

  // SIK interaction (Interactable + collider) drives the on-surface cursor and
  // jitter-filtered drag, replacing the raw thumbTip bookkeeping. The globe
  // Interactable rotates the globe; the map Interactable pans the table; each
  // marker Interactable taps to select a city.
  private globeInteractable: Interactable | null = null
  private mapInteractable: Interactable | null = null
  private markerInteractables: Interactable[] = []

  // Smoothed globe-rotation drag (OVERVIEW). Both the globe surface and any
  // marker forward into this so a drag started on a pin still spins the globe.
  private globeDragTracker = new PinchDragTracker()
  private globeDragInteractor: Interactor | null = null
  private globeDragAccum: vec3 = vec3.zero()
  private globeDragMoved: boolean = false
  // True while the user is actively rotating the globe (hand drag or touch drag).
  // The self-righting spring only runs once this goes false, so a deliberate
  // pole-tilt holds steady under the finger and only levels out on release.
  private globeInputActive: boolean = false

  // Smoothed map pan drag (DOCKED).
  private mapDragTracker = new PinchDragTracker()
  private mapDragInteractor: Interactor | null = null
  private mapDragAccum: vec3 = vec3.zero()

  // A smoothed drag is treated as movement (vs a tap) past this many cm.
  private readonly DRAG_MOVE_EPS = 0.4

  // Touch state. `touches` maps an active touch id -> its latest screen pos
  // ([0,1], top-left origin). A single touch that never moves past the tap
  // threshold is treated as a tap; two touches drive a pinch zoom.
  private touches: { [id: number]: Vec2 } = {}
  private tapId: number = -1
  private tapMoved: boolean = false
  private touchPinchPrev: number = -1
  private readonly TAP_MOVE_THRESH = 0.02

  onAwake() {
    this.logger = new Logger("GlobeController", this.enableLogging || this.enableLoggingLifecycle, true)
    if (this.enableLoggingLifecycle) this.logger.debug("LIFECYCLE: onAwake()")

    // Reachable across prefab boundaries (the CardQueryVoiceAgent drives the
    // zoom from a query result), mirroring global.cropCardStore / cropInterestStore.
    ;(global as any).globeController = this

    if (this.cameraObject) {
      this.camTransform = this.cameraObject.getTransform()
      this.camComponent = this.cameraObject.getComponent("Component.Camera")
    }
    const tableObj = this.tableObject ?? (this.mapViewport ? this.mapViewport.getSceneObject() : null)
    if (tableObj) this.tableTransform = tableObj.getTransform()

    this.createEvent("OnStartEvent").bind(() => this.onStart())

    this.rightHand.onPinchDown.add(this.onRightPinchDown)
    this.rightHand.onPinchUp.add(this.onRightPinchUp)
    this.leftHand.onPinchDown.add(this.onLeftPinchDown)
    this.leftHand.onPinchUp.add(this.onLeftPinchUp)

    // Touch works in the editor and on phone lenses; it complements the hands.
    this.createEvent("TouchStartEvent").bind((e) => this.onTouchStart(e))
    this.createEvent("TouchMoveEvent").bind((e) => this.onTouchMove(e))
    this.createEvent("TouchEndEvent").bind((e) => this.onTouchEnd(e))

    this.createEvent("UpdateEvent").bind(() => this.update(getDeltaTime()))
  }

  private onStart(): void {
    if (!this.cityData) {
      this.logger.error("No CityData assigned; controller cannot run.")
      return
    }
    this.cities = this.cityData.getCities()
    this.propagateTableSize()
    this.configureZoomLimits()
    this.ensureMarkers()
    this.setupInteractions()
    this.enterOverview()
  }

  // Pushes the single authored table size to the globe (footprint match) and the
  // table (quad mesh) so all three components share one value — no per-component
  // tableSizeCm to keep in sync.
  private propagateTableSize(): void {
    if (this.globeView) this.globeView.setTableSizeCm(this.tableSizeCm)
    if (this.mapViewport) this.mapViewport.setTableSizeCm(this.tableSizeCm)
  }

  // Lowers the viewport's hard min uvScale below every per-level step-in
  // threshold so the deeper "switch later" point (where the next LOD loads at
  // lodEnterZoom) is actually reachable before the zoom clamps.
  private configureZoomLimits(): void {
    let smallestEnter = Infinity
    for (const city of this.cities) {
      for (let i = 0; i + 1 < city.levels.length; i++) {
        const ratio = city.levels[i + 1].bounds.spanDeg / Math.max(1e-6, city.levels[i].bounds.spanDeg)
        smallestEnter = Math.min(smallestEnter, this.lodEnterZoom * ratio)
      }
    }
    if (isFinite(smallestEnter)) {
      this.mapViewport.setMinUvScale(Math.max(0.05, smallestEnter - 0.03))
    }
  }

  // Adds a collider + SIK Interactable to the globe, the map table, and each
  // marker (created in code so no manual scene wiring is needed). This is what
  // gives the on-surface cursor feedback and clean, filterable drag events —
  // mirroring how the official Frame example builds its interaction.
  private setupInteractions(): void {
    if (this.globeView) {
      const globeObj = this.globeView.getSceneObject()
      const r = Math.max(0.1, this.globeView.getLocalRadiusCm())
      this.addSphereCollider(globeObj, r)
      this.globeInteractable = this.makeInteractable(globeObj)
      this.globeInteractable.onTriggerStart.add(() => (this.globeDragMoved = false))
      this.globeInteractable.onDragStart.add((e) => this.beginGlobeDrag(e))
      this.globeInteractable.onDragUpdate.add((e) => this.updateGlobeDrag(e))
      this.globeInteractable.onDragEnd.add(() => this.endGlobeDrag())
      this.globeInteractable.onTriggerEnd.add(() => this.endGlobeDrag())
      this.globeInteractable.onTriggerCanceled.add(() => this.endGlobeDrag())
    }

    const tableObj = this.tableObject ?? (this.mapViewport ? this.mapViewport.getSceneObject() : null)
    if (tableObj) {
      this.addBoxCollider(tableObj, new vec3(this.tableSizeCm, 1, this.tableSizeCm))
      this.mapInteractable = this.makeInteractable(tableObj)
      this.mapInteractable.onDragStart.add((e) => this.beginMapDrag(e))
      this.mapInteractable.onDragUpdate.add((e) => this.updateMapDrag(e))
      this.mapInteractable.onDragEnd.add(() => this.endMapDrag())
      this.mapInteractable.onTriggerEnd.add(() => this.endMapDrag())
      this.mapInteractable.onTriggerCanceled.add(() => this.endMapDrag())
    }

    this.setupMarkerInteractions()
  }

  // Each marker becomes tappable (its own Interactable) so SELECTING a city now
  // requires actually targeting the pin — this removes the old "any pinch while
  // gazing instantly zooms" behavior. A drag that starts on a marker still spins
  // the globe (forwarded into the globe drag) and is then NOT treated as a tap.
  private setupMarkerInteractions(): void {
    if (!this.markers) return
    const radius = this.globeView ? Math.max(0.1, this.globeView.getLocalRadiusCm() * 0.06) : 2
    for (let i = 0; i < this.markers.length; i++) {
      const marker = this.markers[i]
      if (!marker) continue
      const obj = marker.getSceneObject()
      const localR = radius / Math.max(0.001, obj.getTransform().getLocalScale().x)
      this.addSphereCollider(obj, localR)
      const interactable = this.makeInteractable(obj)
      interactable.onTriggerStart.add(() => (this.globeDragMoved = false))
      interactable.onDragStart.add((e) => this.beginGlobeDrag(e))
      interactable.onDragUpdate.add((e) => this.updateGlobeDrag(e))
      interactable.onDragEnd.add(() => this.endGlobeDrag())
      interactable.onTriggerEnd.add(() => this.onMarkerTriggerEnd(marker))
      interactable.onTriggerCanceled.add(() => this.endGlobeDrag())
      this.markerInteractables.push(interactable)
    }
  }

  private makeInteractable(obj: SceneObject): Interactable {
    let interactable = obj.getComponent(Interactable.getTypeName()) as Interactable
    if (!interactable) {
      interactable = obj.createComponent(Interactable.getTypeName()) as Interactable
    }
    // Direct (near-field) + Indirect (far-field ray) so it works hand-near and
    // pointed-at; one interactor at a time so two-hand zoom never fights a drag.
    interactable.targetingMode = 3
    interactable.allowMultipleInteractors = false
    return interactable
  }

  private addSphereCollider(obj: SceneObject, radius: number): void {
    if (obj.getComponent("Physics.ColliderComponent")) return
    const collider = obj.createComponent("Physics.ColliderComponent") as ColliderComponent
    const shape = Shape.createSphereShape()
    shape.radius = radius
    collider.shape = shape
    collider.fitVisual = false
  }

  private addBoxCollider(obj: SceneObject, size: vec3): void {
    if (obj.getComponent("Physics.ColliderComponent")) return
    const collider = obj.createComponent("Physics.ColliderComponent") as ColliderComponent
    const shape = Shape.createBoxShape()
    shape.size = size
    collider.shape = shape
    collider.fitVisual = false
  }

  // Creates + places a marker per city from its lat/lng if none were assigned
  // (or auto-create is on). Markers parent to the globe so they ride its
  // rotation; positions come straight from GeoMath, so no hand placement.
  private ensureMarkers(): void {
    const haveAssigned = this.markers && this.markers.filter((m) => !!m).length > 0
    if (haveAssigned && !this.autoCreateMarkers) return
    if (!this.globeView) {
      this.logger.warn("Cannot auto-create markers without a GlobeView.")
      return
    }

    const globeObj = this.globeView.getSceneObject()
    const radius = this.globeView.getLocalRadiusCm() * Math.max(1, this.markerSurfaceOffset)
    const created: CityMarker[] = []
    for (let i = 0; i < this.cities.length; i++) {
      const city = this.cities[i]
      const aimed = this.applyTextureLonOffset(city.latLng)
      const p = lonLatToSpherePos(aimed.lng, aimed.lat, radius)
      // Logic-only object: a selection target (collider + Interactable) with no
      // visual of its own. The visible, TEXTURED markers are rendered separately
      // by CardMarkerLayer from the CardStore, so selection and visuals can't drift.
      const obj = global.scene.createSceneObject("Marker_" + city.name)
      obj.setParent(globeObj)
      obj.layer = globeObj.layer

      const t = obj.getTransform()
      t.setLocalPosition(new vec3(p.x, p.y, p.z))
      t.setLocalScale(vec3.one().uniformScale(Math.max(0.001, this.markerScale)))

      let marker = obj.getComponent(CityMarker.getTypeName()) as unknown as CityMarker
      if (!marker) {
        marker = obj.createComponent(CityMarker.getTypeName()) as unknown as CityMarker
      }
      marker.setCityName(city.name)
      marker.refreshBaseScale()
      created.push(marker)
    }
    this.markers = created
    this.logger.info("Auto-created " + created.length + " city markers.")
  }

  // --- State transitions -----------------------------------------------------

  private enterOverview(): void {
    this.state = "OVERVIEW"
    this.activeCity = null
    this.activeLevelIndex = 0
    this.diveMapActive = false
    this.setMarkersVisible(true)
    if (this.globeView) this.globeView.show(this.crossfadeSec)
    if (this.mapViewport) {
      this.mapViewport.endTransition()
      this.mapViewport.hide()
    }
    this.setLabel("")
    this.logger.info("State -> OVERVIEW")
  }

  /** Begins the guided approach toward a selected city. */
  selectCity(city: City): void {
    if (!city || city.levels.length === 0) {
      this.logger.warn("selectCity: city has no LOD levels.")
      return
    }
    if (this.state !== "OVERVIEW") return
    this.activeCity = city
    this.activeLevelIndex = 0
    this.state = "ZOOMING_IN"
    this.setMarkersVisible(false)
    this.setLabel(city.name)
    this.logger.info("State -> ZOOMING_IN (" + city.name + ")")

    const l0 = city.levels[0]
    const enterSpan = this.enterFraction() * l0.bounds.spanDeg

    // Remember the overview pose (top tip + rotation) so back() can reverse this
    // exact dive.
    const gT = this.globeView.getSceneObject().getTransform()
    this.preDockTopPos = this.globeView.getTopTip()
    this.preDockRot = gT.getWorldRotation()

    const fromScale = this.globeView.getScale()
    const toScale = this.globeView.dockScaleForSpan(enterSpan)

    if (this.hasTransition()) {
      // Seamless handoff: the table co-zooms WITH the globe from the critical
      // level inward. updateDiveMap() frames it every frame to the globe's live
      // footprint span (starting on the wide L-1 capture, crossfading to sharp L0
      // as it passes L0's home span) and crossfades its opacity against the globe.
      this.diveMapActive = true
      this.diveCenter = { lat: city.latLng.lat, lng: city.latLng.lng }
      this.resetDiveLog()
      this.mapViewport.beginTransition(city.transitionLevel, l0, l0.bounds.spanDeg, true)
      this.logDiveStart("IN", fromScale, toScale, false)
    } else {
      // No L-1 capture for this city: fall back to bringing the table up at the
      // (partly-zoomed) L0 framing and fading it in over the dive window.
      this.diveMapActive = false
      const enterView = {
        centerLatLng: { lat: l0.bounds.centerLatLng.lat, lng: l0.bounds.centerLatLng.lng },
        spanDeg: enterSpan,
      }
      this.mapViewport.setLevel(l0, enterView, false)
      this.mapViewport.show(undefined, this.approachSec)
    }

    // The globe simultaneously rotates the city to its top, slides that top onto
    // the table center, scales up until the surface patch matches the table
    // footprint, and (unless the fade-out toggle is off) fades out — visually
    // "becoming" the map. Each channel runs on its own easing curve.
    const pose = this.computeDockPose(city.latLng, enterSpan)
    const targetAlpha = this.fadeOutGlobe ? 0 : 1
    this.globeView.animateToPose(
      pose.topPos,
      pose.rot,
      pose.scale,
      targetAlpha,
      this.approachSec,
      this.diveEasing(false, fromScale, toScale),
      () => this.dock()
    )
  }

  // Whether the active city has a wide L-1 handoff capture (so the table can
  // co-zoom continuously with the globe). Without it, the dive falls back to a
  // plain table fade and the legacy full-range channel easing.
  private hasTransition(): boolean {
    return !!(this.activeCity && this.activeCity.transitionLevel)
  }

  // The globe scale whose surface footprint equals the L-1 transition span — the
  // "critical level" where rotation + position have finished and the globe<->table
  // crossfade begins. 0 when the city has no L-1 capture.
  private criticalScale(): number {
    const tl = this.activeCity ? this.activeCity.transitionLevel : null
    if (!tl) return 0
    return this.globeView.dockScaleForSpan(tl.bounds.spanDeg)
  }

  // The per-channel easing for the dive (or its reverse), built from the
  // inspector bias + speed knobs around the CRITICAL LEVEL:
  //   - SCALE runs the whole dive (one continuous curve) so the footprint zoom
  //     never changes pace — that is what lets the table match by span alone.
  //   - ROTATION + POSITION finish BY the critical level (a hard deadline). Speed
  //     can only make them finish EARLIER (>=1); it can never push them past
  //     critical, so after critical the globe<->table match depends on zoom only.
  //   - FADE runs over [critical, L0-home]: the globe fades out / table fades in
  //     and COMPLETES the moment L0 fills the table (100% zoom), so the rest of the
  //     dive is a fully-opaque sharp-L0 zoom (100%->enter) rather than the L0 only
  //     becoming visible at the very end.
  // The reverse mirrors this with each direction's own critical time and reversed
  // curve shapes: the globe fades back IN over [L0-home, critical] (the return
  // starts opaque on L0 at home), then un-rotates outward.
  private diveEasing(reversed: boolean, fromScale: number, toScale: number): PoseEasing {
    const sclF = (t: number) => biasedEase(t * this.scaleSpeed, this.scaleBias)

    if (!this.hasTransition()) {
      // Legacy full-range dive: every channel spans the whole window.
      const f = (spd: number, bias: number) => (t: number) => biasedEase(t * spd, bias)
      const wrap = (g: (t: number) => number) => (reversed ? (t: number) => 1 - g(1 - t) : g)
      return {
        position: wrap(f(this.positionSpeed, this.positionBias)),
        rotation: wrap(f(this.rotationSpeed, this.rotationBias)),
        scale: wrap(f(this.scaleSpeed, this.scaleBias)),
        alpha: wrap(f(this.fadeSpeed, this.fadeBias)),
      }
    }

    const eps = 1e-4
    const eff = (s: number) => Math.max(1, s) // rot/pos may finish earlier, never later

    if (!reversed) {
      const tc = clamp01(this.criticalTimeFraction(sclF, fromScale, toScale))
      // The globe fades OUT / table fades IN over [critical, L0-home], COMPLETING
      // the instant L0 fills the table (span = L0 home / 100% zoom). After that the
      // globe is gone and the fully-opaque sharp L0 keeps zooming in to the enter
      // framing — so L0 is clearly visible at 100% with a real 100%->70% zoom, not
      // only revealed once the dive finishes.
      const homeSpan = this.activeCity ? this.activeCity.levels[0].bounds.spanDeg : 1
      const homeScale = this.globeView.dockScaleForSpan(homeSpan)
      const tHome = Math.max(tc + eps, clamp01(this.scaleTimeFraction(sclF, fromScale, toScale, homeScale)))
      const pre = (spd: number, bias: number) => (t: number) =>
        biasedEase((t / Math.max(eps, tc)) * eff(spd), bias)
      return {
        scale: sclF,
        position: pre(this.positionSpeed, this.positionBias),
        rotation: pre(this.rotationSpeed, this.rotationBias),
        alpha: (t: number) =>
          t <= tc
            ? 0
            : t >= tHome
            ? 1
            : biasedEase(((t - tc) / Math.max(eps, tHome - tc)) * this.fadeSpeed, this.fadeBias),
      }
    }

    // Reverse (table -> globe). Scale is the forward curve mirrored in time so the
    // zoom-out paces like the zoom-in reversed; rotation/position depart AT the
    // (reverse) critical level and ease outward; the globe fades back IN by it.
    const sclRev = (t: number) => 1 - sclF(1 - t)
    const tcr = clamp01(this.criticalTimeFraction(sclRev, fromScale, toScale))
    const post = (spd: number, bias: number) => (t: number) =>
      t <= tcr ? 0 : 1 - biasedEase((1 - (t - tcr) / Math.max(eps, 1 - tcr)) * eff(spd), bias)
    return {
      scale: sclRev,
      position: post(this.positionSpeed, this.positionBias),
      rotation: post(this.rotationSpeed, this.rotationBias),
      alpha: (t: number) =>
        t >= tcr ? 1 : 1 - biasedEase((1 - t / Math.max(eps, tcr)) * this.fadeSpeed, this.fadeBias),
    }
  }

  // The dive-time fraction at which a (monotonic 0->1) scale-progress function
  // `scl` reaches the critical scale (globe footprint span == L-1 span).
  private criticalTimeFraction(scl: (t: number) => number, fromScale: number, toScale: number): number {
    return this.scaleTimeFraction(scl, fromScale, toScale, this.criticalScale())
  }

  // The dive-time fraction at which a (monotonic 0->1) scale-progress function
  // `scl` reaches `targetScale`. Solved by bisection; clamped to [0, 1].
  private scaleTimeFraction(
    scl: (t: number) => number,
    fromScale: number,
    toScale: number,
    targetScale: number
  ): number {
    const denom = toScale - fromScale
    // Degenerate (no zoom): no meaningful crossing — collapse the window.
    if (Math.abs(denom) < 1e-6) return toScale >= fromScale ? 0 : 1
    const e = clamp01((targetScale - fromScale) / denom)
    let lo = 0
    let hi = 1
    for (let i = 0; i < 28; i++) {
      const mid = (lo + hi) / 2
      if (scl(mid) < e) lo = mid
      else hi = mid
    }
    return (lo + hi) / 2
  }

  // The fraction of a level's home span that a freshly-entered level is framed at
  // (lodEnterZoom, clamped to a sane 0..1), leaving room to pan immediately.
  private enterFraction(): number {
    return Math.max(0.05, Math.min(1, this.lodEnterZoom))
  }

  // Dive finished: settle into the DOCKED phase (the table is already up from
  // selectCity). Normally the globe has faded out, so disable it; but when the
  // fade-out toggle is off we keep it enabled at the dock pose so its orientation
  // can be inspected against the table.
  private dock(): void {
    if (!this.activeCity) return
    const l0 = this.activeCity.levels[0]
    this.activeLevelIndex = 0

    // Settle the table onto sharp, normally-docked L0 at the partly-zoomed enter
    // framing. During the dive it was the co-zooming handoff (slot A=L-1/B=L0 by
    // span); this hands it back to plain L0 pan/zoom at the SAME framing (so the
    // swap is invisible) and pins it fully opaque.
    if (this.diveMapActive) {
      const enterView = {
        centerLatLng: { lat: l0.bounds.centerLatLng.lat, lng: l0.bounds.centerLatLng.lng },
        spanDeg: this.enterFraction() * l0.bounds.spanDeg,
      }
      this.mapViewport.endTransition()
      this.mapViewport.setLevel(l0, enterView, false)
      this.mapViewport.setOpacity(1)
      this.diveMapActive = false
    }

    if (this.fadeOutGlobe) this.globeView.getSceneObject().enabled = false
    this.state = "DOCKED"
    this.setLabel(l0.label)
    this.logger.info("State -> DOCKED L0")
  }

  // The dock pose: where the globe's TOP TIP should land (the table center), the
  // rotation that brings `centerLatLng` to the top with map-north aligned, and the
  // scale whose surface patch (spanning `spanDeg`) fills the table footprint. The
  // top tip is GlobeView's scale/position pivot, so returning it (not the center)
  // keeps the dive framed. Uses the SAME texture-longitude offset as the markers
  // so the pin we dive into stays put. Pure read — never mutates inputs.
  private computeDockPose(centerLatLng: LatLng, spanDeg: number): { topPos: vec3; rot: quat; scale: number } {
    const aimed = this.applyTextureLonOffset(centerLatLng)
    const scale = this.globeView.dockScaleForSpan(spanDeg)

    const tT = this.tableTransform
    // Table surface frame in world space. normal = the quad's +Y (its up axis).
    // Geographic NORTH on the table is the quad's -Z (Lens Studio's `forward` is
    // the +Z axis, so map-north = -forward). Negating fixes the otherwise-flipped
    // north in the dive so the globe's orientation matches the map.
    const n = tT.up.normalize()
    const mapNorth = tT.forward.uniformScale(-1).normalize()
    // The top tip lands exactly on the table center; GlobeView derives the (deep,
    // huge) sphere center from this tip and the scale.
    const topPos = tT.getWorldPosition()

    // Local frame at `aimed`, derived straight from lonLatToSpherePos (the same
    // function that places the markers) so the location we dive into is EXACTLY a
    // marker direction — no hand-rolled trig that could miss the texture's
    // east/west mirror. normalLocal = outward dir; northLocal = finite-difference
    // toward +lat (orthogonalized against the normal inside frameQuat).
    const c = lonLatToSpherePos(aimed.lng, aimed.lat, 1)
    const north = lonLatToSpherePos(aimed.lng, aimed.lat + 0.5, 1)
    const normalLocal = new vec3(c.x, c.y, c.z)
    const northLocal = new vec3(north.x - c.x, north.y - c.y, north.z - c.z)

    // Rotation mapping the local (north, normal) frame onto the table (north, up)
    // frame puts the location on top with north aligned; east follows by construction.
    const rot = this.frameQuat(mapNorth, n).multiply(this.invertQuat(this.frameQuat(northLocal, normalLocal)))
    return { topPos, rot, scale }
  }

  // A right-handed orientation whose +Z is `up` and +Y is `north` (orthogonalized
  // against up). Building both frames the same way guarantees a proper rotation
  // (no mirroring) when we compose one with the inverse of the other.
  private frameQuat(north: vec3, up: vec3): quat {
    const z = up.normalize()
    let y = north.sub(z.uniformScale(north.dot(z)))
    y = y.length < 1e-5 ? this.anyPerpendicular(z) : y.normalize()
    const x = y.cross(z).normalize()
    const m = new mat3()
    m.column0 = x
    m.column1 = y
    m.column2 = z
    return quat.fromRotationMat(m)
  }

  // Conjugate == inverse for a unit quaternion (avoids relying on quat.invert()).
  private invertQuat(q: quat): quat {
    return new quat(q.w, -q.x, -q.y, -q.z)
  }

  private anyPerpendicular(v: vec3): vec3 {
    const a = Math.abs(v.x) < 0.9 ? vec3.right() : vec3.up()
    return a.sub(v.uniformScale(a.dot(v))).normalize()
  }

  // Steps to the next/previous baked LOD, keeping the focused coordinate put.
  private stepLod(delta: number): void {
    if (!this.activeCity) return
    const next = this.activeLevelIndex + delta
    if (next < 0) {
      this.back()
      return
    }
    if (next >= this.activeCity.levels.length) return
    // Carry the CURRENT view (center + span) into the new level so the step is
    // continuous: stepping out lands the shallower level zoomed-in (near its min
    // edge), not at home, so a single zoom-out no longer cascades to the globe.
    const keep = this.currentViewBounds()
    this.activeLevelIndex = next
    const level = this.activeCity.levels[next]
    this.mapViewport.setLevel(level, keep, true)
    this.setLabel(level.label)
    this.logger.info("DOCKED L" + level.level + " (" + level.label + ")")
  }

  /** Returns to the globe overview from the docked table, reversing the dive. */
  back(): void {
    if (this.state !== "DOCKED") return
    this.state = "ZOOMING_OUT"
    this.logger.info("State -> ZOOMING_OUT")

    // Reappear matching whatever the table currently shows (center + span) so the
    // globe emerges seamlessly from the map, then un-dives back to the overview
    // pose we captured at selection while the table fades out in place.
    const view = this.currentViewBounds()
    const startPose = this.computeDockPose(view.centerLatLng, view.spanDeg)
    const globe = this.globeView.getSceneObject()
    globe.enabled = true
    this.globeView.setPose(startPose.topPos, startPose.rot, startPose.scale)
    // Start faded out only if we're fading; otherwise the globe stayed visible.
    this.globeView.setAlpha(this.fadeOutGlobe ? 0 : 1)

    const fromScale = startPose.scale

    if (this.hasTransition() && this.activeCity) {
      // Reverse co-zoom: the table keeps tracking the globe's footprint span as it
      // zooms back OUT (sharp L0 -> wide L-1 past home), crossfading its opacity
      // out against the reappearing globe. updateDiveMap() drives it each frame;
      // it is centered on the CURRENT view (where the user left the map).
      this.diveMapActive = true
      this.diveCenter = { lat: view.centerLatLng.lat, lng: view.centerLatLng.lng }
      this.resetDiveLog()
      const l0 = this.activeCity.levels[0]
      this.mapViewport.beginTransition(this.activeCity.transitionLevel, l0, l0.bounds.spanDeg, false)
      this.logDiveStart("OUT", fromScale, 1, true)
      // Match the table to the globe's starting footprint immediately so frame 0
      // shows the same sharp view the user had (no pop before the first update).
      this.mapViewport.updateTransitionFraming(this.diveCenter, view.spanDeg)
      this.mapViewport.setOpacity(1)
    } else {
      this.diveMapActive = false
      this.mapViewport.hide(undefined, this.approachSec)
    }

    this.globeView.animateToPose(
      this.preDockTopPos,
      this.preDockRot,
      1,
      1,
      this.approachSec,
      this.diveEasing(true, fromScale, 1),
      () => this.enterOverview()
    )
  }

  // --- External drive (CardQueryVoiceAgent) ----------------------------------

  /**
   * Zooms to a city by (case-insensitive) name, e.g. a card's `location`. Only
   * starts the dive from OVERVIEW (selectCity's own guard); returns false when the
   * name has no resolved city or the globe isn't in OVERVIEW so the caller can
   * retry next frame. Used by the query agent to land the globe on the place a
   * result set was captured.
   */
  focusCityByName(name: string): boolean {
    const city = this.cityData ? this.cityData.getCity(name) : null
    if (!city) return false
    if (this.state !== "OVERVIEW") return false
    this.selectCity(city)
    return true
  }

  /** True when `name` resolves to a known city (so a zoom is possible at all). */
  hasCity(name: string): boolean {
    return !!(this.cityData && this.cityData.getCity(name))
  }

  /** Reverses the dive back to the globe overview. Only runs from DOCKED. */
  resetToGlobe(): boolean {
    if (this.state !== "DOCKED") return false
    this.back()
    return true
  }

  isOverview(): boolean {
    return this.state === "OVERVIEW"
  }

  isDocked(): boolean {
    return this.state === "DOCKED"
  }

  /** True while a zoom transition is in flight (selectCity/back can't be issued). */
  isAnimating(): boolean {
    return this.state === "ZOOMING_IN" || this.state === "ZOOMING_OUT"
  }

  /** The city the user is gaze-highlighting in OVERVIEW, or null. Lets the
   *  CardMarkerLayer pop the matching textured marker (the logic markers that
   *  receive the gaze are invisible). */
  getGazedCityName(): string | null {
    return this.gazedMarker ? this.gazedMarker.getCityName() : null
  }

  /**
   * The geographic point the current dive / dock is focused on: the live dive
   * center while a handoff is active, else the active city. Null in OVERVIEW.
   * Returns a NEW LatLng. Used by CardMarkerLayer to clip markers to the
   * shrinking footprint during a dive.
   */
  getFocusLatLng(): LatLng | null {
    if (this.diveMapActive) return { lat: this.diveCenter.lat, lng: this.diveCenter.lng }
    if (this.activeCity) return { lat: this.activeCity.latLng.lat, lng: this.activeCity.latLng.lng }
    return null
  }

  // --- Input (per frame) -----------------------------------------------------

  private update(dt: number): void {
    if (this.state === "OVERVIEW") {
      this.updateGazeHighlight()
      // Right the globe back to vertical once the user has let go.
      if (!this.globeInputActive && this.globeView && this.globeRightingSpeed > 0) {
        this.globeView.rightingStep(dt, this.globeRightingSpeed)
      }
    } else if (this.state === "DOCKED") {
      this.updateDockedInput()
    } else if (this.state === "ZOOMING_IN" || this.state === "ZOOMING_OUT") {
      this.updateDiveMap()
    }
  }

  // Per-frame globe<->table co-zoom while a dive is in flight: the table is framed
  // to the globe's LIVE footprint span (so they zoom in lockstep) and its opacity
  // is crossfaded against the globe (map = 1 - globe). The table only participates
  // once the footprint is at/inside the L-1 span (i.e. at/after the critical level,
  // by which point rotation + position have finished, so the globe's top patch is
  // the centered city and the flat table matches it). Before that it stays hidden.
  private updateDiveMap(): void {
    if (!this.diveMapActive || !this.activeCity) return
    const tl = this.activeCity.transitionLevel
    if (!tl) return
    const scale = this.globeView.getScale()
    const span = this.globeView.spanForScale(scale)
    const globeAlpha = this.globeView.getAlpha()
    const participating = span <= tl.bounds.spanDeg
    if (participating) {
      this.mapViewport.updateTransitionFraming(this.diveCenter, span)
      this.mapViewport.setOpacity(1 - globeAlpha)
    } else {
      this.mapViewport.setOpacity(0)
    }
    this.logDiveMap(span, scale, globeAlpha, participating, tl)
  }

  // Detailed dive telemetry: one-shot milestones (map first participates; span
  // reaches L0 home, where sharp L0 should become visible) plus a throttled
  // per-frame line. Gated by enableLogging.
  private logDiveMap(span: number, scale: number, globeAlpha: number, participating: boolean, tl: LodLevel): void {
    if (!this.enableLogging || !this.activeCity) return
    const homeSpan = this.activeCity.levels[0].bounds.spanDeg
    const mapOpacity = participating ? 1 - globeAlpha : 0
    if (participating && !this.diveLoggedMapOn) {
      this.diveLoggedMapOn = true
      this.logger.info(
        "DIVE map ON @span=" +
          span.toFixed(3) +
          " (transSpan=" +
          tl.bounds.spanDeg.toFixed(3) +
          ") globeAlpha=" +
          globeAlpha.toFixed(2) +
          " mapOpacity=" +
          mapOpacity.toFixed(2)
      )
    }
    if (span <= homeSpan && !this.diveLoggedHome) {
      this.diveLoggedHome = true
      this.logger.info(
        "DIVE reached L0-home @span=" +
          span.toFixed(3) +
          " (home=" +
          homeSpan.toFixed(3) +
          ") globeAlpha=" +
          globeAlpha.toFixed(2) +
          " mapOpacity=" +
          mapOpacity.toFixed(2) +
          " -> sharp L0 should be visible now"
      )
    }
    this.diveLogT += getDeltaTime()
    if (this.diveLogT >= 0.15) {
      this.diveLogT = 0
      this.logger.info(
        "DIVE f: span=" +
          span.toFixed(3) +
          " scale=" +
          scale.toFixed(1) +
          " globeAlpha=" +
          globeAlpha.toFixed(2) +
          " mapOpacity=" +
          mapOpacity.toFixed(2)
      )
    }
  }

  // Resets dive logging throttle + one-shot milestone flags for a fresh dive.
  private resetDiveLog(): void {
    this.diveLogT = 0
    this.diveLoggedMapOn = false
    this.diveLoggedHome = false
  }

  // Logs the key scales/spans/time-fractions for a dive so the handoff timing can
  // be verified against what is actually seen on screen.
  private logDiveStart(label: string, fromScale: number, toScale: number, reversed: boolean): void {
    if (!this.enableLogging || !this.activeCity) return
    const homeSpan = this.activeCity.levels[0].bounds.spanDeg
    const transSpan = this.activeCity.transitionLevel ? this.activeCity.transitionLevel.bounds.spanDeg : 0
    const critScale = this.criticalScale()
    const homeScale = this.globeView.dockScaleForSpan(homeSpan)
    const sclF = (t: number) => biasedEase(t * this.scaleSpeed, this.scaleBias)
    const scl = reversed ? (t: number) => 1 - sclF(1 - t) : sclF
    const tc = clamp01(this.criticalTimeFraction(scl, fromScale, toScale))
    const tHome = clamp01(this.scaleTimeFraction(scl, fromScale, toScale, homeScale))
    this.logger.info(
      "DIVE START " +
        label +
        ": fromScale=" +
        fromScale.toFixed(1) +
        " (span=" +
        this.globeView.spanForScale(fromScale).toFixed(3) +
        ") toScale=" +
        toScale.toFixed(1) +
        " (span=" +
        this.globeView.spanForScale(toScale).toFixed(3) +
        ") | critScale=" +
        critScale.toFixed(1) +
        " (span=" +
        transSpan.toFixed(3) +
        ") homeScale=" +
        homeScale.toFixed(1) +
        " (span=" +
        homeSpan.toFixed(3) +
        ") | tc=" +
        tc.toFixed(3) +
        " tHome=" +
        tHome.toFixed(3)
    )
  }

  // Highlights the marker the user is gazing at (front of camera, inside cone).
  private updateGazeHighlight(): void {
    if (!this.camTransform || !this.markers) return
    const camPos = this.camTransform.getWorldPosition()
    const viewDir = this.camTransform.forward.uniformScale(-1)
    const cosThresh = Math.cos((Math.max(1, this.gazeHalfAngleDeg) * Math.PI) / 180)
    let best: CityMarker | null = null
    let bestCos = cosThresh
    for (let i = 0; i < this.markers.length; i++) {
      const m = this.markers[i]
      if (!m) continue
      const to = m.getWorldPosition().sub(camPos)
      const len = to.length
      if (len < 1e-3) continue
      const cosA = to.dot(viewDir) / len
      if (cosA > bestCos) {
        bestCos = cosA
        best = m
      }
    }
    for (let i = 0; i < this.markers.length; i++) {
      if (this.markers[i]) this.markers[i].setHighlighted(this.markers[i] === best)
    }
    this.gazedMarker = best
  }

  // Single-hand pan is now handled by the map Interactable's drag events (with
  // jitter filtering + cursor feedback). This path only owns the TWO-hand pinch
  // zoom, which is read straight from the tracked hands.
  private updateDockedInput(): void {
    const both = this.leftDown && this.rightDown

    if (both) {
      // Two-hand pinch -> zoom (uvScale). Drop any single-hand pan in progress so
      // the two paths never fight over the table.
      this.endMapDrag()
      const rawDist = this.leftHand.thumbTip.position.distance(this.rightHand.thumbTip.position)
      // Low-pass the pinch distance so two-hand zoom doesn't jitter.
      const dist = this.pinchDistSmoothed < 0 ? rawDist : this.pinchDistSmoothed + (rawDist - this.pinchDistSmoothed) * 0.5
      this.pinchDistSmoothed = dist
      if (this.pinchDistPrev > 0) {
        // Spread (dist up) zooms IN (uvScale down): factor = prev/curr scaled by speed.
        const ratio = this.pinchDistPrev / Math.max(1e-3, dist)
        const factor = 1 + (ratio - 1) * this.zoomSpeed
        const scale = this.mapViewport.zoom(factor)
        this.maybeStepLodByZoom(scale, dist < this.pinchDistPrev)
      }
      this.pinchDistPrev = dist
    } else {
      this.pinchDistPrev = -1
      this.pinchDistSmoothed = -1
    }
  }

  private bothHandsPinching(): boolean {
    return this.leftDown && this.rightDown
  }

  // --- Interactable drag: globe rotate (OVERVIEW) ----------------------------

  // Begins a smoothed globe-rotation drag. Shared by the globe surface and the
  // markers so starting a drag on a pin still spins the globe.
  private beginGlobeDrag(e: DragInteractorEvent): void {
    if (this.state !== "OVERVIEW" || e.target !== e.interactable) return
    this.globeDragInteractor = e.interactor
    this.globeDragAccum = vec3.zero()
    this.globeDragMoved = false
    this.globeInputActive = true
    this.globeDragTracker.begin(this.globeDragAccum)
  }

  private updateGlobeDrag(e: DragInteractorEvent): void {
    if (this.state !== "OVERVIEW" || !this.globeView || e.target !== e.interactable) return
    if (this.globeDragInteractor && e.interactor !== this.globeDragInteractor) return
    // Accumulate the interactor's per-frame world delta into a running point so
    // the OneEuroFilter smooths an absolute path (not a noisy raw delta).
    this.globeDragAccum = this.globeDragAccum.add(e.dragVector ?? vec3.zero())
    const delta = this.globeDragTracker.update(this.globeDragAccum)
    if (delta.length > this.DRAG_MOVE_EPS) this.globeDragMoved = true
    // Map the smoothed hand motion onto the screen's horizontal/vertical axes so
    // dragging right spins the globe right and dragging up tilts it up.
    const right = this.camTransform ? this.camTransform.right : vec3.right()
    const up = this.camTransform ? this.camTransform.up : vec3.up()
    const yaw = delta.dot(right) * this.handRotateSpeed
    // Pitch is negated so dragging up tilts the globe up (matches the touch path).
    const pitch = -delta.dot(up) * this.handRotateSpeed
    this.globeView.rotateBy(yaw, pitch)
  }

  private endGlobeDrag(): void {
    this.globeDragInteractor = null
    this.globeInputActive = false
    this.globeDragTracker.end()
  }

  private onMarkerTriggerEnd(marker: CityMarker): void {
    this.endGlobeDrag()
    // A drag (rotate) is never a selection; only a clean tap selects a city.
    if (this.state !== "OVERVIEW" || this.globeDragMoved) return
    const city = this.cityData.getCity(marker.getCityName())
    if (city) this.selectCity(city)
  }

  // --- Interactable drag: map pan (DOCKED) -----------------------------------

  private beginMapDrag(e: DragInteractorEvent): void {
    if (this.state !== "DOCKED" || this.bothHandsPinching() || e.target !== e.interactable) return
    this.mapDragInteractor = e.interactor
    this.mapDragAccum = vec3.zero()
    this.mapDragTracker.begin(this.mapDragAccum)
  }

  private updateMapDrag(e: DragInteractorEvent): void {
    if (this.state !== "DOCKED" || this.bothHandsPinching() || !this.tableTransform || e.target !== e.interactable) return
    if (this.mapDragInteractor && e.interactor !== this.mapDragInteractor) return
    this.mapDragAccum = this.mapDragAccum.add(e.dragVector ?? vec3.zero())
    const delta = this.mapDragTracker.update(this.mapDragAccum)
    this.applyPan(delta)
  }

  private endMapDrag(): void {
    this.mapDragInteractor = null
    this.mapDragTracker.end()
  }

  // Converts a smoothed world-space drag delta into a clamped UV pan.
  //
  // Horizontal pan projects onto the table's right axis (already screen-aligned).
  // Vertical pan projects onto the CAMERA's up axis rather than the table's
  // (near-horizontal) forward axis: a flat table viewed at a steep angle
  // foreshortens that forward axis, so an up/down drag would otherwise be 2-3x
  // weaker than left/right. The sign is matched to the table's forward direction
  // so the pan direction stays the same.
  private applyPan(deltaWorld: vec3): void {
    const localRight = deltaWorld.dot(this.tableTransform.right)
    const size = Math.max(1e-3, this.tableSizeCm)
    const scale = this.mapViewport.getUvScale()

    let localUp: number
    if (this.camTransform) {
      const camUp = this.camTransform.up
      const sFwd = Math.sign(camUp.dot(this.tableTransform.forward)) || 1
      localUp = deltaWorld.dot(camUp) * sFwd
    } else {
      localUp = deltaWorld.dot(this.tableTransform.forward)
    }

    const dx = -(localRight / size) * scale * this.panSpeed
    const dy = (localUp / size) * scale * this.panSpeed
    this.mapViewport.pan({ x: dx, y: dy })
  }

  // Steps LOD when the zoom reaches an edge. The direction guards are symmetric:
  // step IN only while zooming in (min edge), step OUT only while zooming out
  // (max edge). This prevents a step that lands near an edge from immediately
  // re-triggering the opposite (or same) step on the following frame.
  private maybeStepLodByZoom(scale: number, zoomingOut: boolean): void {
    if (!zoomingOut && scale <= this.minScaleEdge()) {
      this.stepLod(+1)
      this.pinchDistPrev = -1
      this.pinchDistSmoothed = -1
      this.touchPinchPrev = -1
    } else if (zoomingOut && scale >= this.maxScaleEdge()) {
      this.stepLod(-1)
      this.pinchDistPrev = -1
      this.pinchDistSmoothed = -1
      this.touchPinchPrev = -1
    }
  }

  // The current level's uvScale at which a zoom-IN should step to the next level.
  // It is chosen so that, by continuity, the next (deeper) level loads framed at
  // lodEnterZoom (e.g. 0.7) rather than at its fully-zoomed-out home — leaving
  // room to pan/zoom. Returns 0 at the deepest level (no further step-in).
  private minScaleEdge(): number {
    if (!this.activeCity) return 0.2
    const next = this.activeLevelIndex + 1
    if (next >= this.activeCity.levels.length) return 0
    const cur = this.activeCity.levels[this.activeLevelIndex]
    const nxt = this.activeCity.levels[next]
    const ratio = nxt.bounds.spanDeg / Math.max(1e-6, cur.bounds.spanDeg)
    return this.lodEnterZoom * ratio
  }

  private maxScaleEdge(): number {
    return 0.999
  }

  // The geographic view (center + span) currently shown, used to keep a LOD step
  // continuous. Falls back to the active level's home framing if unavailable.
  private currentViewBounds() {
    const vb = this.mapViewport.getViewBounds()
    if (vb) return vb
    const level = this.activeCity ? this.activeCity.levels[this.activeLevelIndex] : null
    const center = this.activeCity ? this.activeCity.latLng : { lat: 0, lng: 0 }
    return { centerLatLng: center, spanDeg: level ? level.bounds.spanDeg : 1 }
  }

  // --- Pinch callbacks -------------------------------------------------------

  // The pinch callbacks now only track which hands are down for the two-hand
  // zoom. City selection moved to the marker Interactables (a deliberate tap),
  // and globe rotation moved to the globe Interactable drag.
  private onRightPinchDown = () => {
    this.rightDown = true
  }
  private onRightPinchUp = () => {
    this.rightDown = false
    this.pinchDistPrev = -1
    this.pinchDistSmoothed = -1
  }
  private onLeftPinchDown = () => {
    this.leftDown = true
  }
  private onLeftPinchUp = () => {
    this.leftDown = false
    this.pinchDistPrev = -1
    this.pinchDistSmoothed = -1
  }

  // --- Touch input -----------------------------------------------------------

  private onTouchStart(e: TouchStartEvent): void {
    const id = e.getTouchId()
    const p = e.getTouchPosition()
    this.touches[id] = { x: p.x, y: p.y }
    const count = this.touchCount()
    if (count === 1) {
      this.tapId = id
      this.tapMoved = false
    } else {
      // A second finger cancels the tap and begins a pinch.
      this.tapId = -1
      this.touchPinchPrev = this.twoTouchDistance()
    }
  }

  private onTouchMove(e: TouchMoveEvent): void {
    const id = e.getTouchId()
    const p = e.getTouchPosition()
    const prev = this.touches[id]
    this.touches[id] = { x: p.x, y: p.y }
    const count = this.touchCount()

    if (count >= 2) {
      // Two-finger pinch -> zoom (DOCKED only).
      this.tapMoved = true
      this.handleTouchPinch()
      return
    }
    if (count === 1 && prev) {
      const dx = p.x - prev.x
      const dy = p.y - prev.y
      if (Math.abs(dx) + Math.abs(dy) > this.TAP_MOVE_THRESH) this.tapMoved = true
      if (this.state === "OVERVIEW") {
        // Drag the globe to rotate it (yaw with x, pitch with y; y is top-down).
        // Hold off the self-righting spring while a finger is steering.
        this.globeInputActive = true
        this.globeView.rotateBy(dx * this.touchRotateSpeed, -dy * this.touchRotateSpeed)
      } else if (this.state === "DOCKED") {
        // Drag the table to pan. Mirrors the hand-drag sign conventions.
        const scale = this.mapViewport.getUvScale()
        const g = this.touchPanGain * this.panSpeed
        this.mapViewport.pan({ x: -dx * scale * g, y: -dy * scale * g })
      }
    }
  }

  private onTouchEnd(e: TouchEndEvent): void {
    const id = e.getTouchId()
    const wasSingleTap = this.touchCount() === 1 && id === this.tapId && !this.tapMoved
    const p = e.getTouchPosition()
    delete this.touches[id]
    if (this.touchCount() < 2) this.touchPinchPrev = -1
    // Once every finger is up, let the globe spring back upright.
    if (this.touchCount() === 0) this.globeInputActive = false
    if (wasSingleTap) this.handleTap({ x: p.x, y: p.y })
  }

  private touchCount(): number {
    return Object.keys(this.touches).length
  }

  private twoTouchDistance(): number {
    const vals = Object.keys(this.touches).map((k) => this.touches[Number(k)])
    if (vals.length < 2) return -1
    const a = vals[0]
    const b = vals[1]
    return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y))
  }

  private handleTouchPinch(): void {
    if (this.state !== "DOCKED") return
    const dist = this.twoTouchDistance()
    if (dist <= 0) return
    if (this.touchPinchPrev > 0) {
      const ratio = this.touchPinchPrev / Math.max(1e-4, dist)
      const factor = 1 + (ratio - 1) * this.zoomSpeed
      const scale = this.mapViewport.zoom(factor)
      this.maybeStepLodByZoom(scale, dist < this.touchPinchPrev)
    }
    this.touchPinchPrev = dist
  }

  // A tap selects a city (OVERVIEW) or steps the LOD in / back out (DOCKED).
  private handleTap(screenPos: Vec2): void {
    if (this.state === "OVERVIEW") {
      const marker = this.markerNearestToScreen(screenPos)
      if (marker) {
        const city = this.cityData.getCity(marker.getCityName())
        if (city) this.selectCity(city)
      }
    } else if (this.state === "DOCKED") {
      if (this.activeCity && this.activeLevelIndex < this.activeCity.levels.length - 1) {
        this.stepLod(+1)
      } else {
        this.back()
      }
    }
  }

  // Picks the marker whose projected screen position is closest to the tap, used
  // for touch selection. Returns null if none is within a reasonable radius.
  private markerNearestToScreen(screenPos: Vec2): CityMarker | null {
    if (!this.camComponent || !this.markers) return null
    let best: CityMarker | null = null
    let bestDist = 0.12 // max normalized screen distance to count as a hit
    for (let i = 0; i < this.markers.length; i++) {
      const m = this.markers[i]
      if (!m) continue
      const s = this.camComponent.worldSpaceToScreenSpace(m.getWorldPosition())
      const d = Math.sqrt((s.x - screenPos.x) * (s.x - screenPos.x) + (s.y - screenPos.y) * (s.y - screenPos.y))
      if (d < bestDist) {
        bestDist = d
        best = m
      }
    }
    return best
  }

  // --- Helpers ---------------------------------------------------------------

  // Adds the configured texture longitude offset to a coordinate, returning a
  // NEW LatLng (never mutates the city's own data). Applied identically to
  // marker placement and globe aim so the two never drift apart.
  private applyTextureLonOffset(latLng: LatLng): LatLng {
    if (!this.textureLonOffsetDeg) return latLng
    return { lat: latLng.lat, lng: latLng.lng + this.textureLonOffsetDeg }
  }

  private setMarkersVisible(visible: boolean): void {
    if (!this.markers) return
    for (let i = 0; i < this.markers.length; i++) {
      if (this.markers[i]) this.markers[i].setVisible(visible)
    }
  }

  private setLabel(text: string): void {
    if (this.labelText) this.labelText.text = text
  }
}
