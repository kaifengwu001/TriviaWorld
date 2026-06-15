/**
 * Specs Inc. 2026
 * GpsPingLayer – a fake GPS icon pinned flat on the globe / map table.
 *
 * One surface-aligned textured quad at a configurable city center (default Los
 * Angeles). Every frame it re-maps onto whichever surface is active — globe in
 * OVERVIEW + dives, table while DOCKED — using the same handoff rules as
 * CardMarkerLayer so the icon never jumps through zoom or transition phases.
 *
 * Unlike CardMarkerLayer's camera billboards, this icon lies tangent to the
 * surface: on the globe its normal follows the sphere outward; on the table it
 * aligns with the quad's +Y. World size stays constant (iconSizeCm) regardless
 * of globe scale or map zoom.
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger";
import { GlobeController } from "./GlobeController";
import { angularDistanceDeg } from "./CardGeo";
import { GeoBounds, LatLng, lonLatToSpherePos } from "./GeoMath";

/** Which surface the GPS icon is mapped onto this frame. */
type SurfaceMode =
  | { kind: "none" }
  | { kind: "globe"; clipCenter: LatLng | null; clipSpanDeg: number }
  | { kind: "table"; view: GeoBounds };

@component
export class GpsPingLayer extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">GpsPingLayer – fake GPS icon flat on globe + map table</span><br/><span style="color: #94A3B8; font-size: 11px;">Surface-aligned icon at a city center (default Los Angeles). Constant world size through every zoom, pan, LOD step, and dive.</span>')
  @ui.separator

  @ui.label('<span style="color: #60A5FA;">References</span>')
  @input
  @hint("The GlobeController that owns the globe/table state machine. If unset, global.globeController is used.")
  @allowUndefined
  globeController: GlobeController

  @input
  @hint("Unlit transparent material for the icon quad (cloned at runtime; its baseTex is replaced by Icon Texture). Falls back to a clone of the globe's material if unset.")
  @allowUndefined
  iconMaterial: Material

  @input
  @hint("The GPS icon texture (PNG drawn on a surface-aligned quad).")
  @allowUndefined
  iconTexture: Texture

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Placement</span>')
  @input
  @hint('City whose centerLatLng is used (must match cityBounds.ts exactly, e.g. "Los Angeles").')
  cityName: string = "Los Angeles"

  @input
  @hint("How far (cm) the icon floats above the ACTIVE surface — globe AND table use the same lift so the dive handoff is height-continuous.")
  surfaceLiftCm: number = 1.5

  @input
  @hint("Radius of the table's visible (feathered) circle as a fraction of its half-size. The icon disappears past the rim and reappears when panned back in.")
  visibleCircleFraction: number = 0.95

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Visuals</span>')
  @input
  @hint("Icon quad size (cm). Constant world size; does not grow or shrink with globe scale or map zoom.")
  iconSizeCm: number = 4

  @input
  @hint("Render order for the icon quad. Keep above the globe/table so the icon is never z-fought away.")
  renderOrder: number = 510

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
  private visual: SceneObject | null = null
  private image: Image | null = null
  private lastStatus: string = ""

  onAwake() {
    this.logger = new Logger("GpsPingLayer", this.enableLogging || this.enableLoggingLifecycle, true)
    if (this.enableLoggingLifecycle) this.logger.debug("LIFECYCLE: onAwake()")
    this.createEvent("UpdateEvent").bind(() => this.update())
  }

  private update(): void {
    try {
      this.updateInner()
    } catch (e) {
      this.logger.error("Update failed: " + e)
    }
  }

  private updateInner(): void {
    const ctrl = this.resolveController()
    if (!ctrl) {
      this.reportStatus("BLOCKED: no GlobeController")
      this.hide()
      return
    }
    if (!ctrl.globeView || !ctrl.mapViewport || !ctrl.cityData) {
      this.reportStatus("BLOCKED: GlobeController missing globeView / mapViewport / cityData")
      this.hide()
      return
    }

    const city = ctrl.cityData.getCity(this.cityName)
    if (!city) {
      this.reportStatus('BLOCKED: city "' + this.cityName + '" not found in CityData')
      this.hide()
      return
    }

    const mode = this.decideMode(ctrl)
    if (mode.kind === "none") {
      this.reportStatus(ctrl.isDocked() ? "hidden: docked but map bounds unavailable" : "hidden: globe disabled")
      this.hide()
      return
    }

    const latLng = city.latLng
    if (mode.kind === "globe" && mode.clipCenter) {
      if (angularDistanceDeg(latLng, mode.clipCenter) > mode.clipSpanDeg * 0.75) {
        this.reportStatus("hidden: outside dive footprint")
        this.hide()
        return
      }
    }

    let pos: vec3
    let rot: quat
    if (mode.kind === "table") {
      const mapped = this.tableWorldPos(latLng, mode.view, ctrl)
      if (mapped.planarDistCm > this.visibleCircleFraction * ctrl.tableSizeCm * 0.5) {
        this.reportStatus("hidden: outside table visible circle")
        this.hide()
        return
      }
      pos = mapped.pos
      rot = this.tableSurfaceRotation(ctrl)
    } else {
      pos = this.globeWorldPos(latLng, ctrl)
      if (!this.isVisibleOnGlobe(pos, ctrl)) {
        this.reportStatus("hidden: behind globe")
        this.hide()
        return
      }
      rot = this.globeSurfaceRotation(latLng, ctrl)
    }

    this.ensureVisual(ctrl)
    if (!this.visual) return

    this.visual.enabled = true
    const t = this.visual.getTransform()
    t.setWorldPosition(pos)
    t.setWorldRotation(rot)
    const s = this.iconSizeCm
    t.setWorldScale(new vec3(s * this.iconAspect(), s, s))
    this.reportStatus("visible mode=" + mode.kind)
  }

  private resolveController(): GlobeController | null {
    if (this.globeController) return this.globeController
    return ((global as any).globeController as GlobeController) ?? null
  }

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

  private globeWorldPos(latLng: LatLng, ctrl: GlobeController): vec3 {
    const gv = ctrl.globeView
    const p = lonLatToSpherePos(latLng.lng + (ctrl.textureLonOffsetDeg ?? 0), latLng.lat, gv.getLocalRadiusCm())
    const surface = gv.getSceneObject().getTransform().getWorldTransform().multiplyPoint(new vec3(p.x, p.y, p.z))
    const center = gv.getSceneObject().getTransform().getWorldPosition()
    const outward = surface.sub(center)
    const len = outward.length
    if (len < 1e-5) return surface
    return surface.add(outward.uniformScale(this.surfaceLiftCm / len))
  }

  private tableWorldPos(
    latLng: LatLng,
    view: GeoBounds,
    ctrl: GlobeController
  ): { pos: vec3; planarDistCm: number } {
    const tT = this.tableTransform(ctrl)
    const size = Math.max(1e-3, ctrl.tableSizeCm)
    const span = Math.max(1e-6, view.spanDeg)
    const dEast = ((latLng.lng - view.centerLatLng.lng) / span) * size
    const dNorth = ((latLng.lat - view.centerLatLng.lat) / span) * size
    const pos = tT
      .getWorldPosition()
      .add(tT.right.uniformScale(dEast))
      .add(tT.forward.uniformScale(-dNorth))
      .add(tT.up.uniformScale(this.surfaceLiftCm))
    return { pos, planarDistCm: Math.sqrt(dEast * dEast + dNorth * dNorth) }
  }

  private globeSurfaceRotation(latLng: LatLng, ctrl: GlobeController): quat {
    const aimed = {
      lng: latLng.lng + (ctrl.textureLonOffsetDeg ?? 0),
      lat: latLng.lat,
    }
    const c = lonLatToSpherePos(aimed.lng, aimed.lat, 1)
    const n = lonLatToSpherePos(aimed.lng, aimed.lat + 0.5, 1)
    const normalLocal = new vec3(c.x, c.y, c.z)
    const northLocal = new vec3(n.x - c.x, n.y - c.y, n.z - c.z)
    const rot = ctrl.globeView.getSceneObject().getTransform().getWorldRotation()
    const normal = rot.multiplyVec3(normalLocal).normalize()
    const north = rot.multiplyVec3(northLocal).normalize()
    return this.frameQuat(north, normal)
  }

  private tableSurfaceRotation(ctrl: GlobeController): quat {
    const tT = this.tableTransform(ctrl)
    const up = tT.up.normalize()
    const north = tT.forward.uniformScale(-1).normalize()
    return this.frameQuat(north, up)
  }

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

  private anyPerpendicular(v: vec3): vec3 {
    const a = Math.abs(v.x) < 0.9 ? vec3.right() : vec3.up()
    return a.sub(v.uniformScale(a.dot(v))).normalize()
  }

  private isVisibleOnGlobe(markerPos: vec3, ctrl: GlobeController): boolean {
    const camT = ctrl.cameraObject ? ctrl.cameraObject.getTransform() : null
    if (!camT) return true
    const cam = camT.getWorldPosition()
    const center = ctrl.globeView.getSceneObject().getTransform().getWorldPosition()
    const r = ctrl.globeView.getRadiusCm() * ctrl.globeView.getScale() * 0.98
    const toMarker = markerPos.sub(cam)
    const len = toMarker.length
    if (len < 1e-4) return true
    const dir = toMarker.uniformScale(1 / len)
    const toCenter = center.sub(cam)
    const along = toCenter.dot(dir)
    if (along < 0 || along > len) return true
    const perpSq = toCenter.dot(toCenter) - along * along
    return perpSq >= r * r
  }

  private tableTransform(ctrl: GlobeController): Transform {
    const obj = ctrl.tableObject ?? ctrl.mapViewport.getSceneObject()
    return obj.getTransform()
  }

  private ensureVisual(ctrl: GlobeController): void {
    if (this.visual) return
    const layerObj = this.getSceneObject()
    const obj = global.scene.createSceneObject("GpsPing")
    obj.setParent(layerObj)
    obj.layer = ctrl.globeView ? ctrl.globeView.getSceneObject().layer : layerObj.layer

    const image = obj.createComponent("Component.Image") as Image
    const mat = this.sharedMaterial(ctrl)
    if (mat) {
      image.clearMaterials()
      image.addMaterial(mat)
      if (this.iconTexture) image.mainPass.baseTex = this.iconTexture
      image.mainPass.baseColor = new vec4(1, 1, 1, 1)
    }
    ;(image as any).renderOrder = this.renderOrder

    this.visual = obj
    this.image = image
  }

  private sharedMaterial(ctrl: GlobeController): Material | null {
    if (this.material) return this.material
    if (!this.iconTexture) {
      this.logger.warn("No iconTexture assigned; GPS icon will show the material's default texture.")
    }
    let src = this.iconMaterial ?? null
    if (!src && ctrl.globeView && ctrl.globeView.globeVisual) {
      src = ctrl.globeView.globeVisual.mainMaterial
      this.logger.warn("No iconMaterial assigned; falling back to a clone of the globe material.")
    }
    if (!src) {
      this.logger.error("No iconMaterial and no globe material to fall back on; GPS icon will not render.")
      return null
    }
    this.material = src.clone()
    if (this.iconTexture) {
      const pass = this.material.mainPass as any
      pass.baseTex = this.iconTexture
    }
    return this.material
  }

  private iconAspect(): number {
    if (!this.iconTexture) return 1
    const w = this.iconTexture.getWidth()
    const h = this.iconTexture.getHeight()
    return w > 0 && h > 0 ? w / h : 1
  }

  private hide(): void {
    if (this.visual && this.visual.enabled) this.visual.enabled = false
  }

  private reportStatus(status: string): void {
    if (status === this.lastStatus) return
    this.lastStatus = status
    this.logger.info("Status: " + status)
  }
}
