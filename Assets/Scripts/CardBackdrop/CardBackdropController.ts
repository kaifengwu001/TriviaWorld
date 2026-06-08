/**
 * Specs Inc. 2026
 * Card Backdrop Controller for the Crop Spectacles lens.
 *
 * Attach this to the SAME object as PictureController. PictureController spawns
 * the Scanner prefab as a child of that object (one per crop); this component
 * watches for those children and, for each, spawns a single full-morph BubbleMesh
 * rounded rect that sits on the card's plane, measures the picture + caption
 * extents, and wraps both inside.
 *
 * Separation of concerns: BubbleMesh is reused unchanged through its public API;
 * this never reaches into PictureBehavior's internals beyond its public inputs
 * (the picture visual, the picture anchor, and the caption).
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger"
import { PictureBehavior } from "../PictureBehavior"
import { CardBackdrop } from "./CardBackdrop"

@component
export class CardBackdropController extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">CardBackdropController – wraps each spawned scanner card in a rounded rect</span><br/><span style="color: #94A3B8; font-size: 11px;">Watches for Scanner prefab children and spawns a full-morph BubbleMesh sized to enclose the picture and caption.</span>')
  @ui.separator

  @ui.label('<span style="color: #60A5FA;">Material & Color</span>')
  @input
  @hint("Base material cloned onto the backdrop rect. For the flowing-rainbow border, assign the rainbow shader-graph material (see this folder's README) — it should expose a float reveal param and read baseColor as the topic color. A plain unlit two-sided material also works (the script then cycles the rainbow as a flat hue).")
  @allowUndefined
  baseMaterial: Material

  @input
  @hint("Backdrop color (RGBA). Only its ALPHA is used at runtime — the RGB is driven by the rainbow (while the topic is unknown) then the topic color (TopicColors) once the caption resolves.")
  color: vec4 = new vec4(1.0, 1.0, 1.0, 1.0)

  @input
  @hint("Rainbow flow speed (hue cycles per second) while the topic is unknown.")
  rainbowFlowSpeed: number = 0.25

  @input
  @hint("Seconds to cross-fade the border from the rainbow to the resolved topic color.")
  topicRevealSeconds: number = 0.8

  @input
  @hint("Name of the rainbow shader graph's reveal float parameter (0 = rainbow, 1 = solid topic color). Leave blank if your material has no such parameter.")
  revealParam: string = "reveal"

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Rect Shape</span>')
  @input
  @hint("Padding (cm) added on every side around the measured picture + caption extents.")
  padding: number = 1.5

  @input
  @hint("Fixed corner radius (cm) of the wrapping rounded rectangle.")
  cornerRadius: number = 2

  @input
  @hint("Rect band thickness (cm). Thin = an outline frame around the card; raise toward half the shorter side to make it a solid filled panel.")
  rectLineWidth: number = 0.4

  @input
  @hint("Points per rim of the rounded rect (controls corner smoothness). The ring mesh uses 2x for outer + inner rims.")
  numPoints: number = 64

  @input
  @hint("Opacity multiplier for the rect fill (needs a translucent material to show).")
  fillOpacity: number = 1.0

  @input
  @hint("Distance (cm) to push the rect behind the card along its plane normal, so it never z-fights the picture or text. Flip the sign if it lands in front.")
  backOffset: number = 0.3

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Logging</span>')
  @input
  @hint("Enable general logging")
  enableLogging: boolean = false

  @input
  @hint("Enable lifecycle logging (onAwake, onStart, onUpdate, onDestroy)")
  enableLoggingLifecycle: boolean = false

  // Rect band fraction passed through to BubbleMesh; unused at full morph (the
  // rect band uses Rect Line Width instead) but kept valid for configure().
  private readonly innerFraction: number = 0.1

  private logger: Logger
  // Parallel lists kept in lockstep: scanners[i] is wrapped by backdrops[i].
  private scanners: SceneObject[] = []
  private backdrops: CardBackdrop[] = []

  onAwake() {
    this.logger = new Logger("CardBackdropController", this.enableLogging || this.enableLoggingLifecycle, true)
    if (this.enableLoggingLifecycle) this.logger.debug("LIFECYCLE: onAwake()")
    this.createEvent("UpdateEvent").bind(() => this.update())
  }

  private update(): void {
    const children = this.sceneObject.children
    this.pruneRemoved(children)
    this.attachNew(children)
    this.driveBackdrops()
  }

  // Drops backdrops whose scanner has left the hierarchy (e.g. a too-small crop
  // destroys its own scanner). The backdrop object dies with the scanner, so we
  // only need to forget the manager. Relies on Lens Studio returning stable
  // SceneObject references for the same underlying object across frames.
  private pruneRemoved(children: SceneObject[]): void {
    for (let i = this.scanners.length - 1; i >= 0; i--) {
      if (children.indexOf(this.scanners[i]) < 0) {
        this.removeAt(i)
      }
    }
  }

  // Attaches a backdrop to any scanner child we are not already tracking.
  private attachNew(children: SceneObject[]): void {
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      if (this.scanners.indexOf(child) >= 0) continue
      const backdrop = this.tryCreateBackdrop(child)
      if (backdrop) {
        this.scanners.push(child)
        this.backdrops.push(backdrop)
      }
    }
  }

  private driveBackdrops(): void {
    for (let i = this.backdrops.length - 1; i >= 0; i--) {
      let alive = false
      try {
        alive = this.backdrops[i].update()
      } catch (e) {
        // The scanner was likely destroyed mid-frame; prune defensively.
        this.logger.warn("Backdrop update failed; pruning. " + e)
        alive = false
      }
      if (!alive) this.removeAt(i)
    }
  }

  // Builds a CardBackdrop from a scanner's PictureBehavior public references.
  // Returns null (and retries next frame) if the scanner isn't a wrappable card.
  private tryCreateBackdrop(scanner: SceneObject): CardBackdrop | null {
    const pb = (scanner as any).getComponent(PictureBehavior.getTypeName()) as PictureBehavior
    if (!pb) return null

    const pictureVisual = pb.captureRendMesh
    const picAnchorObj = pb.picAnchorObj
    const caption = pb.caption
    if (!pictureVisual || !picAnchorObj || !caption || !caption.captionText) {
      this.logger.warn("Scanner is missing picture/caption references; skipping backdrop.")
      return null
    }

    return new CardBackdrop({
      scannerRoot: scanner,
      picAnchor: picAnchorObj.getTransform(),
      pictureVisual: pictureVisual,
      captionVisual: caption.captionText,
      captionScaleTransform: caption.captionText.getSceneObject().getTransform(),
      baseMaterial: this.baseMaterial,
      color: this.color,
      cornerRadius: this.cornerRadius,
      padding: this.padding,
      backOffset: this.backOffset,
      numPoints: this.numPoints,
      rectLineWidth: this.rectLineWidth,
      innerFraction: this.innerFraction,
      fillOpacity: this.fillOpacity,
      // The card's topics resolve once the AI caption arrives; until then this
      // returns null and the border flows a rainbow.
      topicsProvider: () => pb.getResolvedTopics(),
      rainbowFlowSpeed: this.rainbowFlowSpeed,
      topicRevealSeconds: this.topicRevealSeconds,
      revealParam: this.revealParam,
      logger: this.logger,
    })
  }

  private removeAt(index: number): void {
    this.backdrops[index].destroy()
    this.backdrops.splice(index, 1)
    this.scanners.splice(index, 1)
  }
}
