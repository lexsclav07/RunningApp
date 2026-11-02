/** @jest-environment node */
import { describe, expect, it } from '@jest/globals';
import { assessElevation, detectClimbs, gainLoss, grades, smoothElevation, upcomingClimb } from '../elevation';
import { makeRoute, twoHills } from '../sim/routes';
import { simulateRun, type SimAltitudeMode } from '../sim/trace';
import { buildRouteGeometry } from '../track';
import type { Climb, GpsFix, RoutePoint } from '../types';

const T0 = Date.UTC(2026, 9, 29, 7, 0, 0);
const LENGTH = 2000;

/** 0, step, 2·step, … up to `to` inclusive. */
const grid = (to: number, step: number) => Array.from({ length: Math.round(to / step) + 1 }, (_, i) => i * step);

/** Route points at distances `ds` with elevation `ele(d)` (positions only need to be distinct). */
const pointsFor = (ds: number[], ele: (d: number) => number | null): RoutePoint[] =>
  ds.map((d) => ({ lat: 51.5 + d / 111195, lon: -0.13, d, ele: ele(d) }));

/** Elevation that is flat at 30 m, then rises at `grade` over `[from, from + len]`, then stays flat. */
const ramp = (from: number, len: number, grade: number) => (d: number) =>
  30 + grade * Math.min(Math.max(d - from, 0), len);

/** A recording of the twoHills 2 km loop: slower uphill, faster downhill. */
function recordHills(altitude: SimAltitudeMode, seed = 1) {
  const route = makeRoute('loop', { length: LENGTH, elevation: twoHills(LENGTH) });
  return simulateRun(route, {
    speed: (_d, grade) => Math.max(1.5, 3.2 - 12 * grade),
    startMs: T0,
    noiseM: 4,
    seed,
    altitude,
  });
}

describe('smoothElevation', () => {
  it('removes isolated spikes (median of 5)', () => {
    const d = grid(200, 2);
    const ele = d.map((x) => (x === 60 ? 5 : x === 140 || x === 142 ? 80 : 50));
    for (const v of smoothElevation(d, ele)) expect(v).toBeCloseTo(50, 9);
  });

  it('leaves a steady slope unchanged where the window fits', () => {
    const d = grid(300, 3);
    const out = smoothElevation(d, d.map((x) => 20 + 0.08 * x));
    d.forEach((x, i) => {
      if (x >= 30 && x <= 270) expect(out[i]).toBeCloseTo(20 + 0.08 * x, 9);
    });
  });

  it('bridges gaps ≤ 100 m linearly and leaves longer gaps null', () => {
    const d = grid(600, 5);
    const ele = d.map((x) => ((x > 100 && x < 180) || (x > 300 && x < 450) ? null : x <= 100 ? 10 : 30));
    const out = smoothElevation(d, ele);
    const at = (x: number) => out[d.indexOf(x)];
    expect(at(100)).toBeCloseTo(10, 9);
    expect(at(120)).toBeCloseTo(15, 9);
    expect(at(140)).toBeCloseTo(20, 9);
    expect(at(180)).toBeCloseTo(30, 9);
    for (let x = 305; x < 450; x += 5) expect(at(x)).toBeNull();
    expect(at(450)).toBeCloseTo(30, 9);
  });

  it('holds the nearest value across gaps ≤ 100 m at either end', () => {
    const d = grid(500, 5);
    const out = smoothElevation(d, d.map((x) => (x < 60 || x > 340 ? null : 42)));
    expect(out[0]).toBeCloseTo(42, 9); // 60 m leading gap: held
    expect(out[d.indexOf(340)]).toBeCloseTo(42, 9);
    expect(out[d.indexOf(345)]).toBeNull(); // 160 m trailing gap: left empty
    expect(out[d.length - 1]).toBeNull();
  });

  it('returns all null without any altitude', () => {
    expect(smoothElevation([0, 5, 10], [null, null, null])).toEqual([null, null, null]);
    expect(smoothElevation([], [])).toEqual([]);
  });
});

describe('gainLoss', () => {
  const up = Array.from({ length: 41 }, (_, i) => i * 0.5); // 0 → 20
  const down = Array.from({ length: 31 }, (_, i) => 20 - i * 0.5); // 20 → 5

  it('counts a clean climb and descent exactly', () => {
    const r = gainLoss([...up, ...down.slice(1)]);
    expect(r.gain).toBeCloseTo(20, 9);
    expect(r.loss).toBeCloseTo(15, 9);
  });

  it('ignores wiggles below the hysteresis without eating into real climbs', () => {
    expect(gainLoss([10, 12, 10, 12, 10, 12])).toEqual({ gain: 0, loss: 0 });
    const r = gainLoss([...up, 19, 20, 18.5, 20, ...down.slice(1)]);
    expect(r.gain).toBeCloseTo(20, 9);
    expect(r.loss).toBeCloseTo(15, 9);
    expect(gainLoss([0, 2, 0, 2], 1)).toEqual({ gain: 4, loss: 2 });
  });

  it('is zero for empty or single-sample input', () => {
    expect(gainLoss([])).toEqual({ gain: 0, loss: 0 });
    expect(gainLoss([7])).toEqual({ gain: 0, loss: 0 });
  });
});

