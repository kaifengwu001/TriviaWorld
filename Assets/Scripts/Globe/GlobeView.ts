/**
 * Specs Inc. 2026
 * GlobeView – the overview/approach Earth globe.
 *
 * Owns a low/moderate-poly sphere with an UNLIT equirectangular base texture.
 * It is moved by TRADITIONAL rotate-to-aim + scale-to-zoom (the interaction
 * model never changes with depth). During the dock handoff the controller drives
 * a full WORLD-pose tween (animateToPose): the globe simultaneously rotates the
 * selected location to its top, slides so that top lands on the table center,
 * scales up until that surface patch matches the table footprint (dockScaleForSpan),
 * and fades OUT — so it visually "becomes" the map. It stays HIDDEN for the whole
 * DOCKED phase and reverses the same pose tween on the way back out.
 *
 * Fading is done on a CLONED material's baseColor alpha (clone-before-modify, so
 * the shared asset is never mutated — same pattern as PictureBehavior /
 * PingController). Aim/zoom/alpha are tweened in a single UpdateEvent.
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger";
import { LatLng, Easing, aimEuler, dockScaleForSpan, spanForDockScale, easeInOutCubic, clamp01, lerp } from "./GeoMath";

/**
 * Per-channel easing for a pose tween. Each channel (position / rotation / scale
 * / alpha) advances on its own curve so the dive can, e.g., shoot the globe
 * toward the table early (ease-out position) while the zoom accelerates late
 * (ease-in scale). Any omitted channel defaults to ease-in-out cubic.
 */
export interface PoseEasing {
  position?: Easing;
  rotation?: Easing;
  scale?: Easing;
  alpha?: Easing;
}

interface GlobeTween {
  // Position is tracked as the globe's TOP TIP (its world-up-most surface point),
  // NOT its center, so scale and position both pivot about that tip — the dive
  // looks like zooming into the top surface instead of flinging the center.
  fromTop: vec3;
  toTop: vec3;
  fromRot: quat;
  toRot: quat;
  fromScale: number;
  toScale: number;
  fromAlpha: number;
  toAlpha: number;
  easePos: Easing;
  easeRot: Easing;
  easeScale: Easing;
  easeAlpha: Easing;
  duration: number;
  elapsed: number;
  onDone: (() => void) | null;
}

