/** @jest-environment node */
import { describe, expect, it } from '@jest/globals';
import {
  IncompleteProfileError,
  distanceAt,
  finishTime,
  makeProfile,
  resolveTargetFinish,
  scaleProfile,
  timeAt,
} from '../profile';
import { makeRoute, twoHills } from '../sim/routes';
import { simulateRun } from '../sim/trace';
import type { TimeProfile } from '../types';

/** 5 km reference finishing in 30:00 with an uneven pace. */
const REF_30: TimeProfile = makeProfile([1000, 2000, 3000, 4000, 5000], [350, 700, 1080, 1440, 1800], 5000);

describe('makeProfile', () => {
  it('prepends (0, 0) and ends exactly at the route length', () => {
    const p = makeProfile([100, 200, 300], [30, 60, 90], 300);
    expect(p).toEqual({ d: [0, 100, 200, 300], t: [0, 30, 60, 90] });
  });

  it('sorts by distance, drops non-increasing distances and makes time non-decreasing', () => {
    // (0, 3) and (−5, 1) are not past the origin; 100 m keeps its first (earliest) time; 150 m dips below 30 s
    const p = makeProfile([200, 100, 100, 150, 300, 0, -5], [70, 35, 30, 28, 90, 3, 1], 300);
    expect(p.d).toEqual([0, 100, 150, 200, 300]);
    expect(p.t).toEqual([0, 30, 30, 70, 90]);
  });

  it('extrapolates the last pace when the run ends within 30 m of the length', () => {
    const d = Array.from({ length: 50 }, (_, i) => 20 * (i + 1)); // 20 … 1000 m
    const p = makeProfile(
      d.filter((x) => x <= 980),
      d.filter((x) => x <= 980).map((x) => x * 0.3), // 300 s/km
      1000,
    );
    expect(p.d[p.d.length - 1]).toBe(1000);
    expect(finishTime(p)).toBeCloseTo(300, 9);
  });

  it('cuts a run that continues past the end at exactly the length', () => {
    const p = makeProfile([500, 1000, 1100], [150, 300, 330], 1050);
    expect(p.d).toEqual([0, 500, 1000, 1050]);
    expect(p.t[3]).toBeCloseTo(315, 9);
  });

  it('throws IncompleteProfileError on a run ending 300 m short', () => {
    const run = () => makeProfile([100, 400, 700], [30, 120, 210], 1000);
    expect(run).toThrow(IncompleteProfileError);
    try {
      run();
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as IncompleteProfileError).name).toBe('IncompleteProfileError');
    }
  });

  it('throws IncompleteProfileError when nothing beyond the start was recorded', () => {
    expect(() => makeProfile([], [], 1000)).toThrow(IncompleteProfileError);
  });
});

describe('timeAt / distanceAt / finishTime', () => {
  const p = makeProfile([100, 200], [30, 70], 200);

  it('interpolates time linearly between profile points', () => {
    expect(timeAt(p, 0)).toBe(0);
    expect(timeAt(p, 50)).toBeCloseTo(15, 9);
    expect(timeAt(p, 100)).toBeCloseTo(30, 9);
    expect(timeAt(p, 150)).toBeCloseTo(50, 9);
    expect(timeAt(p, 200)).toBeCloseTo(70, 9);
  });

  it('clamps time outside the route', () => {
    expect(timeAt(p, -10)).toBe(0);
    expect(timeAt(p, 500)).toBe(70);
  });

  it('distanceAt is the inverse of timeAt, clamped', () => {
    expect(distanceAt(p, 15)).toBeCloseTo(50, 9);
    expect(distanceAt(p, 50)).toBeCloseTo(150, 9);
    expect(distanceAt(p, -1)).toBe(0);
    expect(distanceAt(p, 100)).toBe(200);
  });

  it('distanceAt returns the first distance reaching a time on a flat stretch', () => {
    const flat: TimeProfile = { d: [0, 100, 150, 200], t: [0, 30, 30, 70] };
    expect(distanceAt(flat, 30)).toBeCloseTo(100, 9);
  });

  it('finishTime is the time at the route end', () => {
    expect(finishTime(p)).toBe(70);
    expect(finishTime(REF_30)).toBe(1800);
  });
});

