/** @jest-environment node */
import { describe, expect, it } from '@jest/globals';
import { cumulativeDistances, haversine, makeProjection, projectOntoSegment } from '../geo';
import { DEFAULT_SIM_ORIGIN, makeRoute } from '../sim/routes';
import { simulateRun } from '../sim/trace';
import { buildRouteGeometry, resample } from '../track';
import type { GpsFix, LatLon } from '../types';

const T0 = Date.UTC(2026, 9, 29, 7, 0, 0);
const run3 = () => 3;

/** Largest distance (m) from any of `pts` to the polyline `path`. */
function maxDeviation(pts: LatLon[], path: LatLon[]): number {
  const proj = makeProjection(path[0]);
  const xy = path.map((p) => proj.toXY(p));
  let worst = 0;
  for (const p of pts) {
    const q = proj.toXY(p);
    let best = Infinity;
    for (let i = 0; i + 1 < xy.length; i++) best = Math.min(best, projectOntoSegment(q, xy[i], xy[i + 1]).dist);
    worst = Math.max(worst, best);
  }
  return worst;
}

describe('resample', () => {
  it('resampled straight 1000 m route has 201 points and length 1000 ± 1', () => {
    const pts = resample(makeRoute('straight', { length: 1000 }), 5);
    expect(pts).toHaveLength(201);
    expect(pts[0].d).toBe(0);
    expect(Math.abs(pts[200].d - 1000)).toBeLessThanOrEqual(1);
  });

  it('spaces points evenly along the path and keeps both end points', () => {
    const route = makeRoute('loop', { length: 1000 });
    const pts = resample(route, 5);
    const last = pts[pts.length - 1];
    const step = last.d / (pts.length - 1);
    expect(step).toBeCloseTo(5, 1);
    pts.forEach((p, i) => expect(p.d).toBeCloseTo(i * step, 6));
    expect(pts[0].lat).toBeCloseTo(route[0].lat, 12);
    expect(pts[0].lon).toBeCloseTo(route[0].lon, 12);
    expect(last.lat).toBeCloseTo(route[route.length - 1].lat, 12);
    expect(last.lon).toBeCloseTo(route[route.length - 1].lon, 12);
    expect(maxDeviation(pts, route)).toBeLessThan(0.01);
  });

  it('uses round(length / spacing) equal steps when the length is not a multiple of the spacing', () => {
    const pts = resample(makeRoute('straight', { length: 1002.4 }), 5);
    expect(pts).toHaveLength(201);
    expect(pts[200].d).toBeCloseTo(1002.4, 0);
    expect(pts[1].d - pts[0].d).toBeCloseTo(5.012, 2);
  });

  it('interpolates elevation linearly and takes the nearer value next to a missing one', () => {
    const proj = makeProjection(DEFAULT_SIM_ORIGIN);
    const at = (y: number, ele: number | null) => ({ ...proj.toLatLon(0, y), ele });
    const pts = resample([at(0, 10), at(20, 12), at(40, null), at(60, 20)], 5);
    expect(pts).toHaveLength(13);
    expect(pts[2].ele).toBeCloseTo(11, 6); // d = 10, halfway from 10 to 12
    expect(pts[4].ele).toBeCloseTo(12, 6); // d = 20
    expect(pts[5].ele).toBeCloseTo(12, 6); // d = 25, nearer neighbour has 12
    expect(pts[7].ele).toBeNull(); // d = 35, nearer neighbour has none
    expect(pts[9].ele).toBeNull(); // d = 45
    expect(pts[11].ele).toBeCloseTo(20, 6); // d = 55
  });

  it('handles empty, single-point and duplicate-point input', () => {
    expect(resample([], 5)).toEqual([]);
    const p = { lat: 51.5, lon: -0.13, ele: 12 };
    expect(resample([p], 5)).toEqual([{ lat: 51.5, lon: -0.13, d: 0, ele: 12 }]);
    expect(resample([p, { ...p }, { ...p }], 5)).toEqual([{ lat: 51.5, lon: -0.13, d: 0, ele: 12 }]);
    const route = makeRoute('straight', { length: 100 });
    const withDuplicates = route.flatMap((q, i) => (i % 10 === 0 ? [q, { ...q }] : [q]));
    expect(resample(withDuplicates, 5)).toEqual(resample(route, 5));
  });

  it('rejects a non-positive spacing', () => {
    const route = makeRoute('straight', { length: 100 });
    expect(() => resample(route, 0)).toThrow(RangeError);
    expect(() => resample(route, -5)).toThrow(RangeError);
  });
});

