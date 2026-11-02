/** @jest-environment node */
import { describe, expect, it } from '@jest/globals';
import { angleDiff, bearing, cumulativeDistances, haversine, makeProjection } from '../geo';
import { toEvents } from '../sim/events';
import { gaussian, mulberry32 } from '../sim/prng';
import { makeRoute, twoHills } from '../sim/routes';
import { simulateRun } from '../sim/trace';
import type { GpsFix, LatLon } from '../types';

const START = Date.UTC(2026, 9, 29, 7, 0, 0);
const constant = (v: number) => () => v;

function routeLength(points: LatLon[]): number {
  const d = cumulativeDistances(points);
  return d[d.length - 1];
}

/** Position of the route at along-route distance s (linear interpolation). */
function pointAt(points: LatLon[], cum: number[], s: number): LatLon {
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const f = cum[i] === cum[i - 1] ? 0 : (s - cum[i - 1]) / (cum[i] - cum[i - 1]);
  return {
    lat: points[i - 1].lat + f * (points[i].lat - points[i - 1].lat),
    lon: points[i - 1].lon + f * (points[i].lon - points[i - 1].lon),
  };
}

describe('prng', () => {
  it('mulberry32 is deterministic and in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });

  it('gaussian has mean ~0 and sd ~1', () => {
    const rand = mulberry32(7);
    const n = 20000;
    let sum = 0;
    let sq = 0;
    for (let i = 0; i < n; i++) {
      const z = gaussian(rand);
      expect(Number.isFinite(z)).toBe(true);
      sum += z;
      sq += z * z;
    }
    const mean = sum / n;
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(Math.sqrt(sq / n - mean * mean)).toBeCloseTo(1, 1);
  });
});

describe('makeRoute', () => {
  const kinds = ['straight', 'loop', 'outAndBack', 'figureEight', 'hairpin'] as const;

  it.each(kinds)('%s has the requested length and ~2 m spacing', (kind) => {
    const pts = makeRoute(kind, { length: 2000 });
    expect(Math.abs(routeLength(pts) - 2000)).toBeLessThan(2);
    const cum = cumulativeDistances(pts);
    for (let i = 1; i < cum.length; i++) {
      const step = cum[i] - cum[i - 1];
      expect(step).toBeGreaterThan(1.5);
      expect(step).toBeLessThan(2.5);
    }
    expect(pts.every((p) => p.ele === null)).toBe(true);
  });

  it('starts at the requested origin', () => {
    const origin = { lat: -33.9, lon: 151.2 };
    const pts = makeRoute('straight', { length: 500, origin });
    expect(haversine(pts[0], origin)).toBeLessThan(1e-6);
    expect(bearing(pts[0], pts[pts.length - 1])).toBeCloseTo(0, 3); // straight runs north
  });

  it('applies the elevation function by distance', () => {
    const pts = makeRoute('straight', { length: 1000, elevation: (d) => d / 100 });
    const cum = cumulativeDistances(pts);
    pts.forEach((p, i) => expect(p.ele).toBeCloseTo(cum[i] / 100, 2));
  });

  it('loop returns to its start and does not cross itself', () => {
    const pts = makeRoute('loop', { length: 1000 });
    const L = routeLength(pts);
    expect(haversine(pts[0], pts[pts.length - 1])).toBeLessThan(1e-6);
    const cum = cumulativeDistances(pts);
    for (let i = 0; i < pts.length; i += 3) {
      for (let j = i + 1; j < pts.length; j += 3) {
        const along = Math.min(cum[j] - cum[i], L - (cum[j] - cum[i]));
        if (along > 30) expect(haversine(pts[i], pts[j])).toBeGreaterThan(10);
      }
    }
  });

  it('outAndBack returns along the outbound path (offset < 1 m)', () => {
    const L = 2000;
    const pts = makeRoute('outAndBack', { length: L });
    const cum = cumulativeDistances(pts);
    const half = pts.filter((_, i) => cum[i] <= L / 2 + 1e-6);
    expect(haversine(pts[0], pts[pts.length - 1])).toBeLessThan(1);
    // The turnaround is the farthest point from the start.
    const far = Math.max(...pts.map((p) => haversine(pts[0], p)));
    expect(haversine(pts[0], pointAt(pts, cum, L / 2))).toBeCloseTo(far, 0);
    pts.forEach((p, i) => {
      if (cum[i] <= L / 2) return;
      const nearest = Math.min(...half.map((q) => haversine(p, q)));
      expect(nearest).toBeLessThan(1);
    });
    // Return-leg position at L − s coincides with outbound position at s.
    for (let s = 50; s < L / 2; s += 97) {
      expect(haversine(pointAt(pts, cum, s), pointAt(pts, cum, L - s))).toBeLessThan(1);
    }
  });

  it('figureEight crosses itself exactly once, in the middle', () => {
    const L = 2000;
    const pts = makeRoute('figureEight', { length: L });
    const cum = cumulativeDistances(pts);
    expect(haversine(pts[0], pts[pts.length - 1])).toBeLessThan(1e-6);
    const proj = makeProjection(pts[0]);
    const xy = pts.map((p) => proj.toXY(p));
    const cx = (Math.min(...xy.map((p) => p.x)) + Math.max(...xy.map((p) => p.x))) / 2;
    const cy = (Math.min(...xy.map((p) => p.y)) + Math.max(...xy.map((p) => p.y))) / 2;
    const close: { di: number; dj: number; x: number; y: number }[] = [];
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const along = Math.min(cum[j] - cum[i], L - (cum[j] - cum[i]));
        if (along < 20) continue;
        if (Math.hypot(xy[i].x - xy[j].x, xy[i].y - xy[j].y) < 2) {
          close.push({ di: cum[i], dj: cum[j], x: xy[i].x, y: xy[i].y });
        }
      }
    }
    expect(close.length).toBeGreaterThan(0);
    for (const c of close) {
      // one crossing location: the centre of the figure
      expect(Math.hypot(c.x - cx, c.y - cy)).toBeLessThan(5);
      // visited once at ~L/4 and once at ~3L/4
      expect(Math.abs(c.di - L / 4)).toBeLessThan(10);
      expect(Math.abs(c.dj - (3 * L) / 4)).toBeLessThan(10);
    }
  });

  it('hairpin has 180-degree switchbacks 25 m apart', () => {
    const pts = makeRoute('hairpin', { length: 1500 });
    const cum = cumulativeDistances(pts);
    const nearestOther: number[] = [];
    for (let i = 0; i < pts.length; i += 2) {
      let best = Infinity;
      for (let j = 0; j < pts.length; j++) {
        if (Math.abs(cum[j] - cum[i]) < 50) continue;
        best = Math.min(best, haversine(pts[i], pts[j]));
      }
      nearestOther.push(best);
    }
    // never closer than the switchback spacing, and mostly exactly at it
    expect(Math.min(...nearestOther)).toBeGreaterThan(24.5);
    const sorted = [...nearestOther].sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length / 2)]).toBeCloseTo(25, 0);
    // legs alternate north / south
    const legBearings = [bearing(pts[5], pts[15]), bearing(pts[pts.length - 16], pts[pts.length - 6])];
    expect(Math.min(angleDiff(legBearings[0], 0), angleDiff(legBearings[0], 180))).toBeLessThan(1);
    expect(Math.min(angleDiff(legBearings[1], 0), angleDiff(legBearings[1], 180))).toBeLessThan(1);
  });
});

