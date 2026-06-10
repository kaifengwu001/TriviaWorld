/**
 * Specs Inc. 2026
 * Card Action Buttons Controller for the Crop Spectacles lens.
 *
 * Attach this to the SAME object as PictureController / CardBackdropController.
 * It watches for the Scanner prefab children that PictureController spawns (one
 * per crop) and, once a card's AI caption has loaded (getResolvedTopics() turns
 * non-null), spawns a CardActionButtons rail — like / comment / delete — off the
 * card's right edge.
 *
 *   - like    : demo-only toggle; nothing beyond the visual state.
 *   - comment : engages the voice agent on that card (same path as tapping the
 *               card, which keeps working). Whichever path engages a card, that
 *               card's comment button toggles ON and every other card's toggles
 *               OFF (the agent highlights one card at a time).
 *   - delete  : removes the card from the CardStore and destroys the scanner.
 *
 * Separation of concerns: PictureBehavior is reached only through its public
 * API (getResolvedTopics, getCardFrame, picAnchorObj, engage, addOnEngaged,
 * getStoredCardId); the button visuals live in CardActionButtons.
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger"
import { PictureBehavior } from "../PictureBehavior"
import { CardActionButtons } from "./CardActionButtons"

// One tracked card: its scanner child, behavior, and spawned button rail.
type CardEntry = {
  scanner: SceneObject
  pb: PictureBehavior
  buttons: CardActionButtons
}

@component
export class CardActionButtonsController extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">CardActionButtonsController – like/comment/delete rail per card</span><br/><span style="color: #94A3B8; font-size: 11px;">Watches for Scanner prefab children and, once each card\'s caption loads, spawns three RoundButtons off its right edge. Comment mirrors the agent highlight; delete removes the card from the CardStore.</span>')
  @ui.separator

  @ui.label('<span style="color: #60A5FA;">Icons (hollow = off, solid = on)</span>')
  @input
  @hint("LIKE icon when toggled OFF (hollow version).")
  @allowUndefined
  likeIconOff: Texture

  @input
  @hint("LIKE icon when toggled ON (solid version).")
  @allowUndefined
  likeIconOn: Texture

  @input
  @hint("COMMENT icon when OFF (hollow). Shown solid when the agent highlights this card (caption load, card tap, or this button).")
  @allowUndefined
  commentIconOff: Texture

  @input
  @hint("COMMENT icon when ON (solid version).")
  @allowUndefined
  commentIconOn: Texture

  @input
  @hint("DELETE icon (single — delete is a momentary action, not a toggle).")
  @allowUndefined
  deleteIcon: Texture

  @input
  @hint("Unlit, transparency-capable material the icons are drawn with. Cloned per icon (same material as SceneSwitcherPanel's icons works).")
  @allowUndefined
  iconMaterial: Material

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Button Prefab</span>')
  @input
  @hint("The authored RoundButton prefab (the same one used under SceneSwitcher). Instantiated three times per card. Drag the scene RoundButton into Assets to make a prefab if you don't have one yet.")
  buttonPrefab: ObjectPrefab

  @input
  @hint("Hide the RoundButton's rendered shape so only the icon is visible. The collider stays active, so taps still work. Turn off to debug button placement.")
  hideButtonVisual: boolean = true

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Layout</span>')
  @input
  @hint("RoundButton width/height (cm).")
  buttonWidth: number = 3

  @input
  @hint("Vertical gap (cm) between buttons.")
  buttonSpacing: number = 1

  @input
  @hint("Gap (cm) between the card's right edge and the buttons.")
  sideOffset: number = 1.5

  @input
  @hint("Distance (cm) to push the buttons toward the viewer along the card normal, so they clear the backdrop rect. Flip the sign if they land behind.")
  forwardOffset: number = 0.6

  @input
  @hint("Icon height in cm. Width follows the texture's aspect ratio.")
  iconSize: number = 1.8

  @input
  @hint("How far in front of the button face (cm) the icon sits, to avoid clipping.")
  iconForwardOffset: number = 0.2

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Logging</span>')
  @input
  @hint("Enable general logging")
  enableLogging: boolean = false

  @input
  @hint("Enable lifecycle logging (onAwake, onStart, onUpdate, onDestroy)")
  enableLoggingLifecycle: boolean = false

  private logger: Logger
  private entries: CardEntry[] = []
  // The card the agent currently highlights (last engaged), if any.
  private engagedPb: PictureBehavior | null = null

  onAwake() {
    this.logger = new Logger("CardActionButtonsController", this.enableLogging || this.enableLoggingLifecycle, true)
    if (this.enableLoggingLifecycle) this.logger.debug("LIFECYCLE: onAwake()")
    this.createEvent("UpdateEvent").bind(() => this.update())
  }

  private update(): void {
    const children = this.sceneObject.children
    this.pruneRemoved(children)
    this.attachNew(children)
  }

  // Drops entries whose scanner has left the hierarchy (deleted card, or a
  // too-small crop that destroyed its own scanner). The rail object dies with
  // the scanner, so we only need to forget the record.
  private pruneRemoved(children: SceneObject[]): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (children.indexOf(this.entries[i].scanner) < 0) {
        this.entries[i].buttons.destroy()
        this.entries.splice(i, 1)
      }
    }
  }

  // Spawns a rail on any scanner child whose caption has loaded and that we are
  // not already tracking. Cards still capturing (topics null) are retried next
  // frame — "text loads in" is the spawn trigger.
  private attachNew(children: SceneObject[]): void {
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      if (this.isTracked(child)) continue
      const pb = (child as any).getComponent(PictureBehavior.getTypeName()) as PictureBehavior
      if (!pb || pb.getResolvedTopics() === null) continue
      this.attachButtons(child, pb)
    }
  }

  private isTracked(scanner: SceneObject): boolean {
    return this.entries.some((e) => e.scanner === scanner)
  }

  private attachButtons(scanner: SceneObject, pb: PictureBehavior): void {
    const buttons = new CardActionButtons({
      scannerRoot: scanner,
      pictureBehavior: pb,
      buttonPrefab: this.buttonPrefab,
      likeIconOff: this.likeIconOff ?? null,
      likeIconOn: this.likeIconOn ?? null,
      commentIconOff: this.commentIconOff ?? null,
      commentIconOn: this.commentIconOn ?? null,
      deleteIcon: this.deleteIcon ?? null,
      iconMaterial: this.iconMaterial ?? null,
      hideButtonVisual: this.hideButtonVisual,
      buttonWidth: this.buttonWidth,
      buttonSpacing: this.buttonSpacing,
      sideOffset: this.sideOffset,
      forwardOffset: this.forwardOffset,
      iconSize: this.iconSize,
      iconForwardOffset: this.iconForwardOffset,
      // Comment button = the same engagement path as tapping the card. engage()
      // fires pb's onEngaged callbacks, which route back into markEngaged below,
      // so the toggle states settle no matter which path started it.
      onCommentPressed: () => pb.engage(),
      onDeletePressed: () => this.deleteCard(scanner, pb),
      logger: this.logger,
    })

    this.entries.push({ scanner, pb, buttons })

    // Any future engagement of this card (tap on the card, comment button, a
    // re-capture flow) toggles its comment button on and the other cards' off.
    pb.addOnEngaged(() => this.markEngaged(pb))

    // The capture flow already engaged the agent when the caption loaded (just
    // before we could attach), so this newest card starts highlighted.
    this.markEngaged(pb)
  }

  // Radio behaviour across cards: the agent highlights one card at a time, so
  // exactly that card's comment button shows the engaged (toggled-on) state.
  private markEngaged(pb: PictureBehavior): void {
    this.engagedPb = pb
    this.entries.forEach((entry) => entry.buttons.setCommentEngaged(entry.pb === pb))
  }

  /**
   * Delete button: drop the card from the CardStore, send the agent's orb home
   * if it was perched on this card, then destroy the scanner. Destruction is
   * deferred a frame so we never tear down the button mid-trigger-callback;
   * pruneRemoved then forgets the entry on the next update.
   */
  private deleteCard(scanner: SceneObject, pb: PictureBehavior): void {
    const id = pb.getStoredCardId()
    const store = (global as any).cropCardStore
    if (id && store && typeof store.removeCard === "function") {
      const removed = store.removeCard(id)
      this.logger.info("Removed card " + id + " from CardStore: " + removed)
    } else {
      this.logger.warn("Could not remove card from CardStore (id=" + id + ").")
    }

    // Only send the orb home when it was perched on THE deleted card.
    if (this.engagedPb === pb) {
      this.engagedPb = null
      const sphere = (global as any).agentSphere
      if (sphere && typeof sphere.goHome === "function") {
        sphere.goHome()
      }
    }

    const delayed = this.createEvent("DelayedCallbackEvent")
    delayed.bind(() => {
      try {
        scanner.destroy()
      } catch (e) {
        // Already gone; nothing to do.
      }
    })
    delayed.reset(0)
  }
}