describe('buildRouteGeometry', () => {
  it('an ideal straight 1000 m recording gives 201 points and length 1000 ± 1', () => {
    const route = makeRoute('straight', { length: 1000 });
    const { fixes } = simulateRun(route, { speed: run3, startMs: T0, noiseM: 0 });
    const g = buildRouteGeometry(fixes);
    expect(g.points).toHaveLength(201);
    expect(Math.abs(g.length - 1000)).toBeLessThanOrEqual(1);
    expect(g.length).toBe(g.points[200].d);
    expect(g.isLoop).toBe(false);
    expect(maxDeviation(g.points, route)).toBeLessThan(0.5);
  });

  it('uses accepted fixes only, in time order (poor accuracy, teleports, stale duplicates ignored)', () => {
    const route = makeRoute('straight', { length: 1000 });
    const { fixes } = simulateRun(route, { speed: run3, startMs: T0, noiseM: 0 });
    const proj = makeProjection(route[0]);
    const shift = (f: GpsFix, dx: number, over: Partial<GpsFix> = {}): GpsFix => {
      const xy = proj.toXY(f);
      return { ...f, ...proj.toLatLon(xy.x + dx, xy.y), ...over };
    };
    const bad = [
      shift(fixes[100], 60, { t: fixes[100].t + 500, hAcc: 80 }), // accuracy
      shift(fixes[200], 500, { t: fixes[200].t + 500 }), // 500 m in 0.5 s
      shift(fixes[300], 20), // same t as fixes[300], delivered again later
    ];
    const clean = buildRouteGeometry(fixes);
    expect(buildRouteGeometry([...fixes, ...bad])).toEqual(clean);
    expect(buildRouteGeometry([...fixes].reverse())).toEqual(clean);
  });

  it("a 10-minute stationary start doesn't add spurs (length within 2 % of truth)", () => {
    for (const kind of ['straight', 'loop'] as const) {
      const route = makeRoute(kind, { length: 1000 });
      for (const seed of [1, 2, 3, 4, 5]) {
        const { fixes } = simulateRun(route, {
          speed: run3,
          startMs: T0,
          noiseM: 5,
          seed,
          stops: [{ atSec: 0, durationSec: 600 }],
        });
        // joining the 600 standing fixes as they are would add far more than 2 %
        const standing = fixes.filter((f) => f.t < T0 + 600_000);
        expect(cumulativeDistances(standing)[standing.length - 1]).toBeGreaterThan(100);
        const g = buildRouteGeometry(fixes);
        expect(Math.abs(g.length - 1000)).toBeLessThanOrEqual(20);
        expect(haversine(g.points[0], route[0])).toBeLessThan(15);
      }
    }
  });

  it('a stop mid-route does not add spurs either', () => {
    const route = makeRoute('loop', { length: 1000 });
    for (const seed of [1, 2, 3]) {
      const { fixes } = simulateRun(route, {
        speed: run3,
        startMs: T0,
        noiseM: 5,
        seed,
        stops: [{ atSec: 120, durationSec: 180 }],
      });
      expect(Math.abs(buildRouteGeometry(fixes).length - 1000)).toBeLessThanOrEqual(20);
    }
  });

  it('a noisy 2 km recording follows the true path', () => {
    const route = makeRoute('figureEight', { length: 2000 });
    for (const seed of [1, 2, 3]) {
      const { fixes } = simulateRun(route, { speed: () => 3.2, startMs: T0, noiseM: 4, seed });
      const g = buildRouteGeometry(fixes);
      expect(Math.abs(g.length - 2000)).toBeLessThanOrEqual(40);
      expect(maxDeviation(g.points, route)).toBeLessThan(15);
      for (let i = 1; i < g.points.length; i++) expect(g.points[i].d).toBeGreaterThan(g.points[i - 1].d);
    }
  });

  it('isLoop: closes within 50 m and is at least 400 m long', () => {
    const geometryOf = (kind: 'loop' | 'straight', length: number) =>
      buildRouteGeometry(simulateRun(makeRoute(kind, { length }), { speed: run3, startMs: T0, noiseM: 3 }).fixes);
    expect(geometryOf('loop', 1000).isLoop).toBe(true);
    expect(geometryOf('straight', 1000).isLoop).toBe(false);
    expect(geometryOf('loop', 300).isLoop).toBe(false);
  });

  it('a recording that never moves collapses to a single point', () => {
    const { fixes } = simulateRun(makeRoute('straight', { length: 200 }), {
      speed: run3,
      startMs: T0,
      noiseM: 8,
      stops: [{ atSec: 0, durationSec: 600 }],
    });
    const g = buildRouteGeometry(fixes.filter((f) => f.t < T0 + 600_000));
    expect(g.points).toHaveLength(1);
    expect(g.length).toBe(0);
    expect(g.isLoop).toBe(false);
  });

  it('returns an empty geometry when no fix is accepted', () => {
    const empty = { points: [], length: 0, isLoop: false, elevationReliable: false };
    expect(buildRouteGeometry([])).toEqual(empty);
    const { fixes } = simulateRun(makeRoute('straight', { length: 200 }), { speed: run3, startMs: T0, hAcc: 80 });
    expect(buildRouteGeometry(fixes)).toEqual(empty);
  });
});
