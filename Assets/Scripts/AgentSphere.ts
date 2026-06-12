/**
 * Specs Inc. 2026
 * AgentSphere — the visual presence of the voice agent.
 *
 * A small sphere that embodies the AI agent: it lives in the user's field of view,
 * faces the user, and travels to wherever the agent's attention currently is. State
 * is pushed in by the other scripts (no import coupling) through global.agentSphere:
 *
 *   - home  : bottom-left of the user's FOV. The default everywhere except an active
 *             card (launch, after "Start exploring", while the NudgeVoice speaks, etc.).
 *   - card  : the top-left corner of the card the CardVoiceAgent is currently talking
 *             about.
 *   - panel : (legacy) perched on the interest panel's corner. No longer entered —
 *             home covers the panel now — kept only so goPanel()/getPanelFrame compile.
 *
 * Every frame the orb eases toward an FOV-relative or card-relative target computed
 * from the head camera, so it naturally follows the user's gaze. It also gently bobs
 * when idle and pulses while the agent is producing audio.
 *
 * Registered at global.agentSphere (mirrors global.cardVoiceAgent / cropInterestStore).
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger";
import { AgentRing } from "./AgentVisual/AgentRing";

type SphereState = "panel" | "home" | "card";

// Envelope shaping for the amplitude reaction. RMS of speech tends to sit low
// (~0.1–0.4), so we scale it up before clamping. Attack rises quickly toward the
// currently-playing frame; release falls back a touch slower so the visual
// breathes instead of flickering on every frame boundary.
const LEVEL_GAIN = 3.0;
const LEVEL_ATTACK = 18; // per-second lerp factor when the level is rising
const LEVEL_RELEASE = 6; // per-second lerp factor when the level is falling

// Safety cap on how much audio (seconds) we keep scheduled ahead. Gemini bursts
// a few seconds of frames up front; this only guards against unbounded growth if
// playback ever stalls (oldest frames are dropped past this).
const MAX_SCHEDULED_SECONDS = 20;

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
  @hint("Home state: bottom-left of the FOV. Lower magnitudes keep it more centered / safely on-screen.")
  homeScreenPos: vec2 = new vec2(-0.55, -0.55)

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
  @ui.label('<span style="color: #60A5FA;">Subtitle</span>')
  @input
  @hint("Orb ring radius (cm) — fallback only; auto-read from the AgentRing on the sphere object when present. One subtitle line = half the orb height.")
  orbRadiusCm: number = 3

  @input
  @hint("Gap (cm) between the orb (home) or card bottom edge and the subtitle.")
  subtitleGapCm: number = 1.5

  @input
  @hint("Margin (cm) kept between the subtitle's right edge and the FOV edge in home state.")
  subtitleFovMarginCm: number = 3

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Motion</span>')
  @input
  @hint("Position follow speed (lerp factor = moveSpeed * dt). Lower = lazier, laggier follow.")
  moveSpeed: number = 4

  @input
  @hint("Rotation follow speed for the billboard (slerp factor = rotateSpeed * dt).")
  rotateSpeed: number = 4

  @input
  @hint("Rotational DEADZONE (degrees) for the billboard: the orb only re-aims once the camera direction has changed more than this from its current facing, then settles and holds again. Generous values (15-30) keep the orb visually rock-steady and skip the per-frame slerp while you look around. 0 = always track.")
  billboardDeadzoneDeg: number = 20

  @input
  @hint("Amplitude (cm) of the subtle idle bob (folded into the target so it stays smooth).")
  idleBob: number = 0.5

  @input
  @hint("Extra scale fraction applied while the agent is speaking.")
  speakPulse: number = 0.18

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Audio Reaction</span>')
  @input
  @hint("Playout latency compensation (seconds). Audio frames arrive a bit before they're audible (the player buffers first), so the visual is held back by this much at the start of each utterance to line up with the sound. Raise if the animation still races ahead; lower if it lags.")
  audioLatency: number = 0.2

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
  // Orb world half-height (= one subtitle line slot), computed once at startup.
  private orbHalfHeightCm = 3

  private state: SphereState = "home"
  // The PictureBehavior of the card we're perched on (duck-typed: has getCardFrame()).
  private activeCard: any = null
  // Smoothed current pose, seeded (snapped) on the first update.
  private currentPos: vec3 | null = null
  private currentRot: quat | null = null
  // Rotational-deadzone hysteresis: once the target drifts past the deadzone we
  // "chase" until we are almost re-aligned, then hold again. Prevents the orb
  // from jittering at the deadzone boundary.
  private rotChasing = false
  // Smoothed amplitude envelope (0..1) the ring/orb visual reads each frame.
  private audioLevel = 0
  // Playback schedule: per-frame loudness paired with the frame's playback
  // duration (seconds). Frames arrive in a burst ahead of playback, so we drain
  // this by real time each update to stay in sync with what's audible.
  private levelQueue: { rms: number; dur: number }[] = []
  private scheduledSeconds = 0
  // Seconds of playout latency still to "wait out" before the schedule starts
  // draining — primed at the start of each utterance so the visual lines up with
  // the (slightly delayed) audible playback instead of racing the arriving frames.
  private playoutDelay = 0

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

    // Orb world half-height = one subtitle line (so two lines == the orb's height).
    // Read the ring radius from the AgentRing on the sphere object when present;
    // localScale == baseScale right now, so the world scale is the un-pulsed size.
    let radius = this.orbRadiusCm;
    const ring = this.sphereObj.getComponent(AgentRing.getTypeName()) as any;
    if (ring && typeof ring.radius === "number" && ring.radius > 0) radius = ring.radius;
    this.orbHalfHeightCm = radius * this.sphereTrans.getWorldScale().x;

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

  /**
   * Called when the agent produces an audio frame. `level` is the frame's RMS
   * loudness (0..~1 from pcm16Rms); `durationSec` is how long that frame plays
   * (from pcm16DurationSec). The frame is SCHEDULED so the envelope tracks
   * playback, not arrival — keeping the visual alive for the whole utterance
   * even though all the frames land up front. Omit args for a default blip.
   */
  noteAudioFrame(level: number = 0.4, durationSec: number = 0): void {
    const rms = Math.max(0, level);
    // Without a real duration (legacy callers) fall back to a short blip so the
    // schedule still advances rather than sticking.
    const dur = durationSec > 0 ? durationSec : 0.05;
    // Fresh utterance (nothing scheduled and the envelope has settled to silence):
    // prime the playout-latency delay so the visual starts when the audio is
    // actually audible, not when the burst of frames arrives.
    if (this.levelQueue.length === 0 && this.audioLevel < 0.02) {
      this.playoutDelay = Math.max(0, this.audioLatency);
    }
    this.levelQueue.push({ rms, dur });
    this.scheduledSeconds += dur;
    // Drop the oldest scheduled audio if playback has stalled and the queue grows
    // unbounded (shouldn't happen in normal streaming).
    while (this.scheduledSeconds > MAX_SCHEDULED_SECONDS && this.levelQueue.length > 1) {
      this.scheduledSeconds -= this.levelQueue.shift()!.dur;
    }
  }

  /** Smoothed amplitude envelope (0..1) for visuals (read by AgentRing). */
  getAudioLevel(): number {
    return this.audioLevel;
  }

  /** Buffered speech (seconds) still to be played — AgentSubtitle paces its reveal on this. */
  getSpeakingSecondsRemaining(): number {
    return Math.max(0, this.scheduledSeconds);
  }

  /**
   * Barge-in: the agent was cut off mid-utterance, so drop any scheduled audio and
   * silence the envelope NOW. Without this the orb keeps "talking" for the seconds
   * of frames already queued (Gemini bursts them up front). Pairs with
   * DynamicAudioOutput.interruptAudioOutput() flushing the actual playback.
   */
  interruptAudio(): void {
    this.levelQueue = [];
    this.scheduledSeconds = 0;
    this.playoutDelay = 0;
    this.audioLevel = 0;
  }

  /**
   * Advances the playback schedule by `dt` and returns the shaped loudness of
   * whatever is playing now (0 when the schedule has drained = audio finished).
   */
  private drainSchedule(dt: number): number {
    let remaining = dt;
    // Hold the schedule back by the playout latency first (nothing audible yet).
    if (this.playoutDelay > 0) {
      if (this.playoutDelay >= remaining) {
        this.playoutDelay -= remaining;
        return 0;
      }
      remaining -= this.playoutDelay;
      this.playoutDelay = 0;
    }
    let playing = 0;
    while (remaining > 0 && this.levelQueue.length > 0) {
      const seg = this.levelQueue[0];
      playing = Math.max(playing, seg.rms);
      if (seg.dur > remaining) {
        seg.dur -= remaining;
        this.scheduledSeconds -= remaining;
        remaining = 0;
      } else {
        remaining -= seg.dur;
        this.scheduledSeconds -= seg.dur;
        this.levelQueue.shift();
      }
    }
    if (this.scheduledSeconds < 0) this.scheduledSeconds = 0;
    return Math.min(1, playing * LEVEL_GAIN);
  }

  /** Angle (degrees) between two rotations, used for the rotational deadzone. */
  private quatAngleDeg(a: quat, b: quat): number {
    let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
    dot = Math.min(1, Math.abs(dot));
    return (2 * Math.acos(dot) * 180) / Math.PI;
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
      .sub(frame.right.uniformScale(this.cardPadRight))
      .add(frame.up.uniformScale(this.cardPadUp))
      .add(normal.uniformScale(this.cardPopOut));
  }

  /**
   * Positions the shared AgentSubtitle (global.agentSubtitle) for this frame: always
   * a head-billboarded ribbon to the RIGHT of the orb, vertically centered on it —
   * wherever the orb currently is (its home corner, or perched on a card). The width
   * is capped to stay inside the FOV at the orb's actual depth, and further clamped to
   * the card's width when perched on a card so the text never overruns the card.
   * `lineHeightCm` is half the orb height, so a 2-line caption equals the orb.
   */
  private driveSubtitle(): void {
    const sub = (global as any).agentSubtitle;
    if (!sub || typeof sub.place !== "function") return;

    const rot = quat.lookAt(this.camTrans.forward, vec3.up());
    const orbPos = this.currentPos ?? this.fovPoint(this.homeScreenPos, this.homeDepth);

    // Project the orb into the camera frame so the FOV width cap is correct for any
    // orb position/depth (home corner or card perch), not just the home placement.
    const camPos = this.camTrans.getWorldPosition();
    const viewDir = this.camTrans.forward.uniformScale(-1);
    const toOrb = orbPos.sub(camPos);
    const depth = Math.max(1, toOrb.dot(viewDir));
    const offsetRight = toOrb.dot(this.camTrans.right);
    const fovHalfW = depth * Math.tan(this.fovRad() * 0.5) * this.aspect();

    const start = offsetRight + this.orbHalfHeightCm + this.subtitleGapCm;
    const pos = orbPos.add(this.camTrans.right.uniformScale(this.orbHalfHeightCm + this.subtitleGapCm));
    let widthCm = Math.max(10, fovHalfW - start - this.subtitleFovMarginCm);
    // On a card, keep the orb-relative position but cap the ribbon to the card's
    // width so the text wraps within the card instead of running far past its edges.
    if (this.state === "card" && this.activeCard?.getCardFrame) {
      const f = this.activeCard.getCardFrame();
      if (f && typeof f.width === "number" && f.width > 0) {
        widthCm = Math.min(widthCm, f.width);
      }
    }
    sub.place(pos, rot, this.orbHalfHeightCm, widthCm, "left", "center");
  }

  private update(dt: number): void {
    if (!this.camTrans || !this.sphereTrans) return;

    // Fold a gentle idle bob into the TARGET (not after the lerp) so it gets
    // smoothed along with everything else instead of reading as a raw wobble.
    const target = this.computeTarget().add(
      vec3.up().uniformScale(this.idleBob * Math.sin(getTime() * 1.5))
    );

    // Full billboard: aim the orb's +Z normal straight at the camera POSITION,
    // including pitch (so it also tilts up/down to face the viewer), not just yaw.
    const camPos = this.camTrans.getWorldPosition();
    const dir = camPos.sub(this.currentPos ?? target);
    const targetRot =
      dir.length > 1e-4 ? quat.lookAt(dir.normalize(), vec3.up()) : (this.currentRot ?? quat.quatIdentity());

    if (this.currentPos === null || this.currentRot === null) {
      // Snap to the target on the first frame (mirrors snapOnEnable).
      this.currentPos = target;
      this.currentRot = targetRot;
      this.rotChasing = false;
    } else {
      // Plain frame-rate-scaled lerp/slerp (matches FollowPosition.cs).
      this.currentPos = vec3.lerp(this.currentPos, target, Math.min(1, this.moveSpeed * dt));
      // Generous rotational deadzone: only re-aim once the head has turned more
      // than billboardDeadzoneDeg from the orb's current facing. Hysteresis keeps
      // chasing until nearly re-aligned so it never chatters on the boundary, and
      // a resting orb skips the slerp entirely.
      const dz = Math.max(0, this.billboardDeadzoneDeg);
      const angDeg = this.quatAngleDeg(this.currentRot, targetRot);
      if (!this.rotChasing && angDeg > dz) this.rotChasing = true;
      if (this.rotChasing) {
        this.currentRot = quat.slerp(this.currentRot, targetRot, Math.min(1, this.rotateSpeed * dt));
        if (angDeg <= dz * 0.15) this.rotChasing = false;
      }
    }

    this.sphereTrans.setWorldPosition(this.currentPos);
    this.sphereTrans.setWorldRotation(this.currentRot);

    // Position the live caption relative to wherever the orb is now.
    this.driveSubtitle();

    // Advance the amplitude envelope by playback time: target is the loudness of
    // the frame currently playing (0 once the schedule drains), eased fast up /
    // slower down. AgentRing reads getAudioLevel() to drive its distortion.
    const levelTarget = this.drainSchedule(dt);
    const k = levelTarget > this.audioLevel ? LEVEL_ATTACK : LEVEL_RELEASE;
    this.audioLevel += (levelTarget - this.audioLevel) * Math.min(1, k * dt);

    // Talking pulse: scale with loudness rather than a fixed on/off sine. With
    // the AgentRing as the main visual this is a subtle size breath on top of
    // the noise distortion; keep speakPulse low (or 0) if it feels like too much.
    const f = 1 + this.speakPulse * this.audioLevel;
    const scale = this.baseScale.uniformScale(f);
    this.sphereTrans.setLocalScale(vec3.lerp(this.sphereTrans.getLocalScale(), scale, Math.min(1, 12 * dt)));
  }
}
