import { timeAt } from './profile';
import type { Checkpoint, SplitResult, TimeProfile } from './types';

/** A final gap shorter than this fraction of the interval is merged into the last split. */
const MERGE_FRACTION = 0.4;

/** Checkpoint spacing (m) for a route length (m): ≤ 1.5 km → 100, ≤ 5 km → 250, ≤ 12 km → 500, else 1000. */
export function checkpointInterval(length: number): number {
  if (length <= 1500) return 100;
  if (length <= 5000) return 250;
  if (length <= 12000) return 500;
  return 1000;
}

/**
 * Checkpoints at every multiple of `interval` plus one at `length`; when the last regular checkpoint
 * would leave a final gap < 0.4 × interval, it is dropped so that gap merges into the final split.
 * `index` is the 0-based position in the returned list. Elapsed times come from `target` (the ghost,
 * or the reference when there is no target) and `reference`.
 */
export function buildCheckpoints(
  length: number,
  target: TimeProfile,
  reference: TimeProfile,
  interval: number = checkpointInterval(length),
): Checkpoint[] {
  if (!(length > 0) || !Number.isFinite(length)) throw new RangeError('buildCheckpoints: length must be positive');
  if (!(interval > 0) || !Number.isFinite(interval)) throw new RangeError('buildCheckpoints: interval must be positive');

  const ds: number[] = [];
  for (let k = 1; k * interval < length; k++) ds.push(k * interval);
  if (ds.length > 0 && length - ds[ds.length - 1] < MERGE_FRACTION * interval) ds.pop();
  ds.push(length);

  let prevElapsed = 0;
  return ds.map((d, index) => {
    const targetElapsed = timeAt(target, d);
    const cp: Checkpoint = {
      index,
      d,
      targetElapsed,
      targetSplit: targetElapsed - prevElapsed,
      referenceElapsed: timeAt(reference, d),
    };
    prevElapsed = targetElapsed;
    return cp;
  });
}

/** Records checkpoint crossings as progress advances. Checkpoints are crossed in order, once each. */
export class SplitTracker {
  private readonly cps: readonly Checkpoint[];
  private readonly done: SplitResult[] = [];

  constructor(cps: Checkpoint[]) {
    this.cps = [...cps].sort((a, b) => a.d - b.d);
  }

  /**
   * Advances from (prevProgress, prevRunSec) to (progress, runSec) and returns the checkpoints crossed,
   * possibly several. Crossing time is linearly interpolated:
   * t = prevRunSec + (cp.d − prevProgress) / (progress − prevProgress) × (runSec − prevRunSec),
   * with the fraction clamped to [0, 1] (a checkpoint already behind prevProgress gets prevRunSec).
   */
  update(prevProgress: number, prevRunSec: number, progress: number, runSec: number): SplitResult[] {
    const out: SplitResult[] = [];
    const span = progress - prevProgress;
    while (this.done.length < this.cps.length) {
      const cp = this.cps[this.done.length];
      if (cp.d > progress) break;
      const f = span > 0 ? Math.min(1, Math.max(0, (cp.d - prevProgress) / span)) : 0;
      const actualElapsed = prevRunSec + f * (runSec - prevRunSec);
      const prev = this.done[this.done.length - 1];
      const actualSplit = actualElapsed - (prev ? prev.actualElapsed : 0);
      const result: SplitResult = {
        ...cp,
        actualElapsed,
        actualSplit,
        splitDiff: cp.targetSplit - actualSplit,
        cumulativeDiff: cp.targetElapsed - actualElapsed,
      };
      this.done.push(result);
      out.push(result);
    }
    return out;
  }

  /** The first not-yet-crossed checkpoint beyond `progress`, or null. */
  next(progress: number): Checkpoint | null {
    for (let i = this.done.length; i < this.cps.length; i++) {
      if (this.cps[i].d > progress) return this.cps[i];
    }
    return null;
  }

  /** Every crossed checkpoint so far, in route order. */
  results(): SplitResult[] {
    return [...this.done];
  }
}
