import { timeAt } from './profile';
import type { TimeProfile } from './types';

export interface RouteStats {
  count: number;
  totalDistance: number;
  best: { runId: string; finishSec: number } | null;
  latest: { runId: string; finishSec: number } | null;
  averageSec: number | null;
  baselineSec: number | null;
  /** latest − baseline, s (negative = faster than the baseline). */
  changeFromBaselineSec: number | null;
  trend: 'improving' | 'declining' | 'steady' | null;
  /** Finished runs, oldest first. */
  series: { runId: string; startedAt: number; finishSec: number }[];
}

/** One run on the route, as `routeStats` needs it (finishSec null = did not complete the route). */
export interface RouteRunInput { id: string; startedAt: number; finishSec: number | null; distance: number }

/** The trend uses at most this many of the latest finishes… */
const TREND_RUNS = 6;
/** …needs at least this many… */
const TREND_MIN_RUNS = 3;
/** …and calls a slope steeper than ±this (s per run) improving or declining. */
const TREND_SLOPE = 1;

/**
 * History statistics for one route. Every run counts towards `count` and `totalDistance`; times come
 * from finished runs only (finishSec ≠ null). `trend` is the least-squares slope of finish time against
 * run order over the last ≤ 6 finishes: < −1 s/run improving, > +1 declining, else steady; null with < 3.
 */
export function routeStats(runs: RouteRunInput[], baselineRunId: string): RouteStats {
  const finished = runs
    .filter((r): r is RouteRunInput & { finishSec: number } => r.finishSec !== null && Number.isFinite(r.finishSec))
    .map((r, i) => ({ ...r, i }))
    .sort((a, b) => a.startedAt - b.startedAt || a.i - b.i);
  const series = finished.map((r) => ({ runId: r.id, startedAt: r.startedAt, finishSec: r.finishSec }));

  let best: RouteStats['best'] = null;
  for (const r of finished) if (best === null || r.finishSec < best.finishSec) best = { runId: r.id, finishSec: r.finishSec };
  const last = finished[finished.length - 1];
  const latest = last ? { runId: last.id, finishSec: last.finishSec } : null;
  const baselineSec = runs.find((r) => r.id === baselineRunId)?.finishSec ?? null;

  return {
    count: runs.length,
    totalDistance: runs.reduce((sum, r) => sum + r.distance, 0),
    best,
    latest,
    averageSec: finished.length > 0 ? finished.reduce((sum, r) => sum + r.finishSec, 0) / finished.length : null,
    baselineSec,
    changeFromBaselineSec: latest && baselineSec !== null ? latest.finishSec - baselineSec : null,
    trend: trendOf(finished.slice(-TREND_RUNS).map((r) => r.finishSec)),
    series,
  };
}

function trendOf(ys: number[]): RouteStats['trend'] {
  const n = ys.length;
  if (n < TREND_MIN_RUNS) return null;
  // least squares with x = 0…n−1: slope = Σ(x − x̄)(y − ȳ) / Σ(x − x̄)², in s per run
  const xMean = (n - 1) / 2;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  ys.forEach((y, x) => {
    num += (x - xMean) * (y - yMean);
    den += (x - xMean) ** 2;
  });
  const slope = num / den;
  if (slope < -TREND_SLOPE) return 'improving';
  if (slope > TREND_SLOPE) return 'declining';
  return 'steady';
}

/** Two runs' times at the given route distances; diff = b − a (positive = b slower there). */
export function compareProfiles(
  a: TimeProfile,
  b: TimeProfile,
  at: number[],
): { d: number; a: number; b: number; diff: number }[] {
  return at.map((d) => {
    const ta = timeAt(a, d);
    const tb = timeAt(b, d);
    return { d, a: ta, b: tb, diff: tb - ta };
  });
}
