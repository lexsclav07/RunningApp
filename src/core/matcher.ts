/**
 * Route matcher: turns a stream of GPS fixes into a monotonic position along a saved route ("progress",
 * metres from the route start), robust to GPS jitter, sharp turns, loops, out-and-backs, gaps, pauses and
 * detours. Pure TypeScript, no I/O; one instance per run.
 *
 * Algorithm (per accepted fix; s = matched progress m, v = progress speed m/s):
 * 1. σ = clamp(hAcc ?? 20, 5, 50) m. The fix is projected to local planar metres (equirectangular around
 *    the first route point); route points are projected once in the constructor.
 * 2. Search window along progress [lo, hi]: while acquiring, [0, startWindow] (acquisition happens only
 *    near the start); otherwise lo = s − backTolerance, hi = s + maxSpeed·dtWall + 2σ + 20, where dtWall
 *    is wall seconds since the last on-route fix, so GPS gaps, pauses and detours widen it. The window is
 *    what keeps loops, figure-eights and out-and-backs on the right occurrence of a repeated position.
 * 3. Each route segment overlapping the window (clipped to it) gives one candidate: the fix's closest
 *    point on it, with progress d_c, offset (fix → candidate, m) and the segment bearing.
 * 4. Candidate cost = (offset/σ)² + ((d_c − predicted)/(σ + 15 + 0.5·v·dtRun))² + heading, where
 *    predicted = s + v·dtRun, dtRun = run-clock seconds since the last match (0 across a pause), and
 *    heading = 2·(angleDiff(course, bearing_c)/90)² when the fix has speed ≥ 1.5 m/s and a course, else 0.
 *    While acquiring there is no previous match to predict from, so the progress term is omitted (with
 *    predicted = 0 it would drag acquisition toward the route start). The cheapest candidate wins.
 * 5. If its offset > max(offRouteDistance, 2.5σ) the fix is off route: an off-route timer starts and,
 *    after offRouteConfirmSec of consecutive off-route fixes, the state becomes 'offRoute' ('acquiring'
 *    stays 'acquiring'). s never changes on an off-route fix.
 * 6. Otherwise the fix is on route and s, v follow an alpha-beta filter (Benedict–Bordner gains):
 *    r = d_best − predicted; α = 0.5 (σ ≤ 10), 0.3 (σ ≤ 25), else 0.15; β = α²/(2 − α);
 *    v += β·r/dtRun (when dtRun > 0), clamped to [0, maxSpeed]; s = max(s_prev, predicted + α·r) clamped
 *    to [0, length], so progress never goes backwards. On first acquisition, and on re-acquisition
 *    (after 'offRoute', 'lost' or resetMotion) when |r| > 50 m, the filter is re-seeded instead:
 *    s = max(s_prev, d_best), v = fix speed ?? 0.
 * 7. noteTime(now): no fix for more than lostAfterSec → 'lost' (offset unknown). In every result,
 *    atFinish = acquired && s ≥ length − finishTolerance.
 */
import { angleDiff, makeProjection, normalizeDeg, type Projection, type XY } from './geo';
import type { GpsFix, MatchResult, MatchState, RouteGeometry } from './types';

export interface MatcherOptions {
  /** Fastest plausible running speed, m/s: bounds the forward search window and the speed estimate. */
  maxSpeed: number;
  /** A fix further than this from the route (m) is off route; raised to 2.5σ for inaccurate fixes. */
  offRouteDistance: number;
  /** Seconds of consecutive off-route fixes before the state becomes 'offRoute'. */
  offRouteConfirmSec: number;
  /** How far behind the current progress the search window reaches, m. */
  backTolerance: number;
  /** Acquisition is only possible within this many metres of the route start. */
  startWindow: number;
  /** Seconds without any fix before the state becomes 'lost'. */
  lostAfterSec: number;
  /** Progress within this many metres of the route end counts as at the finish. */
  finishTolerance: number;
}

export const DEFAULT_MATCHER_OPTIONS: Readonly<MatcherOptions> = Object.freeze({
  maxSpeed: 7,
  offRouteDistance: 35,
  offRouteConfirmSec: 6,
  backTolerance: 15,
  startWindow: 150,
  lostAfterSec: 10,
  finishTolerance: 20,
});

