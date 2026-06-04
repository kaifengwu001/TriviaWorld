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
import { BubbleMesh } from "./BubbleMesh";

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
  @ui.label('<span style="color: #60A5FA;">Spawning</span>')
  @input
  @hint("Number of bubbles to spawn")
  bubbleCount: number = 12

  @input
  @hint("Half-extents (cm) of the local XY area bubbles are scattered within")
  spawnExtents: vec2 = new vec2(30, 30)

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
  @hint("Outline points per bubble (smoothness vs. cost)")
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
  @ui.label('<span style="color: #60A5FA;">Logging</span>')
  @input
  @hint("Enable general logging")
  enableLogging: boolean = false

  @input
  @hint("Enable lifecycle logging (onAwake, onStart, onUpdate, onDestroy)")
  enableLoggingLifecycle: boolean = false

  private logger: Logger
  private bubbles: BubbleMesh[] = []
  private elapsed: number = 0

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
    this.spawnBubbles()
    this.logger.info("Spawned " + this.bubbles.length + " bubbles.")
  }

  private spawnBubbles(): void {
    const count = Math.max(0, Math.floor(this.bubbleCount))
    for (let i = 0; i < count; i++) {
      const obj = global.scene.createSceneObject("Bubble_" + i)
      obj.setParent(this.sceneObject)
      // Inherit the field's render layer so the camera actually draws the
      // runtime-created bubbles (otherwise they may land on an unrendered layer).
      obj.layer = this.sceneObject.layer
      obj.getTransform().setLocalPosition(this.randomLocalPosition())

      const bubble = obj.createComponent(BubbleMesh.getTypeName()) as unknown as BubbleMesh
      bubble.configure({
        baseMaterial: this.baseMaterial,
        color: this.colorForIndex(i),
        radius: this.randBetween(this.radiusMin, this.radiusMax),
        targetWidth: this.randBetween(this.targetWidthMin, this.targetWidthMax),
        targetHeight: this.randBetween(this.targetHeightMin, this.targetHeightMax),
        targetCornerRadius: this.targetCornerRadius,
        noiseScale: this.noiseScale,
        distortion: this.distortion,
        numPoints: this.numPoints,
        undulateSpeed: this.undulateSpeed,
        progress: this.globalProgress,
      })
      this.bubbles.push(bubble)
    }
  }

  private update(dt: number): void {
    if (this.bubbles.length === 0) return

    this.elapsed += dt
    let progress = Math.max(0, Math.min(1, this.globalProgress))
    if (this.autoAnimate) {
      // Smooth 0 <-> 1 oscillation.
      progress = 0.5 - 0.5 * Math.cos(this.elapsed * this.animateSpeed)
    }

    for (let i = 0; i < this.bubbles.length; i++) {
      this.bubbles[i].setProgress(progress)
    }
  }

  // --- helpers ---------------------------------------------------------------

  private randomLocalPosition(): vec3 {
    const x = this.randBetween(-this.spawnExtents.x, this.spawnExtents.x)
    const y = this.randBetween(-this.spawnExtents.y, this.spawnExtents.y)
    return new vec3(x, y, 0)
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
