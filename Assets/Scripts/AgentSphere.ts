/**
 * Specs Inc. 2026
 * AgentSphere — the visual presence of the voice agent.
 *
 * A small sphere that embodies the AI agent: it lives in the user's field of view,
 * faces the user, and travels to wherever the agent's attention currently is. State
 * is pushed in by the other scripts (no import coupling) through global.agentSphere:
 *
 *   - panel : perched on the interest panel's top-right corner (initial, at launch).
 *   - home  : bottom-right of the user's FOV (after "Start exploring", and while the
 *             NudgeVoice is speaking).
 *   - card  : the peripheral (top-right) corner of the card the CardVoiceAgent is
 *             currently talking about.
 *
 * Every frame the orb eases toward an FOV-relative or card-relative target computed
 * from the head camera, so it naturally follows the user's gaze. It also gently bobs
 * when idle and pulses while the agent is producing audio.
 *
 * Registered at global.agentSphere (mirrors global.cardVoiceAgent / cropInterestStore).
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger";

type SphereState = "panel" | "home" | "card";

// How long after the last audio frame we keep "speaking" (seconds).
const SPEAK_HOLD = 0.25;

@component
export class AgentSphere extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">AgentSphere – the voice agent\'s visual presence</span><br/><span style="color: #94A3B8; font-size: 11px;">A small orb that head-follows the user and travels between the panel, a home corner of the FOV, and the active card. Driven by the voice scripts via global.agentSphere.</span>')
  @ui.separator

  @ui.label('<span style="color: #60A5FA;">Scene References</span>')
  @input
  @hint("Head camera object (wire the 'Camera Object'). Used as the frame for FOV-relative positions.")
  cameraObj: SceneObject

  @input
  @hint("The orb whose world transform is driven (a small sphere visual).")
  sphereObj: SceneObject

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Placement (fraction of half-FOV: x -1=left..+1=right, y -1=bottom..+1=top)</span>')
  @input
  @hint("Panel state: top-right of the FOV (in front of the panel), matching the card-perch corner. Lower magnitudes pull it toward center if the device crops it.")
  panelScreenPos: vec2 = new vec2(0.50, 0.50)

  @input
  @hint("Distance (cm) for the panel state. The interest panel sits ~140cm out; keep this a bit in front of it.")
  panelDepth: number = 120

  @input
  @hint("Home state: bottom-right of the FOV. Lower magnitudes keep it more centered / safely on-screen.")
  homeScreenPos: vec2 = new vec2(0.55, -0.55)

  @input
  @hint("Distance (cm) for the home state.")
  homeDepth: number = 55

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Perch offsets (cm — shared by the card and panel top-right corner)</span>')
  @input
  @hint("How far past the right edge to sit.")
  cardPadRight: number = 3

  @input
  @hint("How far above the top edge to sit.")
  cardPadUp: number = 3

  @input
  @hint("How far to pop out toward the viewer off the surface plane (keeps the orb in front of the card / panel).")
  cardPopOut: number = 3

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Motion</span>')
  @input
  @hint("Position follow speed (lerp factor = moveSpeed * dt). Lower = lazier, laggier follow.")
  moveSpeed: number = 4

  @input
  @hint("Rotation follow speed for the yaw-only billboard (slerp factor = rotateSpeed * dt).")
  rotateSpeed: number = 4

  @input
  @hint("Amplitude (cm) of the subtle idle bob (folded into the target so it stays smooth).")
  idleBob: number = 0.5

  @input
  @hint("Extra scale fraction applied while the agent is speaking.")
  speakPulse: number = 0.18

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Logging</span>')
  @input
  @hint("Enable general logging")
  enableLogging: boolean = false;

  private logger: Logger;

  private camTrans: Transform
  private camComp: Camera | null = null
  private sphereTrans: Transform
  private baseScale: vec3

  private state: SphereState = "panel"
  // The PictureBehavior of the card we're perched on (duck-typed: has getCardFrame()).
  private activeCard: any = null
  // Smoothed current pose, seeded (snapped) on the first update.
  private currentPos: vec3 | null = null
  private currentRot: quat | null = null
  // getTime() value until which we consider the agent "speaking".
  private speakingUntil = 0

  onAwake(): void {
    this.logger = new Logger("AgentSphere", this.enableLogging, true);

    // Other scripts (PictureBehavior, TopicSelectionPanel, NudgeVoice, voices) drive
    // the sphere through this global — same pattern as cropInterestStore / cardVoiceAgent.
    (global as any).agentSphere = this;

    if (!this.cameraObj) {
      this.logger.error("cameraObj not assigned — wire the head Camera Object.");
      return;
    }
    if (!this.sphereObj) {
      this.logger.error("sphereObj not assigned — wire the orb visual.");
      return;
    }
    this.camTrans = this.cameraObj.getTransform();
    // The Camera component gives us the real FOV at runtime so placements track
    // whatever the device actually renders (the editor FOV differs from on-device).
    this.camComp = this.cameraObj.getComponent("Component.Camera") as Camera;
    if (!this.camComp) {
      this.logger.warn("No Camera component on cameraObj — falling back to a default FOV.");
    }
    this.sphereTrans = this.sphereObj.getTransform();
    this.baseScale = this.sphereTrans.getLocalScale();

    this.createEvent("UpdateEvent").bind(() => this.update(getDeltaTime()));
  }

  /** Send the orb to its home corner (bottom-right of the FOV). */
  goHome(): void {
    if (this.state !== "home") this.logger.info("-> home");
    this.state = "home";
  }

  /** Send the orb back in front of the panel (top-left). */
  goPanel(): void {
    if (this.state !== "panel") this.logger.info("-> panel");
    this.state = "panel";
  }

  /** Perch the orb on a card the agent is talking about. `card` exposes getCardFrame(). */
  perchOnCard(card: any): void {
    if (!card || typeof card.getCardFrame !== "function") return;
    if (this.state !== "card" || this.activeCard !== card) this.logger.info("-> card");
    this.activeCard = card;
    this.state = "card";
  }

  /** Called when the agent produces an audio frame — drives the talking pulse. */
  noteAudioFrame(): void {
    this.speakingUntil = getTime() + SPEAK_HOLD;
  }

  /** Vertical FOV in radians (Camera.fov is radians), with a ~63.5° fallback. */
  private fovRad(): number {
    return this.camComp ? this.camComp.fov : 1.109;
  }

  private aspect(): number {
    return this.camComp ? this.camComp.aspect : 1;
  }

  /**
   * A point at `depth` cm in front of the camera, offset by a FRACTION of the FOV
   * half-extents (so it stays on-screen regardless of the device's actual FOV).
   * screen.x: -1=left edge..+1=right edge; screen.y: -1=bottom..+1=top.
   */
  private fovPoint(screen: vec2, depth: number): vec3 {
    const camPos = this.camTrans.getWorldPosition();
    // In Lens Studio transform.forward points BEHIND the camera, so the view
    // direction is -forward (matches TopicSelectionPanel.positionPanel / PictureBehavior).
    const viewDir = this.camTrans.forward.uniformScale(-1);
    const halfV = depth * Math.tan(this.fovRad() * 0.5);
    const halfH = halfV * this.aspect();
    return camPos
      .add(viewDir.uniformScale(depth))
      .add(this.camTrans.right.uniformScale(screen.x * halfH))
      .add(this.camTrans.up.uniformScale(screen.y * halfV));
  }

  private computeTarget(): vec3 {
    if (this.state === "card" && this.activeCard?.getCardFrame) {
      const frame = this.activeCard.getCardFrame();
      if (frame) return this.perch(frame);
    }
    if (this.state === "panel") {
      // Anchor to the real panel's top-right corner so the orb always sits in
      // front of it (popped toward the viewer), mirroring the card perch. Falls
      // back to an FOV-relative point until the panel has been built/positioned.
      const panel = (global as any).topicPanel;
      if (panel && typeof panel.getPanelFrame === "function") {
        const pf = panel.getPanelFrame();
        if (pf) return this.perch(pf);
      }
      return this.fovPoint(this.panelScreenPos, this.panelDepth);
    }
    return this.fovPoint(this.homeScreenPos, this.homeDepth);
  }

  /**
   * Places the orb at a flat surface's top-right corner, nudged outward and popped
   * toward the camera so it never hides behind the surface. `frame.normal` (toward
   * the camera) is used if provided, otherwise it is derived from the camera pos.
   */
  private perch(frame: {corner: vec3; right: vec3; up: vec3; normal?: vec3}): vec3 {
    const normal =
      frame.normal ?? this.camTrans.getWorldPosition().sub(frame.corner).normalize();
    return frame.corner
      .add(frame.right.uniformScale(this.cardPadRight))
      .add(frame.up.uniformScale(this.cardPadUp))
      .add(normal.uniformScale(this.cardPopOut));
  }

  private update(dt: number): void {
    if (!this.camTrans || !this.sphereTrans) return;

    // Fold a gentle idle bob into the TARGET (not after the lerp) so it gets
    // smoothed along with everything else instead of reading as a raw wobble.
    const target = this.computeTarget().add(
      vec3.up().uniformScale(this.idleBob * Math.sin(getTime() * 1.5))
    );

    // Yaw-only billboard: face the user but ignore pitch, like FollowPosition.cs
    // zeroing the look direction's vertical component.
    const camPos = this.camTrans.getWorldPosition();
    let dir = camPos.sub(this.currentPos ?? target);
    dir = new vec3(dir.x, 0, dir.z);
    const targetRot =
      dir.length > 1e-4 ? quat.lookAt(dir.normalize(), vec3.up()) : (this.currentRot ?? quat.quatIdentity());

    if (this.currentPos === null || this.currentRot === null) {
      // Snap to the target on the first frame (mirrors snapOnEnable).
      this.currentPos = target;
      this.currentRot = targetRot;
    } else {
      // Plain frame-rate-scaled lerp/slerp (matches FollowPosition.cs).
      this.currentPos = vec3.lerp(this.currentPos, target, Math.min(1, this.moveSpeed * dt));
      this.currentRot = quat.slerp(this.currentRot, targetRot, Math.min(1, this.rotateSpeed * dt));
    }

    this.sphereTrans.setWorldPosition(this.currentPos);
    this.sphereTrans.setWorldRotation(this.currentRot);

    // Talking pulse: scale up rhythmically while audio is flowing, else relax to base.
    let scale = this.baseScale;
    if (getTime() < this.speakingUntil) {
      const f = 1 + this.speakPulse * 0.5 * (1 + Math.sin(getTime() * 18));
      scale = this.baseScale.uniformScale(f);
    }
    this.sphereTrans.setLocalScale(vec3.lerp(this.sphereTrans.getLocalScale(), scale, Math.min(1, 12 * dt)));
  }
}
