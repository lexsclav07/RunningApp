/**
 * RunSession: the engine's single entry point during a run. It consumes the append-only event log
 * (`SessionEvent`s, see `apply`) and a clock (`tick`), and produces live snapshots and a run summary.
 *
 * Rules:
 * - Run time: runSec(t) = (t − start − paused ms before t) / 1000 (see `RunClock`). Comparisons, splits
 *   and finish times all use it; wall time includes pauses.
 * - Fixes are taken in arrival order. A fix with t ≤ the last processed fix is dropped (duplicate or
 *   out-of-order batch delivery); every other fix updates the GPS quality, and `classifyFix` decides
 *   whether it is accepted.
 * - Accepted fixes in active time (running, at or after the latest start/resume) feed distance, pace,
 *   moving time and the route matcher. Fixes while paused update GPS quality only. A resume resets the
 *   distance anchor, the pace estimator and the matcher's motion model.
 * - Route mode: comparisons (baseline, ghost, splits, required pace, projection) are computed only on
 *   fixes the matcher placed on the route, and held otherwise. The ghost is the reference scaled to the
 *   target finish; splits and projections use the ghost when there is a target, else the reference.
 * - The route finishes on the first matched fix with atFinish. Its time is extrapolated to the end:
 *   finishedSec = runSec + clamp((length − progress) / max(v, 1), 0, 10), where v (m/s) is the progress
 *   speed over the trailing 10 s of run time. Every route value then freezes there (a finish tapped
 *   later doesn't change it); distance and run time keep counting until the finish event.
 * - Engine state depends on the events only. `tick` merely moves the clock at which derived values are
 *   read (run time, GPS age, 'lost', pace staleness), so replaying a log reproduces the run exactly.
 */
import { advantageAt, statusOf } from './comparison';
import { DistanceAccumulator } from './distance';
import { assessElevation, gainLoss, smoothElevation, upcomingClimb, usableAltitude } from './elevation';
import { classifyFix } from './filter';
import { DEFAULT_MATCHER_OPTIONS, RouteMatcher } from './matcher';
import { MOVING_SPEED, PaceEstimator } from './pace';
import { makeProfile, scaleProfile } from './profile';
import { PerformanceTracker, projectFinish, requiredPace } from './projection';
import { RunClock } from './run-clock';
import { buildCheckpoints, checkpointInterval, SplitTracker } from './splits';
import type {
  Climb,
  ComparisonReading,
  GpsFix,
  GpsQuality,
  LiveSnapshot,
  MatchResult,
  PrimaryComparison,
  RequiredPace,
  RouteGeometry,
  RunSummary,
  SessionConfig,
  SessionEvent,
  SplitResult,
  TimeProfile,
} from './types';

/** The live comparison counts as reliable only while the last fix is at most this old, s. */
export const RELIABLE_FIX_AGE_SEC = 5;
/** Most points kept in each summary advantage series. */
export const SERIES_MAX_POINTS = 200;
/** Average pace is reported from this distance on, m. */
const AVG_PACE_MIN_M = 50;
/** No fix for longer than this (s) means GPS is lost; summary gaps use the same limit. */
const LOST_AFTER_SEC = DEFAULT_MATCHER_OPTIONS.lostAfterSec;
/** Finish extrapolation: at most this many seconds, at a progress speed of at least FINISH_MIN_SPEED m/s. */
const FINISH_MAX_EXTRAPOLATION_SEC = 10;
const FINISH_MIN_SPEED = 1;
/** Run-time window (s) of the progress speed used for the finish extrapolation. */
const FINISH_SPEED_WINDOW_SEC = 10;
// Mirror of RouteMatcher steps 1 and 5 (σ from hAcc, off-route limit), so the session can tell a matched
// fix from one the matcher set aside while it confirms an off-route streak (its state is unchanged then).
const SIGMA_MIN = 5;
const SIGMA_MAX = 50;
const SIGMA_UNKNOWN = 20;
const OFF_ROUTE_SIGMAS = 2.5;

type SeriesPoint = { d: number; advantage: number };
type ProgressSample = { progress: number; runSec: number };

