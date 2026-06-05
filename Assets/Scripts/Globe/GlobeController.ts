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
import { GlobeView } from "./GlobeView";
import { MapViewport } from "./MapViewport";
import { CityData, City } from "./CityData";
import { CityMarker } from "./CityMarker";
import { lonLatToSpherePos } from "./GeoMath";

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
  panSpeed: number = 1.0

  @input
  @hint("Two-hand pinch zoom sensitivity (>1 = faster). Applies to both hand and two-finger touch zoom.")
  zoomSpeed: number = 1.0

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
  // One-hand pan tracking.
  private panHandPrev: vec3 | null = null
  // Two-hand zoom tracking.
  private pinchDistPrev: number = -1
  private camTransform: Transform = null
  private camComponent: Camera = null
  private tableTransform: Transform = null
  private gazedMarker: CityMarker | null = null

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
    this.enterOverview()
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
      const p = lonLatToSpherePos(city.latLng.lng, city.latLng.lat, radius)
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
    // crossfade globe-out / table-in.
    this.globeView.animate(city.latLng, dockScale, 1, this.approachSec, () => this.dock())
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
    const keep = this.currentViewCenter()
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
      const aim = city ? city.latLng : null
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

  private updateDockedInput(): void {
    const both = this.leftDown && this.rightDown
    const one = this.leftDown !== this.rightDown // exactly one

    if (both) {
      // Two-hand pinch -> zoom (uvScale); reset pan tracking.
      this.panHandPrev = null
      const dist = this.leftHand.thumbTip.position.distance(this.rightHand.thumbTip.position)
      if (this.pinchDistPrev > 0) {
        // Spread (dist up) zooms IN (uvScale down): factor = prev/curr scaled by speed.
        const ratio = this.pinchDistPrev / Math.max(1e-3, dist)
        const factor = 1 + (ratio - 1) * this.zoomSpeed
        const scale = this.mapViewport.zoom(factor)
        this.maybeStepLodByZoom(scale, dist < this.pinchDistPrev)
      }
      this.pinchDistPrev = dist
    } else if (one) {
      // One-hand drag -> pan (uvOffset).
      this.pinchDistPrev = -1
      const hand = this.rightDown ? this.rightHand : this.leftHand
      const pos = hand.thumbTip.position
      if (this.panHandPrev && this.tableTransform) {
        this.applyPan(pos.sub(this.panHandPrev))
      }
      this.panHandPrev = pos
    } else {
      this.panHandPrev = null
      this.pinchDistPrev = -1
    }
  }

  // Converts a world-space hand delta into a clamped UV pan along the flat table.
  // The table lies in its XZ plane, so the in-surface axes are right (+X) and
  // forward (+Z), not up.
  private applyPan(deltaWorld: vec3): void {
    const right = this.tableTransform.right
    const forward = this.tableTransform.forward
    const localRight = deltaWorld.dot(right)
    const localFwd = deltaWorld.dot(forward)
    const size = Math.max(1e-3, this.tableSizeCm)
    const scale = this.mapViewport.getUvScale()
    const dx = -(localRight / size) * scale * this.panSpeed
    const dy = (localFwd / size) * scale * this.panSpeed
    this.mapViewport.pan({ x: dx, y: dy })
  }

  // Steps LOD when the zoom reaches an edge: at min uvScale step IN, and when
  // already at home (uvScale ~ max) and still zooming out, step OUT / back.
  private maybeStepLodByZoom(scale: number, zoomingOut: boolean): void {
    if (scale <= this.minScaleEdge()) {
      this.stepLod(+1)
      this.pinchDistPrev = -1
      this.touchPinchPrev = -1
    } else if (zoomingOut && scale >= this.maxScaleEdge()) {
      this.stepLod(-1)
      this.pinchDistPrev = -1
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

  private currentViewCenter() {
    const vb = this.mapViewport.getViewBounds()
    return vb ? vb.centerLatLng : (this.activeCity ? this.activeCity.latLng : { lat: 0, lng: 0 })
  }

  // --- Pinch callbacks -------------------------------------------------------

  private onRightPinchDown = () => {
    this.rightDown = true
    this.onPinchDown()
  }
  private onRightPinchUp = () => {
    this.rightDown = false
    this.panHandPrev = null
    this.pinchDistPrev = -1
  }
  private onLeftPinchDown = () => {
    this.leftDown = true
    this.onPinchDown()
  }
  private onLeftPinchUp = () => {
    this.leftDown = false
    this.panHandPrev = null
    this.pinchDistPrev = -1
  }

  // A pinch in OVERVIEW while gazing a marker selects that city.
  private onPinchDown(): void {
    if (this.state === "OVERVIEW" && this.gazedMarker) {
      const city = this.cityData.getCity(this.gazedMarker.getCityName())
      if (city) this.selectCity(city)
    }
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