describe('resolveTargetFinish', () => {
  it('uses a finish time as given', () => {
    expect(resolveTargetFinish(1800, { kind: 'finishTime', seconds: 1770 })).toBe(1770);
  });

  it('subtracts an improvement in seconds', () => {
    expect(resolveTargetFinish(1800, { kind: 'improvementSeconds', seconds: 30 })).toBe(1770);
  });

  it('scales by an improvement in percent (2 % → × 0.98)', () => {
    expect(resolveTargetFinish(1800, { kind: 'improvementPercent', percent: 2 })).toBeCloseTo(1764, 9);
  });

  it('rejects a target that is not a positive time', () => {
    expect(() => resolveTargetFinish(1800, { kind: 'improvementSeconds', seconds: 1800 })).toThrow(RangeError);
    expect(() => resolveTargetFinish(1800, { kind: 'finishTime', seconds: Number.NaN })).toThrow(RangeError);
  });
});

describe('scaleProfile (ghost target)', () => {
  it('#4 the ghost of a 30:00 reference with target 29:30 starts at 0 and finishes at 1770 s', () => {
    const target = resolveTargetFinish(finishTime(REF_30), { kind: 'finishTime', seconds: 29 * 60 + 30 });
    const ghost = scaleProfile(REF_30, target);
    expect(timeAt(ghost, 0)).toBe(0);
    expect(finishTime(ghost)).toBe(1770);
    expect(ghost.d).toEqual(REF_30.d);
    ghost.t.forEach((t, i) => expect(t).toBeCloseTo((REF_30.t[i] * 1770) / 1800, 9));
  });

  it('rejects a non-positive target or a reference with no duration', () => {
    expect(() => scaleProfile(REF_30, 0)).toThrow(RangeError);
    expect(() => scaleProfile({ d: [0, 100], t: [0, 0] }, 60)).toThrow(RangeError);
  });

  it('#6 steep hills keep the reference run\'s relative timing in the ghost', () => {
    const LENGTH = 3000;
    const route = makeRoute('straight', { length: LENGTH, elevation: twoHills(LENGTH) });
    // the reference runner slows from 3.5 m/s to 2 m/s on the 10 % climbs
    const sim = simulateRun(route, { speed: (_d, grade) => (grade > 0.03 ? 2 : 3.5), startMs: 0, noiseM: 0 });
    const lastSec = (sim.fixes[sim.fixes.length - 1].t - sim.fixes[0].t) / 1000;
    const secs = Array.from({ length: Math.floor(lastSec) }, (_, i) => i + 1);
    const ref = makeProfile(secs.map((s) => sim.truthAtSec(s)), secs, LENGTH);
    const ghost = scaleProfile(ref, finishTime(ref) * 0.95);

    const split = (p: TimeProfile, a: number, b: number) => timeAt(p, b) - timeAt(p, a);
    const hills: [number, number][] = [
      [0.25 * LENGTH, 0.25 * LENGTH + 200],
      [0.65 * LENGTH, 0.65 * LENGTH + 200],
    ];
    const flat: [number, number] = [100, 300];

    // the setup really is slower uphill (s/m on a hill vs on the flat)
    for (const [a, b] of hills) expect(split(ref, a, b)).toBeGreaterThan(1.5 * split(ref, ...flat));

    for (const [a, b] of hills) {
      const refShare = split(ref, a, b) / finishTime(ref);
      const ghostShare = split(ghost, a, b) / finishTime(ghost);
      expect(Math.abs(ghostShare - refShare)).toBeLessThan(1e-9);
      // hill vs flat ratio is unchanged too
      const refRatio = split(ref, a, b) / split(ref, ...flat);
      const ghostRatio = split(ghost, a, b) / split(ghost, ...flat);
      expect(Math.abs(ghostRatio - refRatio)).toBeLessThan(1e-9);
    }
  });
});
