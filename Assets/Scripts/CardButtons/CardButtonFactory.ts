/**
 * Specs Inc. 2026
 * CardButtonFactory – shared helpers for building the icon RoundButtons used by
 * the card action rail (CardActionButtons) and the share-pics drawer
 * (ShareDrawer).
 *
 * Both spawn the authored RoundButton prefab, hide its rendered shape so only an
 * icon Image shows, and finalize it through the UI Kit's idempotent lifecycle
 * (setIsToggleable -> initialize). Keeping that logic here means the rail and the
 * drawer build buttons identically without duplicating the wiring.
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger"
import { RoundButton } from "SpectaclesUIKit.lspkg/Scripts/Components/Button/RoundButton"
import { RoundedRectangleVisual } from "SpectaclesUIKit.lspkg/Scripts/Visuals/RoundedRectangle/RoundedRectangleVisual"

// An icon Image plus its two textures; swapping baseTex shows toggle state.
export type IconHandle = {
  image: Image
  offTex: Texture | null
  onTex: Texture | null
}

export interface IconButtonOptions {
  // The authored RoundButton prefab, instantiated once per button.
  prefab: ObjectPrefab
  // Object the new button is parented to (the rail / drawer root).
  parent: SceneObject
  // Suffix for the spawned object's name (and the icon's name).
  name: string
  // Toggle (like/comment/share) vs momentary (profile/delete/share-pic).
  toggleable: boolean
  // Local position of the button under `parent`.
  localPos: vec3
  buttonWidth: number
  // Hide the RoundButton's render mesh so only the icon shows (taps still work).
  hideVisual: boolean
  // Unlit transparent material, CLONED per icon so each icon owns its texture.
  iconMaterial: Material | null
  // Icon textures: hollow = off, solid = on (off only for momentary buttons).
  offTex: Texture | null
  onTex: Texture | null
  iconSize: number
  iconForwardOffset: number
  logger: Logger
}

export type IconButtonResult = { button: RoundButton | null; icon: IconHandle | null }

/**
 * Instantiates the RoundButton prefab under `parent`, grabs its RoundButton
 * component, hides its visual, finalizes it via the UI Kit's idempotent
 * lifecycle, and builds its icon. Mirrors how SceneSwitcherPanel wires its
 * pre-placed buttons. Event binding is left to the caller.
 */
export function createIconButton(opts: IconButtonOptions): IconButtonResult {
  const obj = opts.prefab.instantiate(opts.parent)
  obj.name = "CardButton " + opts.name
  obj.layer = opts.parent.layer
  const t = obj.getTransform()
  t.setLocalPosition(opts.localPos)
  t.setLocalRotation(quat.quatIdentity())
  t.setLocalScale(vec3.one())

  const button = obj.getComponent(RoundButton.getTypeName()) as unknown as RoundButton
  if (!button) {
    opts.logger.error("Prefab instance '" + opts.name + "' has no RoundButton component.")
    return { button: null, icon: null }
  }
  button.width = opts.buttonWidth
  // The prefab is authored toggleable; momentary buttons opt out. Both
  // setIsToggleable and initialize are idempotent, so this is safe either order.
  button.setIsToggleable(opts.toggleable)
  button.initialize()

  if (opts.hideVisual) hideButtonVisual(button)

  return {
    button,
    icon: createIcon(obj, opts.name, opts.offTex, opts.onTex, opts.iconMaterial, opts.iconSize, opts.iconForwardOffset, opts.logger),
  }
}

/**
 * Disables the RoundButton's rendered rounded-rect (and its shadow, if any) so
 * the button is invisible while still interactive. The mesh's `.enabled` flag is
 * independent of the Interactable + collider, so taps continue to register.
 */
export function hideButtonVisual(button: RoundButton): void {
  const v = (button as any).visual as RoundedRectangleVisual
  if (v && v.renderMeshVisual) v.renderMeshVisual.enabled = false
  const shadow = (button as any).shadowVisual
  if (shadow && shadow.renderMeshVisual) shadow.renderMeshVisual.enabled = false
}

/**
 * Builds the icon Image on a child of the button (mirrors SceneSwitcherPanel).
 * The shared icon material is CLONED per icon so each icon owns its texture and
 * its own opacity (used by the drawer's fade-out). Starts on the "off" texture.
 */
export function createIcon(
  buttonObj: SceneObject,
  name: string,
  offTex: Texture | null,
  onTex: Texture | null,
  iconMaterial: Material | null,
  iconSize: number,
  iconForwardOffset: number,
  logger: Logger
): IconHandle | null {
  const initial = offTex ?? onTex
  if (!initial) return null
  if (!iconMaterial) {
    logger.warn("iconMaterial not assigned — '" + name + "' button gets no icon.")
    return null
  }

  const iconObj = global.scene.createSceneObject(name + " Icon")
  iconObj.setParent(buttonObj)
  iconObj.layer = buttonObj.layer
  // Sit just in front of the button face so the icon isn't hidden by it.
  iconObj.getTransform().setLocalPosition(new vec3(0, 0, iconForwardOffset))

  const aspect = textureAspect(initial)
  iconObj.getTransform().setLocalScale(new vec3(iconSize * aspect, iconSize, 1))

  const image = iconObj.createComponent("Component.Image") as Image
  const mat = iconMaterial.clone()
  image.clearMaterials()
  image.addMaterial(mat)
  image.mainPass.baseTex = initial
  image.mainPass.baseColor = new vec4(1, 1, 1, 1)
  return { image, offTex, onTex }
}

export function textureAspect(tex: Texture): number {
  const w = tex.getWidth()
  const h = tex.getHeight()
  return w > 0 && h > 0 ? w / h : 1
}

// Swaps the icon's texture to reflect toggle state. Falls back to whichever
// texture exists when only one was provided (e.g. a momentary button's icon).
export function setIconSelected(icon: IconHandle | null, selected: boolean): void {
  if (!icon || !icon.image || !icon.image.mainPass) return
  const tex = selected ? (icon.onTex ?? icon.offTex) : (icon.offTex ?? icon.onTex)
  if (tex) icon.image.mainPass.baseTex = tex
}

// Sets the icon's overall opacity (cloned material, so per-icon). Used by the
// share drawer's fade-out on the selected pic.
export function setIconOpacity(icon: IconHandle | null, alpha: number): void {
  if (!icon || !icon.image || !icon.image.mainPass) return
  icon.image.mainPass.baseColor = new vec4(1, 1, 1, alpha)
}
