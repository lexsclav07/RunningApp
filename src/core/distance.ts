import { haversine } from './geo';
import type { GpsFix } from './types';

/** Minimum credited step, m. */
const MIN_STEP = 3;
/** Accuracy assumed when a fix reports none, m. */
const NULL_ACCURACY = 10;
/**
 * A valid reported (Doppler) speed below this, m/s, means the runner is standing: the fix only
 * re-anchors. Doppler speed is far more reliable than position differences at rest, and without this
 * slow position wander while standing (e.g. at a crossing) accumulates phantom distance.
 */
export const STATIONARY_SPEED = 0.5;

/**
 * Filtered distance actually run. Anchor-based: a fix adds its distance from the anchor only when that
 * displacement is ≥ max(3, 0.5 × max(hAcc_anchor, hAcc_fix)) m; the anchor then moves to the fix.
 * Feed it accepted fixes only (see `classifyFix`).
 */
export class DistanceAccumulator {
  private anchor: GpsFix | null = null;
  private sum = 0;

  add(fix: GpsFix): { delta: number; total: number } {
    const anchor = this.anchor;
    const standing = fix.speed !== null && fix.speed >= 0 && fix.speed < STATIONARY_SPEED;
    if (!anchor || standing) {
      this.anchor = fix;
      return { delta: 0, total: this.sum };
    }
    const d = haversine(anchor, fix);
    const threshold = Math.max(MIN_STEP, 0.5 * Math.max(anchor.hAcc ?? NULL_ACCURACY, fix.hAcc ?? NULL_ACCURACY));
    if (d < threshold) return { delta: 0, total: this.sum };
    this.sum += d;
    this.anchor = fix;
    return { delta: d, total: this.sum };
  }

  /** Drops the anchor (e.g. on resume) so the next fix starts a new segment; keeps the total. */
  reset(): void {
    this.anchor = null;
  }

  get total(): number {
    return this.sum;
  }
}