@component
export class GlobeView extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">GlobeView – rotate-to-aim + scale-to-zoom Earth globe</span><br/><span style="color: #94A3B8; font-size: 11px;">Hidden while the holodeck table is up. Aim/zoom/fade are math-driven so the dock handoff lines up by construction.</span>')
  @ui.separator

  @ui.label('<span style="color: #60A5FA;">References</span>')
  @input
  @hint("RenderMeshVisual of the sphere. Its material is cloned so fading never mutates the shared asset.")
  globeVisual: RenderMeshVisual

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Footprint matching</span>')
  @input
  @hint("Sphere radius in cm at scale = 1. Leave at 0 to AUTO-DETECT from the mesh bounding box (recommended). Set > 0 to override.")
  globeRadiusCm: number = 0

  // On-screen size in cm of the holodeck table; dockScaleForSpan/spanForScale use
  // it to match the globe footprint to the table. NOT an @input: GlobeController
  // owns the single authored value and pushes it here via setTableSizeCm so the
  // table size can never drift between the globe, the table mesh, and panning.
  private tableSizeCm: number = 60

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Logging</span>')
  @input
  @hint("Enable general logging")
  enableLogging: boolean = false

  @input
  @hint("Enable lifecycle logging (onAwake, onStart, onUpdate, onDestroy)")
  enableLoggingLifecycle: boolean = false

  private logger: Logger
  private transform: Transform
  private material: Material = null
  private baseScale: vec3 = vec3.one()
  // Resolved sphere radius (cm) at scale = 1; auto-detected from the mesh AABB
  // when globeRadiusCm <= 0, otherwise the override value.
  private resolvedRadiusCm: number = 0
  private currentScale: number = 1
  private currentAlpha: number = 1
  private tween: GlobeTween | null = null

  onAwake() {
    this.logger = new Logger("GlobeView", this.enableLogging || this.enableLoggingLifecycle, true)
    if (this.enableLoggingLifecycle) this.logger.debug("LIFECYCLE: onAwake()")

    this.transform = this.getSceneObject().getTransform()
    this.baseScale = this.transform.getLocalScale()
    this.cloneMaterial()

    this.createEvent("UpdateEvent").bind(() => this.update(getDeltaTime()))
  }

  // --- Public API ------------------------------------------------------------

  /** Sets the shared table size (cm). Called by GlobeController at startup. */
  setTableSizeCm(cm: number): void {
    this.tableSizeCm = Math.max(1, cm)
  }

  /** The globe scale whose footprint matches the table showing `spanDeg`. */
  dockScaleForSpan(spanDeg: number): number {
    return dockScaleForSpan(spanDeg, this.getRadiusCm(), this.tableSizeCm)
  }

  /** Inverse of {@link dockScaleForSpan}: the table-footprint span at `scale`. */
  spanForScale(scale: number): number {
    return spanForDockScale(scale, this.getRadiusCm(), this.tableSizeCm)
  }

  /** The globe's current zoom scale (multiplier on the authored base scale). */
  getScale(): number {
    return this.currentScale
  }

  /** The globe's current opacity (0..1). */
  getAlpha(): number {
    return this.currentAlpha
  }

  /**
   * The sphere radius in cm at scale = 1. Uses the override when set, otherwise
   * auto-detects (once) from the mesh's local AABB scaled by the authored base
   * scale, so the footprint match needs no hand-measured radius.
   */
  getRadiusCm(): number {
    if (this.globeRadiusCm > 0) return this.globeRadiusCm
    if (this.resolvedRadiusCm > 0) return this.resolvedRadiusCm
    this.resolvedRadiusCm = this.detectRadiusCm()
    return this.resolvedRadiusCm
  }

  /**
   * Local-space sphere radius (half the largest AABB axis), in the globe's own
   * coordinate space. Use this to place children (e.g. city markers) on the
   * surface so they ride along with the globe's rotation/scale.
   */
  getLocalRadiusCm(): number {
    if (!this.globeVisual) return 0
    const min = this.globeVisual.localAabbMin()
    const max = this.globeVisual.localAabbMax()
    return Math.max(max.x - min.x, max.y - min.y, max.z - min.z) / 2
  }

  /**
   * Manually rotates the globe by yaw/pitch deltas (radians) in local space.
   *
   * Manual rotation is AUTHORITATIVE: any in-flight tween is finalized first so a
   * still-running fade (e.g. the OVERVIEW crossfade enterOverview() starts after a
   * return dive) can't overwrite the rotation each frame and "rubber band" the
   * drag back. Finalizing snaps the tween to its end (alpha/scale/pose land
   * correctly) before the user delta is applied.
   */
  rotateBy(yawRad: number, pitchRad: number): void {
    if (this.tween) this.finishTween()
    const delta = quat.angleAxis(yawRad, vec3.up()).multiply(quat.angleAxis(pitchRad, vec3.right()))
    this.transform.setLocalRotation(delta.multiply(this.transform.getLocalRotation()))
  }

  /**
   * Eases the globe one frame toward "upright" — its spin axis (local +Y / the
   * north pole) brought back to vertical — while leaving its heading (which
   * longitude faces the viewer) untouched. This is the self-righting spring that
   * undoes pole-tilt after the user lets go, so an up/down drag never leaves the
   * globe stuck at an awkward angle.
   *
   * The correction is a critically-damped exponential (no overshoot): each call
   * removes a `1 - e^(-speed*dt)` fraction of the remaining tilt, so it slows as
   * it levels and naturally settles. Returns the tilt (radians) BEFORE this
   * step, so callers can tell when it has finished (~0). No-op during a tween.
   */
  rightingStep(dt: number, speed: number): number {
    if (this.tween || speed <= 0 || dt <= 0) return 0
    const q = this.transform.getLocalRotation()
    // Where the north pole currently points (same space rotateBy operates in).
    const upNow = q.multiplyVec3(vec3.up())
    const cosTilt = Math.max(-1, Math.min(1, upNow.dot(vec3.up())))
    const tilt = Math.acos(cosTilt)
    if (tilt < 1e-3) return tilt
    // Axis that swings the pole back to vertical along the shortest arc. When the
    // globe is exactly upside-down the cross product vanishes, so fall back to a
    // fixed horizontal axis to keep righting.
    let axis = upNow.cross(vec3.up())
    const len = axis.length
    axis = len < 1e-5 ? vec3.right() : axis.uniformScale(1 / len)
    const target = quat.angleAxis(tilt, axis).multiply(q)
    const k = 1 - Math.exp(-speed * dt)
    this.transform.setLocalRotation(quat.slerp(q, target, k))
    return tilt
  }

  // Local-space half-extent (largest axis) times the authored base scale gives
  // the world radius at scale = 1, independent of any runtime zoom we apply.
  private detectRadiusCm(): number {
    const fallback = 30
    if (!this.globeVisual) {
      this.logger.warn("Cannot auto-detect globe radius (no globeVisual); using " + fallback + " cm.")
      return fallback
    }
    const min = this.globeVisual.localAabbMin()
    const max = this.globeVisual.localAabbMax()
    const localR = Math.max(max.x - min.x, max.y - min.y, max.z - min.z) / 2
    const s = this.baseScale
    const worldR = localR * Math.max(s.x, s.y, s.z)
    if (!(worldR > 0)) {
      this.logger.warn("Auto-detected non-positive globe radius; using " + fallback + " cm.")
      return fallback
    }
    this.logger.info("Auto-detected globe radius: " + worldR.toFixed(1) + " cm")
    return worldR
  }

  /** Instantly rotates the globe so `latLng` faces the viewer (front-center). */
  aimAt(latLng: LatLng): void {
    this.transform.setLocalRotation(this.rotationFor(latLng))
  }

  /** Instantly sets the zoom scale (multiplier on the authored base scale). */
  zoomTo(scale: number): void {
    this.currentScale = Math.max(1e-3, scale)
    this.applyScale()
  }

  /** Sets the globe opacity (0..1) on the cloned material's baseColor alpha. */
  setAlpha(alpha: number): void {
    this.currentAlpha = clamp01(alpha)
    this.applyAlpha()
  }

  /** The globe's current world TOP TIP (its world-up-most surface point). */
  getTopTip(): vec3 {
    return this.currentTopTip()
  }

  /**
   * Tweens aim + zoom + alpha together over `duration` seconds, leaving the
   * globe's world POSITION unchanged. Used by show()/hide() for plain fades.
   * Calls `onDone` when finished.
   */
  animate(
    targetLatLng: LatLng | null,
    targetScale: number,
    targetAlpha: number,
    duration: number,
    onDone?: () => void
  ): void {
    const toRot = targetLatLng ? this.rotationFor(targetLatLng) : this.transform.getWorldRotation()
    this.startTween(this.currentTopTip(), toRot, targetScale, targetAlpha, duration, onDone ?? null)
  }

  /**
   * Tweens the full WORLD pose plus alpha over `duration` seconds, with position
   * and scale pivoting about the globe's TOP TIP. This is the dock handoff: the
   * globe rotates the selected location to its top, moves that top tip onto
   * `toTopTip` (the table center), scales up about that tip until the surface
   * patch matches the table footprint, and (optionally) fades out — so it
   * visually "becomes" the map without the center flinging away. Passing null for
   * `toTopTip`/`toRot` keeps the current world value. `easing` supplies an
   * independent curve per channel (defaults to ease-in-out cubic).
   */
  animateToPose(
    toTopTip: vec3 | null,
    toRot: quat | null,
    toScale: number,
    toAlpha: number,
    duration: number,
    easing?: PoseEasing,
    onDone?: () => void
  ): void {
    this.startTween(
      toTopTip ?? this.currentTopTip(),
      toRot ?? this.transform.getWorldRotation(),
      toScale,
      toAlpha,
      duration,
      onDone ?? null,
      easing
    )
  }

  /**
   * Instantly snaps the globe so its TOP TIP is at `topTip`, with `rot`/`scale`.
   * The transform center is derived so the tip lands exactly where asked.
   */
  setPose(topTip: vec3, rot: quat, scale: number): void {
    this.tween = null
    this.currentScale = Math.max(1e-3, scale)
    this.transform.setWorldRotation(rot)
    this.transform.setWorldPosition(this.centerFromTop(topTip, this.currentScale))
    this.applyScale()
  }

  private startTween(
    toTop: vec3,
    toRot: quat,
    toScale: number,
    toAlpha: number,
    duration: number,
    onDone: (() => void) | null,
    easing?: PoseEasing
  ): void {
    this.tween = {
      fromTop: this.currentTopTip(),
      toTop,
      fromRot: this.transform.getWorldRotation(),
      toRot,
      fromScale: this.currentScale,
      toScale: Math.max(1e-3, toScale),
      fromAlpha: this.currentAlpha,
      toAlpha: clamp01(toAlpha),
      easePos: easing?.position ?? easeInOutCubic,
      easeRot: easing?.rotation ?? easeInOutCubic,
      easeScale: easing?.scale ?? easeInOutCubic,
      easeAlpha: easing?.alpha ?? easeInOutCubic,
      duration: Math.max(0.0001, duration),
      elapsed: 0,
      onDone,
    }
    if (duration <= 0) this.finishTween()
  }

  // The globe's current top tip: the world-up-most point of the sphere surface,
  // i.e. center + worldUp * (worldRadiusAtScale1 * currentScale). Independent of
  // the globe's rotation, by construction.
  private currentTopTip(): vec3 {
    return this.transform.getWorldPosition().add(vec3.up().uniformScale(this.getRadiusCm() * this.currentScale))
  }

  // The transform center that places the top tip at `top` for a given `scale`.
  private centerFromTop(top: vec3, scale: number): vec3 {
    return top.sub(vec3.up().uniformScale(this.getRadiusCm() * scale))
  }

  /** Fades the globe in (and enables it) over `duration` seconds. */
  show(duration: number = 0.6, onDone?: () => void): void {
    this.getSceneObject().enabled = true
    this.animate(null, this.currentScale, 1, duration, onDone)
  }

  /** Fades the globe out over `duration` seconds, then disables the object. */
  hide(duration: number = 0.6, onDone?: () => void): void {
    this.animate(null, this.currentScale, 0, duration, () => {
      this.getSceneObject().enabled = false
      if (onDone) onDone()
    })
  }

  // --- Internal --------------------------------------------------------------

  private rotationFor(latLng: LatLng): quat {
    const e = aimEuler(latLng.lng, latLng.lat)
    return quat.fromEulerAngles(e.x, e.y, e.z)
  }

  private cloneMaterial(): void {
    if (!this.globeVisual) {
      this.logger.warn("No globeVisual assigned; globe will not render or fade.")
      return
    }
    // Clone-before-modify so the shared base material asset is never mutated.
    this.material = this.globeVisual.mainMaterial.clone()
    this.globeVisual.mainMaterial = this.material
    this.applyAlpha()
  }

  private applyScale(): void {
    this.transform.setLocalScale(this.baseScale.uniformScale(this.currentScale))
  }

  private applyAlpha(): void {
    if (!this.material) return
    const pass = this.material.mainPass as any
    const c = pass.baseColor as vec4
    if (c) {
      pass.baseColor = new vec4(c.r, c.g, c.b, this.currentAlpha)
    }
  }

  private update(dt: number): void {
    if (!this.tween) return
    const t = this.tween
    t.elapsed += dt
    const raw = clamp01(t.elapsed / t.duration)

    // Scale first, then derive the center from the (independently eased) top tip
    // so the tip tracks its own curve exactly no matter how scale eases.
    this.currentScale = lerp(t.fromScale, t.toScale, t.easeScale(raw))
    this.applyScale()
    const top = vec3.lerp(t.fromTop, t.toTop, t.easePos(raw))
    this.transform.setWorldPosition(this.centerFromTop(top, this.currentScale))
    this.transform.setWorldRotation(quat.slerp(t.fromRot, t.toRot, t.easeRot(raw)))
    this.currentAlpha = lerp(t.fromAlpha, t.toAlpha, t.easeAlpha(raw))
    this.applyAlpha()

    if (t.elapsed >= t.duration) this.finishTween()
  }

  private finishTween(): void {
    if (!this.tween) return
    const t = this.tween
    this.currentScale = t.toScale
    this.applyScale()
    this.transform.setWorldPosition(this.centerFromTop(t.toTop, this.currentScale))
    this.transform.setWorldRotation(t.toRot)
    this.currentAlpha = t.toAlpha
    this.applyAlpha()
    const done = t.onDone
    this.tween = null
    if (done) done()
  }
}