describe('grades', () => {
  it('reads a constant slope exactly, including at the ends', () => {
    const d = grid(300, 5);
    for (const g of grades(d, d.map((x) => 12 + 0.06 * x))) expect(g).toBeCloseTo(0.06, 9);
  });

  it('uses a centred 50 m window: zero on the flat, the climb grade inside the climb', () => {
    const d = grid(1000, 5);
    const g = grades(d, d.map(ramp(300, 400, 0.08)));
    const at = (x: number) => g[d.indexOf(x)];
    expect(at(100)).toBeCloseTo(0, 12);
    expect(at(300)).toBeCloseTo(0.04, 9); // half the window is on the climb
    expect(at(500)).toBeCloseTo(0.08, 9);
    expect(at(900)).toBeCloseTo(0, 12);
    expect(grades([], [])).toEqual([]);
  });
});

describe('detectClimbs', () => {
  it('finds one 10 % climb with its bounds, gain and grades', () => {
    const climbs = detectClimbs(pointsFor(grid(1000, 5), ramp(300, 200, 0.1)));
    expect(climbs).toHaveLength(1);
    const [c] = climbs;
    expect(c.startD).toBeCloseTo(300, 6);
    expect(c.endD).toBeCloseTo(500, 6);
    expect(c.gain).toBeCloseTo(20, 6);
    expect(c.avgGrade).toBeCloseTo(0.1, 6);
    expect(c.maxGrade).toBeCloseTo(0.1, 6);
  });

  it('ignores climbs that are too short, too shallow or downhill (defaults 4 %, 80 m, 6 m)', () => {
    const ds = grid(1000, 5);
    const bump = pointsFor(ds, ramp(300, 60, 0.1)); // 60 m long, 6 m gain
    expect(detectClimbs(bump)).toEqual([]);
    expect(detectClimbs(pointsFor(ds, ramp(300, 400, 0.03)))).toEqual([]); // 3 %, 12 m gain
    expect(detectClimbs(pointsFor(ds, ramp(300, 200, -0.1)))).toEqual([]);
    // the thresholds are options
    expect(detectClimbs(bump, { minLength: 50 })).toHaveLength(1);
    expect(detectClimbs(pointsFor(ds, ramp(300, 200, 0.1)), { minGain: 25 })).toEqual([]);
    expect(detectClimbs(pointsFor(ds, ramp(300, 400, 0.03)), { minGrade: 0.02 })).toHaveLength(1);
  });

  it('treats a climb with a short easing as one climb', () => {
    // 150 m at 10 %, 40 m at 1 %, 150 m at 10 %
    const ele = (d: number) =>
      30 + 0.1 * Math.min(Math.max(d - 300, 0), 150) + 0.01 * Math.min(Math.max(d - 450, 0), 40) +
      0.1 * Math.min(Math.max(d - 490, 0), 150);
    const climbs = detectClimbs(pointsFor(grid(1000, 5), ele));
    expect(climbs).toHaveLength(1);
    expect(climbs[0].startD).toBeCloseTo(300, 6);
    expect(climbs[0].endD).toBeCloseTo(640, 6);
    expect(climbs[0].gain).toBeCloseTo(30.4, 6);
  });

  it('returns [] when any elevation is missing', () => {
    const ds = grid(1000, 5);
    const climb = ramp(300, 200, 0.1);
    expect(detectClimbs(pointsFor(ds, (d) => (d === 800 ? null : climb(d))))).toEqual([]);
    expect(detectClimbs(pointsFor([0], () => 30))).toEqual([]);
    expect(detectClimbs([])).toEqual([]);
  });
});

