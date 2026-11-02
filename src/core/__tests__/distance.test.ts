/** @jest-environment node */
import { describe, expect, it } from '@jest/globals';
import { DistanceAccumulator } from '../distance';
import { classifyFix } from '../filter';
import { makeProjection } from '../geo';
import { makeRoute } from '../sim/routes';
import { simulateRun } from '../sim/trace';
import type { GpsFix } from '../types';

const T0 = Date.UTC(2026, 9, 29, 7, 0, 0);
const proj = makeProjection({ lat: 51.5, lon: -0.13 });

function fixAt(sec: number, x: number, y: number, over: Partial<GpsFix> = {}): GpsFix {
  const ll = proj.toLatLon(x, y);
  return { t: T0 + sec * 1000, lat: ll.lat, lon: ll.lon, hAcc: 5, alt: null, vAcc: null, speed: null, course: null, ...over };
}

/** Feeds fixes through the same accept filter the session uses and returns the accumulated distance. */
function accumulate(fixes: GpsFix[]): number {
  const acc = new DistanceAccumulator();
  let prev: GpsFix | null = null;
  for (const f of fixes) {
    if (!classifyFix(f, prev).accept) continue;
    prev = f;
    acc.add(f);
  }
  return acc.total;
}

describe('DistanceAccumulator (anchor rule)', () => {
  it('adds nothing until the displacement from the anchor reaches max(3, 0.5 × hAcc)', () => {
    const acc = new DistanceAccumulator();
    expect(acc.add(fixAt(0, 0, 0))).toEqual({ delta: 0, total: 0 });
    expect(acc.add(fixAt(1, 0, 2)).delta).toBe(0); // 2 m < 3 m
    const r = acc.add(fixAt(2, 0, 3.5)); // 3.5 m from the anchor
    expect(r.delta).toBeCloseTo(3.5, 3);
    expect(r.total).toBeCloseTo(3.5, 3);
    expect(acc.add(fixAt(3, 0, 5.5)).delta).toBe(0); // anchor moved to 3.5
    expect(acc.add(fixAt(4, 0, 7)).delta).toBeCloseTo(3.5, 3);
    expect(acc.total).toBeCloseTo(7, 3);
  });

  it('uses the worse accuracy of anchor and fix, and 10 m for null accuracy', () => {
    const acc = new DistanceAccumulator();
    acc.add(fixAt(0, 0, 0, { hAcc: 20 })); // threshold 10 m
    expect(acc.add(fixAt(1, 0, 8)).delta).toBe(0);
    expect(acc.add(fixAt(2, 0, 10.5)).delta).toBeCloseTo(10.5, 3);
    const nul = new DistanceAccumulator();
    nul.add(fixAt(0, 0, 0, { hAcc: null })); // threshold 5 m
    expect(nul.add(fixAt(1, 0, 4.5)).delta).toBe(0);
    expect(nul.add(fixAt(2, 0, 5.2)).delta).toBeCloseTo(5.2, 3);
  });

  it('reset() drops the anchor but keeps the total', () => {
    const acc = new DistanceAccumulator();
    acc.add(fixAt(0, 0, 0));
    acc.add(fixAt(1, 0, 10));
    expect(acc.total).toBeCloseTo(10, 3);
    acc.reset();
    expect(acc.total).toBeCloseTo(10, 3);
    // the first fix after a reset only re-anchors (e.g. resuming 200 m away after a pause)
    expect(acc.add(fixAt(100, 0, 210)).delta).toBe(0);
    expect(acc.add(fixAt(101, 0, 220)).delta).toBeCloseTo(10, 3);
    expect(acc.total).toBeCloseTo(20, 3);
  });

  it('does not accumulate while the reported Doppler speed says stationary', () => {
    const acc = new DistanceAccumulator();
    acc.add(fixAt(0, 0, 0, { speed: 0.1 }));
    expect(acc.add(fixAt(1, 6, 0, { speed: 0.2 })).delta).toBe(0); // wander while standing
    expect(acc.add(fixAt(2, 0, 6, { speed: 0 })).delta).toBe(0);
    // moving again: measured from the latest stationary fix
    expect(acc.add(fixAt(3, 0, 10, { speed: 3 })).delta).toBeCloseTo(4, 3);
    // unavailable speed (−1) falls back to the anchor rule alone
    expect(acc.add(fixAt(4, 0, 16, { speed: -1 })).delta).toBeCloseTo(6, 3);
  });
});

describe('DistanceAccumulator on simulated traces', () => {
  it('stationary 10 min with 8 m noise accumulates < 20 m', () => {
    const route = makeRoute('straight', { length: 200 });
    for (const seed of [1, 2, 3, 4, 5]) {
      const sim = simulateRun(route, {
        speed: () => 3,
        startMs: T0,
        noiseM: 8,
        seed,
        stops: [{ atSec: 0, durationSec: 600 }],
      });
      const standing = sim.fixes.filter((f) => f.t < T0 + 600_000);
      expect(standing).toHaveLength(600);
      expect(accumulate(standing)).toBeLessThan(20);
    }
  });

  it('1 km straight with 3 m noise totals 1000 ± 25 m', () => {
    const route = makeRoute('straight', { length: 1000 });
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const sim = simulateRun(route, { speed: () => 3, startMs: T0, noiseM: 3, seed });
      expect(Math.abs(accumulate(sim.fixes) - 1000)).toBeLessThanOrEqual(25);
    }
  });

  it('a curvy loop with stops stays within 3 % of the truth', () => {
    const route = makeRoute('figureEight', { length: 2000 });
    for (const seed of [11, 12, 13]) {
      const sim = simulateRun(route, {
        speed: () => 3.2,
        startMs: T0,
        noiseM: 4,
        seed,
        stops: [
          { atSec: 120, durationSec: 45 },
          { atSec: 400, durationSec: 90 },
        ],
      });
      expect(Math.abs(accumulate(sim.fixes) - 2000)).toBeLessThan(60);
    }
  });
});
