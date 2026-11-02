/** @jest-environment node */
import { describe, expect, it } from '@jest/globals';
import { makeProfile, scaleProfile, timeAt } from '../profile';
import { SplitTracker, buildCheckpoints, checkpointInterval } from '../splits';
import type { TimeProfile } from '../types';

/** Constant 300 s/km over `length` metres. */
const steady = (length: number): TimeProfile => makeProfile([length], [length * 0.3], length);

describe('checkpointInterval', () => {
  it('adapts the checkpoint spacing to the route length', () => {
    expect(checkpointInterval(800)).toBe(100);
    expect(checkpointInterval(1500)).toBe(100);
    expect(checkpointInterval(1501)).toBe(250);
    expect(checkpointInterval(5000)).toBe(250);
    expect(checkpointInterval(5001)).toBe(500);
    expect(checkpointInterval(12000)).toBe(500);
    expect(checkpointInterval(12001)).toBe(1000);
  });
});

describe('buildCheckpoints', () => {
  it('places checkpoints at multiples of the interval plus the finish', () => {
    const p = steady(1000);
    const cps = buildCheckpoints(1000, p, p, 100);
    expect(cps.map((c) => c.d)).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
    expect(cps.map((c) => c.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('merges a trailing gap shorter than 0.4 × interval into the finish', () => {
    const p = steady(1030);
    expect(buildCheckpoints(1030, p, p, 100).map((c) => c.d).slice(-2)).toEqual([900, 1030]);
    const q = steady(1050);
    expect(buildCheckpoints(1050, q, q, 100).map((c) => c.d).slice(-2)).toEqual([1000, 1050]);
  });

  it('defaults the interval from the route length', () => {
    const p = steady(3000);
    const cps = buildCheckpoints(3000, p, p);
    expect(cps).toHaveLength(12);
    expect(cps[0].d).toBe(250);
    expect(cps[11].d).toBe(3000);
  });

  it('fills target elapsed, target split and reference elapsed', () => {
    const ref = makeProfile([500, 1000], [140, 300], 1000);
    const target = scaleProfile(ref, 280);
    const cps = buildCheckpoints(1000, target, ref, 250);
    let prev = 0;
    for (const cp of cps) {
      expect(cp.targetElapsed).toBeCloseTo(timeAt(target, cp.d), 9);
      expect(cp.referenceElapsed).toBeCloseTo(timeAt(ref, cp.d), 9);
      expect(cp.targetSplit).toBeCloseTo(cp.targetElapsed - prev, 9);
      prev = cp.targetElapsed;
    }
    expect(cps[cps.length - 1].targetElapsed).toBeCloseTo(280, 9);
  });

  it('#5 a faster target gives proportionally faster checkpoint times and splits', () => {
    const ref = makeProfile([1000, 2000, 3000, 4000, 5000], [350, 700, 1080, 1440, 1800], 5000);
    const ghost = scaleProfile(ref, 1770);
    const k = 1770 / 1800;
    const ghostCps = buildCheckpoints(5000, ghost, ref);
    const refCps = buildCheckpoints(5000, ref, ref);
    expect(ghostCps.map((c) => c.d)).toEqual(refCps.map((c) => c.d));
    ghostCps.forEach((cp, i) => {
      expect(cp.targetElapsed).toBeCloseTo(cp.referenceElapsed * k, 9);
      expect(cp.targetSplit).toBeCloseTo(refCps[i].targetSplit * k, 9);
      expect(cp.targetSplit).toBeLessThan(refCps[i].targetSplit);
    });
  });
});

describe('SplitTracker', () => {
  const p = steady(1000); // 30 s per 100 m
  const cps = buildCheckpoints(1000, p, p, 100);

  it('records a crossing at the linearly interpolated run time', () => {
    const tracker = new SplitTracker(cps);
    expect(tracker.update(0, 0, 90, 27)).toEqual([]);
    const [s] = tracker.update(90, 27, 110, 33);
    expect(s.d).toBe(100);
    expect(s.index).toBe(0);
    expect(s.actualElapsed).toBeCloseTo(30, 9); // 27 + (10/20) × 6
    expect(s.actualSplit).toBeCloseTo(30, 9);
    expect(s.splitDiff).toBeCloseTo(0, 9);
    expect(s.cumulativeDiff).toBeCloseTo(0, 9);
  });

  it('reports several checkpoints crossed in one update', () => {
    const tracker = new SplitTracker(cps);
    tracker.update(0, 0, 110, 33);
    const out = tracker.update(110, 33, 330, 99);
    expect(out.map((s) => s.d)).toEqual([200, 300]);
    expect(out[0].actualElapsed).toBeCloseTo(60, 9); // 33 + (90/220) × 66
    expect(out[1].actualElapsed).toBeCloseTo(90, 9); // 33 + (190/220) × 66
    expect(out[1].actualSplit).toBeCloseTo(30, 9);
  });

  it('signs split and cumulative differences (positive = faster / ahead)', () => {
    const tracker = new SplitTracker(cps);
    const [first] = tracker.update(0, 0, 100, 36); // 6 s slower than target
    expect(first.splitDiff).toBeCloseTo(-6, 9);
    expect(first.cumulativeDiff).toBeCloseTo(-6, 9);
    const [second] = tracker.update(100, 36, 200, 62); // 26 s split: 4 s faster
    expect(second.actualSplit).toBeCloseTo(26, 9);
    expect(second.splitDiff).toBeCloseTo(4, 9);
    expect(second.cumulativeDiff).toBeCloseTo(-2, 9);
  });

  it('never reports a checkpoint twice', () => {
    const tracker = new SplitTracker(cps);
    expect(tracker.update(0, 0, 150, 45)).toHaveLength(1);
    expect(tracker.update(150, 45, 150, 46)).toEqual([]);
    expect(tracker.update(90, 44, 150, 47)).toEqual([]);
    expect(tracker.results()).toHaveLength(1);
  });

  it('next() is the first uncrossed checkpoint ahead of the progress', () => {
    const tracker = new SplitTracker(cps);
    expect(tracker.next(0)?.d).toBe(100);
    tracker.update(0, 0, 330, 99);
    expect(tracker.next(330)?.d).toBe(400);
    tracker.update(330, 99, 1000, 300);
    expect(tracker.next(1000)).toBeNull();
  });

  it('results() lists every crossed checkpoint in order', () => {
    const tracker = new SplitTracker(cps);
    tracker.update(0, 0, 250, 75);
    tracker.update(250, 75, 1000, 300);
    const res = tracker.results();
    expect(res.map((s) => s.index)).toEqual(cps.map((c) => c.index));
    expect(res[9].actualElapsed).toBeCloseTo(300, 9);
  });
});
