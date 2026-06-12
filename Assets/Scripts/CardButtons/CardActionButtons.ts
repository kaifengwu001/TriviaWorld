/**
 * Specs Inc. 2026
 * Card Action Buttons – the profile / like / comment / share / delete rail for
 * one card.
 *
 * Instantiates the authored RoundButton prefab (the same one used under
 * SceneSwitcher) five times, stacked vertically DOWN from the card's top-right
 * corner (offset by a vertical gap) and parented to the card's frame so they
 * share its lifetime and stay aligned as it tracks/animates. The button VISUAL is
 * hidden (its render mesh is disabled) so only the icon is seen — the collider/
 * Interactable stays active so taps still register. Toggle state is shown by
 * swapping the icon texture (a hollow "off" texture vs a solid "on" texture),
 * not by changing opacity.
 *
 *   - profile : topmost; momentary (non-toggle), single icon picked at RANDOM
 *               from a texture pool when the card spawns (a stand-in avatar).
 *   - like    : pure visual toggle (demo only) — swaps its own off/on icon.
 *   - comment : shows the "on" (solid) icon whenever the agent highlights this
 *               card (any path: caption load, card tap, or pressing this button).
 *               Pressing it engages the voice agent via the controller callback.
 *   - share   : toggle; opens/closes a horizontal ShareDrawer of share-pic
 *               buttons to its right (see ShareDrawer for the open/select/dismiss
 *               animations).
 *   - delete  : momentary (made non-toggleable) — always shows its icon; asks the
 *               controller to remove the card from the CardStore + destroy it.
 *
 * The RoundButton instances come from the prefab (visual/collider/audio config
 * authored in one place); this only drives their public API (width,
 * setIsToggleable, initialize, toggle, onTriggerUp, onValueChange).
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger"
import { RoundButton } from "SpectaclesUIKit.lspkg/Scripts/Components/Button/RoundButton"
import { CardButtonHost } from "./CardButtonHost"
import { createIconButton, IconHandle, setIconSelected } from "./CardButtonFactory"
import { ShareDrawer } from "./ShareDrawer"

export interface CardActionButtonsConfig {
  // Adapter for the wrapped card (captured Scanner card or premade card): owns
  // the rail's parent + placement, engage, and store removal.
  host: CardButtonHost
  // The authored RoundButton prefab, instantiated once per button.
  buttonPrefab: ObjectPrefab
  // Like / comment toggle icons: hollow = off, solid = on.
  likeIconOff: Texture | null
  likeIconOn: Texture | null
  commentIconOff: Texture | null
  commentIconOn: Texture | null
  // Delete is momentary, so it shows a single icon.
  deleteIcon: Texture | null
  // Share toggle icons: hollow = off, solid = on (open).
  shareIconOff: Texture | null
  shareIconOn: Texture | null
  // Share drawer: a SEPARATE list of pics (shown in order), and how many to show.
  sharePics: Texture[]
  shareCount: number
  // Horizontal gap (cm) between adjacent share-pics (own setting, not the rail's).
  sharePicSpacing: number
  // Profile-pic button: a pool of textures; ONE is picked at random per card.
  profileIcons: Texture[]
  // Unlit transparent material, CLONED per icon so each icon's texture is its own.
  iconMaterial: Material | null
  // Hide the RoundButton's render mesh so only the icon shows (interaction stays).
  hideButtonVisual: boolean
  buttonWidth: number
  buttonSpacing: number
  // Gap (cm) between the card's right edge and the buttons' left edge.
  sideOffset: number
  // Gap (cm) between the card's top edge and the topmost (profile) button.
  verticalOffset: number
  // Push (cm) toward the viewer along the card normal, to clear the backdrop.
  forwardOffset: number
  iconSize: number
  iconForwardOffset: number
  // Hover label (shown to the right of a button while it is hovered).
  labelSize: number
  labelOffset: number
  labelColor: vec4
  // Random like-count range (inclusive), picked once per card at spawn.
  likeCountMin: number
  likeCountMax: number
  onCommentPressed: () => void
  onDeletePressed: () => void
  logger: Logger
}

export class CardActionButtons {
  private rootObj: SceneObject = null
  private profileButton: RoundButton = null
  private profileIcon: IconHandle = null
  private likeButton: RoundButton = null
  private likeIcon: IconHandle = null
  private commentButton: RoundButton = null
  private commentIcon: IconHandle = null
  private shareButton: RoundButton = null
  private shareIcon: IconHandle = null
  private shareDrawer: ShareDrawer = null
  private deleteButton: RoundButton = null
  private deleteIcon: IconHandle = null
  // Like-count hover label state: a base count picked at spawn, shown as
  // base (+1 while liked). Updated only when the like toggle flips.
  private likeLabel: Text = null
  private likeBaseCount = 0

  constructor(private config: CardActionButtonsConfig) {
    if (!config.buttonPrefab) {
      config.logger.error("buttonPrefab not assigned — cannot spawn card buttons.")
      return
    }
    this.build()
  }

  /**
   * Drives the comment button to mirror "the agent is highlighting this card".
   * Called by the controller when ANY card engages the agent (this one on, the
   * others off) — including re-asserting ON when the user taps the button while
   * it is already on (the raw toggle would otherwise flip it off).
   */
  setCommentEngaged(on: boolean): void {
    if (this.commentButton) this.commentButton.toggle(on)
    setIconSelected(this.commentIcon, on)
  }

  // Per-frame hook (forwarded by the controller) so the share drawer can animate
  // its pics opening / shrinking / fading. No-op when the drawer is idle.
  update(dt: number): void {
    if (this.shareDrawer) this.shareDrawer.update(dt)
  }

  destroy(): void {
    if (this.shareDrawer) {
      this.shareDrawer.destroy()
      this.shareDrawer = null
    }
    if (this.rootObj) {
      // Parented to the scanner root, so when the scanner is destroyed this
      // child dies with it; destroy() then throws "Object is null" — guard it.
      try {
        this.rootObj.destroy()
      } catch (e) {
        // Already destroyed alongside its parent scanner; nothing to do.
      }
      this.rootObj = null
    }
  }

  // --- internal --------------------------------------------------------------

  // Creates the rail root under the card's chosen parent (the backdrop frame for
  // captured cards, the card root for premade cards) and lets the host place it.
  // In both cases the parent is centred on / tracks the card, so the rail follows.
  private build(): void {
    const host = this.config.host
    const parent = host.getRailParent()
    const halfW = this.config.buttonWidth * 0.5

    const root = global.scene.createSceneObject("CardActionButtons")
    root.setParent(parent)
    root.layer = parent.layer
    this.rootObj = root

    // The rail origin is the card's top-right corner. Hang the buttons DOWN from
    // it, the first one a vertical-offset gap below the top edge.
    host.placeRail(root, this.config.sideOffset + halfW, this.config.forwardOffset)

    const step = this.config.buttonWidth + this.config.buttonSpacing
    const topY = -(this.config.verticalOffset + halfW)

    // Profile (topmost): a random avatar from the pool; momentary, no action.
    // Its hover label is the chosen texture's name.
    const profileTex = this.pickProfileIcon()
    const profile = this.createButton("Profile", false, topY, profileTex, null)
    this.profileButton = profile.button
    this.profileIcon = profile.icon
    setIconSelected(this.profileIcon, false)
    this.addHoverLabel(this.profileButton, "Profile", this.textureName(profileTex))

    const like = this.createButton("Like", true, topY - step, this.config.likeIconOff, this.config.likeIconOn)
    this.likeButton = like.button
    this.likeIcon = like.icon
    this.likeBaseCount = this.randomLikeCount()
    this.likeLabel = this.addHoverLabel(this.likeButton, "Like", String(this.likeBaseCount))
    if (this.likeButton) {
      // Pure demo toggle: swap its own off/on icon AND bump the like count by 1
      // while liked (base while not). The base never changes after spawn.
      this.likeButton.onValueChange.add((value: number) => {
        const liked = value === 1
        setIconSelected(this.likeIcon, liked)
        this.updateLikeLabel(liked)
      })
    }
    setIconSelected(this.likeIcon, false)

    const comment = this.createButton("Comment", true, topY - 2 * step, this.config.commentIconOff, this.config.commentIconOn)
    this.commentButton = comment.button
    this.commentIcon = comment.icon
    if (this.commentButton) {
      this.commentButton.onTriggerUp.add(() => this.config.onCommentPressed())
    }
    setIconSelected(this.commentIcon, false)
    this.addHoverLabel(this.commentButton, "Comment", "Chat with Momo")

    // Share (between comment and delete): toggles a horizontal row of share pics.
    const shareY = topY - 3 * step
    const share = this.createButton("Share", true, shareY, this.config.shareIconOff, this.config.shareIconOn)
    this.shareButton = share.button
    this.shareIcon = share.icon
    setIconSelected(this.shareIcon, false)
    this.addHoverLabel(this.shareButton, "Share", "Share")
    this.buildShareDrawer(shareY)
    if (this.shareButton) {
      this.shareButton.onValueChange.add((value: number) => {
        const on = value === 1
        setIconSelected(this.shareIcon, on)
        if (!this.shareDrawer) return
        if (on) this.shareDrawer.expand()
        else this.shareDrawer.collapse()
      })
    }

    const del = this.createButton("Delete", false, topY - 4 * step, this.config.deleteIcon, null)
    this.deleteButton = del.button
    this.deleteIcon = del.icon
    if (this.deleteButton) {
      this.deleteButton.onTriggerUp.add(() => this.config.onDeletePressed())
    }
    // Momentary action: always shows its single (off) icon.
    setIconSelected(this.deleteIcon, false)
    this.addHoverLabel(this.deleteButton, "Delete", "Remove")

    this.config.logger.info("Spawned card action buttons (profile/like/comment/share/delete)")
  }

  // Builds the share-pics drawer hanging off the right of the Share button. The
  // pics live under the same rail root (so they track the card); onClosed resets
  // the Share button to OFF (after a selection, a shrink, or an outside dismiss).
  private buildShareDrawer(shareY: number): void {
    this.shareDrawer = new ShareDrawer({
      railRoot: this.rootObj,
      buttonPrefab: this.config.buttonPrefab,
      sharePics: this.config.sharePics ?? [],
      shareCount: this.config.shareCount,
      iconMaterial: this.config.iconMaterial,
      hideButtonVisual: this.config.hideButtonVisual,
      buttonWidth: this.config.buttonWidth,
      // Horizontal gap between pics has its own setting; the rail's side offset is
      // reused as the gap from the Share button to the first pic.
      spacing: this.config.sharePicSpacing,
      gap: this.config.sideOffset,
      forward: this.config.iconForwardOffset,
      iconSize: this.config.iconSize,
      iconForwardOffset: this.config.iconForwardOffset,
      rowLocalY: shareY,
      onClosed: () => {
        // Reset the Share button to OFF. The drawer is already closed, so the
        // toggle's collapse() is a no-op.
        if (this.shareButton) this.shareButton.toggle(false)
        setIconSelected(this.shareIcon, false)
      },
      logger: this.config.logger,
    })
  }

  // A random integer in [likeCountMin, likeCountMax] (inclusive), clamped sane.
  private randomLikeCount(): number {
    const lo = Math.round(Math.min(this.config.likeCountMin, this.config.likeCountMax))
    const hi = Math.round(Math.max(this.config.likeCountMin, this.config.likeCountMax))
    const min = Math.max(0, lo)
    return min + Math.floor(Math.random() * (Math.max(min, hi) - min + 1))
  }

  // Shows base (+1 while liked). Base is fixed for the card's lifetime.
  private updateLikeLabel(liked: boolean): void {
    if (this.likeLabel) this.likeLabel.text = String(this.likeBaseCount + (liked ? 1 : 0))
  }

  // The chosen profile texture's asset name (the profile button's hover label).
  private textureName(tex: Texture | null): string {
    return tex ? ((tex as any).name ?? "") : ""
  }

  // Picks one profile-pic texture at random from the pool, or null if none set.
  private pickProfileIcon(): Texture | null {
    const pool = this.config.profileIcons
    if (!pool || pool.length === 0) return null
    return pool[Math.floor(Math.random() * pool.length)] ?? null
  }

  // Spawns one icon button at local (0, localY, 0) under the rail root via the
  // shared factory. Events are bound by build().
  private createButton(
    name: string,
    toggleable: boolean,
    localY: number,
    offTex: Texture | null,
    onTex: Texture | null
  ): { button: RoundButton; icon: IconHandle | null } {
    return createIconButton({
      prefab: this.config.buttonPrefab,
      parent: this.rootObj,
      name,
      toggleable,
      localPos: new vec3(0, localY, 0),
      buttonWidth: this.config.buttonWidth,
      hideVisual: this.config.hideButtonVisual,
      iconMaterial: this.config.iconMaterial,
      offTex,
      onTex,
      iconSize: this.config.iconSize,
      iconForwardOffset: this.config.iconForwardOffset,
      logger: this.config.logger,
    })
  }

  /**
   * Creates a Text label just to the RIGHT of a button, hidden until the button
   * is hovered (the UI Kit fires onHoverEnter/onHoverExit even with the visual
   * hidden, since the collider/Interactable stay active). Returns the Text so the
   * caller can update it (the like count), or null if the button is absent.
   */
  private addHoverLabel(button: RoundButton, name: string, content: string): Text | null {
    if (!button) return null
    const buttonObj = button.getSceneObject()
    const obj = global.scene.createSceneObject(name + " Label")
    obj.setParent(buttonObj)
    obj.layer = buttonObj.layer
    // Sit off the button's right edge, slightly toward the viewer so it's clear.
    const x = this.config.buttonWidth * 0.5 + this.config.labelOffset
    obj.getTransform().setLocalPosition(new vec3(x, 0, this.config.iconForwardOffset))

    const text = obj.createComponent("Component.Text") as Text
    text.text = content
    text.size = Math.max(1, Math.round(this.config.labelSize))
    // Left-anchored so the label grows rightward, away from the card.
    text.horizontalAlignment = HorizontalAlignment.Left
    text.verticalAlignment = VerticalAlignment.Center
    text.textFill.color = this.config.labelColor

    obj.enabled = false // shown only while hovered
    button.onHoverEnter.add(() => {
      obj.enabled = true
    })
    button.onHoverExit.add(() => {
      obj.enabled = false
    })
    return text
  }
}
