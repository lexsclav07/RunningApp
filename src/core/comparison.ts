import { timeAt } from './profile';
import type { AdvantageStatus, TimeProfile } from './types';

/** |advantage| (s) below which the runner reads as on target. */
export const ON_TARGET_BAND = 2;

/**
 * Time advantage (s) over a profile at the current route position:
 * advantage = t_profile(progress) − runSec, positive = ahead. With the reference profile this is the
 * baseline advantage; with the scaled ghost profile it is the ghost advantage.
 */
export function advantageAt(p: TimeProfile, progress: number, runSec: number): number {
  return timeAt(p, progress) - runSec;
}

/** 'onTarget' when |advantage| < band, else 'ahead' (positive) or 'behind' (negative). */
export function statusOf(advantage: number, band = ON_TARGET_BAND): AdvantageStatus {
  if (Math.abs(advantage) < band) return 'onTarget';
  return advantage > 0 ? 'ahead' : 'behind';
}
