/** @jest-environment node */
import { describe, expect, it } from '@jest/globals';
import {
  angleDiff,
  bearing,
  cumulativeDistances,
  haversine,
  makeProjection,
  projectOntoSegment,
} from '../geo';

describe('haversine', () => {
  it('measures 1 degree of latitude as ~111195 m', () => {
    expect(Math.abs(haversine({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }) - 111195)).toBeLessThanOrEqual(1);
  });

  it('is symmetric and zero for identical points', () => {
    const a = { lat: 51.5, lon: -0.13 };
    const b = { lat: 51.51, lon: -0.12 };
    expect(haversine(a, a)).toBe(0);
    expect(haversine(a, b)).toBeCloseTo(haversine(b, a), 9);
  });
});

describe('bearing / angleDiff', () => {
  it('north = 0, east = 90, south = 180, west = 270', () => {
    const o = { lat: 10, lon: 20 };
    expect(bearing(o, { lat: 10.01, lon: 20 })).toBeCloseTo(0, 6);
    expect(bearing(o, { lat: 10, lon: 20.01 })).toBeCloseTo(90, 2);
    expect(bearing(o, { lat: 9.99, lon: 20 })).toBeCloseTo(180, 6);
    expect(bearing(o, { lat: 10, lon: 19.99 })).toBeCloseTo(270, 2);
  });

  it('always returns a value in [0, 360)', () => {
    const o = { lat: 0, lon: 0 };
    for (let deg = 0; deg < 360; deg += 15) {
      const r = (deg * Math.PI) / 180;
      const b = bearing(o, { lat: 0.001 * Math.cos(r), lon: 0.001 * Math.sin(r) });
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(360);
    }
  });

  it('angleDiff is the smallest absolute difference in [0, 180]', () => {
    expect(angleDiff(350, 10)).toBeCloseTo(20, 9);
    expect(angleDiff(10, 350)).toBeCloseTo(20, 9);
    expect(angleDiff(0, 180)).toBeCloseTo(180, 9);
    expect(angleDiff(90, 90)).toBe(0);
    expect(angleDiff(-90, 270)).toBeCloseTo(0, 9);
    expect(angleDiff(725, 0)).toBeCloseTo(5, 9);
  });
});

describe('makeProjection', () => {
  const origin = { lat: 51.5, lon: -0.13 };
  const proj = makeProjection(origin);

  it('maps the origin to (0, 0) and round-trips', () => {
    expect(proj.toXY(origin)).toEqual({ x: 0, y: 0 });
    const p = { lat: 51.507, lon: -0.121 };
    const xy = proj.toXY(p);
    const back = proj.toLatLon(xy.x, xy.y);
    expect(back.lat).toBeCloseTo(p.lat, 10);
    expect(back.lon).toBeCloseTo(p.lon, 10);
  });

  it('x is east, y is north, and XY distances match haversine within 0.1 %', () => {
    const north = proj.toXY({ lat: 51.51, lon: -0.13 });
    const east = proj.toXY({ lat: 51.5, lon: -0.12 });
    expect(north.x).toBeCloseTo(0, 9);
    expect(north.y).toBeGreaterThan(0);
    expect(east.y).toBeCloseTo(0, 9);
    expect(east.x).toBeGreaterThan(0);
    const p = { lat: 51.508, lon: -0.118 };
    const xy = proj.toXY(p);
    const planar = Math.hypot(xy.x, xy.y);
    expect(Math.abs(planar - haversine(origin, p)) / haversine(origin, p)).toBeLessThan(0.001);
  });
});

describe('projectOntoSegment', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 10, y: 0 };

  it('projects onto the interior', () => {
    expect(projectOntoSegment({ x: 4, y: 3 }, a, b)).toEqual({ f: 0.4, dist: 3, x: 4, y: 0 });
  });

  it('clamps f to [0, 1]', () => {
    const before = projectOntoSegment({ x: -5, y: 0 }, a, b);
    expect(before.f).toBe(0);
    expect(before.dist).toBe(5);
    expect(before.x).toBe(0);
    const after = projectOntoSegment({ x: 13, y: 4 }, a, b);
    expect(after.f).toBe(1);
    expect(after.dist).toBe(5);
    expect(after.x).toBe(10);
  });

  it('handles a zero-length segment', () => {
    expect(projectOntoSegment({ x: 3, y: 4 }, a, a)).toEqual({ f: 0, dist: 5, x: 0, y: 0 });
  });
});

describe('cumulativeDistances', () => {
  it('starts at 0 and accumulates haversine distances', () => {
    const pts = [
      { lat: 0, lon: 0 },
      { lat: 0.001, lon: 0 },
      { lat: 0.002, lon: 0 },
    ];
    const d = cumulativeDistances(pts);
    expect(d).toHaveLength(3);
    expect(d[0]).toBe(0);
    expect(d[1]).toBeCloseTo(haversine(pts[0], pts[1]), 9);
    expect(d[2]).toBeCloseTo(2 * haversine(pts[0], pts[1]), 6);
  });

  it('returns [] for no points', () => {
    expect(cumulativeDistances([])).toEqual([]);
  });
});
