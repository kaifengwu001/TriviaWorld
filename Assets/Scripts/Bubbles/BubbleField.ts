/**
 * Specs Inc. 2026
 * Bubble Field spawner for the Bubble Morph Mesh system.
 *
 * Spawns a field of BubbleMesh bubbles at runtime, each with its own color,
 * size and target rounded-rectangle, then drives their shared morph progress.
 * This is the test/demo harness for the rendering + morph pass (no activation,
 * push, or indicator logic yet).
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger";
import animate, { CancelSet } from "SpectaclesInteractionKit.lspkg/Utils/animate";
import { BubbleMesh } from "./BubbleMesh";
import { PingController } from "../PingController";

// Scale a wavefront-spawned bubble pops in from (a hair above zero).
const POP_START_SCALE = 0.02;
// Fallback wavefront speed (cm/s) when no PingController is linked and no
// override is set. Matches PingController.pingSpeed's default.
const DEFAULT_WAVEFRONT_SPEED = 250;

@component
export class BubbleField extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">BubbleField – spawns and drives a field of morphing bubbles</span><br/><span style="color: #94A3B8; font-size: 11px;">Creates N BubbleMesh children with assorted colors/sizes and animates the blob &lt;-&gt; rounded-rect morph for testing.</span>')
  @ui.separator

  @ui.label('<span style="color: #60A5FA;">Material & Colors</span>')
  @input
  @hint("Base material cloned onto every bubble. Use an unlit, two-sided material.")
  @allowUndefined
  baseMaterial: Material

  @input
  @hint("Color palette (RGBA). Bubbles cycle through these; if empty, random colors are used.")
  palette: vec4[] = []

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

  @input
  @hint("Minimum blob radius (cm)")
  radiusMin: number = 3

  @input
  @hint("Maximum blob radius (cm)")
  radiusMax: number = 6

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Target Rounded Rectangles</span>')
  @input
  @hint("Minimum target rectangle width (cm)")
  targetWidthMin: number = 8

  @input
  @hint("Maximum target rectangle width (cm)")
  targetWidthMax: number = 16

  @input
  @hint("Minimum target rectangle height (cm)")
  targetHeightMin: number = 6

  @input
  @hint("Maximum target rectangle height (cm)")
  targetHeightMax: number = 10

  @input
  @hint("Fixed corner radius (cm), kept constant regardless of size/aspect")
  targetCornerRadius: number = 2

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Shape Detail</span>')
  @input
  @hint("Points per RIM (the ring mesh uses 2x for outer + inner). On the rounded rect every point goes to the corners (none on the straight edges), so each corner gets ~numPoints/4 points. Raise for denser corners.")
  numPoints: number = 64

  @input
  @hint("Perlin sampling scale for the blob rim")
  noiseScale: number = 0.48

  @input
  @hint("Blob rim distortion amount")
  distortion: number = 4.0

  @input
  @hint("Wobble animation speed")
  undulateSpeed: number = 0.15

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Ring</span>')
  @input
  @hint("BLOB ring thickness as a fraction of the radius (the prototype's SUB_FRACTION). Varies per bubble with the radius. Small = thin rim ring; 1 = solid disc.")
  innerFraction: number = 0.1

  @input
  @hint("RECT ring thickness in cm. Uniform across every bubble, so all morphed rounded rects share the same line width regardless of bubble size.")
  rectLineWidth: number = 0.4

  @input
  @hint("Opacity multiplier for the ring fill (needs a translucent material to show). Matches the prototype's 0.9 fill opacity.")
  fillOpacity: number = 0.9

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Morph Control (debug)</span>')
  @input
  @hint("Morph amount applied to all bubbles when Auto Animate is off (0 = blob, 1 = rounded rect)")
  globalProgress: number = 0

  @input
  @hint("Continuously oscillate the morph 0 <-> 1 for testing")
  autoAnimate: boolean = true

  @input
  @hint("Oscillation speed (radians per second) when Auto Animate is on")
  animateSpeed: number = 1.0

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Camera & Performance</span>')
  @input
  @hint("The player camera object. Used to billboard bubbles toward the viewer and to cull off-screen updates. If unset, billboarding and FOV culling are disabled.")
  @allowUndefined
  cameraObject: SceneObject

  @input
  @hint("Rotate every visible bubble to face the camera each frame (screen-aligned billboard).")
  billboard: boolean = true

  @input
  @hint("Skip per-frame mesh updates for bubbles outside the camera's field of view (they freeze until they come back into view).")
  fovCullEnabled: boolean = true

  @input
  @hint("Half-angle (degrees) of the view cone used for FOV culling. Generous values avoid culling bubbles near the screen edges; lower to cull more aggressively.")
  fovCullHalfAngleDeg: number = 70

  @input
  @hint("Update only half the bubbles each frame (alternating halves), halving per-frame mesh compute. Wobble stays smooth because the skipped frame's time is folded into the next update.")
  halfRateUpdate: boolean = true

  @input
  @hint("Write a once-per-second report (bubble count, advances/frame, culled/frame, and time spent in the update loop) so you can verify FOV culling and half-rate updates are actually reducing work.")
  logPerfStats: boolean = false

  @input
  @hint("Text component the perf report is written to. If unset, the report falls back to the console.")
  @allowUndefined
  perfStatsText: Text

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Logging</span>')
  @input
  @hint("Enable general logging")
  enableLogging: boolean = false

  @input
  @hint("Enable lifecycle logging (onAwake, onStart, onUpdate, onDestroy)")
  enableLoggingLifecycle: boolean = false

  private logger: Logger
  private bubbles: BubbleMesh[] = []
  // Parallel arrays kept in lockstep with `bubbles` so the hot loop avoids repeated
  // getTransform()/getComponent() calls.
  private bubbleTransforms: Transform[] = []
  // Conservative billboard-facing radius (cm) per bubble for the FOV cone test, so
  // a bubble whose center is just off-screen but whose body is visible isn't culled.
  private bubbleCullRadius: number[] = []
  private elapsed: number = 0
  // Wavefront-spawn bookkeeping: whether a wave has fired and the running index so
  // each bubble keeps a stable parity slot even though they spawn at different times.
  private waveSpawned: boolean = false
  private nextBubbleIndex: number = 0
  private popCancels: CancelSet[] = []
  // Which half updates this frame (toggles 0/1). Wall-time accrues into both
  // accumulators every frame and is reset for whichever half just advanced, so a
  // half-rated (or briefly culled) bubble always advances by the real elapsed time.
  private parity: number = 0
  private groupDtAccum: number[] = [0, 0]
  private cameraMissingWarned: boolean = false
  // Rolling per-second profiler (only active when logPerfStats is on).
  private perfWindow: number = 0
  private perfFrames: number = 0
  private perfLoopMsSum: number = 0
  private perfAdvancedSum: number = 0
  private perfCulledSum: number = 0

  onAwake() {
    this.logger = new Logger("BubbleField", this.enableLogging || this.enableLoggingLifecycle, true)
    if (this.enableLoggingLifecycle) this.logger.debug("LIFECYCLE: onAwake()")

    this.createEvent("OnStartEvent").bind(() => this.onStart())
    this.createEvent("UpdateEvent").bind(() => this.update(getDeltaTime()))
  }

  private onStart(): void {
    if (!this.baseMaterial) {
      this.logger.warn("No baseMaterial assigned; bubbles will spawn but not render.")
    }
    if (this.spawnOnWavefront) {
      // Hold off: bubbles pop in when spawnWave(origin) is called (e.g. forwarded
      // by PingCardSpawner on the prayer ping).
      this.logger.info("Wavefront mode: waiting for spawnWave() before spawning bubbles.")
      return
    }
    this.spawnAllNow()
    this.logger.info("Spawned " + this.bubbles.length + " bubbles.")
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
    for (const c of this.popCancels) c.cancel()
    this.popCancels = []
    for (const t of this.bubbleTransforms) {
      const obj = t ? t.getSceneObject() : null
      if (obj) obj.destroy()
    }
    this.bubbles = []
    this.bubbleTransforms = []
    this.bubbleCullRadius = []
    this.nextBubbleIndex = 0
    this.waveSpawned = false
  }

  // --- internal --------------------------------------------------------------

  // Legacy path: every bubble exists from the very start, all running all the time.
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
  }

  // Instantiates one bubble at `localPos`, configures its mesh, and registers it
  // in the parallel hot-loop arrays. When `pop` is set it animates a scale pop-in.
  private createBubble(localPos: vec3, pop: boolean = false): BubbleMesh {
    const index = this.nextBubbleIndex++
    const obj = global.scene.createSceneObject("Bubble_" + index)
    obj.setParent(this.sceneObject)
    // Inherit the field's render layer so the camera actually draws the
    // runtime-created bubbles (otherwise they may land on an unrendered layer).
    obj.layer = this.sceneObject.layer
    const transform = obj.getTransform()
    transform.setLocalPosition(localPos)

    const radius = this.randBetween(this.radiusMin, this.radiusMax)
    const targetWidth = this.randBetween(this.targetWidthMin, this.targetWidthMax)
    const targetHeight = this.randBetween(this.targetHeightMin, this.targetHeightMax)

    const bubble = obj.createComponent(BubbleMesh.getTypeName()) as unknown as BubbleMesh
    bubble.configure({
      baseMaterial: this.baseMaterial,
      color: this.colorForIndex(index),
      radius: radius,
      targetWidth: targetWidth,
      targetHeight: targetHeight,
      targetCornerRadius: this.targetCornerRadius,
      noiseScale: this.noiseScale,
      distortion: this.distortion,
      numPoints: this.numPoints,
      undulateSpeed: this.undulateSpeed,
      progress: this.globalProgress,
      innerFraction: this.innerFraction,
      rectLineWidth: this.rectLineWidth,
      fillOpacity: this.fillOpacity,
    })
    this.bubbles.push(bubble)
    this.bubbleTransforms.push(transform)
    // Largest shape the bubble ever occupies, used as the cone-test margin.
    this.bubbleCullRadius.push(Math.max(radius, targetWidth * 0.5, targetHeight * 0.5))

    if (pop) this.popIn(transform)
    return bubble
  }

  // Pops a bubble open from near-zero to its full scale for a "spawn" feel on the
  // wavefront. The mesh size comes from the radius, so this just scales the root.
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

  private update(dt: number): void {
    if (this.bubbles.length === 0) return

    this.elapsed += dt
    let progress = Math.max(0, Math.min(1, this.globalProgress))
    if (this.autoAnimate) {
      // Smooth 0 <-> 1 oscillation.
      progress = 0.5 - 0.5 * Math.cos(this.elapsed * this.animateSpeed)
    }

    // Accrue this frame's time into both halves, then claim it for whichever half
    // advances now. This keeps each bubble's wobble in real time regardless of the
    // half-rate throttle or frames spent culled.
    this.groupDtAccum[0] += dt
    this.groupDtAccum[1] += dt
    this.parity = 1 - this.parity
    const activeDt = this.groupDtAccum[this.parity]
    this.groupDtAccum[this.parity] = 0

    const loopStart = this.logPerfStats ? getTime() : 0
    let advancedCount = 0
    let culledCount = 0

    // Camera-derived billboard rotation + cull frame, computed once for all bubbles.
    const camTransform = this.cameraObject ? this.cameraObject.getTransform() : null
    if (!camTransform && (this.billboard || this.fovCullEnabled) && !this.cameraMissingWarned) {
      // print() so this is visible even with general logging off — without a camera,
      // FOV culling and billboarding silently do nothing.
      print("[BubbleField] WARNING: no Camera Object assigned -> billboarding and FOV culling are DISABLED.")
      this.cameraMissingWarned = true
    }
    // Match the project convention (see PictureBehavior): a bubble faces the viewer
    // when its +Z aligns with the camera transform's forward.
    const billboardRot = camTransform ? quat.lookAt(camTransform.forward, vec3.up()) : null
    // The camera LOOKS along -forward in this project (objects placed in front use
    // forward * negative), so the view direction is -forward.
    const camPos = camTransform ? camTransform.getWorldPosition() : null
    const viewDir = camTransform ? camTransform.forward.uniformScale(-1) : null
    const cullActive = this.fovCullEnabled && camPos !== null
    const cosHalfAngle = Math.cos((Math.max(1, this.fovCullHalfAngleDeg) * Math.PI) / 180)

    for (let i = 0; i < this.bubbles.length; i++) {
      const bubble = this.bubbles[i]
      // Always keep the morph target current; advancing the mesh to reflect it is
      // what we throttle/cull below.
      bubble.setProgress(progress)

      if (cullActive && !this.isInView(this.bubbleTransforms[i].getWorldPosition(), this.bubbleCullRadius[i], camPos, viewDir, cosHalfAngle)) {
        culledCount++
        continue
      }

      if (this.billboard && billboardRot) {
        this.bubbleTransforms[i].setWorldRotation(billboardRot)
      }

      // Alternate-frame throttle: update only this frame's half (matched by index
      // parity). Skipped bubbles catch up via the accumulated dt next time.
      if (this.halfRateUpdate) {
        if ((i & 1) === this.parity) {
          bubble.advance(activeDt)
          advancedCount++
        }
      } else {
        bubble.advance(dt)
        advancedCount++
      }
    }

    if (this.logPerfStats) {
      this.reportPerf(dt, (getTime() - loopStart) * 1000, advancedCount, culledCount)
    }
  }

  // Accumulates per-frame stats and prints a compact report once per second so
  // toggling Half Rate Update / FOV Cull shows a measurable change in
  // advances-per-frame and loop time. `advanced` = bubbles whose mesh was rebuilt
  // this frame; `culled` = bubbles skipped by the FOV cone test.
  private reportPerf(dt: number, loopMs: number, advanced: number, culled: number): void {
    this.perfWindow += dt
    this.perfFrames++
    this.perfLoopMsSum += loopMs
    this.perfAdvancedSum += advanced
    this.perfCulledSum += culled
    if (this.perfWindow < 1 || this.perfFrames === 0) return

    const f = this.perfFrames
    const avgMs = (this.perfLoopMsSum / f).toFixed(3)
    const avgAdvanced = (this.perfAdvancedSum / f).toFixed(1)
    const avgCulled = (this.perfCulledSum / f).toFixed(1)
    const fovOn = this.fovCullEnabled && this.cameraObject != null
    const billboardOn = this.billboard && this.cameraObject != null
    const report =
      "Bubbles: " + this.bubbles.length + "\n" +
      "Advanced/frame: " + avgAdvanced + "\n" +
      "Culled/frame: " + avgCulled + "\n" +
      "Loop time: " + avgMs + " ms\n" +
      "Half-rate: " + (this.halfRateUpdate ? "on" : "off") + "\n" +
      "FOV cull: " + (fovOn ? "on" : "off") + "\n" +
      "Billboard: " + (billboardOn ? "on" : "off")

    if (this.perfStatsText) {
      this.perfStatsText.text = report
    } else {
      // No Text assigned: keep the data visible somewhere.
      print("[BubbleField] " + report.split("\n").join("  "))
    }

    this.perfWindow = 0
    this.perfFrames = 0
    this.perfLoopMsSum = 0
    this.perfAdvancedSum = 0
    this.perfCulledSum = 0
  }

  // --- helpers ---------------------------------------------------------------

  /**
   * True when the bubble (a sphere of `cullRadius` at `pos`) is in front of the
   * camera and inside its view cone. A cone is used (rather than the exact
   * frustum) because it needs no projection matrix and a generous half-angle
   * keeps edge-of-screen bubbles updating; the only cost of a false positive is
   * updating a just-off-screen bubble, which is harmless.
   */
  private isInView(pos: vec3, cullRadius: number, camPos: vec3, viewDir: vec3, cosHalfAngle: number): boolean {
    const to = pos.sub(camPos)
    const along = to.dot(viewDir)
    // Behind the camera (beyond the bubble's own radius) -> not visible.
    if (along < -cullRadius) return false
    const dist = to.length
    // Very close (camera effectively inside the bubble) -> always update.
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

  private colorForIndex(i: number): vec4 {
    if (this.palette && this.palette.length > 0) {
      return this.palette[i % this.palette.length]
    }
    // No palette: pick a bright random hue-ish color.
    return new vec4(
      0.3 + Math.random() * 0.7,
      0.3 + Math.random() * 0.7,
      0.3 + Math.random() * 0.7,
      1.0
    )
  }

  private randBetween(min: number, max: number): number {
    return min + Math.random() * (max - min)
  }
}
