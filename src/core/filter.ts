import { haversine } from './geo';
import type { GpsFix, GpsQuality } from './types';

/** hAcc (m) at or below which a fix is 'good'. */
export const GOOD_ACCURACY = 10;
/** hAcc (m) at or below which a fix is 'fair'; above is 'poor'. */
export const FAIR_ACCURACY = 25;
/** Fixes with hAcc above this (m) are rejected. */
export const MAX_ACCURACY = 50;
/** Implied speed (m/s) from the previous accepted fix above which a fix is rejected as a jump. */
export const MAX_IMPLIED_SPEED = 12;

export interface FixClassification {
  accept: boolean;
  quality: GpsQuality;
  reason?: 'accuracy' | 'speed' | 'stale';
}

/** Quality from horizontal accuracy: ≤ 10 m good, ≤ 25 m fair, else poor; unknown accuracy → fair. */
export function qualityOf(hAcc: number | null): GpsQuality {
  if (hAcc === null) return 'fair';
  if (hAcc < 0) return 'poor';
  if (hAcc <= GOOD_ACCURACY) return 'good';
  if (hAcc <= FAIR_ACCURACY) return 'fair';
  return 'poor';
}

/**
 * Decides whether a fix can be used, given the previous *accepted* fix. Checks, in order:
 * stale (t ≤ prev.t: duplicates and out-of-order batch deliveries), accuracy (hAcc > 50 m, or a
 * negative hAcc, which iOS uses for an invalid coordinate), then speed (implied speed > 12 m/s).
 */
export function classifyFix(fix: GpsFix, prev: GpsFix | null): FixClassification {
  const quality = qualityOf(fix.hAcc);
  if (prev && fix.t <= prev.t) return { accept: false, quality, reason: 'stale' };
  const invalid = !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon) || (fix.hAcc !== null && fix.hAcc < 0);
  if (invalid || (fix.hAcc !== null && fix.hAcc > MAX_ACCURACY)) return { accept: false, quality, reason: 'accuracy' };
  if (prev) {
    // implied speed = great-circle distance (m) / elapsed (s)
    const v = haversine(prev, fix) / ((fix.t - prev.t) / 1000);
    if (v > MAX_IMPLIED_SPEED) return { accept: false, quality, reason: 'speed' };
  }
  return { accept: true, quality };
}
