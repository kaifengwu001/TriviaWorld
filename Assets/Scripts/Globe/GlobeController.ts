/**
 * Specs Inc. 2026
 * GlobeController – the guided state machine for the Interactive Globe lens.
 *
 * States: OVERVIEW -> ZOOMING_IN -> DOCKED (L0..Ln) -> ZOOMING_OUT -> OVERVIEW.
 *
 *   OVERVIEW    full globe + city markers; gaze a marker, pinch to select.
 *   ZOOMING_IN  tween globe aim to the city + zoom to dockScaleForSpan(L0),
 *               then crossfade globe OUT / table IN at the matched footprint.
 *   DOCKED      globe hidden; the table pans (one-hand drag -> uvOffset) and
 *               zooms (two-hand pinch -> uvScale). Crossing a zoom edge steps
 *               the baked LOD (swap mapTex, recompute UV from bounds).
 *   ZOOMING_OUT table OUT / globe IN, tween the globe back to OVERVIEW.
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
import { GlobeView } from "./GlobeView";
import { MapViewport } from "./MapViewport";
import { CityData, City } from "./CityData";
import { CityMarker } from "./CityMarker";
import { lonLatToSpherePos, LatLng } from "./GeoMath";
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
  @hint("Create + place a marker per city from its lat/lng (parented to the globe). Turn off to use only the markers assigned above.")
  autoCreateMarkers: boolean = true

  @input
  @hint("OPTIONAL prefab instantiated as each auto-created marker's visual. If empty, markers are created as logic-only (invisible) objects.")
  @allowUndefined
  markerPrefab: ObjectPrefab

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

  @input
  @hint("Cosine-threshold half-angle (degrees) of the gaze cone for marker selection.")
  gazeHalfAngleDeg: number = 12

  @input
  @hint("On-screen table size in cm (matches GlobeView.tableSizeCm). Scales hand drags into UV pan.")
  tableSizeCm: number = 60

  @input
  @hint("Pan speed multiplier for one-hand drag -> uvOffset.")
  panSpeed: number = 0.3

  @input
  @hint("Two-hand pinch zoom sensitivity (>1 = faster). Applies to both hand and two-finger touch zoom.")
  zoomSpeed: number = 1.0

  @input
  @hint("Globe rotation gain for a one-hand pinch-drag in OVERVIEW (radians of spin per cm of smoothed hand movement).")
  handRotateSpeed: number = 0.03

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
    this.ensureMarkers()
    this.setupInteractions()
    this.enterOverview()
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
      const obj = this.markerPrefab
        ? this.markerPrefab.instantiate(globeObj)
        : global.scene.createSceneObject("Marker_" + city.name)
      if (!this.markerPrefab) obj.setParent(globeObj)
      obj.layer = globeObj.layer
      obj.name = "Marker_" + city.name

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
    this.setMarkersVisible(true)
    if (this.globeView) this.globeView.show(this.crossfadeSec)
    if (this.mapViewport) this.mapViewport.hide()
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
    const dockScale = this.globeView.dockScaleForSpan(l0.bounds.spanDeg)
    // Tween the globe to aim at the city and zoom to the matched footprint, then
    // crossfade globe-out / table-in. Aim uses the same texture longitude offset
    // as the marker so the pin stays under the viewer through the zoom.
    this.globeView.animate(this.applyTextureLonOffset(city.latLng), dockScale, 1, this.approachSec, () => this.dock())
  }

  // Crossfade: globe fades out while the table fades in at L0 home framing.
  private dock(): void {
    if (!this.activeCity) return
    const l0 = this.activeCity.levels[0]
    this.activeLevelIndex = 0
    this.mapViewport.setLevel(l0)
    this.mapViewport.show()
    this.globeView.hide(this.crossfadeSec, () => {
      this.state = "DOCKED"
      this.setLabel(l0.label)
      this.logger.info("State -> DOCKED L0")
    })
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

  /** Returns to the globe overview from the docked table. */
  back(): void {
    if (this.state !== "DOCKED") return
    this.state = "ZOOMING_OUT"
    const city = this.activeCity
    this.logger.info("State -> ZOOMING_OUT")
    this.mapViewport.hide(() => {
      this.globeView.getSceneObject().enabled = true
      // Aim back at the city at overview scale (scale 1), fading in.
      const aim = city ? this.applyTextureLonOffset(city.latLng) : null
      this.globeView.animate(aim, 1, 1, this.approachSec, () => this.enterOverview())
    })
  }

  // --- Input (per frame) -----------------------------------------------------

  private update(dt: number): void {
    if (this.state === "OVERVIEW") {
      this.updateGazeHighlight()
    } else if (this.state === "DOCKED") {
      this.updateDockedInput()
    }
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

  private minScaleEdge(): number {
    // A small epsilon above the viewport's hard min so we step before clamping.
    return 0.345
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