describe('upcomingClimb', () => {
  const c1: Climb = { startD: 500, endD: 700, gain: 20, avgGrade: 0.1, maxGrade: 0.11 };
  const c2: Climb = { startD: 1300, endD: 1500, gain: 20, avgGrade: 0.1, maxGrade: 0.12 };

  it('returns the next climb at 200 m out and null once past its start', () => {
    expect(upcomingClimb([c1, c2], 300)).toEqual({ distanceTo: 200, climb: c1 });
    expect(upcomingClimb([c1, c2], 499)).toEqual({ distanceTo: 1, climb: c1 });
    expect(upcomingClimb([c1, c2], 501)).toBeNull(); // on c1; c2 is 799 m away
    expect(upcomingClimb([c1, c2], 1100)).toEqual({ distanceTo: 200, climb: c2 });
    expect(upcomingClimb([c1, c2], 1301)).toBeNull();
  });

  it('looks only `lookahead` metres ahead and picks the nearest climb in any order', () => {
    expect(upcomingClimb([c1, c2], 200)).toBeNull(); // 300 m out > 250 m default
    expect(upcomingClimb([c1, c2], 200, 300)).toEqual({ distanceTo: 300, climb: c1 });
    expect(upcomingClimb([c2, c1], 300)).toEqual({ distanceTo: 200, climb: c1 });
    expect(upcomingClimb([], 0)).toBeNull();
  });
});

describe('assessElevation', () => {
  it('accepts a clean altitude trace', () => {
    expect(assessElevation(recordHills('ok').fixes)).toBe(true);
  });

  it('rejects missing and garbage altitude', () => {
    expect(assessElevation(recordHills('missing').fixes)).toBe(false);
    expect(assessElevation(recordHills('garbage').fixes)).toBe(false);
    expect(assessElevation([])).toBe(false);
  });

  it('needs ≥ 60 % of fixes with an altitude whose vAcc is null or ≤ 20 m', () => {
    const { fixes } = recordHills('ok');
    /** Applies `f` to `k` of every 20 consecutive fixes. */
    const degrade = (k: number, f: (fix: GpsFix) => GpsFix) => fixes.map((fix, i) => (i % 20 < k ? f(fix) : fix));
    expect(assessElevation(degrade(7, (x) => ({ ...x, alt: null })))).toBe(true); // 65 % usable
    expect(assessElevation(degrade(9, (x) => ({ ...x, alt: null })))).toBe(false); // 55 %
    expect(assessElevation(degrade(9, (x) => ({ ...x, vAcc: 25 })))).toBe(false);
    expect(assessElevation(degrade(9, (x) => ({ ...x, vAcc: -1 })))).toBe(false); // iOS: altitude invalid
    expect(assessElevation(fixes.map((x) => ({ ...x, vAcc: null })))).toBe(true);
  });

  it('rejects a sustained altitude jump that survives smoothing (> 15 m per 5 m)', () => {
    const { fixes } = recordHills('ok');
    const half = fixes.length >> 1;
    const jumped = fixes.map((f, i) => (i < half ? f : { ...f, alt: (f.alt as number) + 200 }));
    expect(assessElevation(jumped)).toBe(false);
  });
});

describe('elevation from simulated recordings', () => {
  it('twoHills route yields exactly 2 climbs with gain 20 ± 4 m each', () => {
    for (const seed of [1, 2, 3]) {
      const geometry = buildRouteGeometry(recordHills('ok', seed).fixes);
      expect(geometry.elevationReliable).toBe(true);
      expect(geometry.points.every((p) => p.ele !== null)).toBe(true);
      const climbs = detectClimbs(geometry.points);
      expect(climbs).toHaveLength(2);
      climbs.forEach((c, i) => {
        expect(Math.abs(c.gain - 20)).toBeLessThanOrEqual(4);
        expect(Math.abs(c.startD - [500, 1300][i])).toBeLessThanOrEqual(40);
        expect(c.avgGrade).toBeGreaterThan(0.07);
        expect(c.avgGrade).toBeLessThan(0.13);
      });
      const { gain, loss } = gainLoss(geometry.points.map((p) => p.ele as number));
      expect(Math.abs(gain - 40)).toBeLessThanOrEqual(8);
      expect(Math.abs(loss - 40)).toBeLessThanOrEqual(8);
    }
  });

  it("altitude: 'garbage' → elevationReliable = false, all ele null, detectClimbs → []", () => {
    const ok = buildRouteGeometry(recordHills('ok').fixes);
    const shape = (pts: RoutePoint[]) => pts.map(({ lat, lon, d }) => ({ lat, lon, d }));
    for (const altitude of ['garbage', 'missing'] as const) {
      const g = buildRouteGeometry(recordHills(altitude).fixes);
      expect(g.elevationReliable).toBe(false);
      expect(g.points.length).toBeGreaterThan(300);
      expect(g.points.every((p) => p.ele === null)).toBe(true);
      expect(detectClimbs(g.points)).toEqual([]);
      // poor altitude never changes the horizontal route
      expect(shape(g.points)).toEqual(shape(ok.points));
    }
  });
});
