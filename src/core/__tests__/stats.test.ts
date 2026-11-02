/** @jest-environment node */
import { describe, expect, it } from '@jest/globals';
import { compareProfiles, routeStats } from '../stats';
import type { TimeProfile } from '../types';

const day = (n: number) => Date.UTC(2026, 9, n, 7, 0, 0);
const run = (id: string, n: number, finishSec: number | null, distance = 5000) => ({ id, startedAt: day(n), finishSec, distance });

describe('routeStats', () => {
  it('summarises best, latest, average, baseline change and the series in date order', () => {
    // given out of order on purpose
    const runs = [run('c', 3, 1790), run('a', 1, 1800), run('d', 4, null, 2100), run('b', 2, 1760), run('e', 5, 1775)];
    const s = routeStats(runs, 'a');
    expect(s.count).toBe(5);
    expect(s.totalDistance).toBe(22100);
    expect(s.best).toEqual({ runId: 'b', finishSec: 1760 });
    expect(s.latest).toEqual({ runId: 'e', finishSec: 1775 });
    expect(s.averageSec).toBeCloseTo((1800 + 1760 + 1790 + 1775) / 4, 9);
    expect(s.baselineSec).toBe(1800);
    expect(s.changeFromBaselineSec).toBe(-25);
    expect(s.series).toEqual([
      { runId: 'a', startedAt: day(1), finishSec: 1800 },
      { runId: 'b', startedAt: day(2), finishSec: 1760 },
      { runId: 'c', startedAt: day(3), finishSec: 1790 },
      { runId: 'e', startedAt: day(5), finishSec: 1775 },
    ]);
  });

  it('handles no runs, no finished runs and a missing baseline', () => {
    expect(routeStats([], 'x')).toEqual({
      count: 0,
      totalDistance: 0,
      best: null,
      latest: null,
      averageSec: null,
      baselineSec: null,
      changeFromBaselineSec: null,
      trend: null,
      series: [],
    });
    const s = routeStats([run('a', 1, null, 800)], 'zz');
    expect(s.count).toBe(1);
    expect(s.totalDistance).toBe(800);
    expect(s.best).toBeNull();
    expect(s.baselineSec).toBeNull();
    expect(s.changeFromBaselineSec).toBeNull();
  });

  it('trend: least-squares slope over the last ≤ 6 finishes (< −1 s/run improving, > +1 declining)', () => {
    expect(routeStats([run('a', 1, 1800), run('b', 2, 1790)], 'a').trend).toBeNull();
    expect(routeStats([run('a', 1, 1800), run('b', 2, 1790), run('c', 3, 1785)], 'a').trend).toBe('improving');
    expect(routeStats([run('a', 1, 1800), run('b', 2, 1810), run('c', 3, 1805)], 'a').trend).toBe('declining');
    expect(routeStats([run('a', 1, 1800), run('b', 2, 1801), run('c', 3, 1800.5)], 'a').trend).toBe('steady');
    // early fast runs fall outside the last six; the recent six slow down by 2 s/run
    const runs = [run('x', 1, 1500), run('y', 2, 1500), ...[0, 1, 2, 3, 4, 5].map((k) => run(`r${k}`, 3 + k, 1800 + 2 * k))];
    expect(routeStats(runs, 'x').trend).toBe('declining');
    // incomplete runs do not count towards the trend
    expect(routeStats([run('a', 1, 1800), run('b', 2, null), run('c', 3, 1790)], 'a').trend).toBeNull();
  });

  it('breaks ties in best by the earlier run', () => {
    expect(routeStats([run('late', 2, 1700), run('early', 1, 1700)], 'early').best).toEqual({ runId: 'early', finishSec: 1700 });
  });
});

describe('compareProfiles', () => {
  it('reads both profiles at each distance; diff = b − a', () => {
    const a: TimeProfile = { d: [0, 1000, 2000], t: [0, 300, 620] };
    const b: TimeProfile = { d: [0, 1000, 2000], t: [0, 290, 600] };
    expect(compareProfiles(a, b, [0, 500, 1000, 2000, 2500])).toEqual([
      { d: 0, a: 0, b: 0, diff: 0 },
      { d: 500, a: 150, b: 145, diff: -5 },
      { d: 1000, a: 300, b: 290, diff: -10 },
      { d: 2000, a: 620, b: 600, diff: -20 },
      { d: 2500, a: 620, b: 600, diff: -20 },
    ]);
  });
});
