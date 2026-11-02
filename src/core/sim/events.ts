import type { GpsFix, SessionEvent } from '../types';

export interface ToEventsOptions {
  /** Manual pauses (epoch ms); each becomes a pause marker at fromMs and a resume marker at toMs. */
  pauses?: { fromMs: number; toMs: number }[];
  /** Finish marker time (default: the last fix's t). */
  finishMs?: number;
}

/**
 * Builds a session event log from simulated fixes: `start` at the first fix, fixes in time order,
 * pause/resume markers merged by time, and `finish` at `finishMs ?? last fix t`.
 * Ties on t order as start → pause/resume → fix → finish, so a fix at the finish time still counts.
 */
export function toEvents(fixes: readonly GpsFix[], opts: ToEventsOptions = {}): SessionEvent[] {
  if (fixes.length === 0) return [];
  const sorted = [...fixes].sort((a, b) => a.t - b.t);
  const first = sorted[0].t;
  const last = sorted[sorted.length - 1].t;
  const items: { t: number; rank: number; e: SessionEvent }[] = [{ t: first, rank: 0, e: { type: 'start', t: first } }];
  for (const p of opts.pauses ?? []) {
    items.push({ t: p.fromMs, rank: 1, e: { type: 'pause', t: p.fromMs } });
    items.push({ t: p.toMs, rank: 1, e: { type: 'resume', t: p.toMs } });
  }
  for (const fix of sorted) items.push({ t: fix.t, rank: 2, e: { type: 'fix', fix } });
  const finish = opts.finishMs ?? last;
  items.push({ t: finish, rank: 3, e: { type: 'finish', t: finish } });
  // Array.prototype.sort is stable, so equal (t, rank) keep insertion order
  return items.sort((a, b) => a.t - b.t || a.rank - b.rank).map((i) => i.e);
}