/** Per-run state of a route-mode session. */
interface RouteRun {
  readonly geometry: RouteGeometry;
  readonly climbs: Climb[];
  readonly length: number;
  readonly reference: TimeProfile;
  readonly ghost: TimeProfile | null;
  readonly targetFinishSec: number | null;
  /** Profile for splits and projections: the ghost when a target exists, else the reference. */
  readonly target: TimeProfile;
  readonly matcher: RouteMatcher;
  readonly splits: SplitTracker;
  readonly perf: PerformanceTracker;
  match: MatchResult;
  /** Whether the matcher has been given a fix (it never reports 'lost' before one). */
  sawFix: boolean;
  /** Run time of the previous fix given to the matcher (off-route time accounting). */
  prevFixRunSec: number | null;
  /** Last matched (progress, run time). */
  lastOn: ProgressSample | null;
  /** Matched samples from the latest one at or before (now − FINISH_SPEED_WINDOW_SEC) onwards. */
  recent: ProgressSample[];
  baseline: ComparisonReading | null;
  ghostReading: ComparisonReading | null;
  required: RequiredPace | null;
  projected: number | null;
  lastSplit: SplitResult | null;
  finishedSec: number | null;
  profileD: number[];
  profileT: number[];
  baselineSeries: SeriesPoint[];
  ghostSeries: SeriesPoint[];
  offRouteSec: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const reading = (advantage: number): ComparisonReading => ({ advantage, status: statusOf(advantage) });

export class RunSession {
  private readonly mode: 'record' | 'route';
  private readonly clock = new RunClock();
  private readonly route: RouteRun | null;
  private primary: PrimaryComparison;
  /** Session clock, epoch ms: the latest event or tick time (the finish time once finished). */
  private nowMs: number | null = null;

  private lastFixMs: number | null = null;
  private lastAccepted: GpsFix | null = null;
  private quality: GpsQuality = 'none';
  private accuracy: number | null = null;
  private readonly gps = { fixes: 0, accepted: 0, accSum: 0, accCount: 0, poor: 0, gaps: 0, longestGapSec: 0 };

  private readonly distance = new DistanceAccumulator();
  private readonly pace = new PaceEstimator();
  private movingSec = 0;
  private lastActiveRunSec: number | null = null;
  /** Accepted active fixes and the filtered distance at each (for the summary's elevation). */
  private readonly activeFixes: GpsFix[] = [];
  private readonly activeDist: number[] = [];

  constructor(config: SessionConfig) {
    this.mode = config.mode;
    this.route = config.mode === 'route' ? createRouteRun(config) : null;
    this.primary = this.route?.ghost && config.primary !== 'baseline' ? 'ghost' : 'baseline';
  }

  /** A session with every event applied in order: the same state the live session reached. */
  static replay(config: SessionConfig, events: readonly SessionEvent[]): RunSession {
    const s = new RunSession(config);
    for (const e of events) s.apply(e);
    return s;
  }

  apply(e: SessionEvent): void {
    if (this.clock.phase === 'finished') return;
    const t = e.type === 'fix' ? e.fix.t : e.t;
    if (!Number.isFinite(t)) return;
    this.advance(t);
    if (e.type === 'fix') {
      this.onFix(e.fix);
      return;
    }
    if (!this.clock.apply(e)) return;
    if (e.type === 'resume') {
      this.distance.reset();
      this.pace.reset();
      this.route?.matcher.resetMotion();
    } else if (e.type === 'finish') {
      this.nowMs = this.clock.endedAt;
    }
  }

  /** Moves the clock to `nowMs` (never backwards, never past the finish) and returns the snapshot. */
  tick(nowMs: number): LiveSnapshot {
    if (this.clock.phase !== 'finished' && Number.isFinite(nowMs)) this.advance(nowMs);
    return this.snapshot();
  }

  /** Switches the comparison the run screen leads with; 'ghost' needs a target. */
  setPrimary(p: PrimaryComparison): void {
    if (!this.route || (p === 'ghost' && !this.route.ghost)) return;
    this.primary = p;
  }

  snapshot(): LiveSnapshot {
    const now = this.nowMs;
    const phase = this.clock.phase;
    const startedAt = this.clock.startedAt;
    const runSec = now === null ? 0 : this.clock.runSecAt(now);
    const fixAgeSec = now === null || this.lastFixMs === null ? null : Math.max(0, now - this.lastFixMs) / 1000;
    const gpsLost = fixAgeSec === null || fixAgeSec > LOST_AFTER_SEC;
    const quality: GpsQuality = gpsLost ? 'none' : this.quality;
    return {
      phase,
      mode: this.mode,
      startedAt,
      runSec,
      movingSec: this.movingSec,
      wallSec: now === null || startedAt === null ? 0 : Math.max(0, now - startedAt) / 1000,
      distance: this.distance.total,
      paceSecPerKm: phase === 'running' ? this.pace.current(runSec) : null,
      avgPaceSecPerKm: avgPace(runSec, this.distance.total),
      gps: { quality, accuracy: gpsLost ? null : this.accuracy, lastFixAgeSec: fixAgeSec },
      route: this.route ? this.routeSnapshot(this.route, now, quality, fixAgeSec) : null,
    };
  }

