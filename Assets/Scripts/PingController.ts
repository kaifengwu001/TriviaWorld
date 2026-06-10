/**
 * Specs Inc. 2026
 * Ping Controller for the Crop Spectacles lens.
 *
 * Drives a Death Stranding-style expanding "ping" scan. Each emitted ping is a
 * spherical shell whose radius grows over time; a custom graph shader on the
 * World Mesh (and on a ground-plane fallback) lights up a thin band wherever a
 * fragment's world-space distance from the ping origin matches the current
 * radius, so the wavefront drapes over (and passes through) real geometry.
 *
 * The shader (a Code Node material) is expected to expose these parameters:
 *   pingData      : Float Array Object Parameter, Channels = xyzw (vec4), size MAX_PINGS.
 *                   Element i = vec4(originX, originY, originZ, radius). A negative
 *                   radius marks an inactive slot (shader skips it).
 *   pingBrightness: Float Array Object Parameter, Channels = xyzw (vec4), size MAX_PINGS
 *                   (same layout as pingData for reliable per-element assignment).
 *                   Element i = vec4(brightness, 0, 0, 0); the shader reads .x as the
 *                   per-shell intensity multiplier (followup shells in a burst dimmer).
 *   bandThickness : Float Parameter (cm) — sharpness of the leading (outer) edge.
 *                   Small = crisp wavefront.
 *   trailLength   : Float Parameter (cm) — how far the glow trails behind the
 *                   wavefront on the inner side. Large = long comet tail.
 *   trailFalloff  : Float Parameter — tail shaping power. >1 concentrates the
 *                   brightness near the front and fades the tail out smoothly.
 *   maxRadius     : Float Parameter (cm) — shader uses it to fade each shell out
 *   pingColor     : Color Parameter (vec4)
 *
 * With xyzw channels, the Code Node's pingData.sample(i) returns a vec4 element,
 * so each ping is one element set via mainPass["pingData[i]"] = vec4(...).
 *
 * World units in Lens Studio are centimeters, so all distances here are cm.
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger";
import { bindUpdateEvent } from "SnapDecorators.lspkg/decorators";

const MAX_PINGS = 6;
// Radius value used to mark an inactive ping slot; the shader skips negatives.
const INACTIVE_RADIUS = -1;

// A single active shell. New objects are created on emit/expire rather than
// mutating existing ones, to honor the project's immutability convention.
type Ping = {
  startTime: number;
  origin: vec3;
  active: boolean;
  // Per-shell intensity multiplier. Followup shells in a burst are dimmer.
  brightness: number;
};

@component
export class PingController extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">PingController – drives the expanding world-scan ping shells</span><br/><span style="color: #94A3B8; font-size: 11px;">Clones the ping material onto the target visuals and animates per-ping radius/alpha uniforms each frame. Call emitBurst(origin) to fire a series of shells.</span>')
  @ui.separator

  @ui.label('<span style="color: #60A5FA;">References</span>')
  @input
  @hint("Ping scan graph material. Cloned at runtime and assigned to every target visual so the asset itself is never mutated.")
  pingMaterial: Material

  @input
  @hint("Render visuals that should display the ping effect (e.g. the World Mesh visual and the ground-plane fallback quad).")
  targetVisuals: RenderMeshVisual[]

  @input
  @hint("Scene object whose world position is the default ping origin (player head / camera). Used by the editor tap test.")
  @allowUndefined
  headObject: SceneObject

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Tuning</span>')
  @input
  @hint("Expansion speed of each shell, in cm per second")
  pingSpeed: number = 250

  @input
  @hint("Radius (cm) at which a ping has fully faded out and is recycled")
  maxRadius: number = 450

  @input
  @hint("Sharpness of the leading (outer) edge (cm). Small = crisp wavefront.")
  bandThickness: number = 12

  @input
  @hint("How far the glow trails behind the wavefront on the inner side (cm). Large = long comet tail.")
  trailLength: number = 90

  @input
  @hint("Tail shaping power. >1 concentrates brightness near the front and fades the tail out smoothly.")
  trailFalloff: number = 2.0

  @input
  @hint("Number of shells emitted per emitBurst() call")
  burstCount: number = 3

  @input
  @hint("Seconds between successive shells within a burst")
  burstIntervalSec: number = 0.15

  @input
  @hint("Brightness multiplier applied to each successive shell in a burst (0.5 = each followup is half as bright as the previous).")
  burstBrightnessFalloff: number = 0.5

  @input
  @hint("Color of the ping band (RGB), alpha scales overall intensity")
  pingColor: vec4 = new vec4(0.3, 0.8, 1.0, 1.0)

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Debug</span>')
  @input
  @hint("Force one always-on ring at debugRadius (ignores triggers/timer) to verify the shader + material wiring")
  debugStaticRing: boolean = false

  @input
  @hint("Radius (cm) of the forced debug ring")
  debugRadius: number = 150

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Logging</span>')
  @input
  @hint("Enable general logging")
  enableLogging: boolean = false;

  @input
  @hint("Enable lifecycle logging (onAwake, onStart, onUpdate, onDestroy)")
  enableLoggingLifecycle: boolean = false;

  private logger: Logger;

  private isEditor = global.deviceInfoSystem.isEditor()
  private material: Material = null
  private pings: Ping[] = []
  private nextSlot: number = 0

  onAwake() {
    this.logger = new Logger("PingController", this.enableLogging || this.enableLoggingLifecycle, true);
    if (this.enableLoggingLifecycle) this.logger.debug("LIFECYCLE: onAwake()");

    this.initPings()
    this.initMaterial()

    if (this.isEditor) {
      // No prayer hand-tracking in the editor: tap anywhere to fire a burst.
      this.createEvent("TouchStartEvent").bind(this.editorTest.bind(this))
    }
  }

  // Public API ---------------------------------------------------------------

  // Fires a configurable series of shells from a single origin. The first shell
  // goes out immediately; the rest are staggered by burstIntervalSec so the
  // effect reads as a sequence of radiating pings.
  emitBurst(origin: vec3): void {
    if (!origin) {
      this.logger.warn("emitBurst called with no origin")
      return
    }
    const count = Math.max(1, Math.floor(this.burstCount))
    for (let i = 0; i < count; i++) {
      const delay = i * this.burstIntervalSec
      // Each followup shell is dimmer than the one before it.
      const brightness = Math.pow(this.burstBrightnessFalloff, i)
      // Copy the origin so later external mutation can't change a queued ping.
      const frozenOrigin = new vec3(origin.x, origin.y, origin.z)
      if (delay <= 0) {
        this.emitPing(frozenOrigin, brightness)
      } else {
        const delayed = this.createEvent("DelayedCallbackEvent")
        delayed.bind(() => this.emitPing(frozenOrigin, brightness))
        delayed.reset(delay)
      }
    }
  }

  // Starts a single shell at the given origin, recycling the oldest slot.
  emitPing(origin: vec3, brightness: number = 1): void {
    if (!origin) {
      return
    }
    this.pings[this.nextSlot] = {
      startTime: getTime(),
      origin: new vec3(origin.x, origin.y, origin.z),
      active: true,
      brightness: brightness
    }
    this.nextSlot = (this.nextSlot + 1) % MAX_PINGS
  }

  // Internal -----------------------------------------------------------------

  private initPings(): void {
    const initial: Ping[] = []
    for (let i = 0; i < MAX_PINGS; i++) {
      initial.push({ startTime: 0, origin: vec3.zero(), active: false, brightness: 0 })
    }
    this.pings = initial
  }

  private initMaterial(): void {
    if (!this.pingMaterial) {
      this.logger.warn("No ping material assigned; ping effect will not render.")
      return
    }
    // Clone so we never mutate the shared asset (other lenses/visuals may use it).
    this.material = this.pingMaterial.clone()
    const pass = this.material.mainPass as any
    pass.bandThickness = this.bandThickness
    pass.trailLength = this.trailLength
    pass.trailFalloff = this.trailFalloff
    pass.maxRadius = this.maxRadius
    pass.pingColor = this.pingColor

    if (!this.targetVisuals || this.targetVisuals.length < 1) {
      this.logger.warn("No target visuals assigned; nothing will display the ping material.")
      return
    }
    for (let i = 0; i < this.targetVisuals.length; i++) {
      const visual = this.targetVisuals[i]
      if (visual) {
        visual.mainMaterial = this.material
      }
    }
  }

  private editorTest(): void {
    const origin = this.headObject
      ? this.headObject.getTransform().getWorldPosition()
      : vec3.zero()
    this.logger.info("Editor test: emitting ping burst")
    this.emitBurst(origin)
  }

  @bindUpdateEvent
  update(): void {
    if (!this.material) {
      return
    }
    const pass = this.material.mainPass as any

    if (this.debugStaticRing) {
      const origin = this.headObject
        ? this.headObject.getTransform().getWorldPosition()
        : vec3.zero()
      pass["pingData[0]"] = new vec4(origin.x, origin.y, origin.z, this.debugRadius)
      pass["pingBrightness[0]"] = new vec4(1, 0, 0, 0)
      for (let i = 1; i < MAX_PINGS; i++) {
        pass["pingData[" + i + "]"] = new vec4(0, 0, 0, INACTIVE_RADIUS)
        pass["pingBrightness[" + i + "]"] = new vec4(0, 0, 0, 0)
      }
      return
    }

    const now = getTime()

    for (let i = 0; i < MAX_PINGS; i++) {
      const ping = this.pings[i]
      let radius = INACTIVE_RADIUS

      if (ping.active) {
        radius = (now - ping.startTime) * this.pingSpeed
        if (radius >= this.maxRadius) {
          // Expired: recycle the slot with a fresh inactive entry (no mutation).
          this.pings[i] = { startTime: 0, origin: vec3.zero(), active: false, brightness: 0 }
          radius = INACTIVE_RADIUS
        }
      }

      const current = this.pings[i]
      const origin = current.origin
      // Element i = vec4(x, y, z, radius); negative radius = inactive slot.
      pass["pingData[" + i + "]"] = new vec4(origin.x, origin.y, origin.z, radius)
      const b = current.active ? current.brightness : 0
      pass["pingBrightness[" + i + "]"] = new vec4(b, 0, 0, 0)
    }
  }
}
