/**
 * Core data contracts for the Ghost Pace engine.
 * Units: metres, seconds (float), sec/km. Timestamps (`GpsFix.t`, events) are epoch milliseconds.
 * Advantages are positive when the runner is ahead.
 */

export interface LatLon { lat: number; lon: number }
export interface GpsFix {
  t: number;              // epoch ms (device timestamp of the fix)
  lat: number; lon: number;
  hAcc: number | null;    // horizontal accuracy, m
  alt: number | null;     // altitude, m
  vAcc: number | null;    // vertical accuracy, m
  speed: number | null;   // m/s; null or < 0 = unavailable
  course: number | null;  // deg clockwise from north; null or < 0 = unavailable
}
export type GpsQuality = 'good' | 'fair' | 'poor' | 'none';
export interface RoutePoint extends LatLon { d: number; ele: number | null }   // d = cumulative metres
export interface RouteGeometry { points: RoutePoint[]; length: number; isLoop: boolean; elevationReliable: boolean }
/** Run time (s) at route progress (m). d[0]=0, t[0]=0, d strictly increasing, t non-decreasing, last d = route length. */
export interface TimeProfile { d: number[]; t: number[] }
export interface Climb { startD: number; endD: number; gain: number; avgGrade: number; maxGrade: number }
export type MatchState = 'acquiring' | 'onRoute' | 'offRoute' | 'lost';
export interface MatchResult { state: MatchState; progress: number; offset: number | null; atFinish: boolean }
export type TargetSpec =
  | { kind: 'finishTime'; seconds: number }
  | { kind: 'improvementSeconds'; seconds: number }
  | { kind: 'improvementPercent'; percent: number };
export type ComparisonMode = 'baseline' | 'ghost' | 'both';
export type PrimaryComparison = 'ghost' | 'baseline';
export type AdvantageStatus = 'ahead' | 'behind' | 'onTarget';
export interface Checkpoint { index: number; d: number; targetElapsed: number; targetSplit: number; referenceElapsed: number }
export interface SplitResult extends Checkpoint {
  actualElapsed: number; actualSplit: number;
  splitDiff: number;       // targetSplit − actualSplit (positive = faster than target split)
  cumulativeDiff: number;  // targetElapsed − actualElapsed (positive = ahead)
}
export interface RequiredPace { status: 'ok' | 'atRisk' | 'missed' | 'unavailable'; secPerKm: number | null; remainingSec: number; remainingM: number }
/** The append-only run log; replaying it through `RunSession` reproduces the run deterministically. */
export type SessionEvent =
  | { type: 'start'; t: number } | { type: 'pause'; t: number } | { type: 'resume'; t: number }
  | { type: 'finish'; t: number } | { type: 'fix'; fix: GpsFix };
export interface ComparisonReading { advantage: number; status: AdvantageStatus }
export interface SessionConfig {
  mode: 'record' | 'route';
  route?: { geometry: RouteGeometry; climbs: Climb[] };
  reference?: TimeProfile;            // required when mode = 'route'
  targetFinishSec?: number | null;    // ghost target; null/undefined = no ghost
  primary?: PrimaryComparison;        // default: 'ghost' if target else 'baseline'
  checkpointInterval?: number;        // default checkpointInterval(route length)
}
export interface LiveSnapshot {
  phase: 'idle' | 'running' | 'paused' | 'finished';
  mode: 'record' | 'route';
  startedAt: number | null;           // epoch ms
  runSec: number; movingSec: number; wallSec: number;
  distance: number;                   // filtered GPS distance actually run, m
  paceSecPerKm: number | null;        // smoothed current pace; null when stopped/unknown
  avgPaceSecPerKm: number | null;
  gps: { quality: GpsQuality; accuracy: number | null; lastFixAgeSec: number | null };
  route: null | {
    match: MatchState; progress: number; length: number; remaining: number; offset: number | null;
    finishedSec: number | null;       // run time at route-end crossing
    reliable: boolean;                // onRoute && gps good/fair && last fix ≤ 5 s old
    baseline: ComparisonReading | null;
    ghost: (ComparisonReading & { targetFinishSec: number }) | null;
    primary: PrimaryComparison;
    nextCheckpoint: { index: number; d: number; distanceTo: number; targetElapsed: number; targetSplit: number } | null;
    lastSplit: SplitResult | null;
    required: RequiredPace | null;    // only when a ghost target exists
    projectedFinishSec: number | null; // estimate
    upcomingClimb: { distanceTo: number; climb: Climb } | null;
  };
}
export interface RunSummary {
  startedAt: number; endedAt: number;
  runSec: number; movingSec: number; wallSec: number;
  distance: number; avgPaceSecPerKm: number | null;
  pauses: { start: number; end: number }[];
  gps: { fixes: number; accepted: number; meanAccuracy: number | null; poorFraction: number; gaps: number; longestGapSec: number };
  elevation: { gain: number; loss: number } | null;
  route: null | {
    completed: boolean; finishSec: number | null;
    profile: TimeProfile;                       // progress vs run time; usable as a future reference only if completed
    splits: SplitResult[];
    baselineFinalAdvantage: number | null; ghostFinalAdvantage: number | null;
    baselineSeries: { d: number; advantage: number }[];   // ≤ 200 points, for charts
    ghostSeries: { d: number; advantage: number }[];
    offRouteSec: number;
  };
}
