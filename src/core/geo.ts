import type { LatLon } from './types';

/** Mean Earth radius (IUGG), metres. */
export const EARTH_RADIUS = 6371008.8;
const RAD = Math.PI / 180;

/** Local planar coordinates in metres: x = east, y = north. */
export interface XY { x: number; y: number }

export interface Projection {
  toXY(p: LatLon): XY;
  toLatLon(x: number, y: number): LatLon;
}

/** Normalises any angle in degrees to [0, 360). */
export function normalizeDeg(deg: number): number {
  const r = ((deg % 360) + 360) % 360;
  return r === 360 ? 0 : r;
}

/** Great-circle distance in metres. */
export function haversine(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  // h = sin²(Δφ/2) + cos φ1 · cos φ2 · sin²(Δλ/2);  d = 2R · asin(√h)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, degrees clockwise from north in [0, 360). */
export function bearing(a: LatLon, b: LatLon): number {
  const phi1 = a.lat * RAD;
  const phi2 = b.lat * RAD;
  const dLambda = (b.lon - a.lon) * RAD;
  // θ = atan2(sin Δλ · cos φ2, cos φ1 · sin φ2 − sin φ1 · cos φ2 · cos Δλ)
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return normalizeDeg(Math.atan2(y, x) / RAD);
}

/** Smallest absolute difference between two headings, degrees in [0, 180]. */
export function angleDiff(a: number, b: number): number {
  const d = normalizeDeg(a - b);
  return d > 180 ? 360 - d : d;
}

/**
 * Equirectangular projection around `origin`, in metres. Accurate to well under 0.1 % within a few
 * kilometres of the origin, which covers any running route.
 */
export function makeProjection(origin: LatLon): Projection {
  // metres per degree: ky = R·π/180 (north), kx = ky·cos φ0 (east)
  const ky = EARTH_RADIUS * RAD;
  const kx = ky * Math.cos(origin.lat * RAD);
  // Δλ wrapped to [−180, 180) so routes across the antimeridian stay continuous
  const dLon = (lon: number) => ((((lon - origin.lon + 180) % 360) + 360) % 360) - 180;
  return {
    toXY: (p) => ({ x: dLon(p.lon) * kx, y: (p.lat - origin.lat) * ky }),
    toLatLon: (x, y) => ({ lat: origin.lat + y / ky, lon: origin.lon + x / kx }),
  };
}

/**
 * Closest point to `p` on segment a→b (planar). `f` ∈ [0, 1] is the fraction along the segment,
 * `dist` the distance from `p` to that point.
 */
export function projectOntoSegment(p: XY, a: XY, b: XY): { f: number; dist: number; x: number; y: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  // f = ((p − a)·(b − a)) / |b − a|², clamped to the segment
  let f = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  f = Math.max(0, Math.min(1, f));
  const x = a.x + f * dx;
  const y = a.y + f * dy;
  return { f, dist: Math.hypot(p.x - x, p.y - y), x, y };
}

/** Cumulative haversine distance (m) at each point; first entry is 0. */
export function cumulativeDistances(points: readonly LatLon[]): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) sum += haversine(points[i - 1], points[i]);
    out.push(sum);
  }
  return out;
}
