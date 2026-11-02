import { ON_TARGET_BAND, statusOf, type PrimaryComparison } from '@/core';

/** "ghost" / "baseline" as spoken and shown. */
export const comparisonName = (k: PrimaryComparison) => (k === 'ghost' ? 'ghost' : 'baseline');

/** Short status line under the hero: "AHEAD OF GHOST", "BEHIND BASELINE", "ON TARGET". */
export function statusLine(advantage: number, kind: PrimaryComparison): string {
  const s = statusOf(advantage);
  if (s === 'onTarget') return 'ON TARGET';
  return `${s === 'ahead' ? 'AHEAD OF' : 'BEHIND'} ${kind === 'ghost' ? 'GHOST' : 'BASELINE'}`;
}

/** VoiceOver phrase: "12 seconds ahead of ghost", "1 minute 5 seconds behind baseline", "on target with ghost". */
export function spokenAdvantage(advantage: number, kind: PrimaryComparison): string {
  const name = comparisonName(kind);
  if (Math.abs(advantage) < ON_TARGET_BAND) return `on target with ${name}`;
  const total = Math.round(Math.abs(advantage));
  const m = Math.floor(total / 60);
  const s = total % 60;
  const parts = [m > 0 ? `${m} minute${m === 1 ? '' : 's'}` : '', s > 0 || m === 0 ? `${s} second${s === 1 ? '' : 's'}` : '']
    .filter(Boolean)
    .join(' ');
  return advantage > 0 ? `${parts} ahead of ${name}` : `${parts} behind ${name}`;
}
