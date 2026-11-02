import { DistanceAccumulator } from './distance';
import type { Climb, GpsFix, RoutePoint } from './types';

/** Altitudes whose vertical accuracy is worse than this (m) are ignored. */
const MAX_VACC = 20;
/** Share of fixes that must carry a usable altitude for elevation to count as reliable. */
const MIN_USABLE_SHARE = 0.6;
/** The smoothed altitude may change by at most MAX_STEP_M over any STEP_SPAN_M of distance (300 % grade). */
const MAX_STEP_M = 15;
const STEP_SPAN_M = 5;
/** Gaps in the altitude series up to this length (m) are bridged. */
const MAX_GAP_M = 100;
/** Window (m) of the grades used for climb detection. */
const CLIMB_GRADE_WINDOW_M = 50;
/** Steep runs separated by at most this (m) are one climb (a short easing mid-climb). */
const CLIMB_MERGE_GAP_M = 40;
/** A climb's ends may move outward by up to this (m) to reach the true foot and top, which the grade window blurs. */
const CLIMB_EDGE_M = CLIMB_MERGE_GAP_M / 2;

/** The fix's altitude (m) if usable: present, finite, and vAcc null or within 0…20 m (iOS: vAcc < 0 = invalid). */
export function usableAltitude(fix: GpsFix): number | null {
  if (fix.alt === null || !Number.isFinite(fix.alt)) return null;
  if (fix.vAcc !== null && (fix.vAcc < 0 || fix.vAcc > MAX_VACC)) return null;
  return fix.alt;
}

/**
 * Whether a recording's altitude can be trusted: ≥ 60 % of the fixes have a usable altitude, and the
 * smoothed series (along the filtered distance of the fixes) never changes by more than 15 m per 5 m.
 */
export function assessElevation(fixes: GpsFix[]): boolean {
  if (fixes.length === 0) return false;
  const alt = fixes.map(usableAltitude);
  const usable = alt.filter((a) => a !== null).length;
  if (usable < MIN_USABLE_SHARE * fixes.length) return false;
  // along-track distance by the same anchor rule as the run distance, so standing still adds none
  const acc = new DistanceAccumulator();
  const d = fixes.map((f) => acc.add(f).total);
  const smooth = smoothElevation(d, alt);
  const ds: number[] = [];
  const vs: number[] = [];
  smooth.forEach((v, i) => {
    if (v !== null) {
      ds.push(d[i]);
      vs.push(v);
    }
  });
  if (vs.length === 0) return false;
  // sample the smoothed series every STEP_SPAN_M metres and compare neighbours
  let prev = vs[0];
  for (let x = ds[0] + STEP_SPAN_M; x < ds[ds.length - 1] + STEP_SPAN_M; x += STEP_SPAN_M) {
    const v = valueAt(ds, vs, Math.min(x, ds[ds.length - 1]));
    if (Math.abs(v - prev) > MAX_STEP_M) return false;
    prev = v;
  }
  return true;
}

/**
 * Smooths an altitude series sampled at non-decreasing distances `d` (m):
 * 1. median of the (up to 5) non-null samples i−2…i+2, which removes isolated spikes;
 * 2. mean of those medians over the centred distance window |d_j − d_i| ≤ windowM / 2;
 * 3. gaps (null runs) spanning ≤ 100 m are filled: linearly between the values either side, or by
 *    holding the nearest value at either end of the series. Longer gaps stay null.
 */
export function smoothElevation(d: number[], ele: (number | null)[], windowM = 40): (number | null)[] {
  const n = Math.min(d.length, ele.length);
  const med: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    if (ele[i] === null) {
      med.push(null);
      continue;
    }
    const w: number[] = [];
    for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) {
      const v = ele[j];
      if (v !== null) w.push(v);
    }
    med.push(median(w));
  }

  // two-pointer running mean over the window [d_i − h, d_i + h]
  const h = windowM / 2;
  const out: (number | null)[] = [];
  let lo = 0;
  let hi = 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    for (; hi < n && d[hi] <= d[i] + h; hi++) {
      const v = med[hi];
      if (v !== null) {
        sum += v;
        count++;
      }
    }
    for (; lo < hi && d[lo] < d[i] - h; lo++) {
      const v = med[lo];
      if (v !== null) {
        sum -= v;
        count--;
      }
    }
    out.push(med[i] === null || count === 0 ? null : sum / count);
  }

  fillGaps(d, out);
  return out;
}

/** Fills null runs of `v` in place where they span ≤ MAX_GAP_M (see `smoothElevation`). */
function fillGaps(d: number[], v: (number | null)[]): void {
  let last = -1; // index of the last non-null value
  for (let i = 0; i <= v.length; i++) {
    if (i < v.length && v[i] === null) continue;
    if (i - last > 1) {
      // null run (last, i)
      if (last < 0 && i < v.length) {
        if (d[i] - d[0] <= MAX_GAP_M) for (let k = 0; k < i; k++) v[k] = v[i];
      } else if (last >= 0 && i === v.length) {
        if (d[v.length - 1] - d[last] <= MAX_GAP_M) for (let k = last + 1; k < i; k++) v[k] = v[last];
      } else if (last >= 0 && d[i] - d[last] <= MAX_GAP_M) {
        const a = v[last] as number;
        const b = v[i] as number;
        const span = d[i] - d[last];
        // linear in distance: a + (b − a)·(d_k − d_last)/(d_i − d_last)
        for (let k = last + 1; k < i; k++) v[k] = span > 0 ? a + ((b - a) * (d[k] - d[last])) / span : a;
      }
    }
    last = i;
  }
}

