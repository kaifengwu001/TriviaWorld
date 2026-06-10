/**
 * Specs Inc. 2026
 * CardButtonHost – adapts the two card kinds the action-button rail can wrap.
 *
 * The like/comment/delete rail (CardActionButtons) and its watcher
 * (CardActionButtonsController) don't care whether a card is a captured Scanner
 * card (PictureBehavior) or a premade card (PremadeCard) spawned by
 * PingCardSpawner. Each card kind implements this small interface so the rail
 * can: parent + place itself, know when the card is ready to show buttons,
 * engage the voice agent (comment), and delete the card.
 *
 *   - PictureHost  : wraps a captured card. World-space rail placement off the
 *     card's static frame; comment + tap both engage and highlight; delete
 *     drops the card from the CardStore and destroys it.
 *   - PremadeHost  : wraps a PremadeCard. LOCAL rail placement parented to the
 *     billboarding card root (so it tracks the card); ready once the card has
 *     expanded; delete just turns the instance OFF and never touches the store
 *     (these are demo visuals, not database-backed cards).
 */
import { PictureBehavior } from "../PictureBehavior"
import { PremadeCard } from "../PremadeCard/PremadeCard"
import { CardEditTarget } from "../Cards/CardEditTools"

export interface CardButtonHost {
  /** The object the rail is parented to (and that delete destroys). */
  getRoot(): SceneObject
  /**
   * Positions the freshly-created rail root. `rightInset` is how far (cm) right
   * of the card's right edge the rail's vertical centre line sits; `forward` is
   * the push toward the viewer along the card normal.
   */
  placeRail(railRoot: SceneObject, rightInset: number, forward: number): void
  /** True once the card should show its buttons (caption loaded / card open). */
  isReady(): boolean
  /** True if the card is already "highlighted" the moment the rail attaches. */
  shouldStartEngaged(): boolean
  /** Engage the voice agent on this card (comment button / card tap). */
  engage(): void
  /** Register a callback fired when the card engages by another path; may no-op. */
  addOnEngaged(cb: () => void): void
  /** Remove the card from the CardStore if it lives there (else no-op). */
  removeFromStore(): void
  /**
   * Dispose of the card on delete: destroy it (captured cards) or just turn it
   * off (premade cards, which are reusable visuals, not stored data). Deferred a
   * frame by the controller so it never tears down the button mid-callback. After
   * this, getRoot() may be destroyed/disabled — do not touch it again.
   */
  disposeObject(): void
}

/** Builds the right host for a scanner/card child, or null if it is neither. */
export function makeCardButtonHost(obj: SceneObject): CardButtonHost | null {
  const pb = (obj as any).getComponent(PictureBehavior.getTypeName()) as PictureBehavior
  if (pb) return new PictureHost(obj, pb)
  const card = (obj as any).getComponent(PremadeCard.getTypeName()) as PremadeCard
  if (card) return new PremadeHost(obj, card)
  return null
}

/** Captured Scanner card (PictureBehavior). */
class PictureHost implements CardButtonHost {
  constructor(private root: SceneObject, private pb: PictureBehavior) {}

  getRoot(): SceneObject {
    return this.root
  }

  placeRail(railRoot: SceneObject, rightInset: number, forward: number): void {
    // The captured card is static after capture, so a one-time WORLD placement
    // off its frame is enough (mirrors the original rail placement).
    const frame = this.pb.getCardFrame()
    const pos = frame.corner
      .add(frame.right.uniformScale(rightInset))
      .add(frame.normal.uniformScale(forward))
    const t = railRoot.getTransform()
    t.setWorldRotation(this.pb.picAnchorObj.getTransform().getWorldRotation())
    t.setWorldPosition(pos)
    t.setWorldScale(vec3.one())
  }

  isReady(): boolean {
    // Topics resolve when the AI caption has loaded — the card is finished.
    return this.pb.getResolvedTopics() !== null
  }

  shouldStartEngaged(): boolean {
    // The capture flow auto-engages the agent as the caption loads.
    return true
  }

  engage(): void {
    this.pb.engage()
  }

  addOnEngaged(cb: () => void): void {
    this.pb.addOnEngaged(cb)
  }

  removeFromStore(): void {
    const id = this.pb.getStoredCardId()
    if (!id) return
    const store = (global as any).cropCardStore
    if (store && typeof store.removeCard === "function") store.removeCard(id)
  }

  disposeObject(): void {
    // Captured cards are one-shot: a deleted card is gone for good.
    this.root.destroy()
  }
}

/** Premade card (PremadeCard), e.g. spawned by PingCardSpawner. */
class PremadeHost implements CardButtonHost {
  constructor(private root: SceneObject, private card: PremadeCard) {}

  getRoot(): SceneObject {
    return this.root
  }

  placeRail(railRoot: SceneObject, rightInset: number, forward: number): void {
    // Parented to the billboarding card root, so LOCAL placement makes the rail
    // track the card automatically. The card's footprint is centred at
    // getContentLocalCenter() (NOT the root origin — the caption hangs below the
    // picture), so the top-right corner is centre + size/2. Both are root-local
    // cm, valid once isContentMeasured().
    const size = this.card.getContentLocalSize()
    const center = this.card.getContentLocalCenter()
    const t = railRoot.getTransform()
    t.setLocalRotation(quat.quatIdentity())
    t.setLocalPosition(
      new vec3(center.x + size.x * 0.5 + rightInset, center.y + size.y * 0.5, forward)
    )
    t.setLocalScale(vec3.one())
  }

  isReady(): boolean {
    // Show buttons once the bubble has expanded into a card and its footprint
    // is known (so the rail can sit off the real right edge).
    return this.card.isExpanded() && this.card.isContentMeasured()
  }

  shouldStartEngaged(): boolean {
    return false
  }

  engage(): void {
    const agent = (global as any).cardVoiceAgent
    if (!agent || typeof agent.engageCard !== "function") return
    // These cards aren't in the CardStore, so the edit target has no id; spoken
    // edits animate on the live card via setText (good enough for the demo).
    const target: CardEditTarget = {
      getCardId: () => null,
      getText: () => this.card.getText(),
      setTextAnimated: (t: string) => this.card.setText(t),
    }
    agent.engageCard(this.card.getText(), target)
  }

  addOnEngaged(_cb: () => void): void {
    // No external engage path for premade cards (no card-tap-to-engage).
  }

  removeFromStore(): void {
    // Ping/premade cards are visuals only; nothing to remove from the store.
  }

  disposeObject(): void {
    // Premade cards aren't database-backed, so delete just hides the card (and
    // its rail, a child of the root) rather than destroying it. The PingCardSpawner
    // still owns the instance and can clear/recycle it on a later wave.
    this.root.enabled = false
  }
}
