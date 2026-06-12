/**
 * Specs Inc. 2026
 * CardMarkerLayer – textured map markers, one per CardStore card (merged when close).
 *
 * Every card in `global.cropCardStore` gets a marker at a STABLE pseudo-location:
 * the store only knows the card's CITY, so CardGeo scatters each card inside an
 * adjustable mile range around that city's shared center, seeded by the card id
 * (the spot never moves between frames, zooms, or sessions).
 *
 * The markers are NOT parented to the globe or the table. Every frame the layer
 * re-maps each card's lat/lng onto whichever surface is currently showing:
 *
 *   GLOBE  (OVERVIEW + dives)  world = globeTransform x lonLatToSpherePos(...)
 *                              — riding every rotation/scale/position animation
 *                              exactly, including the dock dive and user spins.
 *   TABLE  (DOCKED + handoff)  world = tableCenter + east*dx + north*dy from the
 *                              viewport's LIVE view bounds — tracking every pan,
 *                              zoom, LOD step, and mid-dive co-zoom framing.
 *
 * The switch between the two happens at the dive's opacity crossover, where the
 * globe's surface patch and the table coincide by construction, so markers never
 * jump. While DOCKED, markers are clipped to the visible feathered circle
 * (disappear past the rim, reappear on re-entry); on the globe, back-side
 * markers are hidden, and during a dive markers outside the live footprint span
 * drop away as the zoom commits to one city.
 *
 * Close-by markers (IN-SCENE distance, so the rule adapts to zoom) merge into
 * one marker at the average of their positions, with a count label when more
 * than one card merged. Merging never crosses cities, so the globe view always
 * shows at least one marker each for Tokyo / Seattle / Los Angeles (the layer
 * also pins a markerless city's center icon so all three are always present).
 *
 * Visuals are code-built: a camera-billboarded textured quad (Component.Image,
 * cloned material — clone-before-modify) + a centered count Text. The invisible
 * CityMarker logic objects in GlobeController still own selection (tap/gaze),
 * and this layer pops the gazed city's textured marker for feedback.
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger";
import { GlobeController } from "./GlobeController";
import { City } from "./CityData";
import { GeoBounds, LatLng, lonLatToSpherePos } from "./GeoMath";
import {
  ClusterablePoint,
  MarkerCluster,
  angularDistanceDeg,
  clusterByWorldDistance,
  scatterLatLng,
  scatterLatLngOnLand,
} from "./CardGeo";
import { isLandAt } from "./waterMask";

/** The slice of CardStore this layer reads (it lives on global.cropCardStore). */
interface CardLike {
  id: string;
  location: string;
}
interface StoreLike {
  getCards(): CardLike[];
  getCapturedVersion(): number;
  count(): number;
}

/** A card's resolved, stable geo placement (rebuilt only when the store changes). */
interface CardGeoEntry {
  id: string;
  cityName: string;
  latLng: LatLng;
}

/** One pooled marker visual (billboard image + count text). */
interface MarkerVisual {
  root: SceneObject;
  image: Image;
  textObj: SceneObject;
  text: Text;
}

/** Which surface the markers are mapped onto this frame. */
type SurfaceMode =
  | { kind: "none" }
  | { kind: "globe"; clipCenter: LatLng | null; clipSpanDeg: number }
  | { kind: "table"; view: GeoBounds };

// Location strings that should resolve to a mapped city even though they don't
// contain its name (the CardStore stores free-form places like
// "Long Beach, California", whose map center IS the Los Angeles capture area).
const LOCATION_ALIASES: { [needle: string]: string } = {
  "long beach": "Los Angeles",
};