  /** Summary of the run so far (normally called after the finish event). Throws before the start. */
  summary(): RunSummary {
    const startedAt = this.clock.startedAt;
    if (startedAt === null) throw new Error('RunSession.summary: the run has not started');
    const endedAt = this.clock.endedAt ?? Math.max(startedAt, this.nowMs ?? startedAt);
    const runSec = this.clock.runSecAt(endedAt);
    const g = this.gps;
    const r = this.route;
    return {
      startedAt,
      endedAt,
      runSec,
      movingSec: this.movingSec,
      wallSec: (endedAt - startedAt) / 1000,
      distance: this.distance.total,
      avgPaceSecPerKm: avgPace(runSec, this.distance.total),
      pauses: this.clock.pauses(endedAt),
      gps: {
        fixes: g.fixes,
        accepted: g.accepted,
        meanAccuracy: g.accCount > 0 ? g.accSum / g.accCount : null,
        poorFraction: g.fixes > 0 ? g.poor / g.fixes : 0,
        gaps: g.gaps,
        longestGapSec: g.longestGapSec,
      },
      elevation: this.elevation(),
      route: r && {
        completed: r.finishedSec !== null,
        finishSec: r.finishedSec,
        profile:
          r.finishedSec !== null ? makeProfile(r.profileD, r.profileT, r.length) : partialProfile(r.profileD, r.profileT),
        splits: r.splits.results(),
        baselineFinalAdvantage: r.baseline?.advantage ?? null,
        ghostFinalAdvantage: r.ghostReading?.advantage ?? null,
        baselineSeries: downsample(r.baselineSeries),
        ghostSeries: downsample(r.ghostSeries),
        offRouteSec: r.offRouteSec,
      },
    };
  }

  private advance(t: number): void {
    this.nowMs = this.nowMs === null ? t : Math.max(this.nowMs, t);
  }

  private onFix(fix: GpsFix): void {
    if (this.lastFixMs !== null && fix.t <= this.lastFixMs) return; // duplicate or out of order
    const prevMs = this.lastFixMs;
    this.lastFixMs = fix.t;
    const c = classifyFix(fix, this.lastAccepted);
    this.quality = c.quality;
    this.accuracy = fix.hAcc !== null && fix.hAcc >= 0 ? fix.hAcc : null;

    const started = this.clock.phase !== 'idle';
    if (started) {
      this.gps.fixes++;
      if (c.quality === 'poor') this.gps.poor++;
      const startedAt = this.clock.startedAt as number;
      if (prevMs !== null && prevMs >= startedAt) {
        const gapSec = (fix.t - prevMs) / 1000;
        if (gapSec > LOST_AFTER_SEC) {
          this.gps.gaps++;
          this.gps.longestGapSec = Math.max(this.gps.longestGapSec, gapSec);
        }
      }
    }
    if (!c.accept) return;
    this.lastAccepted = fix;
    if (started) {
      this.gps.accepted++;
      if (this.accuracy !== null) {
        this.gps.accSum += this.accuracy;
        this.gps.accCount++;
      }
    }
    if (this.clock.isActive(fix.t)) this.onActiveFix(fix);
  }

  private onActiveFix(fix: GpsFix): void {
    const runSec = this.clock.runSecAt(fix.t);
    const total = this.distance.add(fix).total;
    this.pace.push(runSec, total);
    if (this.lastActiveRunSec !== null && runSec > this.lastActiveRunSec && this.isMoving(fix, runSec)) {
      this.movingSec += runSec - this.lastActiveRunSec;
    }
    this.lastActiveRunSec = runSec;
    this.activeFixes.push(fix);
    this.activeDist.push(total);
    if (this.route) this.matchFix(this.route, fix, runSec);
  }

  /** Moving when the reported (Doppler) speed is ≥ MOVING_SPEED; without one, while there is a current pace. */
  private isMoving(fix: GpsFix, runSec: number): boolean {
    if (fix.speed !== null && fix.speed >= 0) return fix.speed >= MOVING_SPEED;
    return this.pace.current(runSec) !== null;
  }

