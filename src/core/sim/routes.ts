import { makeProjection, type XY } from '../geo';
import type { LatLon } from '../types';

export type SimRouteKind = 'straight' | 'loop' | 'outAndBack' | 'figureEight' | 'hairpin';
export interface SimRoutePoint { lat: number; lon: number; ele: number | null }
export interface MakeRouteOptions {
  /** Total path length in metres (default 1000). */
  length?: number;
  /** First point of the route (default DEFAULT_SIM_ORIGIN). */
  origin?: LatLon;
  /** Elevation (m) as a function of along-route distance d (m); omitted → ele = null. */
  elevation?: (d: number) => number;
}

export const DEFAULT_SIM_ORIGIN: LatLon = { lat: 51.5, lon: -0.13 };
const DEFAULT_LENGTH = 1000;
/** Target spacing of generated points, m. */
const SPACING = 2;
/** Distance between neighbouring hairpin legs, m (each switchback is a 12.5 m-radius semicircle). */
export const HAIRPIN_SPACING = 25;
/** Preferred hairpin leg length, m. */
const HAIRPIN_LEG = 150;

/** Turtle-graphics path piece. Arc `turn` is in radians, positive = left (counter-clockwise). */
type Piece = { kind: 'line'; len: number } | { kind: 'arc'; radius: number; turn: number };
/** Planar pose: position in metres (x east, y north) and heading in radians counter-clockwise from east. */
interface Pose { x: number; y: number; h: number }

const line = (len: number): Piece => ({ kind: 'line', len });
const arc = (radius: number, turnDeg: number): Piece => ({ kind: 'arc', radius, turn: (turnDeg * Math.PI) / 180 });
const pieceLength = (p: Piece) => (p.kind === 'line' ? p.len : p.radius * Math.abs(p.turn));
const scale = (pieces: Piece[], k: number): Piece[] =>
  pieces.map((p) => (p.kind === 'line' ? line(p.len * k) : { ...p, radius: p.radius * k }));
const totalLength = (pieces: Piece[]) => pieces.reduce((sum, p) => sum + pieceLength(p), 0);

/** Pose after travelling u metres along `piece` from `pose`. */
function advance(pose: Pose, piece: Piece, u: number): Pose {
  if (piece.kind === 'line') {
    return { x: pose.x + u * Math.cos(pose.h), y: pose.y + u * Math.sin(pose.h), h: pose.h };
  }
  const s = Math.sign(piece.turn);
  const r = piece.radius;
  // centre c = p + s·r·(−sin h, cos h) (left of travel for s = +1); point at heading h' = c − s·r·(−sin h', cos h')
  const cx = pose.x - s * r * Math.sin(pose.h);
  const cy = pose.y + s * r * Math.cos(pose.h);
  const h = pose.h + (s * u) / r;
  return { x: cx + s * r * Math.sin(h), y: cy - s * r * Math.cos(h), h };
}