@component
export class CardMarkerLayer extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">CardMarkerLayer – textured card markers on the globe + map table</span><br/><span style="color: #94A3B8; font-size: 11px;">One marker per CardStore card, scattered around its city, merged when close in-scene, clipped to the table\'s visible circle, persistent through every zoom + dive.</span>')
  @ui.separator

  @ui.label('<span style="color: #60A5FA;">References</span>')
  @input
  @hint("The GlobeController that owns the globe/table state machine. If unset, global.globeController is used.")
  @allowUndefined
  globeController: GlobeController

  @input
  @hint("Unlit transparent material for the marker quad (cloned at runtime; its baseTex is replaced by Marker Texture). Falls back to a clone of the globe's material if unset.")
  @allowUndefined
  markerMaterial: Material

  @input
  @hint("The marker icon texture (drawn on a camera-billboarded quad).")
  @allowUndefined
  markerTexture: Texture

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Placement</span>')
  @input
  @hint("Radius (miles) of the disk around a city's center that its cards are scattered in. Each card's spot is random but STABLE (seeded by its id).")
  scatterRangeMiles: number = 5

  @input
  @hint("Markers closer than this IN-SCENE distance (cm) merge into one marker at their average position. Never merges across cities.")
  mergeDistanceCm: number = 4

  @input
  @hint("Keep scattered markers OFF the ocean by re-drawing a card's spot until it lands on land (uses the baked per-city water mask in waterMask.ts). Re-drawing stays seeded by the card id, so positions are still stable.")
  avoidOcean: boolean = true

  @input
  @hint("How far (cm) markers float above the ACTIVE surface — the globe AND the table use the same constant lift, so the dive handoff is height-continuous (markers never rise away as the globe scales up).")
  tableLiftCm: number = 1.5

  @input
  @hint("Radius of the table's visible (feathered) circle as a fraction of its half-size. Markers past it disappear and reappear when panned back in.")
  visibleCircleFraction: number = 0.95

  @input
  @hint("In OVERVIEW, always show a marker at each city's center even if it has no cards (keeps the 3-city minimum).")
  alwaysShowCityMarkers: boolean = true

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Visuals</span>')
  @input
  @hint("Marker quad size (cm). Constant world size; markers billboard toward the camera.")
  markerSizeCm: number = 3

  @input
  @hint("Font size (points) of the merged-count label drawn over the marker.")
  countTextSize: number = 24

  @input
  @hint("Vertical position of the count label relative to the marker, in fractions of the marker size (0 = centered on the icon, +0.5 = half a marker-height up, negative = down).")
  countTextHeight: number = 0

  @input
  @hint("Color (RGBA) of the merged-count label.")
  countTextColor: vec4 = new vec4(1.0, 1.0, 1.0, 1.0)

  @input
  @hint("Scale multiplier applied to a city's markers while the user gazes at it in OVERVIEW (mirrors the old pin highlight).")
  highlightScale: number = 1.35

  @input
  @hint("Render order for the marker quads (count text draws one above). Keep above the globe/table so markers are never z-fought away.")
  markerRenderOrder: number = 500

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Logging</span>')
  @input
  @hint("Enable general logging")
  enableLogging: boolean = false

  @input
  @hint("Enable lifecycle logging (onAwake, onStart, onUpdate, onDestroy)")
  enableLoggingLifecycle: boolean = false

  private logger: Logger
  private material: Material | null = null
  private pool: MarkerVisual[] = []
  private geo: CardGeoEntry[] = []
  // "count:capturedVersion" of the store at the last geo rebuild.
  private lastSyncKey: string = ""
  // Locations we already warned about (unknown city), so the log isn't spammed.
  private warnedLocations: { [key: string]: boolean } = {}
  // Last reported status line + error messages, so diagnostics never spam.
  private lastStatus: string = ""
  private reportedErrors: { [msg: string]: boolean } = {}
  private reportedFirstMarker: boolean = false

  onAwake() {
    this.logger = new Logger("CardMarkerLayer", this.enableLogging || this.enableLoggingLifecycle, true)
    if (this.enableLoggingLifecycle) this.logger.debug("LIFECYCLE: onAwake()")
    this.createEvent("UpdateEvent").bind(() => this.update())
  }

  // --- Per frame ---------------------------------------------------------------

  // Wraps the real per-frame work so a runtime error is REPORTED (once per
  // distinct message) instead of silently killing the layer every frame.
  private update(): void {
    try {
      this.updateInner()
    } catch (e) {
      const msg = "" + e
      if (!this.reportedErrors[msg]) {
        this.reportedErrors[msg] = true
        const stack = (e as any)?.stack ? "\n" + (e as any).stack : ""
        this.logger.error("Update failed: " + msg + stack)
      }
    }
  }

  private updateInner(): void {
    const ctrl = this.resolveController()
    if (!ctrl) {
      this.reportStatus("BLOCKED: no GlobeController (assign the input or ensure global.globeController is set)")
      this.hideAll()
      return
    }
    if (!ctrl.globeView || !ctrl.mapViewport || !ctrl.cityData) {
      this.reportStatus("BLOCKED: GlobeController is missing globeView / mapViewport / cityData inputs")
      this.hideAll()
      return
    }
    this.syncCards(ctrl)

    const mode = this.decideMode(ctrl)
    if (mode.kind === "none") {
      this.reportStatus(
        ctrl.isDocked()
          ? "hidden: docked but the map view bounds are unavailable"
          : "hidden: globe object is disabled (overview)"
      )
      this.hideAll()
      return
    }

    const clusters = this.buildClusters(ctrl, mode)
    this.renderClusters(ctrl, mode, clusters)

    this.reportStatus(
      "mode=" + mode.kind +
      " store=" + (this.lastSyncKey.length > 0 ? this.lastSyncKey : "MISSING (global.cropCardStore unset)") +
      " geo=" + this.geo.length +
      " clusters=" + clusters.length +
      " pool=" + this.pool.length
    )
    if (!this.reportedFirstMarker && clusters.length > 0 && this.pool.length > 0) {
      this.reportedFirstMarker = true
      const p = this.pool[0].root.getTransform().getWorldPosition()
      const camT = ctrl.cameraObject ? ctrl.cameraObject.getTransform() : null
      this.logger.info(
        "First marker '" + clusters[0].cityName + "' x" + clusters[0].count +
        " at (" + p.x.toFixed(1) + ", " + p.y.toFixed(1) + ", " + p.z.toFixed(1) + ")" +
        (camT
          ? " — camera at (" +
            camT.getWorldPosition().x.toFixed(1) + ", " +
            camT.getWorldPosition().y.toFixed(1) + ", " +
            camT.getWorldPosition().z.toFixed(1) + ")"
          : "")
      )
    }
  }

  // Logs the pipeline status whenever it CHANGES (never per frame), so the
  // console always shows which stage the layer is in without log spam.
  private reportStatus(status: string): void {
    if (status === this.lastStatus) return
    this.lastStatus = status
    this.logger.info("Status: " + status)
  }

  private resolveController(): GlobeController | null {
    if (this.globeController) return this.globeController
    return ((global as any).globeController as GlobeController) ?? null
  }

  // --- Card -> stable geo placement ---------------------------------------------

  // Rebuilds the per-card geo cache whenever the store's content changes (capture,
  // remove, clearCaptured). scatterLatLng is seeded by the card id, so a rebuild
  // never moves a surviving card's marker.
  private syncCards(ctrl: GlobeController): void {
    const store = (global as any).cropCardStore as StoreLike | undefined
    if (!store) {
      this.geo = []
      this.lastSyncKey = ""
      return
    }
    const key = store.count() + ":" + store.getCapturedVersion()
    if (key === this.lastSyncKey) return
    this.lastSyncKey = key

    const next: CardGeoEntry[] = []
    let relocated = 0
    for (const card of store.getCards()) {
      const city = this.resolveCity(card.location, ctrl)
      if (!city) {
        this.warnUnknownLocation(card.location)
        continue
      }
      const range = Math.max(0, this.scatterRangeMiles)
      const latLng = this.avoidOcean
        ? scatterLatLngOnLand(city.latLng, range, card.id, (ll) => isLandAt(city.name, ll))
        : scatterLatLng(city.latLng, range, card.id)
      if (this.avoidOcean) {
        const baseline = scatterLatLng(city.latLng, range, card.id)
        if (baseline.lat !== latLng.lat || baseline.lng !== latLng.lng) relocated++
      }
      next.push({ id: card.id, cityName: city.name, latLng })
    }
    this.geo = next
    this.logger.info("Synced " + next.length + " card markers from the store (" + key + ").")
    this.oceanProbe(next.length, relocated)
  }

  // One-shot loud diagnostic (uses print, so it shows WITHOUT toggling logging).
  // Fires on the first NON-EMPTY sync (so it measures real cards, not the empty
  // initial store) and reports, PER CITY: how many markers ended up, how many the
  // mask STILL considers water after reject-sampling, and how many relocated.
  // If "finalInWater" is 0 but the table still shows wet pins, the geo is correct
  // and the bug is in the table rendering; if it's > 0, reject-sampling is failing.
  private reportedOceanProbe: boolean = false
  private oceanProbe(total: number, relocated: number): void {
    if (this.reportedOceanProbe || total === 0) return
    this.reportedOceanProbe = true
    const perCity: { [name: string]: { n: number; wet: number } } = {}
    for (const g of this.geo) {
      const s = perCity[g.cityName] || (perCity[g.cityName] = { n: 0, wet: 0 })
      s.n++
      if (!isLandAt(g.cityName, g.latLng)) s.wet++
    }
    let summary = ""
    for (const name in perCity) summary += " | " + name + ": " + perCity[name].n + " markers, " + perCity[name].wet + " STILL on water"
    print(
      "[CardMarkerLayer OCEAN-PROBE v3] avoidOcean=" + this.avoidOcean +
      " total=" + total + " relocatedOffWater=" + relocated + summary
    )
  }

  // Maps a card's free-form location string onto a resolved city: exact name
  // match, then containment ("Downtown Seattle"), then the alias table.
  private resolveCity(location: string, ctrl: GlobeController): City | null {
    const key = (location ?? "").trim().toLowerCase()
    if (!key) return null
    const cities = ctrl.cityData.getCities()
    for (const c of cities) if (c.name.toLowerCase() === key) return c
    for (const c of cities) if (key.indexOf(c.name.toLowerCase()) >= 0) return c
    for (const needle in LOCATION_ALIASES) {
      if (key.indexOf(needle) >= 0) {
        const aliased = ctrl.cityData.getCity(LOCATION_ALIASES[needle])
        if (aliased) return aliased
      }
    }
    return null
  }

  private warnUnknownLocation(location: string): void {
    const key = (location ?? "").trim().toLowerCase()
    if (this.warnedLocations[key]) return
    this.warnedLocations[key] = true
    this.logger.warn('Card location "' + location + '" matches no mapped city; its marker is skipped.')
  }

  // --- Mode (which surface to pin markers to this frame) -------------------------

  // GLOBE while the globe leads the view (overview + the dive until the table has
  // won the opacity crossfade), TABLE afterwards. At the crossover the globe's
  // surface patch and the table show the same geography at the same footprint by
  // construction, so the marker switch is seamless.
  private decideMode(ctrl: GlobeController): SurfaceMode {
    if (ctrl.isDocked()) {
      const view = ctrl.mapViewport.getLiveViewBounds()
      return view ? { kind: "table", view } : { kind: "none" }
    }
    if (ctrl.isOverview()) {
      return ctrl.globeView.getSceneObject().enabled
        ? { kind: "globe", clipCenter: null, clipSpanDeg: 0 }
        : { kind: "none" }
    }
    // ZOOMING_IN / ZOOMING_OUT.
    const mapOn = ctrl.mapViewport.getSceneObject().enabled
    const mapAlpha = mapOn ? ctrl.mapViewport.getOpacity() : 0
    if (mapAlpha >= 0.5 && mapAlpha >= ctrl.globeView.getAlpha()) {
      const view = ctrl.mapViewport.getLiveViewBounds()
      if (view) return { kind: "table", view }
    }
    return {
      kind: "globe",
      clipCenter: ctrl.getFocusLatLng(),
      clipSpanDeg: ctrl.globeView.spanForScale(ctrl.globeView.getScale()),
    }
  }

  // --- Geo -> world mapping -------------------------------------------------------

  // A coordinate's world position on the globe's surface, derived from the globe's
  // CURRENT transform — so markers ride every spin, dive, and scale exactly. Uses
  // the same texture-longitude offset as the controller's own marker placement.
  //
  // The lift above the surface is a CONSTANT world-space distance (tableLiftCm),
  // NOT a fraction of the radius: during the dock dive the globe scales up by
  // hundreds of times, so a fractional lift would launch the markers meters off
  // the surface mid-animation. With the same constant lift on both surfaces the
  // marker height is continuous through the globe -> table crossfade.
  private globeWorldPos(latLng: LatLng, ctrl: GlobeController): vec3 {
    const gv = ctrl.globeView
    const p = lonLatToSpherePos(latLng.lng + (ctrl.textureLonOffsetDeg ?? 0), latLng.lat, gv.getLocalRadiusCm())
    const surface = gv.getSceneObject().getTransform().getWorldTransform().multiplyPoint(new vec3(p.x, p.y, p.z))
    const center = gv.getSceneObject().getTransform().getWorldPosition()
    const outward = surface.sub(center)
    const len = outward.length
    if (len < 1e-5) return surface
    return surface.add(outward.uniformScale(this.tableLiftCm / len))
  }

  // True when the marker is NOT hidden behind the globe: the camera->marker
  // segment must not pass through the sphere. (A plain front-hemisphere dot test
  // would cull markers right at the silhouette, where they are still fully
  // visible because they hover above the surface.)
  private isVisibleOnGlobe(markerPos: vec3, ctrl: GlobeController): boolean {
    const camT = ctrl.cameraObject ? ctrl.cameraObject.getTransform() : null
    if (!camT) return true
    const cam = camT.getWorldPosition()
    const center = ctrl.globeView.getSceneObject().getTransform().getWorldPosition()
    // Slightly shrunk radius so limb markers floating just above the surface survive.
    const r = ctrl.globeView.getRadiusCm() * ctrl.globeView.getScale() * 0.98
    const toMarker = markerPos.sub(cam)
    const len = toMarker.length
    if (len < 1e-4) return true
    const dir = toMarker.uniformScale(1 / len)
    const toCenter = center.sub(cam)
    const along = toCenter.dot(dir)
    // Sphere behind the camera, or its closest approach lies past the marker.
    if (along < 0 || along > len) return true
    const perpSq = toCenter.dot(toCenter) - along * along
    return perpSq >= r * r
  }

  // A coordinate's world position on the docked table, from the live view bounds.
  // East = the quad's +right; geographic NORTH is the quad's -forward — the SAME
  // convention the controller uses to align the globe to the map during the dive
  // (GlobeController: `mapNorth = tT.forward.uniformScale(-1)`). An earlier
  // +forward flip made panning *feel* right but mirrored absolute placement
  // north<->south, which slid LA's northern land pins into its southern harbor.
  // Also returns the planar distance from the table center (cm) for the
  // visible-circle clip.
  private tableWorldPos(
    latLng: LatLng,
    view: GeoBounds,
    ctrl: GlobeController
  ): { pos: vec3; planarDistCm: number } {
    const tT = this.tableTransform(ctrl)
    const size = Math.max(1e-3, ctrl.tableSizeCm)
    const span = Math.max(1e-6, view.spanDeg)
    // Latitude and longitude are both mapped LINEARLY across `span`, matching
    // GeoMath's square-in-degrees view model (the real placement bug was the
    // inverted map V-convention, fixed at the root in GeoMath.uvToBounds).
    const dEast = ((latLng.lng - view.centerLatLng.lng) / span) * size
    const dNorth = ((latLng.lat - view.centerLatLng.lat) / span) * size
    // North is -forward (see header + GlobeController.mapNorth), so a pin north of
    // center moves along -forward to land on the map's northern features.
    const pos = tT
      .getWorldPosition()
      .add(tT.right.uniformScale(dEast))
      .add(tT.forward.uniformScale(-dNorth))
      .add(tT.up.uniformScale(this.tableLiftCm))
    return { pos, planarDistCm: Math.sqrt(dEast * dEast + dNorth * dNorth) }
  }

  private tableTransform(ctrl: GlobeController): Transform {
    const obj = ctrl.tableObject ?? ctrl.mapViewport.getSceneObject()
    return obj.getTransform()
  }

  // --- Clustering -------------------------------------------------------------------

  // Maps every card onto the active surface, drops the ones outside the visible
  // region, merges the survivors by in-scene distance, and (in OVERVIEW) pins a
  // center marker for any city that ended up with none.
  private buildClusters(ctrl: GlobeController, mode: SurfaceMode): MarkerCluster[] {
    const points: ClusterablePoint[] = []

    for (const g of this.geo) {
      if (mode.kind === "globe") {
        // During a dive, drop markers outside the live footprint span — the
        // zoom is committing to one city and far-away markers would otherwise
        // hang in the room as the sphere blows up past room scale.
        if (mode.clipCenter && angularDistanceDeg(g.latLng, mode.clipCenter) > mode.clipSpanDeg * 0.75) continue
        const pos = this.globeWorldPos(g.latLng, ctrl)
        if (!this.isVisibleOnGlobe(pos, ctrl)) continue
        points.push({ id: g.id, cityName: g.cityName, latLng: g.latLng, world: { x: pos.x, y: pos.y, z: pos.z } })
      } else if (mode.kind === "table") {
        const mapped = this.tableWorldPos(g.latLng, mode.view, ctrl)
        // Requirement: markers only live inside the visible feathered circle.
        if (mapped.planarDistCm > this.visibleCircleFraction * ctrl.tableSizeCm * 0.5) continue
        points.push({
          id: g.id,
          cityName: g.cityName,
          latLng: g.latLng,
          world: { x: mapped.pos.x, y: mapped.pos.y, z: mapped.pos.z },
        })
      }
    }

    const clusters = clusterByWorldDistance(points, this.mergeDistanceCm)

    // Guarantee the 3-city minimum in OVERVIEW: a city with no card markers
    // still shows a (count-less) marker at its center.
    if (mode.kind === "globe" && !mode.clipCenter && this.alwaysShowCityMarkers) {
      for (const city of ctrl.cityData.getCities()) {
        if (clusters.some((c) => c.cityName === city.name)) continue
        const pos = this.globeWorldPos(city.latLng, ctrl)
        if (!this.isVisibleOnGlobe(pos, ctrl)) continue
        clusters.push({
          cityName: city.name,
          count: 0,
          ids: [],
          latLng: { lat: city.latLng.lat, lng: city.latLng.lng },
        })
      }
    }
    return clusters
  }

  // --- Rendering ----------------------------------------------------------------------

  private renderClusters(ctrl: GlobeController, mode: SurfaceMode, clusters: MarkerCluster[]): void {
    this.ensurePool(clusters.length, ctrl)

    const camT = ctrl.cameraObject ? ctrl.cameraObject.getTransform() : null
    // Camera-aligned billboard: the quad's +Z matches the camera's +Z (which
    // points back at the viewer), so the texture always faces the user squarely.
    const camRot = camT ? camT.getWorldRotation() : null
    const gazedCity = ctrl.isOverview() ? ctrl.getGazedCityName() : null

    for (let i = 0; i < this.pool.length; i++) {
      const v = this.pool[i]
      if (i >= clusters.length) {
        if (v.root.enabled) v.root.enabled = false
        continue
      }
      const c = clusters[i]
      // The cluster's representative position is its members' AVERAGE lat/lng,
      // re-mapped through the live surface so it is exact at any zoom.
      const pos =
        mode.kind === "table"
          ? this.tableWorldPos(c.latLng, mode.view, ctrl).pos
          : this.globeWorldPos(c.latLng, ctrl)

      v.root.enabled = true
      const t = v.root.getTransform()
      t.setWorldPosition(pos)
      if (camRot) t.setWorldRotation(camRot)
      const s = this.markerSizeCm * (gazedCity === c.cityName ? this.highlightScale : 1)
      t.setWorldScale(new vec3(s * this.markerAspect(), s, s))

      const label = c.count > 1 ? "" + c.count : ""
      if (v.text.text !== label) v.text.text = label
      const showText = label.length > 0
      if (v.textObj.enabled !== showText) v.textObj.enabled = showText
    }
  }

  private hideAll(): void {
    for (const v of this.pool) {
      if (v.root.enabled) v.root.enabled = false
    }
  }

  // --- Pool / visuals --------------------------------------------------------------------

  private ensurePool(n: number, ctrl: GlobeController): void {
    while (this.pool.length < n) {
      this.pool.push(this.createMarkerVisual(this.pool.length, ctrl))
    }
  }

  // Builds one marker visual: a textured quad (Image) + a centered count Text,
  // parented under this layer (NOT the globe/table — world poses are set
  // directly each frame so the markers never inherit a surface's scale).
  private createMarkerVisual(index: number, ctrl: GlobeController): MarkerVisual {
    const layerObj = this.getSceneObject()
    const obj = global.scene.createSceneObject("CardMarker_" + index)
    obj.setParent(layerObj)
    // Same render layer as the globe so the same camera draws the markers.
    obj.layer = ctrl.globeView ? ctrl.globeView.getSceneObject().layer : layerObj.layer

    const image = obj.createComponent("Component.Image") as Image
    const mat = this.sharedMaterial(ctrl)
    if (mat) {
      image.clearMaterials()
      image.addMaterial(mat)
      // Mirror CardButtonFactory.createIcon exactly: texture + explicit opaque
      // white base color (an authored translucent baseColor would otherwise
      // make every marker invisible).
      if (this.markerTexture) image.mainPass.baseTex = this.markerTexture
      image.mainPass.baseColor = new vec4(1, 1, 1, 1)
    }
    ;(image as any).renderOrder = this.markerRenderOrder

    const textObj = global.scene.createSceneObject("CardMarkerCount_" + index)
    textObj.setParent(obj)
    textObj.layer = obj.layer
    // Nudged toward the viewer (the root billboards so +Z faces the camera),
    // raised by countTextHeight (in local marker-height fractions, since the root
    // is uniformly scaled by markerSizeCm), and counter-scaled so countTextSize
    // reads in normal font points regardless of the marker's world size. The
    // highlight pop still scales text and icon together.
    textObj.getTransform().setLocalPosition(new vec3(0, this.countTextHeight, 0.2))
    const inv = 1 / Math.max(0.001, this.markerSizeCm)
    textObj.getTransform().setLocalScale(new vec3(inv, inv, inv))
    const text = textObj.createComponent("Component.Text") as Text
    text.text = ""
    text.size = Math.max(1, Math.round(this.countTextSize))
    text.horizontalAlignment = HorizontalAlignment.Center
    text.verticalAlignment = VerticalAlignment.Center
    text.textFill.color = this.countTextColor
    ;(text as any).renderOrder = this.markerRenderOrder + 1
    textObj.enabled = false

    return { root: obj, image, textObj, text }
  }

  // One cloned material shared by every marker (same icon everywhere; the count
  // differs via Text, so no per-marker material state is needed). Clone-before-
  // modify keeps the source asset pristine.
  private sharedMaterial(ctrl: GlobeController): Material | null {
    if (this.material) return this.material
    if (!this.markerTexture) {
      this.logger.warn("No markerTexture assigned; markers will show the material's default texture.")
    }
    let src = this.markerMaterial ?? null
    if (!src && ctrl.globeView && ctrl.globeView.globeVisual) {
      src = ctrl.globeView.globeVisual.mainMaterial
      this.logger.warn("No markerMaterial assigned; falling back to a clone of the globe material (icon alpha may render opaque). Assign an Unlit transparent material for best results.")
    }
    if (!src) {
      this.logger.error("No markerMaterial and no globe material to fall back on; markers will not render.")
      return null
    }
    this.material = src.clone()
    if (this.markerTexture) {
      const pass = this.material.mainPass as any
      pass.baseTex = this.markerTexture
    }
    return this.material
  }

  // Width/height ratio of the marker texture so non-square icons aren't squashed.
  private markerAspect(): number {
    if (!this.markerTexture) return 1
    const w = this.markerTexture.getWidth()
    const h = this.markerTexture.getHeight()
    return w > 0 && h > 0 ? w / h : 1
  }
}
