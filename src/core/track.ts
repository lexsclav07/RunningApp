import { DistanceAccumulator, STATIONARY_SPEED } from './distance';
import { assessElevation, smoothElevation, usableAltitude } from './elevation';
import { classifyFix } from './filter';
import { cumulativeDistances, haversine } from './geo';
import type { GpsFix, RouteGeometry, RoutePoint } from './types';

/** Default spacing of route points, m. */
export const ROUTE_SPACING = 5;
/** A route whose ends are at most this far apart (m)… */
const LOOP_CLOSE_M = 50;
/** …and that is at least this long (m) is a loop. */
const LOOP_MIN_LENGTH = 400;
/** The last accepted fix extends the route when it is at least this far (m) past the last kept vertex. */
const MIN_TAIL_M = 1;

/**
 * Resamples a polyline at even steps along its length. Uses n = max(1, round(length / spacing))
 * equal steps of length / n ≈ `spacing`, so the first and last points are the input's end points and
 * `d` (cumulative metres along the input) ends exactly at its length. Positions are interpolated
 * linearly; `ele` too when both neighbours have one, else it is the nearer neighbour's value.
 */
export function resample(points: { lat: number; lon: number; ele: number | null }[], spacing: number): RoutePoint[] {
  if (!(spacing > 0)) throw new RangeError(`resample: spacing must be > 0 (got ${spacing})`);
  if (points.length === 0) return [];
  const cum = cumulativeDistances(points);
  const length = cum[cum.length - 1];
  if (length === 0) return [{ lat: points[0].lat, lon: points[0].lon, d: 0, ele: points[0].ele }];

  const n = Math.max(1, Math.round(length / spacing));
  const out: RoutePoint[] = [];
  let i = 0; // segment i spans cum[i]…cum[i + 1]
  for (let k = 0; k <= n; k++) {
    const s = k === n ? length : (k * length) / n;
    while (i < cum.length - 2 && cum[i + 1] < s) i++;
    const a = points[i];
    const b = points[i + 1];
    const span = cum[i + 1] - cum[i];
    const f = span > 0 ? Math.min(1, Math.max(0, (s - cum[i]) / span)) : 0;
    const ele = a.ele !== null && b.ele !== null ? a.ele + f * (b.ele - a.ele) : f < 0.5 ? a.ele : b.ele;
    out.push({ lat: a.lat + f * (b.lat - a.lat), lon: a.lon + f * (b.lon - a.lon), d: s, ele });
  }
  return out;
}

/**
 * Route geometry from a recording:
 * 1. fixes sorted by time, keeping only those `classifyFix` accepts against the previous accepted fix;
 * 2. stationary clusters collapsed by the distance anchor rule (`DistanceAccumulator`): a fix becomes a
 *    vertex only when it is credited distance. The start vertex is the accumulator's anchor at the first
 *    credit (so a long wait at the start leaves no spur), and the last accepted fix closes the route;
 * 3. the vertices resampled every `spacing` m (default 5).
 * Elevation is the smoothed altitude of the accepted fixes (along their filtered distance) when
 * `assessElevation` judges it reliable and it covers every route point; otherwise `ele` is null
 * everywhere and `elevationReliable` is false.
 */
export function buildRouteGeometry(fixes: GpsFix[], opts: { spacing?: number } = {}): RouteGeometry {
  const spacing = opts.spacing ?? ROUTE_SPACING;

  const accepted: GpsFix[] = [];
  let prev: GpsFix | null = null;
  for (const fix of [...fixes].sort((a, b) => a.t - b.t)) {
    if (!classifyFix(fix, prev).accept) continue;
    accepted.push(fix);
    prev = fix;
  }
  if (accepted.length === 0) return { points: [], length: 0, isLoop: false, elevationReliable: false };

  const acc = new DistanceAccumulator();
  const dist: number[] = []; // filtered distance at each accepted fix, the elevation axis
  const vertices: number[] = []; // indices into `accepted`
  let anchor = -1; // mirrors the accumulator's anchor until the first credit
  accepted.forEach((fix, i) => {
    const { delta, total } = acc.add(fix);
    dist.push(total);
    if (delta > 0) {
      if (vertices.length === 0) vertices.push(anchor);
      vertices.push(i);
      anchor = i;
    } else if (anchor < 0 || isStanding(fix)) {
      anchor = i; // the accumulator re-anchors on the first fix and on standing fixes
    }
  });
  if (vertices.length === 0) vertices.push(anchor);
  const lastIdx = accepted.length - 1;
  const tailFrom = vertices[vertices.length - 1];
  if (tailFrom !== lastIdx && haversine(accepted[tailFrom], accepted[lastIdx]) >= MIN_TAIL_M) vertices.push(lastIdx);

  const assessed = assessElevation(accepted);
  const ele = assessed ? smoothElevation(dist, accepted.map(usableAltitude)) : null;
  const points = resample(
    vertices.map((i) => ({ lat: accepted[i].lat, lon: accepted[i].lon, ele: ele ? ele[i] : null })),
    spacing,
  );
  const elevationReliable = assessed && points.every((p) => p.ele !== null);
  if (!elevationReliable) for (const p of points) p.ele = null;

  const length = points[points.length - 1].d;
  const isLoop = haversine(points[0], points[points.length - 1]) <= LOOP_CLOSE_M && length >= LOOP_MIN_LENGTH;
  return { points, length, isLoop, elevationReliable };
}

/** Same test as `DistanceAccumulator`: a valid Doppler speed below STATIONARY_SPEED means standing. */
function isStanding(fix: GpsFix): boolean {
  return fix.speed !== null && fix.speed >= 0 && fix.speed < STATIONARY_SPEED;
}