  private matchFix(r: RouteRun, fix: GpsFix, runSec: number): void {
    if (r.finishedSec !== null) return; // frozen at the route finish
    if (r.prevFixRunSec !== null && r.match.state === 'offRoute') r.offRouteSec += runSec - r.prevFixRunSec;
    r.prevFixRunSec = runSec;
    // As a 1 Hz tick would have: a fix after > lostAfterSec of silence finds the matcher 'lost', so it
    // re-acquires. Done here rather than in tick() so that matching depends on the events alone.
    r.matcher.noteTime(fix.t);
    const m = r.matcher.update(fix, runSec);
    r.match = m;
    r.sawFix = true;
    if (!isMatched(m, fix)) return;

    const progress = m.progress;
    const prev = r.lastOn ?? { progress, runSec };
    r.lastOn = { progress, runSec };
    r.recent.push({ progress, runSec });
    while (r.recent.length > 2 && r.recent[1].runSec <= runSec - FINISH_SPEED_WINDOW_SEC) r.recent.shift();
    this.recordSplits(r, r.splits.update(prev.progress, prev.runSec, progress, runSec));
    r.perf.push(runSec, progress);
    r.profileD.push(progress);
    r.profileT.push(runSec);
    if (m.atFinish) this.finishRoute(r, progress, runSec);
    else this.compare(r, progress, runSec);
  }

  /** Readings at (progress, runSec): advantage = t_profile(progress) − runSec, positive = ahead. */
  private compare(r: RouteRun, progress: number, runSec: number): void {
    const base = advantageAt(r.reference, progress, runSec);
    r.baseline = reading(base);
    r.baselineSeries.push({ d: progress, advantage: base });
    const ratio = r.perf.ratio();
    r.projected = projectFinish(r.target, progress, runSec, ratio);
    if (r.ghost && r.targetFinishSec !== null) {
      const ghost = advantageAt(r.ghost, progress, runSec);
      r.ghostReading = reading(ghost);
      r.ghostSeries.push({ d: progress, advantage: ghost });
      r.required = requiredPace({
        length: r.length,
        progress,
        runSec,
        targetFinishSec: r.targetFinishSec,
        reference: r.ghost,
        ratio,
      });
    }
  }

  private finishRoute(r: RouteRun, progress: number, runSec: number): void {
    const first = r.recent[0];
    const dt = runSec - first.runSec;
    const v = dt > 0 ? (progress - first.progress) / dt : 0; // progress speed, m/s
    // time to cover the remaining metres at that speed, s
    const finishedSec = runSec + clamp((r.length - progress) / Math.max(v, FINISH_MIN_SPEED), 0, FINISH_MAX_EXTRAPOLATION_SEC);
    this.recordSplits(r, r.splits.update(progress, runSec, r.length, finishedSec));
    r.profileD.push(r.length);
    r.profileT.push(finishedSec);
    r.finishedSec = finishedSec;
    this.compare(r, r.length, finishedSec);
    r.projected = finishedSec;
  }

  private recordSplits(r: RouteRun, crossed: SplitResult[]): void {
    if (crossed.length > 0) r.lastSplit = crossed[crossed.length - 1];
  }

  private routeSnapshot(
    r: RouteRun,
    now: number | null,
    quality: GpsQuality,
    fixAgeSec: number | null,
  ): NonNullable<LiveSnapshot['route']> {
    const done = r.finishedSec !== null;
    const acceptedAgeSec = now === null || this.lastAccepted === null ? null : (now - this.lastAccepted.t) / 1000;
    const lost = !done && r.sawFix && acceptedAgeSec !== null && acceptedAgeSec > LOST_AFTER_SEC;
    const match = lost ? 'lost' : r.match.state;
    const progress = done ? r.length : r.match.progress;
    const next = done ? null : r.splits.next(progress);
    const climb = done ? null : upcomingClimb(r.climbs, progress);
    return {
      match,
      progress,
      length: r.length,
      remaining: Math.max(0, r.length - progress),
      offset: lost ? null : r.match.offset,
      finishedSec: r.finishedSec,
      reliable:
        match === 'onRoute' &&
        (quality === 'good' || quality === 'fair') &&
        fixAgeSec !== null &&
        fixAgeSec <= RELIABLE_FIX_AGE_SEC,
      baseline: r.baseline && { ...r.baseline },
      ghost: r.ghostReading && r.targetFinishSec !== null ? { ...r.ghostReading, targetFinishSec: r.targetFinishSec } : null,
      primary: this.primary,
      nextCheckpoint: next && {
        index: next.index,
        d: next.d,
        distanceTo: next.d - progress,
        targetElapsed: next.targetElapsed,
        targetSplit: next.targetSplit,
      },
      lastSplit: r.lastSplit && { ...r.lastSplit },
      required: r.required && { ...r.required },
      projectedFinishSec: r.projected,
      upcomingClimb: climb && { distanceTo: climb.distanceTo, climb: { ...climb.climb } },
    };
  }