/** σ bounds and the σ assumed for a fix without hAcc, m. */
const SIGMA_MIN = 5;
const SIGMA_MAX = 50;
const SIGMA_UNKNOWN = 20;
/** Extra forward reach of the search window beyond maxSpeed·dtWall + 2σ, m. */
const WINDOW_PAD = 20;
/** Along-route slack added to σ in the progress term of the cost, m. */
const ALONG_PAD = 15;
/** Weight of the heading term; a reversed course costs 2·(180/90)² = 8. */
const HEADING_WEIGHT = 2;
/** Minimum reported speed (m/s) for the course to be trusted. */
const HEADING_MIN_SPEED = 1.5;
/** Off-route limit in units of σ (the limit is max(offRouteDistance, 2.5σ)). */
const OFF_ROUTE_SIGMAS = 2.5;
/** Residual (m) above which a re-acquisition re-seeds the filter instead of smoothing. */
const RESEED_RESIDUAL = 50;

interface Candidate { d: number; offset: number; cost: number }

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export class RouteMatcher {
  private readonly opts: MatcherOptions;
  private readonly length: number;
  private readonly proj: Projection;
  /** Route points: cumulative distance (m) and local XY (m); per segment i → i+1: XY vector (m), bearing (deg). */
  private readonly d: number[];
  private readonly xy: XY[];
  private readonly segDx: number[] = [];
  private readonly segDy: number[] = [];
  private readonly segBearing: number[] = [];

  private state: MatchState = 'acquiring';
  private acquired = false;
  /** Matched progress, m. */
  private s = 0;
  /** Progress speed estimate, m/s. */
  private v = 0;
  private offset: number | null = null;
  private lastFixMs: number | null = null;
  /** Wall time (ms) and run clock (s) of the last on-route match. */
  private lastMatchMs: number | null = null;
  private lastMatchRunSec = 0;
  private offRouteSinceMs: number | null = null;
  /** Set by resetMotion: the next on-route fix counts as a re-acquisition. */
  private reacquire = false;

  constructor(route: RouteGeometry, opts?: Partial<MatcherOptions>) {
    if (route.points.length === 0) throw new Error('RouteMatcher: route has no points');
    this.opts = { ...DEFAULT_MATCHER_OPTIONS, ...opts };
    // a single point becomes a zero-length segment so the search always has one
    const pts = route.points.length === 1 ? [route.points[0], route.points[0]] : route.points;
    this.length = route.length;
    this.proj = makeProjection(pts[0]);
    this.d = pts.map((p) => p.d);
    this.xy = pts.map((p) => this.proj.toXY(p));
    for (let i = 0; i + 1 < pts.length; i++) {
      const dx = this.xy[i + 1].x - this.xy[i].x;
      const dy = this.xy[i + 1].y - this.xy[i].y;
      this.segDx.push(dx);
      this.segDy.push(dy);
      // bearing = atan2(east, north), degrees clockwise from north; zero-length segments inherit the previous one
      this.segBearing.push(
        dx === 0 && dy === 0 ? (this.segBearing[i - 1] ?? 0) : normalizeDeg((Math.atan2(dx, dy) * 180) / Math.PI),
      );
    }
  }

  /** Matches one fix. `runSec` is the run clock (excludes pauses). Stale fixes (t ≤ last) are ignored. */
  update(fix: GpsFix, runSec: number): MatchResult {
    if (this.lastFixMs !== null && fix.t <= this.lastFixMs) return this.current();
    this.lastFixMs = fix.t;
    const o = this.opts;
    const sigma = clamp(fix.hAcc ?? SIGMA_UNKNOWN, SIGMA_MIN, SIGMA_MAX);
    const dtWall = this.lastMatchMs === null ? 0 : Math.max(0, (fix.t - this.lastMatchMs) / 1000);
    const dtRun = this.acquired ? Math.max(0, runSec - this.lastMatchRunSec) : 0;
    const predicted = this.s + this.v * dtRun;

    const lo = this.acquired ? clamp(this.s - o.backTolerance, 0, this.length) : 0;
    const hi = this.acquired
      ? clamp(this.s + o.maxSpeed * dtWall + 2 * sigma + WINDOW_PAD, lo, this.length)
      : clamp(o.startWindow, 0, this.length);
    const course =
      fix.course !== null && fix.course >= 0 && fix.speed !== null && fix.speed >= HEADING_MIN_SPEED ? fix.course : null;
    // along-route tolerance of the progress term, m (infinite = no progress term while acquiring)
    const alongScale = this.acquired ? sigma + ALONG_PAD + 0.5 * this.v * dtRun : Infinity;
    const best = this.search(this.proj.toXY(fix), lo, hi, sigma, predicted, alongScale, course);
    this.offset = best.offset;

    if (best.offset > Math.max(o.offRouteDistance, OFF_ROUTE_SIGMAS * sigma)) {
      this.offRouteSinceMs ??= fix.t;
      if (!this.acquired) this.state = 'acquiring';
      else if ((fix.t - this.offRouteSinceMs) / 1000 >= o.offRouteConfirmSec) this.state = 'offRoute';
      return this.current();
    }

    this.offRouteSinceMs = null;
    const r = best.d - predicted;
    const reacquiring = this.state !== 'onRoute' || this.reacquire;
    if (!this.acquired || (reacquiring && Math.abs(r) > RESEED_RESIDUAL)) {
      this.s = clamp(Math.max(this.s, best.d), 0, this.length);
      this.v = clamp(fix.speed ?? 0, 0, o.maxSpeed); // negative speed = unavailable → 0
    } else {
      const alpha = sigma <= 10 ? 0.5 : sigma <= 25 ? 0.3 : 0.15;
      const beta = (alpha * alpha) / (2 - alpha);
      // alpha-beta: s ← predicted + α·r, v ← v + β·r/dt (m/s)
      if (dtRun > 0) this.v = clamp(this.v + (beta * r) / dtRun, 0, o.maxSpeed);
      this.s = clamp(Math.max(this.s, predicted + alpha * r), 0, this.length);
    }
    this.acquired = true;
    this.reacquire = false;
    this.state = 'onRoute';
    this.lastMatchMs = fix.t;
    this.lastMatchRunSec = runSec;
    return this.current();
  }

  /** Clock tick (epoch ms): flags 'lost' once no fix has arrived for more than lostAfterSec. */
  noteTime(nowMs: number): MatchResult {
    if (this.lastFixMs !== null && (nowMs - this.lastFixMs) / 1000 > this.opts.lostAfterSec && this.state !== 'lost') {
      this.state = 'lost';
      this.offset = null;
    }
    return this.current();
  }

  current(): MatchResult {
    return {
      state: this.state,
      progress: this.s,
      offset: this.offset,
      atFinish: this.acquired && this.s >= this.length - this.opts.finishTolerance,
    };
  }

  /**
   * Forgets the motion estimate (call on resume): v = 0, the off-route timer restarts and the next
   * on-route fix counts as a re-acquisition. Progress is kept.
   */
  resetMotion(): void {
    this.v = 0;
    this.offRouteSinceMs = null;
    if (this.acquired) this.reacquire = true;
  }

  /** Cheapest candidate over the segments overlapping [lo, hi] (see header, steps 3–4). */
  private search(
    p: XY,
    lo: number,
    hi: number,
    sigma: number,
    predicted: number,
    alongScale: number,
    course: number | null,
  ): Candidate {
    const { d, xy, segDx, segDy } = this;
    let bestD = lo;
    let bestOffset = Infinity;
    let bestCost = Infinity;
    for (let i = this.segmentAt(lo); i + 1 < d.length && d[i] <= hi; i++) {
      const span = d[i + 1] - d[i];
      // only fractions f0..f1 of the segment lie inside the window [lo, hi]
      const f0 = span > 0 ? clamp((lo - d[i]) / span, 0, 1) : 0;
      const f1 = span > 0 ? clamp((hi - d[i]) / span, 0, 1) : 0;
      const dx = segDx[i];
      const dy = segDy[i];
      const len2 = dx * dx + dy * dy;
      // closest point: f = ((p − a)·(b − a)) / |b − a|², clamped to the in-window part
      const f = clamp(len2 > 0 ? ((p.x - xy[i].x) * dx + (p.y - xy[i].y) * dy) / len2 : 0, f0, f1);
      const ex = p.x - (xy[i].x + f * dx);
      const ey = p.y - (xy[i].y + f * dy);
      const offset = Math.sqrt(ex * ex + ey * ey);
      const dc = d[i] + f * span;
      let cost = (offset / sigma) ** 2 + ((dc - predicted) / alongScale) ** 2;
      if (course !== null) cost += HEADING_WEIGHT * (angleDiff(course, this.segBearing[i]) / 90) ** 2;
      if (cost < bestCost) {
        bestCost = cost;
        bestD = dc;
        bestOffset = offset;
      }
    }
    return { d: bestD, offset: bestOffset, cost: bestCost };
  }

  /** Index of the segment containing progress `x`: the largest i ≤ n − 2 with d[i] ≤ x. */
  private segmentAt(x: number): number {
    let lo = 0;
    let hi = this.d.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.d[mid] <= x) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}