describe('twoHills', () => {
  it('has two ~10 % climbs of ~20 m over 200 m at 25 % and 65 % of length', () => {
    const L = 2000;
    const ele = twoHills(L);
    const g1 = ele(0.25 * L + 200) - ele(0.25 * L);
    const g2 = ele(0.65 * L + 200) - ele(0.65 * L);
    expect(g1).toBeCloseTo(20, 0);
    expect(g2).toBeCloseTo(20, 0);
    expect((ele(0.25 * L + 150) - ele(0.25 * L + 50)) / 100).toBeCloseTo(0.1, 2);
    // flat before the first climb, back to the base at the end
    expect(ele(0)).toBeCloseTo(ele(0.2 * L), 6);
    expect(ele(L)).toBeCloseTo(ele(0), 6);
  });
});

describe('simulateRun', () => {
  const straight1k = makeRoute('straight', { length: 1000 });

  it('constant 3 m/s on 1000 m: last fix ~333 s after the first, truthAtSec(100) ~300', () => {
    const sim = simulateRun(straight1k, { speed: constant(3), startMs: START, seed: 1 });
    const { fixes } = sim;
    expect(fixes[0].t).toBe(START);
    expect(Math.abs((fixes[fixes.length - 1].t - fixes[0].t) / 1000 - 1000 / 3)).toBeLessThanOrEqual(1);
    expect(sim.truthAtSec(100)).toBeCloseTo(300, 6);
    expect(sim.truthAtSec(0)).toBe(0);
    expect(sim.truthAtSec(10000)).toBeCloseTo(1000, 6);
    // 1 Hz, strictly increasing timestamps
    for (let i = 1; i < fixes.length; i++) expect(fixes[i].t - fixes[i - 1].t).toBe(1000);
  });

  it('same seed → identical fixes; different seed → different noise', () => {
    const a = simulateRun(straight1k, { speed: constant(3), startMs: START, seed: 9 }).fixes;
    const b = simulateRun(straight1k, { speed: constant(3), startMs: START, seed: 9 }).fixes;
    const c = simulateRun(straight1k, { speed: constant(3), startMs: START, seed: 10 }).fixes;
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('position noise has the requested RMS and is time-correlated', () => {
    const route = makeRoute('straight', { length: 6000 });
    const cum = cumulativeDistances(route);
    const proj = makeProjection(route[0]);
    let sq = 0;
    let stepSq = 0;
    let n = 0;
    let steps = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const sim = simulateRun(route, { speed: constant(3), startMs: START, noiseM: 5, seed });
      let prevErr: { x: number; y: number } | null = null;
      for (const f of sim.fixes) {
        const truth = proj.toXY(pointAt(route, cum, sim.truthAtSec((f.t - START) / 1000)));
        const obs = proj.toXY(f);
        const err = { x: obs.x - truth.x, y: obs.y - truth.y };
        sq += err.x ** 2 + err.y ** 2;
        n++;
        if (prevErr) {
          stepSq += (err.x - prevErr.x) ** 2 + (err.y - prevErr.y) ** 2;
          steps++;
        }
        prevErr = err;
      }
    }
    const rms = Math.sqrt(sq / n);
    const stepRms = Math.sqrt(stepSq / steps);
    expect(rms).toBeGreaterThan(3.5);
    expect(rms).toBeLessThan(6.5);
    expect(stepRms).toBeLessThan(rms / 4); // white noise would give rms·√2
  });

  it('noiseM 0 puts fixes exactly on the truth', () => {
    const route = makeRoute('loop', { length: 1000 });
    const cum = cumulativeDistances(route);
    const sim = simulateRun(route, { speed: constant(4), startMs: START, noiseM: 0 });
    for (const f of sim.fixes) {
      const truth = pointAt(route, cum, sim.truthAtSec((f.t - START) / 1000));
      expect(haversine(f, truth)).toBeLessThan(0.01);
    }
  });

  it('fills speed and course from the truth', () => {
    const sim = simulateRun(straight1k, { speed: constant(3), startMs: START, seed: 4 });
    for (const f of sim.fixes) {
      expect(f.speed).not.toBeNull();
      expect(Math.abs((f.speed as number) - 3)).toBeLessThan(0.5);
      expect(angleDiff(f.course as number, 0)).toBeLessThan(15);
      expect(f.hAcc).toBe(5);
    }
    const custom = simulateRun(straight1k, { speed: constant(3), startMs: START, hAcc: 17 });
    expect(custom.fixes.every((f) => f.hAcc === 17)).toBe(true);
  });

  it('uses grade in the speed function', () => {
    const L = 2000;
    const route = makeRoute('straight', { length: L, elevation: twoHills(L) });
    const grades: number[] = [];
    const sim = simulateRun(route, {
      speed: (_d, grade) => {
        grades.push(grade);
        return 3 - 10 * Math.max(0, grade);
      },
      startMs: START,
    });
    expect(Math.max(...grades)).toBeCloseTo(0.1, 2);
    // the climb 500..700 m at 2 m/s takes 100 s; flat at 3 m/s takes ~66.7 s
    const t = (d: number) => {
      let lo = 0;
      let hi = 5000;
      while (hi - lo > 0.01) {
        const mid = (lo + hi) / 2;
        if (sim.truthAtSec(mid) < d) lo = mid;
        else hi = mid;
      }
      return lo;
    };
    expect(t(690) - t(510)).toBeCloseTo(90, 0);
    expect(t(490) - t(310)).toBeCloseTo(60, 0);
  });

  it('gaps emit no fixes', () => {
    const sim = simulateRun(straight1k, {
      speed: constant(3),
      startMs: START,
      gaps: [{ fromSec: 100, toSec: 130 }],
    });
    const secs = sim.fixes.map((f) => (f.t - START) / 1000);
    expect(secs.some((s) => s > 100 && s < 130)).toBe(false);
    expect(secs).toContain(100);
    expect(secs).toContain(130);
    // truth keeps moving through the gap
    expect(sim.truthAtSec(130) - sim.truthAtSec(100)).toBeCloseTo(90, 6);
  });

  it('stops hold position with noise and report no motion', () => {
    const sim = simulateRun(straight1k, {
      speed: constant(3),
      startMs: START,
      noiseM: 4,
      stops: [{ atSec: 50, durationSec: 60 }],
    });
    expect(sim.truthAtSec(50)).toBeCloseTo(150, 6);
    expect(sim.truthAtSec(80)).toBeCloseTo(150, 6);
    expect(sim.truthAtSec(110)).toBeCloseTo(150, 6);
    expect(sim.truthAtSec(120)).toBeCloseTo(180, 6);
    const during = sim.fixes.filter((f) => f.t > START + 50_000 && f.t < START + 110_000);
    expect(during).toHaveLength(59);
    for (const f of during) {
      expect(f.speed as number).toBeLessThan(0.5);
      expect(f.course).toBe(-1);
    }
    const spread = Math.max(...during.map((f) => haversine(f, during[0])));
    expect(spread).toBeGreaterThan(0);
    expect(spread).toBeLessThan(25);
    // the run is 60 s longer than without the stop
    const last = sim.fixes[sim.fixes.length - 1];
    expect(Math.abs((last.t - START) / 1000 - (1000 / 3 + 60))).toBeLessThanOrEqual(1);
  });

  it('altitude modes: ok, missing, garbage', () => {
    const L = 2000;
    const elevation = twoHills(L);
    const route = makeRoute('straight', { length: L, elevation });
    const base = { speed: constant(3), startMs: START, seed: 5 };
    const ok = simulateRun(route, { ...base, altitude: 'ok' });
    for (const f of ok.fixes) {
      const truthEle = elevation(ok.truthAtSec((f.t - START) / 1000));
      expect(Math.abs((f.alt as number) - truthEle)).toBeLessThan(6);
      expect(f.vAcc as number).toBeLessThanOrEqual(10);
    }
    const missing = simulateRun(route, { ...base, altitude: 'missing' });
    expect(missing.fixes.every((f) => f.alt === null && f.vAcc === null)).toBe(true);
    const garbage = simulateRun(route, { ...base, altitude: 'garbage' });
    expect(garbage.fixes.every((f) => f.vAcc === 30 && typeof f.alt === 'number')).toBe(true);
    let jumps = 0;
    for (let i = 1; i < garbage.fixes.length; i++) {
      const step = Math.abs((garbage.fixes[i].alt as number) - (garbage.fixes[i - 1].alt as number));
      if (step > 25) jumps++;
    }
    expect(jumps).toBeGreaterThan(5);
    // horizontal noise is identical across altitude modes (same seed)
    expect(missing.fixes.map((f) => [f.lat, f.lon])).toEqual(ok.fixes.map((f) => [f.lat, f.lon]));
  });

  it('supports other sampling rates', () => {
    const sim = simulateRun(straight1k, { speed: constant(4), startMs: START, hz: 2 });
    expect(sim.fixes[1].t - sim.fixes[0].t).toBe(500);
    expect(sim.fixes.length).toBeGreaterThanOrEqual(500);
  });
});

describe('toEvents', () => {
  const fix = (t: number): GpsFix => ({
    t,
    lat: 0,
    lon: 0,
    hAcc: 5,
    alt: null,
    vAcc: null,
    speed: 3,
    course: 0,
  });

  it('starts at the first fix, merges pauses by time and finishes at the last fix', () => {
    const fixes = [fix(1000), fix(2000), fix(3000), fix(4000), fix(5000)];
    const ev = toEvents(fixes, { pauses: [{ fromMs: 2000, toMs: 3500 }] });
    expect(ev.map((e) => e.type)).toEqual(['start', 'fix', 'pause', 'fix', 'fix', 'resume', 'fix', 'fix', 'finish']);
    expect(ev[0]).toEqual({ type: 'start', t: 1000 });
    expect(ev[ev.length - 1]).toEqual({ type: 'finish', t: 5000 });
    const times = ev.map((e) => (e.type === 'fix' ? e.fix.t : e.t));
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
  });

  it('uses finishMs when given and sorts unsorted fixes', () => {
    const ev = toEvents([fix(3000), fix(1000), fix(2000)], { finishMs: 40_000 });
    expect(ev[0]).toEqual({ type: 'start', t: 1000 });
    expect(ev.filter((e) => e.type === 'fix').map((e) => (e.type === 'fix' ? e.fix.t : 0))).toEqual([
      1000, 2000, 3000,
    ]);
    expect(ev[ev.length - 1]).toEqual({ type: 'finish', t: 40_000 });
  });

  it('returns [] for no fixes', () => {
    expect(toEvents([])).toEqual([]);
  });
});
