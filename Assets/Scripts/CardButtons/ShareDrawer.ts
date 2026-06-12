/**
 * Specs Inc. 2026
 * ShareDrawer – the expandable row of "share to" profile pics for one card's
 * action rail.
 *
 * When the Share button on a card's rail toggles ON, this spawns N (configurable)
 * profile-pic buttons in a horizontal row to the RIGHT of the Share button, each
 * showing a texture from a SEPARATE share-pics list (not the rail's random
 * avatar pool, and shown in list order so the order is authorable). They animate
 * in with a quick scale-up.
 *
 *   - Tapping one share pic: it scales up to 1.5x AND fades out over 0.3s while
 *     every OTHER pic vanishes instantly; the Share button resets to OFF.
 *   - Tapping ANYTHING ELSE in the scene (a pinch that didn't land on a share
 *     pic) shrinks the whole row back to nothing and resets the Share button.
 *   - Toggling the Share button OFF also shrinks the row.
 *
 * The pics are parented to the rail root, so they track/animate with the card
 * and die with it. Per-frame animation is driven by update(dt), forwarded from
 * the controller (this is a plain class with no UpdateEvent of its own).
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger"
import { SIK } from "SpectaclesInteractionKit.lspkg/SIK"
import { createIconButton, IconHandle, setIconOpacity } from "./CardButtonFactory"

export interface ShareDrawerConfig {
  // The rail root the pics are parented to (so they follow the card).
  railRoot: SceneObject
  buttonPrefab: ObjectPrefab
  // The share-pic textures, shown in list order. Separate from the rail's avatar
  // pool so the share row can have different pictures / a different order.
  sharePics: Texture[]
  // How many pics to spawn (clamped to sharePics.length).
  shareCount: number
  iconMaterial: Material | null
  hideButtonVisual: boolean
  buttonWidth: number
  // Horizontal gap (cm) between adjacent pics.
  spacing: number
  // Gap (cm) between the Share button's right edge and the first pic's left edge.
  gap: number
  // Local z (cm) of the pics under the rail root (matches the rail's forward push).
  forward: number
  iconSize: number
  iconForwardOffset: number
  // Local Y (cm, under the rail root) of the Share button — the row's centre line.
  rowLocalY: number
  // Called when the row has fully closed (selected, shrunk, or dismissed) so the
  // owner can reset the Share button to its OFF state.
  onClosed: () => void
  logger: Logger
}

type Pic = {
  obj: SceneObject
  icon: IconHandle | null
}

// "none" idle/open; "in" growing on open; "shrinkOut" dismissing; "selectOut"
// the chosen pic scaling up + fading while the rest are already gone.
type AnimMode = "none" | "in" | "shrinkOut" | "selectOut"

const IN_SEC = 0.15
const SHRINK_SEC = 0.15
const SELECT_SEC = 0.3
const SELECT_SCALE = 1.5
// Ignore the very first pinch right after opening so the gesture that toggled the
// Share button on doesn't immediately dismiss the row it just opened.
const OPEN_GUARD_SEC = 0.25

export class ShareDrawer {
  private pics: Pic[] = []
  private expanded = false
  private animMode: AnimMode = "none"
  private animElapsed = 0
  private animDuration = 0
  private openTime = 0
  // Counts down frames after an outside pinch before we actually shrink, giving a
  // share-pic tap (which lands on trigger-up, same gesture) a chance to win.
  private pendingCollapseTicks = 0

  private rightHand = SIK.HandInputData.getHand("right")
  private leftHand = SIK.HandInputData.getHand("left")
  private pinchSubscribed = false

  constructor(private config: ShareDrawerConfig) {}

  isExpanded(): boolean {
    return this.expanded
  }

  /** Spawns the row and animates it in. No-op if already open. */
  expand(): void {
    if (this.expanded) return
    this.expanded = true
    this.openTime = getTime()
    this.spawnPics()
    if (this.pics.length === 0) {
      // Nothing to show; close immediately so the Share button doesn't stick on.
      this.finishClose()
      return
    }
    this.setAllScale(0)
    this.animMode = "in"
    this.animElapsed = 0
    this.animDuration = IN_SEC
    this.subscribePinch()
  }

  /** Shrinks the row away (Share toggled off, or programmatic close). */
  collapse(): void {
    if (!this.expanded) return
    // A selection in progress should play out; don't interrupt it with a shrink.
    if (this.animMode === "selectOut") return
    this.beginShrink()
  }

  destroy(): void {
    this.unsubscribePinch()
    for (let i = 0; i < this.pics.length; i++) this.destroyPic(this.pics[i])
    this.pics = []
    this.expanded = false
    this.animMode = "none"
  }

  /** Drives the open/close/select animations. Forwarded from the controller. */
  update(dt: number): void {
    if (this.pendingCollapseTicks > 0) {
      this.pendingCollapseTicks -= 1
      if (
        this.pendingCollapseTicks === 0 &&
        this.expanded &&
        (this.animMode === "none" || this.animMode === "in")
      ) {
        this.beginShrink()
      }
    }

    if (this.animMode === "none") return
    this.animElapsed += dt
    const t = this.animDuration > 0 ? Math.min(1, this.animElapsed / this.animDuration) : 1

    switch (this.animMode) {
      case "in": {
        this.setAllScale(this.smooth(t))
        if (t >= 1) {
          this.setAllScale(1)
          this.animMode = "none"
        }
        break
      }
      case "shrinkOut": {
        this.setAllScale(1 - this.smooth(t))
        if (t >= 1) this.finishClose()
        break
      }
      case "selectOut": {
        const scale = 1 + (SELECT_SCALE - 1) * this.smooth(t)
        const pic = this.pics[0]
        if (pic) {
          pic.obj.getTransform().setLocalScale(new vec3(scale, scale, scale))
          setIconOpacity(pic.icon, Math.max(0, 1 - t))
        }
        if (t >= 1) this.finishClose()
        break
      }
    }
  }

  // --- internal --------------------------------------------------------------

  // Tap on a share pic: that pic scales up + fades out; the rest vanish at once;
  // the Share button resets (via onClosed when the fade finishes).
  private select(index: number): void {
    if (!this.expanded) return
    if (this.animMode === "selectOut" || this.animMode === "shrinkOut") return
    this.unsubscribePinch()

    const selected = this.pics[index] ?? null
    for (let i = 0; i < this.pics.length; i++) {
      if (i !== index) this.destroyPic(this.pics[i])
    }
    this.pics = selected ? [selected] : []

    if (!selected) {
      this.finishClose()
      return
    }
    this.animMode = "selectOut"
    this.animElapsed = 0
    this.animDuration = SELECT_SEC
  }

  private spawnPics(): void {
    const pool = this.config.sharePics ?? []
    const count = Math.max(0, Math.min(Math.round(this.config.shareCount), pool.length))
    const step = this.config.buttonWidth + this.config.spacing
    // First pic's centre sits one button-width + gap right of the Share button's
    // centre (its right edge is buttonWidth/2 out; add gap + the pic's own half).
    const firstX = this.config.buttonWidth + this.config.gap

    for (let i = 0; i < count; i++) {
      const tex = pool[i] ?? null
      const localPos = new vec3(firstX + i * step, this.config.rowLocalY, this.config.forward)
      const result = createIconButton({
        prefab: this.config.buttonPrefab,
        parent: this.config.railRoot,
        name: "Share Pic " + i,
        toggleable: false,
        localPos,
        buttonWidth: this.config.buttonWidth,
        hideVisual: this.config.hideButtonVisual,
        iconMaterial: this.config.iconMaterial,
        offTex: tex,
        onTex: null,
        iconSize: this.config.iconSize,
        iconForwardOffset: this.config.iconForwardOffset,
        logger: this.config.logger,
      })
      if (!result.button) continue
      const picIndex = this.pics.length
      result.button.onTriggerUp.add(() => this.select(picIndex))
      this.pics.push({ obj: result.button.getSceneObject(), icon: result.icon })
    }
    this.config.logger.info("Share drawer spawned " + this.pics.length + " pic(s)")
  }

  private beginShrink(): void {
    this.unsubscribePinch()
    this.animMode = "shrinkOut"
    this.animElapsed = 0
    this.animDuration = SHRINK_SEC
  }

  private finishClose(): void {
    for (let i = 0; i < this.pics.length; i++) this.destroyPic(this.pics[i])
    this.pics = []
    this.expanded = false
    this.animMode = "none"
    this.unsubscribePinch()
    this.config.onClosed()
  }

  private setAllScale(s: number): void {
    const v = new vec3(s, s, s)
    for (let i = 0; i < this.pics.length; i++) {
      const pic = this.pics[i]
      if (pic && pic.obj) pic.obj.getTransform().setLocalScale(v)
    }
  }

  private destroyPic(pic: Pic): void {
    if (!pic || !pic.obj) return
    try {
      pic.obj.destroy()
    } catch (e) {
      // Already destroyed alongside the card; nothing to do.
    }
  }

  // Smoothstep for a soft ease in/out on scale.
  private smooth(t: number): number {
    return t * t * (3 - 2 * t)
  }

  // A pinch that didn't select a share pic means "tapped elsewhere" -> dismiss.
  // We defer a couple frames so a share-pic trigger (same gesture, on release)
  // can flip us into selectOut first and cancel the dismiss.
  private onGlobalPinch = (): void => {
    if (!this.expanded) return
    if (this.animMode === "selectOut" || this.animMode === "shrinkOut") return
    if (getTime() - this.openTime < OPEN_GUARD_SEC) return
    this.pendingCollapseTicks = 2
  }

  private subscribePinch(): void {
    if (this.pinchSubscribed) return
    this.rightHand.onPinchUp.add(this.onGlobalPinch)
    this.leftHand.onPinchUp.add(this.onGlobalPinch)
    this.pinchSubscribed = true
  }

  private unsubscribePinch(): void {
    if (!this.pinchSubscribed) return
    this.rightHand.onPinchUp.remove(this.onGlobalPinch)
    this.leftHand.onPinchUp.remove(this.onGlobalPinch)
    this.pinchSubscribed = false
  }
}
