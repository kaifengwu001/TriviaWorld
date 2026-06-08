/**
 * Specs Inc. 2026
 * Topic Selection Panel for the Crop Spectacles lens.
 * Shown at launch: programmatically builds a honeycomb of toggleable CapsuleButtons
 * (Spectacles UI Kit) under a Frame, then commits the selected topics to the
 * InterestStore and hides the panel when the user pinches "Start exploring".
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger";
import { Frame } from "SpectaclesUIKit.lspkg/Scripts/Components/Frame/Frame";
import { CapsuleButton } from "SpectaclesUIKit.lspkg/Scripts/Components/Button/CapsuleButton";
import { InterestStore } from "./InterestStore";
import { DEFAULT_TOPICS } from "./InterestTopics";

// Button footprint requested by design: 7 x 3 x 1 cm.
const BUTTON_SIZE = new vec3(7, 3, 1)

// The confirm button is emphasized at 1.5x the topic-button footprint.
const START_SCALE = 1.5

type TopicButton = {
  topic: string
  button: CapsuleButton
}

@component
export class TopicSelectionPanel extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">TopicSelectionPanel – launch-time interest picker</span><br/><span style="color: #94A3B8; font-size: 11px;">Builds a honeycomb of toggleable CapsuleButtons under a Frame and commits the selection to the InterestStore on Start.</span>')
  @ui.separator

  @ui.label('<span style="color: #60A5FA;">References</span>')
  @input
  @hint("Frame component the buttons are spawned under (falls back to a Frame on this object)")
  @allowUndefined
  frame: Frame

  @input
  @hint("Camera used to position the panel in front of the user at launch (optional)")
  @allowUndefined
  cameraObj: SceneObject

  @input
  @hint("InterestStore to commit selections to (falls back to global.cropInterestStore)")
  @allowUndefined
  interestStore: InterestStore

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Layout</span>')
  @input
  @hint("Topics to show. Leave empty to use the editable DEFAULT_TOPICS list.")
  topics: string[] = []

  @input
  @hint("Width/height ratio of the oval cluster. >1 is wider than tall. Drives how many rows are used.")
  ovalAspect: number = 1.6

  @input
  @hint("Horizontal gap between buttons (cm)")
  horizontalGap: number = 1.5

  @input
  @hint("Vertical gap between honeycomb rows (cm)")
  verticalGap: number = 1.0

  @input
  @hint("How far the buttons sit in front of the frame plane to avoid clipping (cm)")
  buttonDepthOffset: number = 1.0

  @input
  @hint("Font size for the button labels")
  labelSize: number = 28

  @input
  @hint("Label of the confirm button")
  startLabel: string = "Start exploring"

  @input
  @hint("Distance in cm to place the panel in front of the camera at launch")
  distanceFromCamera: number = 60

  @input
  @hint("Offset (cm) of the buttons relative to the background frame: x=right, y=up, z=depth")
  panelOffset: vec3 = vec3.zero()

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Logging</span>')
  @input
  @hint("Enable general logging")
  enableLogging: boolean = false;

  @input
  @hint("Enable lifecycle logging (onAwake, onStart, onUpdate, onDestroy)")
  enableLoggingLifecycle: boolean = false;

  private logger: Logger;
  private topicButtons: TopicButton[] = []
  // True once the panel has been built and positioned, so getPanelFrame() is valid.
  private built = false

  onAwake() {
    this.logger = new Logger("TopicSelectionPanel", this.enableLogging || this.enableLoggingLifecycle, true);
    if (this.enableLoggingLifecycle) this.logger.debug("LIFECYCLE: onAwake()");
    // Let the agent's orb perch on this panel (same global-singleton pattern as
    // cropInterestStore / cardVoiceAgent).
    (global as any).topicPanel = this
    // Build after OnStart so the scene, SIK, and Frame components are ready.
    this.createEvent("OnStartEvent").bind(() => this.build())
  }

  private build() {
    const frame = this.resolveFrame()
    if (!frame) {
      this.logger.error("No Frame found; assign one or add a Frame component to this object.")
      return
    }
    // Frame.initialize() is idempotent; ensure content exists before parenting.
    frame.initialize()
    frame.autoShowHide = false
    frame.autoScaleContent = false
    frame.allowScaling = false

    // Parent the buttons under an offset container so they can be shifted within
    // the (stationary) background frame without moving the frame itself.
    const buttonRoot = global.scene.createSceneObject("Buttons")
    buttonRoot.setParent(frame.content)
    buttonRoot.getTransform().setLocalPosition(this.panelOffset ?? vec3.zero())

    const topics = this.resolveTopics()
    this.buildButtons(frame, buttonRoot, topics)

    frame.showVisual()
    this.positionPanel(frame)
    this.built = true
    this.logger.info("Topic panel built with " + topics.length + " topics.")
  }

  /**
   * Top-right corner + basis of the panel in world space, so the AgentSphere can
   * perch on its periphery (mirrors PictureBehavior.getCardFrame). Returns null
   * until the panel is built/positioned or once it has been hidden on Start.
   */
  getPanelFrame() {
    const frame = this.resolveFrame()
    if (!frame || !this.built) return null
    const fobj = frame.getSceneObject()
    if (!fobj.enabled) return null
    const t = fobj.getTransform()
    const center = t.getWorldPosition()
    const right = t.right
    const up = t.up
    const scale = t.getWorldScale()
    const halfW = frame.innerSize.x * 0.5 * scale.x
    const halfH = frame.innerSize.y * 0.5 * scale.y
    const corner = center.add(right.uniformScale(halfW)).add(up.uniformScale(halfH))
    return {corner, right, up}
  }

  private buildButtons(frame: Frame, parent: SceneObject, topics: string[]) {
    const n = topics.length
    const hSpacing = BUTTON_SIZE.x + this.horizontalGap
    const rowStep = BUTTON_SIZE.y + this.verticalGap
    // Sit the buttons in front of the frame plane to avoid clipping with it.
    const z = this.buttonDepthOffset

    // Symmetric hexagon/diamond rows where adjacent rows always differ by one,
    // so buttons in neighboring rows interlock into a honeycomb (never align).
    const rowCounts = this.computeRowCounts(n, hSpacing, rowStep)
    const numRows = rowCounts.length
    const honeycombHeight = numRows > 0 ? (numRows - 1) * rowStep : 0
    const maxCount = rowCounts.reduce((m, c) => Math.max(m, c), 0)

    const startSize = new vec3(BUTTON_SIZE.x * START_SCALE, BUTTON_SIZE.y * START_SCALE, BUTTON_SIZE.z)
    // The confirm button sits twice the normal row gap below the honeycomb.
    const startEmptyGap = this.verticalGap * 2
    // Gap from the bottom honeycomb row's center to the confirm button's center.
    const startGap = BUTTON_SIZE.y / 2 + startEmptyGap + startSize.y / 2
    // Shift everything up so the union (honeycomb + confirm button) is centered.
    const centerYShift = (startEmptyGap + startSize.y) / 2

    let index = 0
    for (let row = 0; row < numRows; row++) {
      const count = rowCounts[row]
      const rowWidth = (count - 1) * hSpacing
      const y = honeycombHeight / 2 - row * rowStep + centerYShift
      for (let col = 0; col < count; col++) {
        const x = -rowWidth / 2 + col * hSpacing
        const topic = topics[index++]
        const button = this.createButton(parent, topic, true, BUTTON_SIZE, 1)
        button.transform.setLocalPosition(new vec3(x, y, z))
        this.topicButtons.push({topic, button})
      }
    }

    // Confirm button: larger, non-toggle, "Primary" style, centered below the cluster.
    const startY = -(honeycombHeight / 2 + startGap) + centerYShift
    const startButton = this.createButton(parent, this.startLabel, false, startSize, START_SCALE, "Primary")
    startButton.transform.setLocalPosition(new vec3(0, startY, z))
    startButton.onTriggerUp.add(() => this.onStart())

    // Size the frame to fit the oval cluster plus the confirm button, with margin.
    const margin = BUTTON_SIZE.y
    const clusterWidth = Math.max(maxCount - 1, 0) * hSpacing + Math.max(BUTTON_SIZE.x, startSize.x)
    const clusterHeight = honeycombHeight + BUTTON_SIZE.y + startEmptyGap + startSize.y
    frame.innerSize = new vec2(clusterWidth + margin, clusterHeight + margin)
  }

  /**
   * Lays `n` buttons into a symmetric hexagon/diamond where the rows step by one
   * (e.g. 4 / 5 / 4): the peak row is widest and each row away from it has one
   * fewer button, so neighbors always interlock into a honeycomb. The row totals
   * follow `peak + 2*(peak-1) + 2*(peak-2) + ...`, trimming the outer tips when a
   * perfect hexagon can't hold exactly `n`. Among exact fits, the one closest to
   * `ovalAspect` (width/height) is chosen so the silhouette stays oval.
   */
  private computeRowCounts(n: number, hSpacing: number, rowStep: number): number[] {
    if (n <= 0) {
      return []
    }
    if (n === 1) {
      return [1]
    }

    const target = this.ovalAspect > 0 ? this.ovalAspect : 1
    const aspectOf = (rows: number[]): number => {
      const maxCount = rows.reduce((m, c) => Math.max(m, c), 0)
      const width = (maxCount - 1) * hSpacing + BUTTON_SIZE.x
      const height = (rows.length - 1) * rowStep + BUTTON_SIZE.y
      return width / Math.max(height, 0.0001)
    }

    // Search symmetric hexagons rows = a..peak..a (sum = (peak-1+a)*(peak-a)+peak)
    // for an exact fit, picking the silhouette closest to the desired aspect.
    let best: {rows: number[]; score: number} | null = null
    for (let peak = 2; peak <= n; peak++) {
      for (let a = 1; a <= peak; a++) {
        if ((peak - 1 + a) * (peak - a) + peak === n) {
          const rows = this.buildHexRows(a, peak)
          const score = Math.abs(aspectOf(rows) - target)
          if (!best || score < best.score) {
            best = {rows, score}
          }
        }
      }
    }
    if (best) {
      return best.rows
    }

    // No exact hexagon: take the smallest diamond that holds n, then peel buttons
    // off the tips (top/bottom alternately) until the total matches exactly.
    let peak = 1
    while (peak * peak < n) {
      peak++
    }
    const rows = this.buildHexRows(1, peak)
    let total = rows.reduce((a, b) => a + b, 0)
    let trimFront = true
    while (total > n && rows.length > 0) {
      const idx = trimFront ? 0 : rows.length - 1
      rows[idx]--
      total--
      if (rows[idx] <= 0) {
        rows.splice(idx, 1)
      }
      trimFront = !trimFront
    }
    return rows
  }

  /**
   * Builds a palindrome row sequence `a, a+1, ..., peak, ..., a+1, a` whose
   * adjacent entries differ by exactly one (the honeycomb stepping pattern).
   */
  private buildHexRows(a: number, peak: number): number[] {
    const rows: number[] = []
    for (let c = a; c < peak; c++) {
      rows.push(c)
    }
    rows.push(peak)
    for (let c = peak - 1; c >= a; c--) {
      rows.push(c)
    }
    return rows
  }

  private createButton(
    parent: SceneObject,
    label: string,
    toggleable: boolean,
    size: vec3,
    labelScale: number,
    style?: string
  ): CapsuleButton {
    const obj = global.scene.createSceneObject(label || "Button")
    obj.setParent(parent)

    const button = obj.createComponent(CapsuleButton.getTypeName()) as unknown as CapsuleButton
    button.size = size
    // The style backs the default visual, so it must be set before initialize().
    if (style) {
      ;(button as any)._style = style
    }
    if (toggleable) {
      button.setIsToggleable(true)
    }
    button.initialize()

    this.addLabel(obj, label, size, labelScale)
    return button
  }

  private addLabel(buttonObj: SceneObject, label: string, size: vec3, labelScale: number) {
    const textObj = global.scene.createSceneObject("Label")
    textObj.setParent(buttonObj)
    // Push the label slightly toward the viewer so it renders over the capsule.
    textObj.getTransform().setLocalPosition(new vec3(0, 0, size.z * 0.5 + 0.1))
    const text = textObj.createComponent("Component.Text") as Text
    text.text = label
    text.size = Math.round(this.labelSize * labelScale)
    text.horizontalAlignment = HorizontalAlignment.Center
    text.verticalAlignment = VerticalAlignment.Center
    text.textFill.color = new vec4(1, 1, 1, 1)
  }

  private positionPanel(frame: Frame) {
    if (!this.cameraObj) {
      return
    }
    const camTrans = this.cameraObj.getTransform()
    const panelTrans = frame.getSceneObject().getTransform()
    const forwardOffset = camTrans.forward.uniformScale(-this.distanceFromCamera)
    panelTrans.setWorldPosition(camTrans.getWorldPosition().add(forwardOffset))
  }

  private onStart() {
    const selected = this.topicButtons
      .filter((entry) => entry.button.isOn)
      .map((entry) => entry.topic)

    const store = this.resolveStore()
    if (store) {
      store.setInterests(selected)
      store.markReady()
    } else {
      this.logger.error("InterestStore not found; selections were not saved.")
    }

    this.logger.info("Selected topics: " + (selected.length > 0 ? selected.join(", ") : "(none)"))

    // Have the host voice acknowledge the picks and tease recommended places.
    const hostVoice = (global as any).hostVoice
    if (hostVoice && typeof hostVoice.announceInterests === "function") {
      hostVoice.announceInterests(selected)
    }

    const frame = this.resolveFrame()
    if (frame) {
      frame.getSceneObject().enabled = false
    }

    // The agent's orb leaves the panel and glides to its home corner of the FOV.
    const sphere = (global as any).agentSphere
    if (sphere && typeof sphere.goHome === "function") {
      sphere.goHome()
    }

    // The card-query agent now arms itself purely on gaze — it opens its mic when
    // the user looks at the card deck — so the panel no longer force-starts it.
  }

  private resolveFrame(): Frame | null {
    if (this.frame) {
      return this.frame
    }
    return (this.getSceneObject().getComponent(Frame.getTypeName()) as Frame) ?? null
  }

  private resolveTopics(): string[] {
    const provided = (this.topics ?? []).filter((t) => typeof t === "string" && t.trim().length > 0)
    return provided.length > 0 ? provided : DEFAULT_TOPICS.slice()
  }

  private resolveStore(): InterestStore | null {
    if (this.interestStore) {
      return this.interestStore
    }
    return (global as any).cropInterestStore ?? null
  }
}
