/**
 * Specs Inc. 2026
 * Card Action Buttons – the like / comment / delete rail for one finished card.
 *
 * Instantiates the authored RoundButton prefab (the same one used under
 * SceneSwitcher) three times, stacked vertically just off the card's right edge
 * and parented to the scanner root so they share the card's lifetime. The button
 * VISUAL is hidden (its render mesh is disabled) so only the icon is seen — the
 * collider/Interactable stays active so taps still register. Toggle state is
 * shown by swapping the icon texture (a hollow "off" texture vs a solid "on"
 * texture), not by changing opacity.
 *
 *   - like    : pure visual toggle (demo only) — swaps its own off/on icon.
 *   - comment : shows the "on" (solid) icon whenever the agent highlights this
 *               card (any path: caption load, card tap, or pressing this button).
 *               Pressing it engages the voice agent via the controller callback.
 *   - delete  : momentary (made non-toggleable) — always shows its icon; asks the
 *               controller to remove the card from the CardStore + destroy it.
 *
 * The RoundButton instances come from the prefab (visual/collider/audio config
 * authored in one place); this only drives their public API (width,
 * setIsToggleable, initialize, toggle, onTriggerUp, onValueChange).
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger"
import { RoundButton } from "SpectaclesUIKit.lspkg/Scripts/Components/Button/RoundButton"
import { RoundedRectangleVisual } from "SpectaclesUIKit.lspkg/Scripts/Visuals/RoundedRectangle/RoundedRectangleVisual"
import { PictureBehavior } from "../PictureBehavior"

export interface CardActionButtonsConfig {
  scannerRoot: SceneObject
  pictureBehavior: PictureBehavior
  // The authored RoundButton prefab, instantiated once per button.
  buttonPrefab: ObjectPrefab
  // Like / comment toggle icons: hollow = off, solid = on.
  likeIconOff: Texture | null
  likeIconOn: Texture | null
  commentIconOff: Texture | null
  commentIconOn: Texture | null
  // Delete is momentary, so it shows a single icon.
  deleteIcon: Texture | null
  // Unlit transparent material, CLONED per icon so each icon's texture is its own.
  iconMaterial: Material | null
  // Hide the RoundButton's render mesh so only the icon shows (interaction stays).
  hideButtonVisual: boolean
  buttonWidth: number
  buttonSpacing: number
  // Gap (cm) between the card's right edge and the buttons' left edge.
  sideOffset: number
  // Push (cm) toward the viewer along the card normal, to clear the backdrop.
  forwardOffset: number
  iconSize: number
  iconForwardOffset: number
  onCommentPressed: () => void
  onDeletePressed: () => void
  logger: Logger
}

// An icon Image plus its two textures; swapping baseTex shows toggle state.
type IconHandle = {
  image: Image
  offTex: Texture | null
  onTex: Texture | null
}

export class CardActionButtons {
  private rootObj: SceneObject = null
  private likeButton: RoundButton = null
  private likeIcon: IconHandle = null
  private commentButton: RoundButton = null
  private commentIcon: IconHandle = null
  private deleteButton: RoundButton = null
  private deleteIcon: IconHandle = null

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
    this.setIconSelected(this.commentIcon, on)
  }

  destroy(): void {
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

  // Places the rail just off the card's top-right corner, on the card's plane,
  // facing the user (the card frame is static after capture, so a one-time
  // world placement is enough).
  private build(): void {
    const pb = this.config.pictureBehavior
    const frame = pb.getCardFrame()
    const halfW = this.config.buttonWidth * 0.5

    const root = global.scene.createSceneObject("CardActionButtons")
    root.setParent(this.config.scannerRoot)
    root.layer = this.config.scannerRoot.layer
    this.rootObj = root

    const pos = frame.corner
      .add(frame.right.uniformScale(this.config.sideOffset + halfW))
      .add(frame.normal.uniformScale(this.config.forwardOffset))
    const trans = root.getTransform()
    // Same rotation as the card's picture anchor: local +Z points at the viewer.
    trans.setWorldRotation(pb.picAnchorObj.getTransform().getWorldRotation())
    trans.setWorldPosition(pos)
    trans.setWorldScale(vec3.one())

    const step = this.config.buttonWidth + this.config.buttonSpacing

    const like = this.createButton("Like", true, -halfW, this.config.likeIconOff, this.config.likeIconOn)
    this.likeButton = like.button
    this.likeIcon = like.icon
    if (this.likeButton) {
      // Pure demo toggle: swap its own off/on icon as it flips.
      this.likeButton.onValueChange.add((value: number) => this.setIconSelected(this.likeIcon, value === 1))
    }
    this.setIconSelected(this.likeIcon, false)

    const comment = this.createButton("Comment", true, -halfW - step, this.config.commentIconOff, this.config.commentIconOn)
    this.commentButton = comment.button
    this.commentIcon = comment.icon
    if (this.commentButton) {
      this.commentButton.onTriggerUp.add(() => this.config.onCommentPressed())
    }
    this.setIconSelected(this.commentIcon, false)

    const del = this.createButton("Delete", false, -halfW - 2 * step, this.config.deleteIcon, null)
    this.deleteButton = del.button
    this.deleteIcon = del.icon
    if (this.deleteButton) {
      this.deleteButton.onTriggerUp.add(() => this.config.onDeletePressed())
    }
    // Momentary action: always shows its single (off) icon.
    this.setIconSelected(this.deleteIcon, false)

    this.config.logger.info("Spawned card action buttons (like/comment/delete)")
  }

  /**
   * Instantiates the RoundButton prefab at local (0, localY, 0) under the rail
   * root, grabs its RoundButton component, hides its visual, and finalizes it via
   * the UI Kit's idempotent lifecycle (setIsToggleable -> initialize), mirroring
   * how SceneSwitcherPanel wires its pre-placed buttons. Events bound by build().
   */
  private createButton(
    name: string,
    toggleable: boolean,
    localY: number,
    offTex: Texture | null,
    onTex: Texture | null
  ): { button: RoundButton; icon: IconHandle | null } {
    const obj = this.config.buttonPrefab.instantiate(this.rootObj)
    obj.name = "CardButton " + name
    obj.layer = this.rootObj.layer
    const t = obj.getTransform()
    t.setLocalPosition(new vec3(0, localY, 0))
    t.setLocalRotation(quat.quatIdentity())
    t.setLocalScale(vec3.one())

    const button = obj.getComponent(RoundButton.getTypeName()) as unknown as RoundButton
    if (!button) {
      this.config.logger.error("Prefab instance '" + name + "' has no RoundButton component.")
      return { button: null, icon: null }
    }
    button.width = this.config.buttonWidth
    // The prefab is authored toggleable; the delete button is momentary. Both
    // setIsToggleable and initialize are idempotent (they no-op / reconfigure if
    // the prefab's own OnStart already ran), so this is safe either order.
    button.setIsToggleable(toggleable)
    button.initialize()

    // Hide the button's own visual so only the icon is seen; the collider /
    // Interactable are separate components and keep working for taps.
    if (this.config.hideButtonVisual) this.hideButtonVisual(button)

    return { button, icon: this.createIcon(obj, name, offTex, onTex) }
  }

  /**
   * Disables the RoundButton's rendered rounded-rect (and its shadow, if any) so
   * the button is invisible while still interactive. The mesh's `.enabled` flag
   * is independent of the Interactable + collider, so taps continue to register.
   */
  private hideButtonVisual(button: RoundButton): void {
    const v = (button as any).visual as RoundedRectangleVisual
    if (v && v.renderMeshVisual) v.renderMeshVisual.enabled = false
    // The prefab has no shadow, but guard in case one is enabled later.
    const shadow = (button as any).shadowVisual
    if (shadow && shadow.renderMeshVisual) shadow.renderMeshVisual.enabled = false
  }

  /**
   * Builds the icon Image on a child of the button (mirrors SceneSwitcherPanel).
   * The shared icon material is CLONED per icon so each icon owns its texture.
   * The icon starts on the "off" texture; setIconSelected swaps to "on".
   */
  private createIcon(
    buttonObj: SceneObject,
    name: string,
    offTex: Texture | null,
    onTex: Texture | null
  ): IconHandle | null {
    const initial = offTex ?? onTex
    if (!initial) return null
    if (!this.config.iconMaterial) {
      this.config.logger.warn("iconMaterial not assigned — '" + name + "' button gets no icon.")
      return null
    }

    const iconObj = global.scene.createSceneObject(name + " Icon")
    iconObj.setParent(buttonObj)
    iconObj.layer = buttonObj.layer
    // Sit just in front of the button face so the icon isn't hidden by it.
    iconObj.getTransform().setLocalPosition(new vec3(0, 0, this.config.iconForwardOffset))

    const aspect = this.textureAspect(initial)
    iconObj.getTransform().setLocalScale(new vec3(this.config.iconSize * aspect, this.config.iconSize, 1))

    const image = iconObj.createComponent("Component.Image") as Image
    const mat = this.config.iconMaterial.clone()
    image.clearMaterials()
    image.addMaterial(mat)
    image.mainPass.baseTex = initial
    image.mainPass.baseColor = new vec4(1, 1, 1, 1)
    return { image, offTex, onTex }
  }

  private textureAspect(tex: Texture): number {
    const w = tex.getWidth()
    const h = tex.getHeight()
    return w > 0 && h > 0 ? w / h : 1
  }

  // Swaps the icon's texture to reflect toggle state. Falls back to whichever
  // texture exists when only one was provided (e.g. the momentary delete icon).
  private setIconSelected(icon: IconHandle | null, selected: boolean): void {
    if (!icon || !icon.image || !icon.image.mainPass) return
    const tex = selected ? (icon.onTex ?? icon.offTex) : (icon.offTex ?? icon.onTex)
    if (tex) icon.image.mainPass.baseTex = tex
  }
}
