/**
 * Specs Inc. 2026
 * TypewriterText — a small, host-ticked typewriter animation for a Text string.
 *
 * Given a getter/setter over some text, animateTo(target) plays a "delete then
 * type" edit between the current text and the target: it keeps the longest common
 * PREFIX and SUFFIX, back-spaces the diverging middle character-by-character, then
 * types the new middle in. So a correction deletes/retypes only the words that
 * changed, and an append (target = prefix + insertion + same trailing hashtags)
 * types the new sentence in place while the hashtags — the common suffix — never move.
 *
 * It is a pure state machine: it owns no events. The host (e.g. CaptionBehavior)
 * calls tick(dt) from its own UpdateEvent. Mid-animation calls to animateTo()
 * retarget cleanly from whatever is currently displayed.
 */

interface TypewriterOptions {
  getText(): string;
  setText(s: string): void;
  /** Edit speed in characters per second (delete and type share this rate). */
  charsPerSec?: number;
}

export class TypewriterText {
  private getText: () => string;
  private setText: (s: string) => void;
  private interval: number;

  // Edit plan: result is `prefix + middle + suffix` where `middle` grows from the
  // old middle (deleting) down to "" then up to the new middle (typing).
  private prefix = "";
  private suffix = "";
  private oldMiddle = "";
  private newMiddle = "";
  private cursor = 0; // chars of oldMiddle still shown while deleting; of newMiddle while typing
  private phase: "idle" | "deleting" | "typing" = "idle";
  private accum = 0;

  constructor(opts: TypewriterOptions) {
    this.getText = opts.getText;
    this.setText = opts.setText;
    const cps = opts.charsPerSec && opts.charsPerSec > 0 ? opts.charsPerSec : 28;
    this.interval = 1 / cps;
  }

  isAnimating(): boolean {
    return this.phase !== "idle";
  }

  /** Begin animating from the currently displayed text to `target`. */
  animateTo(target: string): void {
    const current = this.getText() ?? "";
    target = target ?? "";
    if (target === current) {
      this.phase = "idle";
      return;
    }

    const p = commonPrefixLen(current, target);
    // Cap the suffix so prefix and suffix never overlap on either string.
    const maxSuffix = Math.min(current.length - p, target.length - p);
    const s = Math.min(commonSuffixLen(current, target), maxSuffix);

    this.prefix = current.slice(0, p);
    this.suffix = s > 0 ? current.slice(current.length - s) : "";
    this.oldMiddle = current.slice(p, current.length - s);
    this.newMiddle = target.slice(p, target.length - s);

    this.accum = 0;
    if (this.oldMiddle.length > 0) {
      this.phase = "deleting";
      this.cursor = this.oldMiddle.length;
    } else {
      this.phase = "typing";
      this.cursor = 0;
    }
    this.render();
  }

  /** Advance the animation; call once per frame from the host's UpdateEvent. */
  tick(dt: number): void {
    if (this.phase === "idle") return;
    this.accum += dt;
    // Allow several chars per frame if the frame was long, so edits stay snappy.
    let steps = Math.floor(this.accum / this.interval);
    if (steps <= 0) return;
    this.accum -= steps * this.interval;

    while (steps-- > 0 && this.phase !== "idle") {
      if (this.phase === "deleting") {
        this.cursor -= 1;
        if (this.cursor <= 0) {
          this.cursor = 0;
          this.phase = this.newMiddle.length > 0 ? "typing" : "idle";
        }
      } else if (this.phase === "typing") {
        this.cursor += 1;
        if (this.cursor >= this.newMiddle.length) {
          this.cursor = this.newMiddle.length;
          this.phase = "idle";
        }
      }
    }
    this.render();
  }

  private render(): void {
    const middle =
      this.phase === "typing" || (this.phase === "idle" && this.newMiddle.length > 0)
        ? this.newMiddle.slice(0, this.cursor)
        : this.oldMiddle.slice(0, this.cursor);
    this.setText(this.prefix + middle + this.suffix);
  }
}

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

function commonSuffixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++;
  return i;
}