/**
 * Total climb and descent (m) of an altitude series, counting a change of direction only once it
 * exceeds `hysteresis` metres; each confirmed rise or fall is counted at its full size.
 */
export function gainLoss(ele: number[], hysteresis = 3): { gain: number; loss: number } {
  let gain = 0;
  let loss = 0;
  if (ele.length === 0) return { gain, loss };
  let dir = 0; // +1 rising, −1 falling, 0 not yet known
  let lo = ele[0]; // extremes seen while dir = 0
  let hi = ele[0];
  let base = ele[0]; // last confirmed turning point
  let peak = ele[0]; // extreme of the current trend
  for (const x of ele) {
    if (dir === 0) {
      if (x - lo >= hysteresis) [dir, base, peak] = [1, lo, x];
      else if (hi - x >= hysteresis) [dir, base, peak] = [-1, hi, x];
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    } else if (dir === 1) {
      if (x > peak) peak = x;
      else if (peak - x >= hysteresis) {
        gain += peak - base;
        [dir, base, peak] = [-1, peak, x];
      }
    } else if (x < peak) peak = x;
    else if (x - peak >= hysteresis) {
      loss += base - peak;
      [dir, base, peak] = [1, peak, x];
    }
  }
  if (dir === 1) gain += peak - base;
  else if (dir === -1) loss += base - peak;
  return { gain, loss };
}

/**
 * Grade (rise / run, 0.1 = 10 %) at each point: the elevation change across the centred window
 * [d − windowM/2, d + windowM/2] (clamped to the series ends) divided by its length.
 */
export function grades(d: number[], ele: number[], windowM = 50): number[] {
  const n = Math.min(d.length, ele.length);
  if (n === 0) return [];
  const first = d[0];
  const last = d[n - 1];
  const h = windowM / 2;
  return d.slice(0, n).map((x) => {
    const a = Math.max(first, x - h);
    const b = Math.min(last, x + h);
    return b > a ? (valueAt(d, ele, b) - valueAt(d, ele, a)) / (b - a) : 0;
  });
}

/**
 * Meaningful climbs along a route. Points whose 50 m grade is ≥ minGrade form steep runs; runs at most
 * 40 m apart merge. Each run is widened (≤ 20 m per side, while the elevation keeps rising) to undo the
 * grade window's blur, then trimmed to its lowest point before its highest point. A climb is kept when
 * it is ≥ minLength long and gains ≥ minGain. `[]` when any point lacks elevation.
 */
export function detectClimbs(
  points: RoutePoint[],
  opts: { minGrade?: number; minLength?: number; minGain?: number } = {},
): Climb[] {
  const minGrade = opts.minGrade ?? 0.04;
  const minLength = opts.minLength ?? 80;
  const minGain = opts.minGain ?? 6;
  if (points.length < 2 || points.some((p) => p.ele === null)) return [];
  const n = points.length;
  const d = points.map((p) => p.d);
  const ele = points.map((p) => p.ele as number);
  const g = grades(d, ele, CLIMB_GRADE_WINDOW_M);

  const runs: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    if (g[i] < minGrade) continue;
    const prev = runs[runs.length - 1];
    if (prev && (prev[1] === i - 1 || d[i] - d[prev[1]] <= CLIMB_MERGE_GAP_M)) prev[1] = i;
    else runs.push([i, i]);
  }

  const climbs: Climb[] = [];
  for (const [s, e] of runs) {
    let i = s;
    while (i > 0 && d[s] - d[i - 1] <= CLIMB_EDGE_M && ele[i - 1] < ele[i]) i--;
    let j = e;
    while (j < n - 1 && d[j + 1] - d[e] <= CLIMB_EDGE_M && ele[j + 1] > ele[j]) j++;
    let top = i; // first highest point
    for (let k = i; k <= j; k++) if (ele[k] > ele[top]) top = k;
    let foot = i; // last lowest point before the top
    for (let k = i; k <= top; k++) if (ele[k] <= ele[foot]) foot = k;
    const length = d[top] - d[foot];
    const gain = ele[top] - ele[foot];
    if (length < minLength || gain < minGain) continue;
    let maxGrade = -Infinity;
    for (let k = foot; k <= top; k++) maxGrade = Math.max(maxGrade, g[k]);
    climbs.push({ startD: d[foot], endD: d[top], gain, avgGrade: gain / length, maxGrade });
  }
  return climbs;
}

/** The nearest climb starting ahead of `progress` (m) within `lookahead` metres, with the distance to its start. */
export function upcomingClimb(
  climbs: Climb[],
  progress: number,
  lookahead = 250,
): { distanceTo: number; climb: Climb } | null {
  let next: Climb | null = null;
  for (const c of climbs) if (c.startD > progress && (next === null || c.startD < next.startD)) next = c;
  if (next === null || next.startD - progress > lookahead) return null;
  return { distanceTo: next.startD - progress, climb: next };
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Linear interpolation of v at x over non-decreasing d, clamped to the ends (repeated d: the last such sample). */
function valueAt(d: number[], v: number[], x: number): number {
  const n = Math.min(d.length, v.length);
  if (x <= d[0]) return v[0];
  if (x >= d[n - 1]) return v[n - 1];
  // largest i with d[i] ≤ x
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (d[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  const span = d[lo + 1] - d[lo];
  return span > 0 ? v[lo] + ((v[lo + 1] - v[lo]) * (x - d[lo])) / span : v[lo];
}