/** Samples a piece path starting at (0, 0) at equal arc-length steps of ≈ `spacing`. */
function samplePath(pieces: Piece[], heading: number, spacing: number): XY[] {
  const lens = pieces.map(pieceLength);
  const total = lens.reduce((a, b) => a + b, 0);
  const n = Math.max(1, Math.round(total / spacing));
  const starts: Pose[] = [];
  let pose: Pose = { x: 0, y: 0, h: heading };
  pieces.forEach((p, i) => {
    starts.push(pose);
    pose = advance(pose, p, lens[i]);
  });
  const out: XY[] = [];
  let i = 0;
  let base = 0;
  for (let k = 0; k <= n; k++) {
    const s = k === n ? total : (k * total) / n;
    while (i < pieces.length - 1 && s > base + lens[i]) base += lens[i++];
    const p = advance(starts[i], pieces[i], Math.min(s - base, lens[i]));
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

const NORTH = Math.PI / 2;
const EAST = 0;

function routeXY(kind: SimRouteKind, length: number): XY[] {
  switch (kind) {
    case 'straight':
      return samplePath([line(length)], NORTH, SPACING);
    case 'loop': {
      // Counter-clockwise rounded rectangle (W = 2H, corner radius 0.1H), starting mid-way along the south side.
      const H = 1;
      const W = 2;
      const rc = 0.1;
      const rel = [
        line(W / 2 - rc), arc(rc, 90), line(H - 2 * rc), arc(rc, 90), line(W - 2 * rc),
        arc(rc, 90), line(H - 2 * rc), arc(rc, 90), line(W / 2 - rc),
      ];
      return closed(samplePath(scale(rel, length / totalLength(rel)), EAST, SPACING));
    }
    case 'figureEight': {
      // Two lobes of radius r with centres 4r apart, joined by two straight lines that cross at the centre at 60°.
      // Starts at the bottom of the lower lobe heading east; the crossing is passed at L/4 and 3L/4.
      const t = 2 * Math.sqrt(3); // 2 × tangent length √(c² − r²) with c = 2r, r = 1
      const rel = [arc(1, 120), line(t), arc(1, -240), line(t), arc(1, 120)];
      return closed(samplePath(scale(rel, length / totalLength(rel)), EAST, SPACING));
    }
    case 'outAndBack': {
      // Out (north, a 60° left bend, straight), then back along exactly the same points.
      const rel = [line(1), arc(0.6, 60), line(1)];
      const out = samplePath(scale(rel, length / 2 / totalLength(rel)), NORTH, SPACING);
      return [...out, ...out.slice(0, -1).reverse()];
    }
    case 'hairpin': {
      // Parallel legs HAIRPIN_SPACING apart joined by alternating right/left 180° semicircles.
      const turnLen = (Math.PI * HAIRPIN_SPACING) / 2;
      let legs = Math.max(1, Math.round((length + turnLen) / (HAIRPIN_LEG + turnLen)));
      while (legs > 1 && (length - (legs - 1) * turnLen) / legs < 20) legs--;
      const leg = (length - (legs - 1) * turnLen) / legs;
      const pieces: Piece[] = [line(leg)];
      for (let i = 1; i < legs; i++) pieces.push(arc(HAIRPIN_SPACING / 2, i % 2 === 1 ? -180 : 180), line(leg));
      return samplePath(pieces, NORTH, SPACING);
    }
  }
}

/** Snaps the last point onto the first so a closed path returns exactly to its start. */
function closed(points: XY[]): XY[] {
  points[points.length - 1] = { ...points[0] };
  return points;
}

/**
 * Synthetic route with points every ≈ 2 m. Geometry is built in local metres and projected around
 * `origin`, so haversine length matches `length` to well under 0.1 %.
 * - straight: due north.
 * - loop: rounded rectangle, ends exactly at its start.
 * - outAndBack: out with one bend, back along the identical points (ends at the start).
 * - figureEight: two lobes, crossing itself once in the middle; ends at its start.
 * - hairpin: north/south legs 25 m apart joined by 180° switchbacks.
 * `ele` = `elevation(d)` with d the along-route distance of the point (null without `elevation`).
 */
export function makeRoute(kind: SimRouteKind, opts: MakeRouteOptions = {}): SimRoutePoint[] {
  const length = opts.length ?? DEFAULT_LENGTH;
  const proj = makeProjection(opts.origin ?? DEFAULT_SIM_ORIGIN);
  const xy = routeXY(kind, length);
  let d = 0;
  return xy.map((p, i) => {
    if (i > 0) d += Math.hypot(p.x - xy[i - 1].x, p.y - xy[i - 1].y);
    const ll = proj.toLatLon(p.x, p.y);
    return { lat: ll.lat, lon: ll.lon, ele: opts.elevation ? opts.elevation(d) : null };
  });
}

/**
 * Elevation profile (m) with two climbs of 20 m over 200 m (10 % grade) starting at 25 % and 65 % of
 * `length`, each followed by a descent (≤ 300 m) back to the 30 m base before the next feature.
 */
export function twoHills(length: number): (d: number) => number {
  const BASE = 30;
  const GAIN = 20;
  const CLIMB = 200;
  const hills = [0.25, 0.65].map((f, i) => {
    const start = f * length;
    const top = start + CLIMB;
    const next = i === 0 ? 0.65 * length : length;
    const descent = Math.max(20, Math.min(300, next - top - 20));
    return { start, top, end: top + descent };
  });
  return (d) => {
    let e = BASE;
    for (const h of hills) {
      if (d <= h.start || d >= h.end) continue;
      // linear ramps: up GAIN over CLIMB metres, then down GAIN over the descent
      e += d < h.top ? (GAIN * (d - h.start)) / CLIMB : GAIN * (1 - (d - h.top) / (h.end - h.top));
    }
    return e;
  };
}
