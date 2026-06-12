/**
 * Specs Inc. 2026
 * Card Action Buttons Controller for the Crop Spectacles lens.
 *
 * Attach this to the SAME object that spawns the cards you want buttons on, and
 * it watches THAT object's children:
 *   - on the capture object (PictureController / CardBackdropController) it picks
 *     up Scanner cards (PictureBehavior);
 *   - on the Exploration Controller (PingCardSpawner) it picks up the ping
 *     PremadeCards.
 * Because it only watches its own children, the CardDeck cosmos — which spawns
 * the same PremadeCard prefab under a DIFFERENT object — gets no buttons.
 *
 * Once a child card is ready (host.isReady(): caption loaded for captured cards,
 * expanded for premade cards) it spawns a CardActionButtons rail off the right
 * edge:
 *   - like    : demo-only toggle; nothing beyond the visual state.
 *   - comment : engages the voice agent on that card (same path as tapping the
 *               card, which keeps working). Whichever path engages a card, that
 *               card's comment button toggles ON and every other card's toggles
 *               OFF (the agent highlights one card at a time).
 *   - share   : toggles a horizontal row of "share to" profile pics off the
 *               button's right (see ShareDrawer); picking one or clicking
 *               elsewhere closes the row.
 *   - delete  : removes the card from the CardStore (if present) and destroys it.
 *
 * The card kind is reached only through CardButtonHost, so this controller is
 * agnostic to captured vs premade cards.
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger"
import { CardActionButtons } from "./CardActionButtons"
import { CardButtonHost, makeCardButtonHost } from "./CardButtonHost"

// One tracked card: its child object, host adapter, and spawned button rail.
type CardEntry = {
  obj: SceneObject
  host: CardButtonHost
  buttons: CardActionButtons
}

@component
export class CardActionButtonsController extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">CardActionButtonsController – profile/like/comment/share/delete rail per card</span><br/><span style="color: #94A3B8; font-size: 11px;">Watches this object\'s child cards (Scanner captures OR ping PremadeCards) and spawns five RoundButtons hanging down from each card\'s top-right corner once it is ready. Profile picks a random avatar; comment mirrors the agent highlight; share opens a row of share-pics; delete removes the card.</span>')
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
  @hint("SHARE icon when toggled OFF (hollow version).")
  @allowUndefined
  shareIconOff: Texture

  @input
  @hint("SHARE icon when toggled ON / drawer open (solid version).")
  @allowUndefined
  shareIconOn: Texture

  @input
  @hint("PROFILE-PIC pool (topmost button). One texture is picked at random per card when it spawns. Not a toggle, so no separate on/off icons.")
  @allowUndefined
  profilePics: Texture[]

  @input
  @hint("SHARE-DRAWER pics, shown in list order when the Share button is toggled on. SEPARATE from the profile pool above, so the share row can use different images / a different order.")
  @allowUndefined
  sharePics: Texture[]

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
  @hint("How many share-pic buttons to spawn to the right of the Share button when it's toggled on (clamped to the number of Share Pics provided).")
  shareCount: number = 3

  @input
  @hint("Horizontal gap (cm) between adjacent spawned share-pic buttons. Independent of the rail's vertical button spacing.")
  sharePicSpacing: number = 1

  @input
  @hint("Gap (cm) between the card's right edge and the buttons.")
  sideOffset: number = 1.5

  @input
  @hint("Gap (cm) between the card's top edge and the topmost (profile) button.")
  verticalOffset: number = 1.5

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
  @ui.label('<span style="color: #60A5FA;">Hover Labels</span>')
  @input
  @hint("Font size (points) of the hover label shown to the right of a button.")
  labelSize: number = 24

  @input
  @hint("Gap (cm) between a button's right edge and its hover label.")
  labelOffset: number = 1.0

  @input
  @hint("Hover label text color (RGBA).")
  labelColor: vec4 = new vec4(1, 1, 1, 1)

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Like Count</span>')
  @input
  @hint("Minimum random like count assigned to a card when it spawns.")
  likeCountMin: number = 3

  @input
  @hint("Maximum random like count assigned to a card when it spawns.")
  likeCountMax: number = 999

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
  private engagedHost: CardButtonHost | null = null

  onAwake() {
    this.logger = new Logger("CardActionButtonsController", this.enableLogging || this.enableLoggingLifecycle, true)
    if (this.enableLoggingLifecycle) this.logger.debug("LIFECYCLE: onAwake()")
    this.createEvent("UpdateEvent").bind(() => this.update())
  }

  private update(): void {
    const children = this.sceneObject.children
    this.pruneRemoved(children)
    this.attachNew(children)
    // Drive each rail's share-drawer animations (open / shrink / select fade).
    const dt = getDeltaTime()
    for (let i = 0; i < this.entries.length; i++) {
      this.entries[i].buttons.update(dt)
    }
  }

  // Drops entries whose card has left the hierarchy (deleted card, a too-small
  // crop that destroyed its own scanner, or a cleared ping wave). The rail dies
  // with the card, so we only need to forget the record.
  private pruneRemoved(children: SceneObject[]): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (children.indexOf(this.entries[i].obj) < 0) {
        this.entries[i].buttons.destroy()
        this.entries.splice(i, 1)
      }
    }
  }

  // Spawns a rail on any child card that is ready and not already tracked. Cards
  // not yet ready (capturing, or a still-collapsed bubble) are retried next frame.
  private attachNew(children: SceneObject[]): void {
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      if (this.isTracked(child)) continue
      const host = makeCardButtonHost(child)
      if (!host || !host.isReady()) continue
      this.attachButtons(child, host)
    }
  }

  private isTracked(obj: SceneObject): boolean {
    return this.entries.some((e) => e.obj === obj)
  }

  private attachButtons(obj: SceneObject, host: CardButtonHost): void {
    const buttons = new CardActionButtons({
      host: host,
      buttonPrefab: this.buttonPrefab,
      likeIconOff: this.likeIconOff ?? null,
      likeIconOn: this.likeIconOn ?? null,
      commentIconOff: this.commentIconOff ?? null,
      commentIconOn: this.commentIconOn ?? null,
      deleteIcon: this.deleteIcon ?? null,
      shareIconOff: this.shareIconOff ?? null,
      shareIconOn: this.shareIconOn ?? null,
      sharePics: this.sharePics ?? [],
      shareCount: this.shareCount,
      sharePicSpacing: this.sharePicSpacing,
      profileIcons: this.profilePics ?? [],
      iconMaterial: this.iconMaterial ?? null,
      hideButtonVisual: this.hideButtonVisual,
      buttonWidth: this.buttonWidth,
      buttonSpacing: this.buttonSpacing,
      sideOffset: this.sideOffset,
      verticalOffset: this.verticalOffset,
      forwardOffset: this.forwardOffset,
      iconSize: this.iconSize,
      iconForwardOffset: this.iconForwardOffset,
      labelSize: this.labelSize,
      labelOffset: this.labelOffset,
      labelColor: this.labelColor ?? new vec4(1, 1, 1, 1),
      likeCountMin: this.likeCountMin,
      likeCountMax: this.likeCountMax,
      // Comment press engages the agent AND marks this card highlighted; for
      // captured cards the tap path also routes here via addOnEngaged below.
      onCommentPressed: () => {
        host.engage()
        this.markEngaged(host)
      },
      onDeletePressed: () => this.deleteCard(obj, host),
      logger: this.logger,
    })

    this.entries.push({ obj, host, buttons })

    // Captured cards can also engage by being tapped directly; route that back
    // into the radio so the comment button mirrors it (no-op for premade cards).
    host.addOnEngaged(() => this.markEngaged(host))

    // Captured cards auto-engage as their caption loads (just before the rail
    // attaches), so they start highlighted; premade cards do not.
    if (host.shouldStartEngaged()) this.markEngaged(host)
  }

  // Radio behaviour across cards: the agent highlights one card at a time, so
  // exactly that card's comment button shows the engaged (toggled-on) state.
  private markEngaged(host: CardButtonHost): void {
    this.engagedHost = host
    this.entries.forEach((entry) => entry.buttons.setCommentEngaged(entry.host === host))
  }

  /**
   * Delete button: drop the card from the CardStore (captured cards only — the
   * host decides), send the agent's orb home if it was perched on this card,
   * then dispose of the card. Disposal (destroy for captured cards, turn-off for
   * premade ones) is deferred a frame so we never tear down the button
   * mid-trigger-callback. A disabled premade card stays in the hierarchy, so we
   * drop its tracking entry + rail here rather than relying on pruneRemoved.
   */
  private deleteCard(obj: SceneObject, host: CardButtonHost): void {
    host.removeFromStore()

    // Only send the orb home when it was perched on THE deleted card.
    if (this.engagedHost === host) {
      this.engagedHost = null
      const sphere = (global as any).agentSphere
      if (sphere && typeof sphere.goHome === "function") {
        sphere.goHome()
      }
    }

    const delayed = this.createEvent("DelayedCallbackEvent")
    delayed.bind(() => {
      try {
        this.forget(obj)
        host.disposeObject()
      } catch (e) {
        // Already gone; nothing to do.
      }
    })
    delayed.reset(0)
  }

  // Drops the tracking entry for a card and destroys its rail. Used on delete so
  // a turned-off (not destroyed) premade card isn't left tracked or re-attached.
  private forget(obj: SceneObject): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].obj === obj) {
        this.entries[i].buttons.destroy()
        this.entries.splice(i, 1)
      }
    }
  }
}
