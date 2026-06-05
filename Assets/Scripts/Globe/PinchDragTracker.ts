/**
 * Specs Inc. 2026
 * PinchDragTracker – jitter-filtered world-space drag deltas.
 *
 * Wraps SpectaclesInteractionKit's OneEuroFilter (the same filter the official
 * Frame / InteractableManipulation use to smooth grabs) so a per-frame drag can
 * be consumed as a STABLE delta instead of raw hand jitter. Feed it the running
 * absolute drag point each frame (e.g. the accumulated Interactor dragVector or a
 * planecast point) and it returns the smoothed delta since the previous frame.
 *
 * Stateful by design (the filter must retain history); nothing it returns is
 * mutated in place — every delta is a fresh vec3.
 */
import { OneEuroFilterVec3, OneEuroFilterConfig } from "SpectaclesInteractionKit.lspkg/Utils/OneEuroFilter";

/**
 * Default tuning, matched to InteractableManipulation's smoothing filter:
 * minCutoff trades jitter for lag, beta trades lag for jitter at speed.
 */
const DEFAULT_CONFIG: OneEuroFilterConfig = {
  frequency: 60,
  minCutoff: 2,
  beta: 0.015,
  dcutoff: 1,
};

export class PinchDragTracker {
  private filter: OneEuroFilterVec3;
  private prevFiltered: vec3 | null = null;

  constructor(config: Partial<OneEuroFilterConfig> = {}) {
    this.filter = new OneEuroFilterVec3({ ...DEFAULT_CONFIG, ...config });
  }

  /** Starts a new drag from `point` (absolute). Resets filter history. */
  begin(point: vec3): void {
    this.filter.reset();
    this.prevFiltered = this.filter.filter(point, getTime());
  }

  /**
   * Feeds the latest absolute drag point and returns the SMOOTHED delta since the
   * previous call. Returns a zero vector on the first sample of a drag.
   */
  update(point: vec3): vec3 {
    const cur = this.filter.filter(point, getTime());
    if (!this.prevFiltered) {
      this.prevFiltered = cur;
      return vec3.zero();
    }
    const delta = cur.sub(this.prevFiltered);
    this.prevFiltered = cur;
    return delta;
  }

  /** Ends the current drag and clears history. */
  end(): void {
    this.prevFiltered = null;
    this.filter.reset();
  }
}
