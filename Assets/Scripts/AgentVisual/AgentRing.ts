/**
 * Specs Inc. 2026
 * AgentRing — the voice agent's animated circle.
 *
 * Stacks three Perlin-distorted SOLID discs (cyan, magenta, yellow) in ADDITIVE
 * blend, separated by a small Z gap. Where the three overlap they add to a white
 * circle; where their rims diverge, each layer's pure color is revealed.
 *
 * Reaction to the agent's voice (read from global.agentSphere.getAudioLevel()):
 *   - QUIET: all three share the same slowly-advancing noise time at a small
 *     distortion, so their rims match → a clean white circle that gently undulates.
 *   - LOUD : distortion and undulate speed rise, AND each layer's noise time
 *     drifts apart (divergence scales with amplitude), so the rims mismatch and
 *     the cyan/magenta/yellow fringes bloom out of the white core.
 *
 * A pair of white rectangle eyes sits in the hollow center (two 4-point quads,
 * each the bounding box of the eye size) with natural idle behavior: occasional
 * blinks (a quick vertical squash) and occasional darts (small shared offsets).
 *
 * Lightweight: per frame it advances one shared time, reads one envelope value,
 * and rebuilds three N-point rims (the allocation-free Bubbles hot path). The eye
 * meshes are static — only their transforms animate. No FFT.
 *
 * Placement: drop this on a child of the object AgentSphere moves (so it inherits
 * the agent's position) — it billboards itself to fully face the camera and
 * spawns its three disc layers (and the eyes) as children. The orb's own sphere
 * mesh, if any, can be hidden so only the ring shows.
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger";
import { AgentNoiseDisc } from "./AgentNoiseDisc";

// Per-layer noise-time seeds. Distinct so the layers diverge from EACH OTHER
// once amplitude scales the divergence in; all multiplied by divergence, so at
// amplitude 0 every layer collapses onto the same shared time (a white circle).
const LAYER_SEEDS = [0, 1, 2];

@component
export class AgentRing extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">AgentRing – the voice agent\'s animated circle</span><br/><span style="color: #94A3B8; font-size: 11px;">Three additive CMY noisy discs that read as a white circle when quiet and bloom into colored fringes with voice amplitude. Reads global.agentSphere.getAudioLevel().</span>')
  @ui.separator

  @ui.label('<span style="color: #60A5FA;">References</span>')
  @input
  @hint("Base material CLONED per layer (its baseColor/blend are overwritten — the asset is never mutated). Any unlit material works; an additive one is ideal.")
  @allowUndefined
  baseMaterial: Material

  @input
  @hint("Head camera object. Used to billboard the circle to fully face the viewer each frame. If unset, billboarding is disabled.")
  @allowUndefined
  cameraObj: SceneObject

  @input
  @hint("Self-billboard this ring each frame. Default OFF: the ring is normally a child of the object AgentSphere already billboards (yaw-only), so re-orienting here is redundant work. Turn on only if the ring is NOT parented under a billboarding AgentSphere.")
  selfBillboard: boolean = false

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Layer Colors (additive → white where they overlap)</span>')
  @input
  color0: vec4 = new vec4(0.0, 1.0, 1.0, 1.0) // cyan
  @input
  color1: vec4 = new vec4(1.0, 0.0, 1.0, 1.0) // magenta
  @input
  color2: vec4 = new vec4(1.0, 1.0, 0.0, 1.0) // yellow

  @input
  @hint("Brightness multiplier applied to all three layer colors (additive blend can clip; lower this if the white core blows out).")
  colorIntensity: number = 0.7

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Shape</span>')
  @input
  @hint("Ring outer radius in cm (local).")
  radius: number = 3

  @input
  @hint("Ring band thickness as a fraction of the radius (the inner rim sits at radius*(1-this)). Small = thin ring; 1 = solid disc. Matches BubbleMesh's Inner Fraction.")
  innerFraction: number = 0.12

  @input
  @hint("Rim points per ring. Higher = smoother circle, more CPU. 48–72 is a good range.")
  numPoints: number = 64

  @input
  @hint("Perlin sampling scale — higher = more, tighter wobbles around the rim.")
  noiseScale: number = 0.5

  @input
  @hint("Z gap (cm) between adjacent layers so the planes don't z-fight. Tiny is fine.")
  zGap: number = 0.05

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Amplitude Response</span>')
  @input
  @hint("Rim distortion when quiet (small = nearly a clean circle).")
  quietDistortion: number = 1.5

  @input
  @hint("Rim distortion at full amplitude (large = dramatic wobble).")
  loudDistortion: number = 7.0

  @input
  @hint("Undulate speed (noise time advanced per second) when quiet.")
  quietSpeed: number = 0.15

  @input
  @hint("Undulate speed at full amplitude.")
  loudSpeed: number = 1.2

  @input
  @hint("How far the three layers' noise times drift apart at full amplitude. 0 = always matched (always white); higher = more colored fringe when loud.")
  divergence: number = 1.6

  @input
  @hint("Shapes the amplitude→divergence curve. 1 = linear; >1 keeps the circle whiter until the agent gets loud, then blooms color.")
  divergenceExponent: number = 1.5

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Eyes</span>')
  @input
  @hint("Draw a pair of white dot eyes in the center of the ring.")
  showEyes: boolean = true

  @input
  @hint("Eye color (RGBA). White reads as classic dot eyes.")
  eyeColor: vec4 = new vec4(1.0, 1.0, 1.0, 1.0)

  @input
  @hint("Eye half-size in cm (the rect spans ±this in x/y; height is then scaled by the ratio below).")
  eyeSize: number = 0.4

  @input
  @hint("Eye height-to-width ratio. 1 = round dot; >1 = taller (oval); <1 = wider. Blinking scales the height further.")
  eyeAspect: number = 1.0

  @input
  @hint("Horizontal distance (cm) between the two eye centers.")
  eyeDistance: number = 1.6

  @input
  @hint("Vertical offset (cm) of the eyes from the ring center. Positive = higher.")
  eyeHeight: number = 0.4

  @input
  @hint("How far to pop the eyes toward the viewer (cm) off the ring plane, so they sit in front of the ring. Larger = more forward.")
  eyeForward: number = 0.5

  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Blink (quick vertical squash)</span>')
  @input
  @hint("Minimum seconds between blinks.")
  blinkIntervalMin: number = 2.5

  @input
  @hint("Maximum seconds between blinks.")
  blinkIntervalMax: number = 6.0

  @input
  @hint("How long a single blink takes (seconds). ~0.1–0.15 looks natural.")
  blinkDuration: number = 0.12

  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Dart (small saccade offsets)</span>')
  @input
  @hint("Minimum seconds between darts.")
  dartIntervalMin: number = 1.5

  @input
  @hint("Maximum seconds between darts.")
  dartIntervalMax: number = 4.5

  @input
  @hint("How long the eyes hold at a darted position before returning to center (seconds).")
  dartHold: number = 0.4

  @input
  @hint("Maximum dart offset in cm (kept small — these are subtle eye flicks).")
  dartAmount: number = 0.25

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Logging</span>')
  @input
  @hint("Enable general logging")
  enableLogging: boolean = false

  private logger: Logger
  private discs: AgentNoiseDisc[] = []
  private camTrans: Transform | null = null
  private selfTrans: Transform
  private sharedTime = 0
  // Round-robin cursor: only one disc's mesh is rebuilt per frame (see update()).
  private discCursor = 0

  // Eyes: static meshes; only their transforms animate.
  private eyeDiscs: AgentNoiseDisc[] = []
  private eyeTransforms: Transform[] = []
  // Blink: blinkStart < 0 means "open"; otherwise a blink is in progress.
  private nextBlinkAt = 0
  private blinkStart = -1
  // Dart: eyes flick to a small offset, hold, then return to center.
  private nextDartAt = 0
  private dartCentered = true
  private dartTargetX = 0
  private dartTargetY = 0
  private dartActualX = 0
  private dartActualY = 0
  // Last eye pose actually written; lets updateEyes skip its transform writes
  // when the eyes are at rest (open and centered, not blinking or darting).
  private lastEyeOpenness = -1
  private lastEyeDartX = NaN
  private lastEyeDartY = NaN

  onAwake(): void {
    this.logger = new Logger("AgentRing", this.enableLogging, true)
    this.selfTrans = this.sceneObject.getTransform()

    if (this.cameraObj) {
      this.camTrans = this.cameraObj.getTransform()
    } else {
      this.logger.warn("No cameraObj assigned — the circle won't billboard to face the viewer.")
    }

    // Build after start so the scene graph is settled (mirrors BubbleField).
    this.createEvent("OnStartEvent").bind(() => this.spawnLayers())
    this.createEvent("UpdateEvent").bind(() => this.update(getDeltaTime()))
  }

  private spawnLayers(): void {
    if (!this.baseMaterial) {
      this.logger.warn("No baseMaterial assigned — layers will build but not render.")
    }
    const colors = [this.color0, this.color1, this.color2]
    for (let i = 0; i < 3; i++) {
      const obj = global.scene.createSceneObject("AgentRingLayer_" + i)
      obj.setParent(this.sceneObject)
      // Inherit our render layer so the camera actually draws the runtime layers.
      obj.layer = this.sceneObject.layer
      obj.getTransform().setLocalPosition(new vec3(0, 0, 0))

      const disc = new AgentNoiseDisc(obj, {
        baseMaterial: this.baseMaterial,
        color: this.scaledColor(colors[i]),
        radius: this.radius,
        innerFraction: this.innerFraction,
        numPoints: this.numPoints,
        zOffset: (i - 1) * this.zGap, // -gap, 0, +gap
      })
      this.discs.push(disc)
    }

    // Render every layer once so all three are valid on the first frame (the
    // constructor leaves a collapsed placeholder mesh). update() then refreshes one
    // layer per frame round-robin, so without this the other two would flash
    // collapsed for a frame or two at spawn. At amplitude 0 divergence is 0, so all
    // layers share time 0 and the quiet distortion — exactly the resting look.
    for (let i = 0; i < this.discs.length; i++) {
      this.discs[i].render(0, this.quietDistortion, this.noiseScale)
    }

    if (this.showEyes) this.spawnEyes()
    this.logger.info("Spawned 3 ring layers" + (this.showEyes ? " + eyes." : "."))
  }

  private spawnEyes(): void {
    // Two solid white RECTANGLES (4-point quads), each the bounding box of the
    // eye half-size. Built ONCE as a static mesh; only the transform animates
    // afterward (aspect, blink squash, dart offset).
    const z = this.eyeForward // pop toward the viewer (+local Z faces the camera)
    for (let i = 0; i < 2; i++) {
      const obj = global.scene.createSceneObject("AgentEye_" + i)
      obj.setParent(this.sceneObject)
      obj.layer = this.sceneObject.layer

      const disc = new AgentNoiseDisc(obj, {
        baseMaterial: this.baseMaterial,
        color: this.eyeColor,
        radius: this.eyeSize,
        innerFraction: 1, // solid (center fan)
        numPoints: 4, // a rectangle: the 4 bounding-box corners
      })
      disc.renderBoundingRect() // static axis-aligned rect, built once
      this.eyeDiscs.push(disc)

      const t = obj.getTransform()
      const halfD = this.eyeDistance * 0.5
      t.setLocalPosition(new vec3(i === 0 ? -halfD : halfD, this.eyeHeight, z))
      this.eyeTransforms.push(t)
    }

    const now = getTime()
    this.nextBlinkAt = now + this.randBetween(this.blinkIntervalMin, this.blinkIntervalMax)
    this.nextDartAt = now + this.randBetween(this.dartIntervalMin, this.dartIntervalMax)
  }

  private update(dt: number): void {
    if (this.discs.length === 0) return

    // Read the smoothed loudness the voice scripts feed AgentSphere.
    const amp = this.clamp01((global as any).agentSphere?.getAudioLevel?.() ?? 0)

    // Speed and distortion both rise with loudness; the shared time advance keeps
    // the layers' base animation in sync (they only split via divergence below).
    const speed = this.lerp(this.quietSpeed, this.loudSpeed, amp)
    this.sharedTime += speed * dt
    const distortion = this.lerp(this.quietDistortion, this.loudDistortion, amp)

    // Divergence: 0 when quiet (layers identical → white), growing with amplitude
    // (shaped by the exponent) so the per-layer seeds pull their noise times apart.
    const div = Math.pow(amp, Math.max(0.01, this.divergenceExponent)) * this.divergence

    // Round-robin: rebuild ONE disc's mesh per frame instead of all three. Each
    // disc then refreshes at ~20 Hz (60/3), imperceptible for the slow Perlin
    // undulation, and the loudness-driven color bloom still reads within 3 frames
    // since each disc samples the live sharedTime/distortion/divergence on its turn.
    if (this.discs.length > 0) {
      const i = this.discCursor % this.discs.length
      const layerTime = this.sharedTime + LAYER_SEEDS[i] * div
      this.discs[i].render(layerTime, distortion, this.noiseScale)
      this.discCursor++
    }

    this.updateEyes(dt)

    // Billboard the whole ring (children inherit) so its +Z NORMAL points AT the
    // camera. Default OFF: the ring usually rides an AgentSphere that already
    // billboards, so this is redundant per-frame work (see selfBillboard).
    // NOTE: a true billboard aims at the camera's POSITION (dir = camPos - ringPos),
    // not at the camera's forward axis — the latter only faces the viewer on the
    // view axis and looks wrong off-centre (e.g. the home corner of the FOV).
    if (this.selfBillboard && this.camTrans) {
      const dir = this.camTrans.getWorldPosition().sub(this.selfTrans.getWorldPosition())
      if (dir.length > 1e-4) {
        this.selfTrans.setWorldRotation(quat.lookAt(dir.normalize(), vec3.up()))
      }
    }
  }

  // Drives the two idle eye behaviors: occasional blinks (a quick vertical
  // squash via local scale.y) and occasional darts (a small shared position
  // offset both eyes share, eased quickly like a real saccade then returned).
  private updateEyes(dt: number): void {
    if (this.eyeTransforms.length < 2) return
    const now = getTime()

    // Blink: openness eases 1 → 0 → 1 over blinkDuration, then waits a random gap.
    let openness = 1
    if (this.blinkStart >= 0) {
      const t = (now - this.blinkStart) / Math.max(0.01, this.blinkDuration)
      if (t >= 1) {
        this.blinkStart = -1
      } else {
        openness = 1 - Math.sin(Math.PI * t) // smooth close-then-open
      }
    } else if (now >= this.nextBlinkAt) {
      this.blinkStart = now
      this.nextBlinkAt =
        now + this.blinkDuration + this.randBetween(this.blinkIntervalMin, this.blinkIntervalMax)
    }
    openness = Math.max(0, openness)

    // Dart: flick to a small random offset, hold, then snap back to center.
    if (now >= this.nextDartAt) {
      if (this.dartCentered) {
        const ang = Math.random() * Math.PI * 2
        const r = (0.4 + Math.random() * 0.6) * this.dartAmount
        this.dartTargetX = Math.cos(ang) * r
        this.dartTargetY = Math.sin(ang) * r * 0.6 // eyes dart mostly sideways
        this.dartCentered = false
        this.nextDartAt = now + Math.max(0.05, this.dartHold)
      } else {
        this.dartTargetX = 0
        this.dartTargetY = 0
        this.dartCentered = true
        this.nextDartAt = now + this.randBetween(this.dartIntervalMin, this.dartIntervalMax)
      }
    }
    // Saccades are quick — ease fast toward the target.
    const k = Math.min(1, 25 * dt)
    this.dartActualX += (this.dartTargetX - this.dartActualX) * k
    this.dartActualY += (this.dartTargetY - this.dartActualY) * k

    // Skip the transform writes entirely when the eyes are at rest (open, centered,
    // and no longer easing). Once a blink ends and the dart settles, openness and
    // dartActual stop changing, so the two setLocal* calls per eye are elided until
    // the next blink/dart kicks in.
    const dartMoved =
      Math.abs(this.dartActualX - this.lastEyeDartX) > 1e-4 ||
      Math.abs(this.dartActualY - this.lastEyeDartY) > 1e-4
    const blinkMoved = Math.abs(openness - this.lastEyeOpenness) > 1e-4
    if (!dartMoved && !blinkMoved) return
    this.lastEyeDartX = this.dartActualX
    this.lastEyeDartY = this.dartActualY
    this.lastEyeOpenness = openness

    const halfD = this.eyeDistance * 0.5
    const z = this.eyeForward
    for (let i = 0; i < 2; i++) {
      const baseX = i === 0 ? -halfD : halfD
      this.eyeTransforms[i].setLocalPosition(
        new vec3(baseX + this.dartActualX, this.eyeHeight + this.dartActualY, z)
      )
      // Width stays 1; height = aspect ratio, squashed further by the blink.
      this.eyeTransforms[i].setLocalScale(new vec3(1, this.eyeAspect * openness, 1))
    }
  }

  // --- helpers ---------------------------------------------------------------

  private scaledColor(c: vec4): vec4 {
    const k = Math.max(0, this.colorIntensity)
    return new vec4(c.r * k, c.g * k, c.b * k, c.a)
  }

  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t
  }

  private clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v
  }

  private randBetween(min: number, max: number): number {
    return min + Math.random() * Math.max(0, max - min)
  }
}
