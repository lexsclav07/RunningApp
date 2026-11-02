/** @jest-environment node */
import { describe, expect, it } from '@jest/globals';
import { DistanceAccumulator } from '../distance';
import { classifyFix } from '../filter';
import { MOVING_SPEED, PaceEstimator } from '../pace';
import { makeRoute } from '../sim/routes';
import { simulateRun, type SimulateRunOptions } from '../sim/trace';
import type { GpsFix } from '../types';

const T0 = Date.UTC(2026, 9, 29, 7, 0, 0);

/**
 * Drives fixes through filter → distance → pace, and samples `current()` once per second of run time
 * (as the UI tick would). Returns pace by whole second.
 */
function paceSeries(opts: Omit<SimulateRunOptions, 'startMs'>, length = 2000): Map<number, number | null> {
  const sim = simulateRun(makeRoute('straight', { length }), { ...opts, startMs: T0 });
  const acc = new DistanceAccumulator();
  const pace = new PaceEstimator();
  const out = new Map<number, number | null>();
  let prev: GpsFix | null = null;
  let i = 0;
  const lastSec = Math.ceil((sim.fixes[sim.fixes.length - 1].t - T0) / 1000);
  for (let sec = 0; sec <= lastSec; sec++) {
    while (i < sim.fixes.length && sim.fixes[i].t <= T0 + sec * 1000) {
      const f = sim.fixes[i++];
      if (!classifyFix(f, prev).accept) continue;
      prev = f;
      pace.push((f.t - T0) / 1000, acc.add(f).total);
    }
    out.set(sec, pace.current(sec));
  }
  return out;
}

describe('PaceEstimator unit behaviour', () => {
  it('exports MOVING_SPEED = 0.8 m/s', () => {
    expect(MOVING_SPEED).toBe(0.8);
  });

  it('is null before any push and with too little distance', () => {
    const p = new PaceEstimator();
    expect(p.current(0)).toBeNull();
    p.push(0, 0);
    p.push(5, 10); // 10 m < 15 m
    expect(p.current(5)).toBeNull();
    p.push(10, 20);
    expect(p.current(10)).toBeCloseTo(500, 6); // 20 m / 10 s = 2 m/s → 500 s/km
  });

  it('is null when slower than MOVING_SPEED', () => {
    const p = new PaceEstimator();
    for (let s = 0; s <= 60; s++) p.push(s, s * 0.6); // 0.6 m/s
    expect(p.current(60)).toBeNull();
  });

  it('is null when the last push is more than 10 s old', () => {
    const p = new PaceEstimator();
    for (let s = 0; s <= 30; s++) p.push(s, s * 3);
    expect(p.current(30)).toBeCloseTo(333.33, 1);
    expect(p.current(40)).not.toBeNull();
    expect(p.current(40.5)).toBeNull();
  });

  it('smooths with an EMA (α = 0.3) on sec/km', () => {
    const p = new PaceEstimator();
    for (let s = 0; s <= 40; s++) p.push(s, s * 4); // 250 s/km
    expect(p.current(40)).toBeCloseTo(250, 6);
    // one push at a faster rate: raw window pace changes, the output moves 30 % of the way
    p.push(41, 40 * 4 + 8);
    const raw = 1000 / ((40 * 4 + 8 - 21 * 4) / 20); // window 21..41 s
    expect(p.current(41)).toBeCloseTo(250 + 0.3 * (raw - 250), 6);
  });

  it('extends the window back until it covers 30 m', () => {
    const p = new PaceEstimator();
    for (let s = 0; s <= 40; s++) p.push(s, s * 1); // 1 m/s: 20 s window holds only 20 m
    expect(p.current(40)).toBeCloseTo(1000, 6);
  });

  it('reset() forgets samples and smoothing', () => {
    const p = new PaceEstimator();
    for (let s = 0; s <= 30; s++) p.push(s, s * 3);
    p.reset();
    expect(p.current(30)).toBeNull();
    p.push(31, 100);
    expect(p.current(31)).toBeNull();
  });
});

describe('PaceEstimator on simulated traces', () => {
  it('constant 3 m/s reads ≈ 333 s/km ± 15', () => {
    for (const seed of [1, 2, 3]) {
      const series = paceSeries({ speed: () => 3, noiseM: 3, seed });
      for (const [sec, v] of series) {
        if (sec < 30) continue;
        expect(v).not.toBeNull();
        expect(Math.abs((v as number) - 1000 / 3)).toBeLessThanOrEqual(15);
      }
    }
  });

  it('is null during a 30 s gap and recovers within 25 s with no value outside [250, 450]', () => {
    for (const seed of [4, 5, 6]) {
      const series = paceSeries({ speed: () => 3, noiseM: 3, seed, gaps: [{ fromSec: 200, toSec: 230 }] });
      // stale after 10 s without fixes
      for (let sec = 211; sec < 230; sec++) expect(series.get(sec)).toBeNull();
      const after = [...series].filter(([sec]) => sec >= 230);
      const firstValue = after.find(([, v]) => v !== null);
      expect(firstValue).toBeDefined();
      expect((firstValue as [number, number])[0]).toBeLessThanOrEqual(230 + 25);
      for (const [, v] of after) {
        if (v === null) continue;
        expect(v).toBeGreaterThanOrEqual(250);
        expect(v).toBeLessThanOrEqual(450);
      }
    }
  });

  it('goes null while standing and recovers after the stop', () => {
    const series = paceSeries({ speed: () => 3, noiseM: 4, seed: 9, stops: [{ atSec: 120, durationSec: 60 }] });
    for (let sec = 150; sec < 180; sec++) expect(series.get(sec)).toBeNull();
    const back = [...series].filter(([sec, v]) => sec >= 180 && sec <= 220 && v !== null);
    expect(back.length).toBeGreaterThan(0);
    expect(series.get(240)).not.toBeNull();
    expect(Math.abs((series.get(240) as number) - 1000 / 3)).toBeLessThan(20);
  });
});