  /** Gain and loss (m) of the smoothed altitude of the active fixes, when it is reliable. */
  private elevation(): { gain: number; loss: number } | null {
    if (!assessElevation(this.activeFixes)) return null;
    const smooth = smoothElevation(this.activeDist, this.activeFixes.map(usableAltitude));
    const ele = smooth.filter((v): v is number => v !== null);
    return ele.length > 0 ? gainLoss(ele) : null;
  }
}

/** The comparison the run screen leads with (`route.primary`) and its reading; null in record mode. */
export function primaryReading(s: LiveSnapshot): { kind: PrimaryComparison; reading: ComparisonReading | null } | null {
  if (!s.route) return null;
  const kind = s.route.primary;
  return { kind, reading: kind === 'ghost' ? s.route.ghost : s.route.baseline };
}

function createRouteRun(config: SessionConfig): RouteRun {
  const { route, reference } = config;
  if (!route || !reference) throw new Error('RunSession: route mode needs a route and a reference profile');
  const length = route.geometry.length;
  if (!(length > 0)) throw new RangeError('RunSession: the route has no length');
  const targetFinishSec = config.targetFinishSec ?? null;
  const ghost = targetFinishSec !== null ? scaleProfile(reference, targetFinishSec) : null;
  const target = ghost ?? reference;
  const interval = config.checkpointInterval ?? checkpointInterval(length);
  const matcher = new RouteMatcher(route.geometry);
  return {
    geometry: route.geometry,
    climbs: route.climbs,
    length,
    reference,
    ghost,
    targetFinishSec,
    target,
    matcher,
    splits: new SplitTracker(buildCheckpoints(length, target, reference, interval)),
    perf: new PerformanceTracker(target),
    match: matcher.current(),
    sawFix: false,
    prevFixRunSec: null,
    lastOn: null,
    recent: [],
    baseline: null,
    ghostReading: null,
    required: null,
    projected: null,
    lastSplit: null,
    finishedSec: null,
    profileD: [],
    profileT: [],
    baselineSeries: [],
    ghostSeries: [],
    offRouteSec: 0,
  };
}

/** Whether the matcher actually placed this fix on the route (not merely kept its state). */
function isMatched(m: MatchResult, fix: GpsFix): boolean {
  if (m.state !== 'onRoute' || m.offset === null) return false;
  const sigma = clamp(fix.hAcc ?? SIGMA_UNKNOWN, SIGMA_MIN, SIGMA_MAX);
  return m.offset <= Math.max(DEFAULT_MATCHER_OPTIONS.offRouteDistance, OFF_ROUTE_SIGMAS * sigma);
}

/** Run time ÷ distance as sec/km (1000 × s/m), once there is enough distance. */
function avgPace(runSec: number, distance: number): number | null {
  return distance >= AVG_PACE_MIN_M ? (runSec / distance) * 1000 : null;
}

/** Profile of an unfinished run: (0, 0), then strictly increasing progress with non-decreasing time. */
function partialProfile(d: readonly number[], t: readonly number[]): TimeProfile {
  const out: TimeProfile = { d: [0], t: [0] };
  for (let i = 0; i < d.length; i++) {
    const n = out.d.length - 1;
    if (!(d[i] > out.d[n])) continue;
    out.d.push(d[i]);
    out.t.push(Math.max(out.t[n], t[i]));
  }
  return out;
}

/** At most SERIES_MAX_POINTS points, evenly spaced by index and keeping the first and last. */
function downsample(xs: readonly SeriesPoint[]): SeriesPoint[] {
  if (xs.length <= SERIES_MAX_POINTS) return xs.map((x) => ({ ...x }));
  const out: SeriesPoint[] = [];
  for (let i = 0; i < SERIES_MAX_POINTS; i++) {
    out.push({ ...xs[Math.round((i * (xs.length - 1)) / (SERIES_MAX_POINTS - 1))] });
  }
  return out;
}
