/**
 * Specs Inc. 2026
 * Card morph timeline for the Premade Card feature.
 *
 * Pure state, no engine dependency: tracks a linear morph value in [0, 1] that
 * eases toward a target over a fixed duration. 0 = bubble (blob), 1 = card
 * (rounded rect). The shape easing itself lives in BubbleMesh; this only feeds it
 * a linear progress and reports when the card is "open enough" to show content.
 */

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

export class CardMorph {
  private current: number
  private target: number

  constructor(
    start: number,
    private duration: number,
    private showThreshold: number
  ) {
    this.current = clamp01(start)
    this.target = this.current
  }

  /** Linear morph value in [0, 1]; feed straight to BubbleMesh.setProgress. */
  get progress(): number {
    return this.current
  }

  /** True once the card is open enough that the picture and text should show. */
  get contentVisible(): boolean {
    return this.current >= this.showThreshold
  }

  get isAnimating(): boolean {
    return this.current !== this.target
  }

  expand(): void {
    this.target = 1
  }

  collapse(): void {
    this.target = 0
  }

  toggle(): void {
    this.target = this.target >= 0.5 ? 0 : 1
  }

  setExpanded(expanded: boolean): void {
    this.target = expanded ? 1 : 0
  }

  /** Jumps straight to the expanded/collapsed end state with no animation. */
  snap(expanded: boolean): void {
    this.target = expanded ? 1 : 0
    this.current = this.target
  }

  /** Advances `current` toward `target`; returns true if it changed this step. */
  step(dt: number): boolean {
    if (this.current === this.target) return false
    const rate = this.duration > 0 ? dt / this.duration : 1
    if (this.current < this.target) {
      this.current = Math.min(this.target, this.current + rate)
    } else {
      this.current = Math.max(this.target, this.current - rate)
    }
    return true
  }
}
