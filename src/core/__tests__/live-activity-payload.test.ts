/** @jest-environment node */
import { describe, expect, it } from '@jest/globals';
import { toLiveActivityPayload } from '../live-activity-payload';
import type { LiveSnapshot } from '../types';

const T0 = Date.UTC(2026, 9, 29, 7, 0, 0);

function snap(o: Partial<LiveSnapshot> & { ghostAdv?: number | null; baselineAdv?: number | null; primary?: 'ghost' | 'baseline' } = {}): LiveSnapshot {
  const { ghostAdv = 12, baselineAdv = -4, primary = 'ghost', ...rest } = o;
  const reading = (a: number) => ({ advantage: a, status: a >= 2 ? 'ahead' : a <= -2 ? 'behind' : 'onTarget' } as const);
  return {
    phase: 'running',
    mode: 'route',
    startedAt: T0,
    runSec: 600,
    movingSec: 590,
    wallSec: 660, // 60 s paused so far
    distance: 1830,
    paceSecPerKm: 307,
    avgPaceSecPerKm: 328,
    gps: { quality: 'good', accuracy: 5, lastFixAgeSec: 0 },
    route: {
      match: 'onRoute',
      progress: 1800,
      length: 5000,
      remaining: 3200,
      offset: 2,
      finishedSec: null,
      reliable: true,
      baseline: baselineAdv === null ? null : reading(baselineAdv),
      ghost: ghostAdv === null ? null : { ...reading(ghostAdv), targetFinishSec: 1770 },
      primary,
      nextCheckpoint: null,
      lastSplit: null,
      required: null,
      projectedFinishSec: null,
      upcomingClimb: null,
    },
    ...rest,
  };
}

describe('toLiveActivityPayload', () => {
  it('running with a ghost: start shifted by paused time, ghost delta, bar to the right', () => {
    const p = toLiveActivityPayload(snap(), 'Riverside');
    expect(p).toEqual({
      routeName: 'Riverside',
      startedAtMs: T0 + 60_000,
      pausedAtMs: null,
      runSec: 600,
      paceText: '5:07',
      deltaText: '+00:12',
      deltaSec: 12,
      status: 'ahead',
      comparisonLabel: 'GHOST',
      barFraction: 0.6, // 12 s on a 20 s scale
      distanceText: '1.83 km',
    });
    // now − startedAtMs = runSec while running
    expect(T0 + 660_000 - p.startedAtMs).toBe(600_000);
  });

  it('paused: pausedAtMs freezes the timer at the run time', () => {
    const p = toLiveActivityPayload(snap({ phase: 'paused', paceSecPerKm: null }), 'R');
    expect(p.pausedAtMs).toBe(p.startedAtMs + 600_000);
    expect(p.paceText).toBe('–:––');
  });

  it('baseline primary: behind fills left', () => {
    const p = toLiveActivityPayload(snap({ primary: 'baseline', baselineAdv: -15 }), 'R');
    expect(p.comparisonLabel).toBe('BASELINE');
    expect(p.deltaText).toBe('−00:15');
    expect(p.deltaSec).toBe(-15);
    expect(p.status).toBe('behind');
    expect(p.barFraction).toBeCloseTo(-0.75, 9); // 15 s on a 20 s scale
  });

  it('no reading yet: dash, no bar', () => {
    const p = toLiveActivityPayload(snap({ ghostAdv: null }), 'R');
    expect(p.comparisonLabel).toBe('GHOST');
    expect(p.deltaText).toBe('—');
    expect(p.deltaSec).toBeNull();
    expect(p.status).toBe('none');
    expect(p.barFraction).toBe(0);
  });

  it('record mode: no comparison', () => {
    const p = toLiveActivityPayload(snap({ mode: 'record', route: null, distance: 640 }), 'New route');
    expect(p.comparisonLabel).toBe('');
    expect(p.deltaText).toBe('');
    expect(p.deltaSec).toBeNull();
    expect(p.status).toBe('none');
    expect(p.barFraction).toBe(0);
    expect(p.distanceText).toBe('640 m');
  });

  it('before the start the timer reads zero', () => {
    const p = toLiveActivityPayload(snap({ phase: 'idle', startedAt: null, runSec: 0, wallSec: 0 }), 'R');
    expect(p.runSec).toBe(0);
    expect(p.pausedAtMs).toBe(p.startedAtMs);
  });
});
