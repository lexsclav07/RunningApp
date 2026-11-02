import { barGeometry, barScale } from './bar';
import { formatDelta, formatDistance, formatPace } from './format';
import { primaryReading } from './session';
import type { AdvantageStatus, LiveSnapshot } from './types';

/** Data the Lock Screen Live Activity renders; plain values only, so it serialises as-is. */
export interface LiveActivityPayload {
  routeName: string;
  /** Run-clock origin, epoch ms: the start shifted by paused time, so now − startedAtMs = runSec while running. */
  startedAtMs: number;
  /** When set, the timer shows pausedAtMs − startedAtMs (= runSec) frozen; null while running. */
  pausedAtMs: number | null;
  runSec: number;
  paceText: string;
  deltaText: string;
  deltaSec: number | null;
  status: AdvantageStatus | 'none';
  comparisonLabel: 'GHOST' | 'BASELINE' | '';
  /** Bar fill: positive = ahead (right), negative = behind (left), −1…1. */
  barFraction: number;
  distanceText: string;
}

/** Live Activity payload for a snapshot, using its primary comparison (ghost or baseline). */
export function toLiveActivityPayload(s: LiveSnapshot, routeName: string): LiveActivityPayload {
  // paused ms so far = wall − run time; shifting the start by it makes a running timer read run time
  const startedAtMs = s.startedAt === null ? 0 : s.startedAt + Math.round((s.wallSec - s.runSec) * 1000);
  const primary = primaryReading(s);
  const reading = primary?.reading ?? null;
  const adv = reading?.advantage ?? null;
  const bar = barGeometry(adv, barScale(Math.abs(adv ?? 0), null));
  return {
    routeName,
    startedAtMs,
    pausedAtMs: s.phase === 'running' ? null : startedAtMs + Math.round(s.runSec * 1000),
    runSec: s.runSec,
    paceText: formatPace(s.paceSecPerKm),
    deltaText: primary === null ? '' : adv === null ? '—' : formatDelta(adv),
    deltaSec: adv,
    status: reading?.status ?? 'none',
    comparisonLabel: primary === null ? '' : primary.kind === 'ghost' ? 'GHOST' : 'BASELINE',
    barFraction: bar.side === 'ahead' ? bar.fraction : bar.side === 'behind' ? -bar.fraction : 0,
    distanceText: formatDistance(s.distance),
  };
}
