/**
 * Specs Inc. 2026
 * World Mesh Fallback for the Crop Spectacles lens.
 *
 * Decides which surface the ping scan draws on. When real-world scene
 * reconstruction (World Mesh) is producing geometry, the ping shader renders on
 * the live World Mesh. When it is not (in the editor, on unsupported hardware,
 * or before the first scan generates faces), a flat ground-plane quad is enabled
 * instead so the ping still has a surface, positioned at the detected (or
 * default) floor height.
 *
 * World units in Lens Studio are centimeters.
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger";
import { bindStartEvent } from "SnapDecorators.lspkg/decorators";

@component
export class WorldMeshFallback extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">WorldMeshFallback – chooses World Mesh vs ground-plane surface</span><br/><span style="color: #94A3B8; font-size: 11px;">Enables the World Mesh visual when reconstruction has faces; otherwise shows a ground quad placed at the detected (or default) floor height.</span>')
  @ui.separator

  @ui.label('<span style="color: #60A5FA;">References</span>')
  @input
  @hint("World Mesh RenderMeshVisual (driven by WorldRenderObjectProvider)")
  @allowUndefined
  worldMeshVisual: RenderMeshVisual

  @input
  @hint("Ground-plane quad used as the fallback ping surface")
  @allowUndefined
  groundPlane: SceneObject

  @input
  @hint("Scene object used as the head/camera reference for floor detection")
  @allowUndefined
  headObject: SceneObject

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Tuning</span>')
  @input
  @hint("Fallback floor offset below the head (cm, negative = below). Used when no floor hit is found.")
  defaultFloorOffset: number = -120

  @input
  @hint("Keep the ground plane enabled even when the World Mesh is available (covers mesh holes)")
  keepGroundWithMesh: boolean = false

  @input
  @hint("On-device, treat the World Mesh as available even when faceCount reads 0. faceCount is reliable in the editor but often reports 0 on Spectacles while the mesh is still scanning/rendering. Disable only for non-Spectacles builds.")
  assumeMeshOnDevice: boolean = true

  @input
  @hint("How often (seconds) to re-evaluate World Mesh availability and floor height")
  checkIntervalSec: number = 1.0

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Debug</span>')
  @input
  @hint("Continuously write World Mesh status (faceCount, chosen surface, etc.) to this Text")
  @allowUndefined
  debugText: Text

  @input
  @hint("Enable writing the live status readout to debugText")
  debugMode: boolean = false

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
  private worldQueryModule = require("LensStudio:WorldQueryModule")
  private hitTestSession = null
  private trackingEnabled = false

  onAwake() {
    this.logger = new Logger("WorldMeshFallback", this.enableLogging || this.enableLoggingLifecycle, true);
    if (this.enableLoggingLifecycle) this.logger.debug("LIFECYCLE: onAwake()");
  }

  @bindStartEvent
  start() {
    if (this.enableLoggingLifecycle) this.logger.debug("LIFECYCLE: onStart()");

    if (!this.isEditor) {
      this.hitTestSession = this.createHitTestSession()
    }

    this.enableWorldMeshTracking()

    // Place the ground at a sensible default immediately, then refine.
    this.positionGroundAtDefault()
    this.updateSurfaceState()
    this.scheduleRecheck()
  }

  // The World Mesh only accumulates faces while tracking is enabled. Turn it on
  // explicitly so faceCount can grow and the mesh surface becomes available.
  private enableWorldMeshTracking(): void {
    if (!this.worldMeshVisual) {
      return
    }
    try {
      const provider = this.worldMeshVisual.mesh.control as WorldRenderObjectProvider
      if (provider) {
        provider.enableWorldMeshesTracking = true
        this.trackingEnabled = true
      }
    } catch (e) {
      this.logger.warn("Could not enable world mesh tracking: " + e)
    }
  }

  private createHitTestSession() {
    try {
      const options = HitTestSessionOptions.create()
      options.filter = true
      return this.worldQueryModule.createHitTestSessionWithOptions(options)
    } catch (e) {
      this.logger.warn("Could not create hit test session: " + e)
      return null
    }
  }

  // Re-evaluates availability and floor height on a fixed cadence. World Mesh
  // refreshes slowly (~5Hz) and fills in over time, so a periodic check lets us
  // switch from the fallback ground to the real mesh once it has geometry.
  private scheduleRecheck(): void {
    const delayed = this.createEvent("DelayedCallbackEvent")
    delayed.bind(() => {
      this.updateSurfaceState()
      this.scheduleRecheck()
    })
    delayed.reset(Math.max(0.1, this.checkIntervalSec))
  }

  private updateSurfaceState(): void {
    // faceCount is reliable in the editor but commonly reads 0 on Spectacles even
    // while the World Mesh is actively scanning and rendering. So we trust the
    // count in the editor, and on-device fall back to assuming the mesh is
    // available (this is a Spectacles project where reconstruction is supported).
    const faces = this.getMeshFaceCount()
    const meshAvailable = faces > 0 || (this.assumeMeshOnDevice && !this.isEditor)

    if (this.enableLogging) {
      this.logger.debug("World mesh faceCount=" + faces + " -> " + (meshAvailable ? "use MESH" : "use ground"))
    }

    if (this.worldMeshVisual) {
      this.worldMeshVisual.enabled = meshAvailable
    }
    if (this.groundPlane) {
      this.groundPlane.enabled = !meshAvailable || this.keepGroundWithMesh
    }

    // Only bother updating the floor when the ground plane is actually shown.
    if (!meshAvailable || this.keepGroundWithMesh) {
      this.updateFloorHeight()
    }

    this.writeDebugStatus(faces, meshAvailable)
  }

  // Mirrors the Text-based debug readout used by PrayerGestureBehavior so the
  // World Mesh decision can be inspected on-device without a console.
  private writeDebugStatus(faces: number, meshAvailable: boolean): void {
    if (!this.debugMode || !this.debugText) {
      return
    }
    const onoff = (b: boolean) => (b ? "on" : "off")
    const lines = [
      "WORLD MESH",
      "faceCount: " + faces,
      "surface: " + (meshAvailable ? "MESH" : "GROUND"),
      "meshVisual: " + (this.worldMeshVisual ? onoff(this.worldMeshVisual.enabled) : "n/a"),
      "groundPlane: " + (this.groundPlane ? onoff(this.groundPlane.enabled) : "n/a"),
      "tracking: " + onoff(this.trackingEnabled),
      "assumeDevice: " + onoff(this.assumeMeshOnDevice && !this.isEditor),
      "editor: " + (this.isEditor ? "yes" : "no")
    ]
    this.debugText.text = lines.join("\n")
  }

  private getMeshFaceCount(): number {
    if (!this.worldMeshVisual) {
      return 0
    }
    try {
      const provider = this.worldMeshVisual.mesh.control as WorldRenderObjectProvider
      return provider ? provider.faceCount : 0
    } catch (e) {
      return 0
    }
  }

  private updateFloorHeight(): void {
    if (!this.groundPlane) {
      return
    }
    if (this.isEditor || !this.hitTestSession || !this.headObject) {
      this.positionGroundAtDefault()
      return
    }

    const headPos = this.headObject.getTransform().getWorldPosition()
    const rayEnd = headPos.add(new vec3(0, -1000, 0))

    this.hitTestSession.hitTest(headPos, rayEnd, (result) => {
      const transform = this.groundPlane.getTransform()
      const current = transform.getWorldPosition()
      if (result) {
        transform.setWorldPosition(new vec3(current.x, result.position.y, current.z))
      } else {
        transform.setWorldPosition(new vec3(current.x, headPos.y + this.defaultFloorOffset, current.z))
      }
    })
  }

  private positionGroundAtDefault(): void {
    if (!this.groundPlane) {
      return
    }
    const transform = this.groundPlane.getTransform()
    const current = transform.getWorldPosition()
    const baseY = this.headObject
      ? this.headObject.getTransform().getWorldPosition().y + this.defaultFloorOffset
      : this.defaultFloorOffset
    transform.setWorldPosition(new vec3(current.x, baseY, current.z))
  }
}
