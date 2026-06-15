/**
 * Specs Inc. 2026
 * Bubble Field spawner for the textured Bubble system.
 *
 * Spawns a field of flat, billboarded PNG quads at runtime, scattered through a
 * cylindrical "pipe" around the player. Each bubble is a single shared unit quad
 * with its own cloned material whose texture is picked at random from a
 * Lens-Studio-assigned array, sized to the texture's aspect ratio.
 *
 * Bubbles pop in on the ping wavefront (spawnWave(origin), e.g. forwarded by
 * PingCardSpawner) and are billboarded ONCE at spawn. The only per-frame work is
 * optional FOV culling (hiding off-screen quads); the quads are otherwise static.
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger";
import animate, { CancelSet } from "SpectaclesInteractionKit.lspkg/Utils/animate";
import { PingController } from "../PingController";
import { createUnitQuadMesh } from "./QuadMesh";

// Scale a wavefront-spawned bubble pops in from (a hair above zero).
const POP_START_SCALE = 0.02;
// Fallback wavefront speed (cm/s) when no PingController is linked and no
// override is set. Matches PingController.pingSpeed's default.
const DEFAULT_WAVEFRONT_SPEED = 250;

@component
export class BubbleField extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">BubbleField – spawns a field of textured, billboarded bubbles</span><br/><span style="color: #94A3B8; font-size: 11px;">Scatters N flat PNG quads in a cylinder around the player, each with a random texture from the array below. Bubbles pop in on the ping wavefront.</span>')
  @ui.separator

  @ui.label('<span style="color: #60A5FA;">Material & Textures</span>')
  @input
  @hint("Base material cloned onto every bubble. Use an unlit, two-sided, textured material — its baseTex is overwritten per bubble.")
  @allowUndefined
  baseMaterial: Material

  @input
  @hint("Textures the bubbles draw. Each bubble picks one at random. If empty, bubbles spawn but show no image.")
  textures: Texture[] = []

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Spawning (cylindrical pipe around the player)</span>')
  @input
  @hint("Number of bubbles to spawn")
  bubbleCount: number = 12

  @input
  @hint("Minimum horizontal distance (cm) from the field origin a bubble can spawn — the pipe's inner wall.")
  minDistance: number = 80

  @input
  @hint("Maximum horizontal distance (cm) from the field origin a bubble can spawn — the pipe's outer wall.")
  maxDistance: number = 220

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Wavefront spawn-out</span>')
  @input
  @hint("Pop bubbles into being as the ping wavefront reaches each one (call spawnWave(origin), e.g. forwarded by PingCardSpawner) instead of spawning them all at start. Off = legacy behaviour: all bubbles exist from the very beginning.")
  spawnOnWavefront: boolean = true

  @input
  @hint("PingController whose pingSpeed times each bubble's reveal so they appear with the visible ping. Optional — falls back to Wavefront Speed Override.")
  @allowUndefined
  pingController: PingController

  @input
  @hint("Override the wavefront speed (cm/s). 0 = read pingSpeed from the linked PingController (recommended so reveals match the visible ping).")
  wavefrontSpeedOverride: number = 0

  @input
  @hint("Extra seconds added to every bubble reveal. Nudge to pop bubbles right ON the band vs slightly behind it.")
  revealOffsetSec: number = 0

  @input
  @hint("Seconds of the bubble's pop-in scale animation when it is revealed on the wavefront.")
  revealPopDuration: number = 0.5

  @input
  @hint("Allow a later wave to clear the previous bubbles and spawn again. Off = the first wave wins and later calls are ignored.")
  allowRespawn: boolean = false

  @input
  @hint("Floor height (cm, local Y) — the bottom of the spawn pipe. May be negative (below the origin).")
  floorHeight: number = -50

  @input
  @hint("Ceiling height (cm, local Y) — the top of the spawn pipe.")
  ceilingHeight: number = 100

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Size</span>')
  @input
  @hint("Minimum bubble size (cm) — drives the LARGER dimension of the quad; the other dimension follows the texture's aspect ratio.")
  radiusMin: number = 3

  @input
  @hint("Maximum bubble size (cm) — drives the LARGER dimension of the quad.")
  radiusMax: number = 6

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Camera & Performance</span>')
  @input
  @hint("The player camera object. Used to billboard bubbles toward the viewer and to cull off-screen ones. If unset, billboarding and FOV culling are disabled.")
  @allowUndefined
  cameraObject: SceneObject

  @input
  @hint("Billboard each bubble to face the camera. Applied ONCE when the bubble spawns (its +Z normal is aimed at the camera position) and then held — the bubbles are world-fixed.")
  billboard: boolean = true

  @input
  @hint("Hide bubbles outside the camera's field of view (they stop drawing until they come back into view).")
  fovCullEnabled: boolean = true

  @input
  @hint("Half-angle (degrees) of the view cone used for FOV culling. Generous values avoid culling bubbles near the screen edges; lower to cull more aggressively.")
  fovCullHalfAngleDeg: number = 70

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Logging</span>')
  @input
  @hint("Enable general logging")
  enableLogging: boolean = false

  @input
  @hint("Enable lifecycle logging (onAwake, onStart, onUpdate, onDestroy)")
  enableLoggingLifecycle: boolean = false

  private logger: Logger
  // Shared unit-quad mesh assigned to every bubble's RenderMeshVisual.
  private quadMesh: RenderMesh = null
  // Parallel arrays kept in lockstep so the cull loop avoids repeated lookups.
  private bubbleTransforms: Transform[] = []
  private bubbleVisuals: RenderMeshVisual[] = []
  // Conservative billboard-facing radius (cm) per bubble for the FOV cone test, so
  // a bubble whose center is just off-screen but whose body is visible isn't culled.
  private bubbleCullRadius: number[] = []
  // Wavefront-spawn bookkeeping: whether a wave has fired and the running index so
  // each bubble keeps a stable slot even though they spawn at different times.
  private waveSpawned: boolean = false
  private nextBubbleIndex: number = 0
  private popCancels: CancelSet[] = []
  // Pending wavefront timers, so clearSpawned() can remove them: createEvent()
  // never auto-releases an event, so leaving them attached leaks one closure per
  // scheduled bubble (unbounded across respawns) and lets stale timers fire after
  // a clear, popping orphan bubbles into the next wave.
  private scheduleEvents: DelayedCallbackEvent[] = []
  private cameraMissingWarned: boolean = false

  onAwake() {
    this.logger = new Logger("BubbleField", this.enableLogging || this.enableLoggingLifecycle, true)
    if (this.enableLoggingLifecycle) this.logger.debug("LIFECYCLE: onAwake()")

    this.createEvent("OnStartEvent").bind(() => this.onStart())
    this.createEvent("UpdateEvent").bind(() => this.update())
  }

  private onStart(): void {
    if (!this.baseMaterial) {
      this.logger.warn("No baseMaterial assigned; bubbles will spawn but not render.")
    }
    if (!this.textures || this.textures.length === 0) {
      this.logger.warn("No textures assigned; bubbles will spawn but show no image.")
    }
    // Guard: a wave forwarded before onStart may have already built it.
    if (!this.quadMesh) this.quadMesh = createUnitQuadMesh()

    if (this.spawnOnWavefront) {
      // Hold off: bubbles pop in when spawnWave(origin) is called (e.g. forwarded
      // by PingCardSpawner on the prayer ping).
      this.logger.info("Wavefront mode: waiting for spawnWave() before spawning bubbles.")
      return
    }
    this.spawnAllNow()
    this.logger.info("Spawned " + this.bubbleVisuals.length + " bubbles.")
  }

  // --- public API ------------------------------------------------------------

  /**
   * Spawns the field on the ping wavefront from `origin` (the player's head).
   * Each bubble is scheduled to pop into being as the wavefront reaches its
   * scattered position, mirroring PingCardSpawner. Safe to call with no origin
   * (falls back to this object's world position).
   */
  spawnWave(origin: vec3): void {
    if (this.waveSpawned && !this.allowRespawn) {
      this.logger.info("spawnWave ignored — already spawned (enable Allow Respawn to re-fire).")
      return
    }
    if (this.waveSpawned && this.allowRespawn) this.clearSpawned()

    // onStart may not have run yet if a wave is forwarded very early.
    if (!this.quadMesh) this.quadMesh = createUnitQuadMesh()

    const from = origin ? new vec3(origin.x, origin.y, origin.z) : this.worldOrigin()
    const speed = this.wavefrontSpeed()
    const toWorld = this.sceneObject.getTransform().getWorldTransform()
    const count = Math.max(0, Math.floor(this.bubbleCount))

    for (let i = 0; i < count; i++) {
      const localPos = this.randomCylinderPosition()
      const worldPos = toWorld.multiplyPoint(localPos)
      const delay = Math.max(0, worldPos.distance(from) / speed + this.revealOffsetSec)
      this.scheduleBubble(localPos, delay)
    }

    this.waveSpawned = true
    this.logger.info("Wave: " + count + " bubble(s) at " + speed.toFixed(0) + " cm/s.")
  }

  /** Destroys every spawned bubble and resets so a fresh wave can be fired. */
  clearSpawned(): void {
    // Drop any pending wavefront timers so they neither fire after the clear nor
    // linger on the component (createEvent never auto-removes them).
    for (const ev of this.scheduleEvents) this.removeEvent(ev)
    this.scheduleEvents = []
    for (const c of this.popCancels) c.cancel()
    this.popCancels = []
    for (const t of this.bubbleTransforms) {
      const obj = t ? t.getSceneObject() : null
      if (obj) obj.destroy()
    }
    this.bubbleTransforms = []
    this.bubbleVisuals = []
    this.bubbleCullRadius = []
    this.nextBubbleIndex = 0
    this.waveSpawned = false
  }

  // --- internal --------------------------------------------------------------

  // Legacy path: every bubble exists from the very start.
  private spawnAllNow(): void {
    const count = Math.max(0, Math.floor(this.bubbleCount))
    for (let i = 0; i < count; i++) {
      this.createBubble(this.randomCylinderPosition())
    }
  }

  // Defers a single bubble's creation to the moment the wavefront arrives, then
  // pops it in. Delay 0 creates it immediately.
  private scheduleBubble(localPos: vec3, delay: number): void {
    if (delay <= 0) {
      this.createBubble(localPos, true)
      return
    }
    const ev = this.createEvent("DelayedCallbackEvent")
    ev.bind(() => this.createBubble(localPos, true))
    ev.reset(delay)
    this.scheduleEvents.push(ev)
  }

  // Instantiates one bubble at `localPos`: a shared quad mesh + a per-bubble
  // cloned material carrying a randomly-chosen texture, sized to that texture's
  // aspect ratio. When `pop` is set it animates a scale pop-in.
  private createBubble(localPos: vec3, pop: boolean = false): void {
    const index = this.nextBubbleIndex++
    const obj = global.scene.createSceneObject("Bubble_" + index)
    obj.setParent(this.sceneObject)
    // Inherit the field's render layer so the camera actually draws the
    // runtime-created bubbles (otherwise they may land on an unrendered layer).
    obj.layer = this.sceneObject.layer
    const transform = obj.getTransform()
    transform.setLocalPosition(localPos)

    const size = this.randBetween(this.radiusMin, this.radiusMax)
    const texture = this.textureForIndex(index)
    const scale = this.quadScale(size, texture)
    transform.setLocalScale(scale)

    const rmv = obj.createComponent("Component.RenderMeshVisual") as RenderMeshVisual
    rmv.mesh = this.quadMesh
    if (this.baseMaterial) {
      const material = this.baseMaterial.clone()
      const pass = material.mainPass as any
      if (texture) pass.baseTex = texture
      // A flat 2D quad should be visible from both sides.
      pass.twoSided = true
      rmv.mainMaterial = material
    }

    this.bubbleTransforms.push(transform)
    this.bubbleVisuals.push(rmv)
    // Largest half-extent the quad occupies, used as the cone-test margin.
    this.bubbleCullRadius.push(Math.max(scale.x, scale.y) * 0.5)

    // Billboard ONCE at spawn and hold: the bubbles are world-fixed, so a true
    // billboard (normal aimed at the camera position) computed now stays correct
    // without a per-frame quat write.
    this.billboardOnce(transform)

    if (pop) this.popIn(transform)
  }

  // Picks a texture at random from the assigned array (null when none assigned).
  private textureForIndex(_index: number): Texture {
    if (!this.textures || this.textures.length === 0) return null
    const i = Math.floor(Math.random() * this.textures.length)
    return this.textures[Math.min(i, this.textures.length - 1)]
  }

  // Local scale for the unit quad so the LARGER dimension equals `size` and the
  // other follows the texture's aspect ratio. Square fallback when no texture.
  private quadScale(size: number, texture: Texture): vec3 {
    let w = 1
    let h = 1
    if (texture) {
      const tw = texture.getWidth()
      const th = texture.getHeight()
      if (tw > 0 && th > 0) {
        if (tw >= th) {
          w = 1
          h = th / tw
        } else {
          w = tw / th
          h = 1
        }
      }
    }
    return new vec3(size * w, size * h, 1)
  }

  // Aims the bubble's +Z NORMAL at the camera's POSITION (a TRUE billboard), once.
  // dir = camPos - bubblePos — NOT the camera's forward axis, which only faces the
  // viewer dead-ahead and looks wrong for bubbles off to the sides of the pipe.
  private billboardOnce(trans: Transform): void {
    if (!this.billboard) return
    const camT = this.cameraObject ? this.cameraObject.getTransform() : null
    if (!camT) return
    const dir = camT.getWorldPosition().sub(trans.getWorldPosition())
    if (dir.length > 1e-4) trans.setWorldRotation(quat.lookAt(dir.normalize(), vec3.up()))
  }

  // Pops a bubble open from near-zero to its full scale for a "spawn" feel on the
  // wavefront. The quad's size lives in its local scale, so this just animates it.
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

  private wavefrontSpeed(): number {
    if (this.wavefrontSpeedOverride > 0) return this.wavefrontSpeedOverride
    if (this.pingController && this.pingController.pingSpeed > 0) return this.pingController.pingSpeed
    return DEFAULT_WAVEFRONT_SPEED
  }

  private worldOrigin(): vec3 {
    return this.sceneObject.getTransform().getWorldPosition()
  }

  // The only per-frame work: hide bubbles outside the camera's view cone (and
  // re-show them when they come back). Nothing happens when culling is off or no
  // camera is assigned — the quads are otherwise static after spawn.
  private update(): void {
    if (this.bubbleVisuals.length === 0) return

    const camTransform = this.cameraObject ? this.cameraObject.getTransform() : null
    if (!camTransform && (this.billboard || this.fovCullEnabled) && !this.cameraMissingWarned) {
      // print() so this is visible even with general logging off — without a camera,
      // FOV culling and billboarding silently do nothing.
      print("[BubbleField] WARNING: no Camera Object assigned -> billboarding and FOV culling are DISABLED.")
      this.cameraMissingWarned = true
    }
    if (!this.fovCullEnabled || !camTransform) return

    // The camera LOOKS along -forward in this project (objects placed in front use
    // forward * negative), so the view direction is -forward.
    const camPos = camTransform.getWorldPosition()
    const viewDir = camTransform.forward.uniformScale(-1)
    const cosHalfAngle = Math.cos((Math.max(1, this.fovCullHalfAngleDeg) * Math.PI) / 180)

    for (let i = 0; i < this.bubbleVisuals.length; i++) {
      const visible = this.isInView(this.bubbleTransforms[i].getWorldPosition(), this.bubbleCullRadius[i], camPos, viewDir, cosHalfAngle)
      const rmv = this.bubbleVisuals[i]
      // Skip redundant writes so an already-correct visual never re-fires its
      // RenderMeshVisual lifecycle.
      if (rmv.enabled !== visible) rmv.enabled = visible
    }
  }

  // --- helpers ---------------------------------------------------------------

  /**
   * True when the bubble (a sphere of `cullRadius` at `pos`) is in front of the
   * camera and inside its view cone. A cone is used (rather than the exact
   * frustum) because it needs no projection matrix and a generous half-angle
   * keeps edge-of-screen bubbles updating; the only cost of a false positive is
   * keeping a just-off-screen bubble drawn, which is harmless.
   */
  private isInView(pos: vec3, cullRadius: number, camPos: vec3, viewDir: vec3, cosHalfAngle: number): boolean {
    const to = pos.sub(camPos)
    const along = to.dot(viewDir)
    // Behind the camera (beyond the bubble's own radius) -> not visible.
    if (along < -cullRadius) return false
    const dist = to.length
    // Very close (camera effectively inside the bubble) -> always show.
    if (dist <= cullRadius) return true
    // Expand the cone by the angular size of the bubble so its body counts, not
    // just its center point.
    const cosAngle = along / dist
    const angularMargin = cullRadius / dist
    return cosAngle >= cosHalfAngle - angularMargin
  }

  private randomCylinderPosition(): vec3 {
    // Scatter within a vertical "pipe": a ring in the XZ plane between the inner
    // and outer wall, at a random height between floor and ceiling.
    const inner = Math.max(0, Math.min(this.minDistance, this.maxDistance))
    const outer = Math.max(this.minDistance, this.maxDistance)
    const theta = Math.random() * Math.PI * 2
    // sqrt keeps the radial distribution area-uniform (no clumping near the inner wall).
    const t = Math.sqrt(Math.random())
    const r = inner + (outer - inner) * t
    const low = Math.min(this.floorHeight, this.ceilingHeight)
    const high = Math.max(this.floorHeight, this.ceilingHeight)
    const y = this.randBetween(low, high)
    return new vec3(r * Math.cos(theta), y, r * Math.sin(theta))
  }

  private randBetween(min: number, max: number): number {
    return min + Math.random() * (max - min)
  }
}
