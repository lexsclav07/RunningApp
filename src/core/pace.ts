/** Speed (m/s) at or above which the runner counts as moving. */
export const MOVING_SPEED = 0.8;

const WINDOW_SEC = 20;
const MIN_WINDOW_M = 30;
const MIN_DISTANCE_M = 15;
const STALE_SEC = 10;
const ALPHA = 0.3;
/** Samples older than this (s) are dropped, keeping one so a gap can still be bridged. */
const RETAIN_SEC = 120;

/**
 * Smoothed current pace from (run time, filtered distance) samples. On each push: take the trailing
 * 20 s window, extend it back until it covers ≥ 30 m, and if it holds ≥ 15 m at ≥ MOVING_SPEED the raw
 * pace (sec/km) feeds an EMA (α = 0.3); otherwise the smoothing restarts. A push that does not advance
 * the distance (or the time) is ignored, so standing still reads as "no push": `current` is null when
 * there is no smoothed value or the last kept push is more than 10 s old. Reading `current` never
 * changes state, so ticks and replays give identical values.
 */
export class PaceEstimator {
  private ts: number[] = [];
  private ds: number[] = [];
  private ema: number | null = null;

  push(runSec: number, distance: number): void {
    const n = this.ts.length;
    // Only samples that advance the distance are kept: the accumulator credits distance in anchor steps,
    // so a sample taken between steps lags the true distance by up to one step.
    if (n > 0 && (runSec <= this.ts[n - 1] || distance <= this.ds[n - 1])) return;
    this.ts.push(runSec);
    this.ds.push(distance);
    while (this.ts.length > 2 && this.ts[1] < runSec - RETAIN_SEC) {
      this.ts.shift();
      this.ds.shift();
    }
    const raw = this.windowPace();
    this.ema = raw === null ? null : this.ema === null ? raw : this.ema + ALPHA * (raw - this.ema);
  }

  reset(): void {
    this.ts = [];
    this.ds = [];
    this.ema = null;
  }

  current(runSec: number): number | null {
    const n = this.ts.length;
    if (n === 0 || runSec - this.ts[n - 1] > STALE_SEC) return null;
    return this.ema;
  }

  /** Raw pace over the window ending at the newest sample, sec/km, or null. */
  private windowPace(): number | null {
    const last = this.ts.length - 1;
    const t = this.ts[last];
    const d = this.ds[last];
    let j = last;
    while (j > 0 && this.ts[j - 1] >= t - WINDOW_SEC) j--;
    while (j > 0 && d - this.ds[j] < MIN_WINDOW_M) j--;
    const dist = d - this.ds[j];
    const dt = t - this.ts[j];
    if (dt <= 0 || dist < MIN_DISTANCE_M) return null;
    const speed = dist / dt; // m/s
    if (speed < MOVING_SPEED) return null;
    return 1000 / speed; // sec/km = 1000 m ÷ (m/s)
  }
}
