/**
 * Specs Inc. 2026
 * Prayer Gesture Behavior for the Crop Spectacles lens experience.
 *
 * Detects the 双手合十 prayer pose (both palms pressed together, fingers
 * pointing up, palms facing each other) and shows a Text notification.
 * The detection moment is isolated in onPrayerDetected() so an animation
 * can be triggered there later instead of (or alongside) the notification.
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger";
import animate, { CancelSet } from "SpectaclesInteractionKit.lspkg/Utils/animate"
import { SIK } from "SpectaclesInteractionKit.lspkg/SIK"
import TrackedHand from "SpectaclesInteractionKit.lspkg/Providers/HandInputData/TrackedHand"
import { PingController } from "./PingController"

// Snapshot of every metric evaluated for the prayer pose on a given frame.
type PoseStatus = {
  leftTracked: boolean
  rightTracked: boolean
  handCount: number
  palmDistance: number | null
  distancePass: boolean
  leftPitch: number | null
  rightPitch: number | null
  pitchPass: boolean
  facingDot: number | null
  facingPass: boolean
  allPass: boolean
}

@component
export class PrayerGestureBehavior extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">PrayerGestureBehavior – detects the 双手合十 prayer pose</span><br/><span style="color: #94A3B8; font-size: 11px;">Requires both hands tracked, palms close + facing each other + fingers pointing up. On detection it shows a Text notification (placeholder for a future animation).</span>')
  @ui.separator

  @ui.label('<span style="color: #60A5FA;">References</span>')
  @input
  @hint("Text component shown briefly when the prayer pose is detected")
  notificationText: Text

  @input
  @hint("Message displayed in the notification text")
  notificationMessage: string = "Prayer detected"

  @input
  @hint("Ping controller fired when the prayer pose is detected (optional)")
  @allowUndefined
  pingController: PingController

  @input
  @hint("Scene object used as the ping origin (player head / camera)")
  @allowUndefined
  headObject: SceneObject

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Detection thresholds</span>')
  @input
  @hint("Max distance (cm) between the two palm centers to count as 'together'")
  palmDistanceCm: number = 8

  @input
  @hint("Min palm pitch angle (deg) for each hand; >0 means fingers point up")
  fingersUpPitchDeg: number = 30

  @input
  @hint("Min dot product of the two palm normals; closer to +1 = more directly facing each other (palms-together reads ~0.7-0.8)")
  palmsFacingDot: number = 0.5

  @input
  @hint("Number of consecutive frames the pose must hold before firing")
  holdFrames: number = 3

  @input
  @hint("Seconds to wait after a detection before it can fire again")
  cooldownSec: number = 2

  @input
  @hint("Seconds the notification stays visible")
  notificationDurationSec: number = 2.5

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Debug</span>')
  @input
  @hint("Continuously write hand count + every threshold's status to the notification Text (keeps it always visible)")
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

  private rightHand: TrackedHand = SIK.HandInputData.getHand("right")
  private leftHand: TrackedHand = SIK.HandInputData.getHand("left")

  private notificationTrans: Transform
  private scaleCancel: CancelSet = new CancelSet()

  private poseFrameCount: number = 0
  private lastDetectionTime: number = -Infinity

  onAwake() {
    this.logger = new Logger("PrayerGestureBehavior", this.enableLogging || this.enableLoggingLifecycle, true);
    if (this.enableLoggingLifecycle) this.logger.debug("LIFECYCLE: onAwake()");

    if (this.notificationText) {
      this.notificationTrans = this.notificationText.getSceneObject().getTransform()
      this.notificationTrans.setLocalScale(vec3.zero())
    } else {
      this.logger.info("notificationText is not assigned; detection will still fire but nothing will display.")
    }

    if (this.isEditor) {
      // No hand tracking in the editor: tap to simulate a detection for testing.
      this.createEvent("TouchStartEvent").bind(this.editorTest.bind(this))
    }

    const updateEvent = this.createEvent("UpdateEvent")
    updateEvent.bind(this.onUpdate)
  }

  editorTest() {
    this.logger.info("Editor test: simulating prayer detection")
    this.onPrayerDetected()
  }

  private onUpdate = (): void => {
    const status = this.evaluatePose()

    if (this.debugMode) {
      this.writeDebugStatus(status)
    }

    // Hand tracking only produces real data on-device; skip detection in editor.
    if (this.isEditor) {
      return
    }

    if (status.allPass) {
      this.poseFrameCount++
      if (this.poseFrameCount >= this.holdFrames && this.isPastCooldown()) {
        this.lastDetectionTime = getTime()
        this.onPrayerDetected()
      }
    } else {
      this.poseFrameCount = 0
    }
  }

  private isPastCooldown(): boolean {
    return getTime() - this.lastDetectionTime >= this.cooldownSec
  }

  // Computes every metric used by the prayer pose without short-circuiting,
  // so the debug view can report each threshold independently.
  private evaluatePose(): PoseStatus {
    const leftTracked = this.leftHand.isTracked()
    const rightTracked = this.rightHand.isTracked()

    const leftPalm = leftTracked ? this.leftHand.getPalmCenter() : null
    const rightPalm = rightTracked ? this.rightHand.getPalmCenter() : null
    const palmDistance = leftPalm && rightPalm ? leftPalm.distance(rightPalm) : null
    const distancePass = palmDistance !== null && palmDistance <= this.palmDistanceCm

    const leftPitch = leftTracked ? this.leftHand.getPalmPitchAngle() : null
    const rightPitch = rightTracked ? this.rightHand.getPalmPitchAngle() : null
    const pitchPass =
      leftPitch !== null &&
      rightPitch !== null &&
      leftPitch >= this.fingersUpPitchDeg &&
      rightPitch >= this.fingersUpPitchDeg

    const leftNormal = leftTracked ? this.computePalmNormal(this.leftHand) : null
    const rightNormal = rightTracked ? this.computePalmNormal(this.rightHand) : null
    const facingDot = leftNormal && rightNormal ? leftNormal.dot(rightNormal) : null
    const facingPass = facingDot !== null && facingDot > this.palmsFacingDot

    return {
      leftTracked,
      rightTracked,
      handCount: (leftTracked ? 1 : 0) + (rightTracked ? 1 : 0),
      palmDistance,
      distancePass,
      leftPitch,
      rightPitch,
      pitchPass,
      facingDot,
      facingPass,
      allPass: distancePass && pitchPass && facingPass
    }
  }

  // Approximates a hand's palm normal from keypoints. The forward vector runs
  // wrist -> middle knuckle (toward the fingers) and the across vector runs
  // index knuckle -> pinky knuckle. Because that across vector is mirrored
  // between the two hands, the resulting normals align (dot ~ +1) when the
  // palms are pressed together facing each other.
  private computePalmNormal(hand: TrackedHand): vec3 | null {
    const wrist = hand.wrist?.position
    const middleKnuckle = hand.middleKnuckle?.position
    const indexKnuckle = hand.indexKnuckle?.position
    const pinkyKnuckle = hand.pinkyKnuckle?.position
    if (!wrist || !middleKnuckle || !indexKnuckle || !pinkyKnuckle) {
      return null
    }
    const forward = middleKnuckle.sub(wrist).normalize()
    const across = indexKnuckle.sub(pinkyKnuckle).normalize()
    return forward.cross(across).normalize()
  }

  // Builds a human-readable status line for each frame and writes it to the
  // notification Text, keeping it visible at full scale.
  private writeDebugStatus(s: PoseStatus): void {
    if (!this.notificationText || !this.notificationTrans) {
      return
    }
    this.scaleCancel.cancel()
    this.notificationTrans.setLocalScale(vec3.one())

    const flag = (pass: boolean) => (pass ? "OK" : "no")
    const num = (n: number | null, digits: number) => (n === null ? "--" : n.toFixed(digits))

    const lines = [
      "Hands: " + s.handCount + "/2  (L:" + (s.leftTracked ? "Y" : "N") + " R:" + (s.rightTracked ? "Y" : "N") + ")",
      "Dist: " + num(s.palmDistance, 1) + "cm  <= " + this.palmDistanceCm + "  [" + flag(s.distancePass) + "]",
      "Pitch L:" + num(s.leftPitch, 0) + " R:" + num(s.rightPitch, 0) + "  >= " + this.fingersUpPitchDeg + "  [" + flag(s.pitchPass) + "]",
      "Facing: " + num(s.facingDot, 2) + "  > " + this.palmsFacingDot + "  [" + flag(s.facingPass) + "]",
      "Hold: " + this.poseFrameCount + "/" + this.holdFrames,
      "PRAYER: " + (s.allPass ? "YES" : "no")
    ]
    this.notificationText.text = lines.join("\n")
  }

  // Single hook fired once when the prayer pose is recognized.
  // Replace/augment with an animation trigger in the future.
  private onPrayerDetected = (): void => {
    // Mark the world as discovered so the 60s NudgeVoice reminder skips itself.
    (global as any).worldDiscovered = true
    this.logger.info("Prayer gesture detected")
    this.emitPing()
    // In debug mode the status readout already reflects detection; don't
    // overwrite it with the auto-hiding notification.
    if (!this.debugMode) {
      this.showNotification()
    }
  }

  // Fires the radiating ping scan from the player's head position. Safe to call
  // even when the controller or head reference is unassigned.
  private emitPing(): void {
    if (!this.pingController || !this.headObject) {
      return
    }
    const headPos = this.headObject.getTransform().getWorldPosition()
    this.pingController.emitBurst(headPos)
  }

  private showNotification(): void {
    if (!this.notificationText || !this.notificationTrans) {
      return
    }

    this.notificationText.text = this.notificationMessage

    if (this.scaleCancel) this.scaleCancel.cancel()
    animate({
      easing: "ease-out-elastic",
      duration: 0.6,
      update: (t: number) => {
        this.notificationTrans.setLocalScale(vec3.lerp(vec3.zero(), vec3.one(), t))
      },
      ended: null,
      cancelSet: this.scaleCancel
    })

    const hideDelay = this.createEvent("DelayedCallbackEvent")
    hideDelay.bind(() => {
      this.hideNotification()
    })
    hideDelay.reset(this.notificationDurationSec)
  }

  private hideNotification(): void {
    if (!this.notificationTrans) {
      return
    }
    if (this.scaleCancel) this.scaleCancel.cancel()
    animate({
      easing: "ease-in-quad",
      duration: 0.3,
      update: (t: number) => {
        this.notificationTrans.setLocalScale(vec3.lerp(vec3.one(), vec3.zero(), t))
      },
      ended: null,
      cancelSet: this.scaleCancel
    })
  }
}
