import { finishTime, timeAt } from './profile';
import type { RequiredPace, TimeProfile } from './types';

/** Trailing progress window (m) for the performance ratio. */
const RATIO_WINDOW_M = 400;
/** The ratio stays null until this much progress (m) and run time (s) have been pushed. */
const RATIO_MIN_M = 150;
const RATIO_MIN_SEC = 45;
const RATIO_ALPHA = 0.3;
const RATIO_MIN = 0.5;
const RATIO_MAX = 2;
/** Below this remaining distance (m) no required pace is given. */
const REQUIRED_MIN_M = 50;
/** A required pace faster than this (sec/km) is treated as unachievable. */
const FASTEST_REQUIRED_PACE = 150;
/** At risk when the required ratio is below this share of the current ratio (needs > ~8 % speed-up). */
const RISK_MARGIN = 0.92;

/**
 * Recent performance relative to a reference profile: ratio = actual run time ÷ reference time over the
 * trailing 400 m of progress (1 = on the reference's pace, 1.1 = 10 % slower). Each push computes the
 * raw ratio over the window [p − 400, p] (from the latest sample at or before p − 400, else the first),
 * clamps it to [0.5, 2] and feeds an EMA (α = 0.3). Null until ≥ 150 m and ≥ 45 s have been pushed.
 */
export class PerformanceTracker {
  private readonly reference: TimeProfile;
  /** Samples from the latest one at or before the window start onwards. */
  private ts: number[] = [];
  private ps: number[] = [];
  private first: { t: number; p: number } | null = null;
  private ema: number | null = null;

  constructor(reference: TimeProfile) {
    this.reference = reference;
  }

  push(runSec: number, progress: number): void {
    if (!Number.isFinite(runSec) || !Number.isFinite(progress)) return;
    const n = this.ts.length;
    if (n > 0 && (runSec <= this.ts[n - 1] || progress < this.ps[n - 1])) return;
    this.ts.push(runSec);
    this.ps.push(progress);
    this.first ??= { t: runSec, p: progress };

    // drop samples until ps[0] is the latest one at or before the window start p − 400
    while (this.ps.length > 2 && this.ps[1] <= progress - RATIO_WINDOW_M) {
      this.ts.shift();
      this.ps.shift();
    }
    if (progress - this.first.p < RATIO_MIN_M || runSec - this.first.t < RATIO_MIN_SEC) return;

    const actual = runSec - this.ts[0];
    const ref = timeAt(this.reference, progress) - timeAt(this.reference, this.ps[0]);
    if (!(ref > 0)) return;
    const raw = Math.min(RATIO_MAX, Math.max(RATIO_MIN, actual / ref));
    this.ema = this.ema === null ? raw : this.ema + RATIO_ALPHA * (raw - this.ema);
  }

  ratio(): number | null {
    return this.ema;
  }
}

/**
 * Projected finish time (s), an estimate: runSec + (finish_ref − t_ref(progress)) × ratio, i.e. the
 * reference's remaining time scaled by recent performance. Null without a ratio.
 */
export function projectFinish(reference: TimeProfile, progress: number, runSec: number, ratio: number | null): number | null {
  if (ratio === null) return null;
  return runSec + (finishTime(reference) - timeAt(reference, progress)) * ratio;
}

/**
 * Average pace needed over the rest of the route to finish at `targetFinishSec`:
 * pace = remainingSec / remainingM × 1000 (sec/km). 'unavailable' within the last 50 m, 'missed' when no
 * time is left, 'atRisk' when the pace is faster than 150 s/km or the required ratio
 * (remainingSec ÷ reference time left) is below 0.92 × the current performance ratio. `secPerKm` is
 * given only when 'ok', so an impossible pace is never shown. `remainingSec` may be negative.
 */
export function requiredPace(args: {
  length: number;
  progress: number;
  runSec: number;
  targetFinishSec: number;
  reference: TimeProfile;
  ratio: number | null;
}): RequiredPace {
  const { length, progress, runSec, targetFinishSec, reference, ratio } = args;
  const remainingM = Math.max(0, length - progress);
  const remainingSec = targetFinishSec - runSec;
  if (remainingM < REQUIRED_MIN_M) return { status: 'unavailable', secPerKm: null, remainingSec, remainingM };
  if (remainingSec <= 0) return { status: 'missed', secPerKm: null, remainingSec, remainingM };

  const pace = (remainingSec / remainingM) * 1000;
  const refLeft = finishTime(reference) - timeAt(reference, progress);
  const requiredRatio = refLeft > 0 ? remainingSec / refLeft : null;
  const atRisk =
    pace < FASTEST_REQUIRED_PACE || (ratio !== null && requiredRatio !== null && requiredRatio < RISK_MARGIN * ratio);
  return atRisk
    ? { status: 'atRisk', secPerKm: null, remainingSec, remainingM }
    : { status: 'ok', secPerKm: pace, remainingSec, remainingM };
}
