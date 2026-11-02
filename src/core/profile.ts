import type { TargetSpec, TimeProfile } from './types';

/** A run may end at most this far (m) before the route end and still be completed by extrapolation. */
export const PROFILE_END_TOLERANCE = 30;
/** Trailing distance (m) whose pace is used to extrapolate a profile to the route end. */
const LAST_PACE_WINDOW = 20;

/** Thrown by `makeProfile` when the samples stop too far before the route end to complete the profile. */
export class IncompleteProfileError extends Error {
  constructor(
    readonly lastD: number,
    readonly length: number,
  ) {
    super(`Profile ends at ${lastD.toFixed(1)} m, more than ${PROFILE_END_TOLERANCE} m before the route end (${length.toFixed(1)} m)`);
    this.name = 'IncompleteProfileError';
    Object.setPrototypeOf(this, IncompleteProfileError.prototype);
  }
}

/**
 * Builds a time profile (run time vs route progress) from raw (progress, run time) samples: keeps finite
 * samples with d > 0, sorts them by (d, t), prepends (0, 0), keeps only strictly increasing d (so a
 * repeated progress keeps its earliest time), makes t non-decreasing (running max), and ends exactly
 * at `length`: samples past it are cut at an interpolated t(length); a run ending within 30 m of it is
 * extrapolated at the pace of its last ≈ 20 m; one ending further short throws `IncompleteProfileError`.
 */
export function makeProfile(d: readonly number[], t: readonly number[], length: number): TimeProfile {
  if (d.length !== t.length) throw new RangeError('makeProfile: d and t differ in length');
  if (!(length > 0) || !Number.isFinite(length)) throw new RangeError('makeProfile: length must be a positive number');

  const samples: [number, number][] = [];
  for (let i = 0; i < d.length; i++) {
    if (Number.isFinite(d[i]) && Number.isFinite(t[i]) && d[i] > 0) samples.push([d[i], t[i]]);
  }
  samples.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const outD = [0];
  const outT = [0];
  for (const [sd, st] of samples) {
    const n = outD.length - 1;
    if (sd <= outD[n]) continue;
    const tt = Math.max(outT[n], st);
    if (sd >= length) {
      // cut at the route end: t(length) interpolated between the bracketing samples
      outT.push(outT[n] + ((length - outD[n]) / (sd - outD[n])) * (tt - outT[n]));
      outD.push(length);
      break;
    }
    outD.push(sd);
    outT.push(tt);
  }

  const n = outD.length - 1;
  if (outD[n] < length) {
    if (n === 0 || outD[n] < length - PROFILE_END_TOLERANCE) throw new IncompleteProfileError(outD[n], length);
    // latest earlier point at least LAST_PACE_WINDOW behind the end (or the origin)
    let j = n - 1;
    while (j > 0 && outD[n] - outD[j] < LAST_PACE_WINDOW) j--;
    const pace = (outT[n] - outT[j]) / (outD[n] - outD[j]); // s/m
    outT.push(outT[n] + (length - outD[n]) * pace);
    outD.push(length);
  }
  return { d: outD, t: outT };
}

/** Index i of the segment with d[i] ≤ x < d[i+1] (assumes d[0] ≤ x < d[last]). */
function segmentIndex(xs: readonly number[], x: number): number {
  let lo = 0;
  let hi = xs.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Run time (s) at route progress `d` (m), interpolated linearly and clamped to [0, finish]. */
export function timeAt(p: TimeProfile, d: number): number {
  const last = p.d.length - 1;
  if (!(d > p.d[0])) return p.t[0];
  if (d >= p.d[last]) return p.t[last];
  const i = segmentIndex(p.d, d);
  return p.t[i] + ((d - p.d[i]) / (p.d[i + 1] - p.d[i])) * (p.t[i + 1] - p.t[i]);
}

/**
 * Route progress (m) first reached at run time `t` (s): the inverse of `timeAt`, clamped to [0, length].
 * Where the profile is flat in time, the earliest distance is returned.
 */
export function distanceAt(p: TimeProfile, t: number): number {
  const last = p.t.length - 1;
  if (!(t > p.t[0])) return p.d[0];
  if (t >= p.t[last]) return p.d[last];
  // first index with p.t[i] ≥ t (t is non-decreasing)
  let lo = 1;
  let hi = last;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (p.t[mid] >= t) hi = mid;
    else lo = mid + 1;
  }
  const i = lo; // p.t[i − 1] < t ≤ p.t[i], so the span is positive
  return p.d[i - 1] + ((t - p.t[i - 1]) / (p.t[i] - p.t[i - 1])) * (p.d[i] - p.d[i - 1]);
}

/** Run time (s) at the route end. */
export function finishTime(p: TimeProfile): number {
  return p.t[p.t.length - 1];
}

/**
 * Ghost target profile: t_ghost(d) = t_ref(d) × (targetFinishSec / finish_ref). Keeps the reference's
 * relative timing (slower hills stay slower), starts at 0 and finishes exactly at `targetFinishSec`.
 */
export function scaleProfile(p: TimeProfile, targetFinishSec: number): TimeProfile {
  const finish = finishTime(p);
  if (!(targetFinishSec > 0) || !Number.isFinite(targetFinishSec)) throw new RangeError('scaleProfile: target must be a positive time');
  if (!(finish > 0)) throw new RangeError('scaleProfile: reference has no duration');
  const k = targetFinishSec / finish;
  // min() keeps the last value exact and t non-decreasing despite rounding of t × k
  const t = p.t.map((x) => Math.min(x * k, targetFinishSec));
  t[t.length - 1] = targetFinishSec;
  return { d: [...p.d], t };
}

/** Target finish time (s) from a target spec; e.g. improvementPercent 2 → reference × 0.98. */
export function resolveTargetFinish(referenceFinishSec: number, spec: TargetSpec): number {
  let target: number;
  switch (spec.kind) {
    case 'finishTime':
      target = spec.seconds;
      break;
    case 'improvementSeconds':
      target = referenceFinishSec - spec.seconds;
      break;
    case 'improvementPercent':
      target = referenceFinishSec * (1 - spec.percent / 100);
      break;
  }
  if (!(target > 0) || !Number.isFinite(target)) throw new RangeError('resolveTargetFinish: target must be a positive time');
  return target;
}
