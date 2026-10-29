# Route Ghost Pacing (Ghost Pace) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An offline iPhone app that records a running route, then paces future runs on it against the reference run and a proportionally-scaled ghost target, with background GPS, local history and a Lock Screen Live Activity.

**Architecture:** A pure-TypeScript engine (`src/core`, no React Native or Expo imports) does filtering, route matching, profiles, ghost targets, splits, projections and cues, and is driven by an event log (`SessionEvent[]`) so any run can be replayed deterministically. `src/data` persists that event log and derived summaries in SQLite. `src/state/run-controller.ts` connects background GPS (`src/services/location.ts`), the engine, persistence, feedback and the Live Activity, and exposes snapshots to the UI through `useSyncExternalStore`. The UI (`src/app`, `src/ui`, `src/features`) only renders snapshots and records.

**Tech Stack:** Expo SDK 58, React Native 0.88, React 19.3, TypeScript 6 strict, Expo Router (native tabs), expo-location + expo-task-manager, expo-sqlite, expo-haptics, expo-speech, expo-keep-awake, expo-file-system + expo-sharing, react-native-svg, expo-widgets + @expo/ui, Jest 30 via jest-expo, @testing-library/react-native.

**Spec:** `docs/superpowers/specs/2026-10-29-route-ghost-pacing-design.md` (includes "Decisions made during planning").

## Global Constraints

- `src/core/**` must not import `react`, `react-native`, `expo*`, or anything under `src/{data,services,state,ui,features,app}`. It is enforced by an ESLint `no-restricted-imports` rule for `src/core/**`.
- TypeScript `strict`. No `any` in `src/core` or `src/data` public signatures.
- Units: metres, seconds, sec/km internally; display metric only (km, m, min/km, m elevation). Timestamps: epoch **ms** on `GpsFix.t` and events; every duration inside the engine is **seconds** (float).
- "Run time" (`runSec`) = wall time minus manual pauses; all comparisons, splits and finish times use it.
- Baseline advantage = `timeAt(reference, progress) − runSec`; ghost advantage = `timeAt(ghost, progress) − runSec`; ghost = reference × (targetFinish / referenceFinish). Positive = ahead.
- Signed deltas display as `+00:25` / `−00:18` (U+2212 minus) / `00:00`.
- Install packages only with `npx expo install` (dev deps: `npx expo install -- --save-dev`). No new runtime dependency without a line in the task saying why.
- No backend, accounts, social, achievements, smartwatch.
- Never edit `ios/` or `android/` by hand (Continuous Native Generation); configure via `app.json` / config plugins.
- Workers do not run `git commit`; the orchestrator commits between stages.
- Verification commands: `npx jest <path>`, `npx tsc --noEmit`, `npx expo lint`, `npx expo export --platform ios --output-dir /tmp/<scratch>` (JS bundle compiles for iOS).

## Review Focus

1. **Batched / out-of-order / duplicate fixes.** iOS delivers background locations in batches, and they can be stale or duplicated. The engine must process fixes in timestamp order and drop any fix with `t ≤` the last accepted `t`. Owned by Task 2 (`classifyFix` stale test) and Task 6 (`session ignores duplicate batch`).
2. **App killed mid-run and relaunched in the background.** The controller must rehydrate from SQLite by replaying events and continue with no lost or double-counted fixes. Owned by Task 8 (`recovers active run and continues`).
3. **Starting away from the route start, or mid-route.** Before acquisition there is no advantage, just a "Head to start" match state. Acquisition happens only within the first 150 m of the route. Owned by Task 5 (`stays acquiring when far from start`).
4. **Finish tapped late, or running past the end.** The finish time is the run time at route-end crossing, not at the tap. Owned by Task 6 (`finish time is crossing time, not tap time`).
5. **Out-and-back routes.** The return leg overlaps the outbound leg, and heading plus expected progress must keep the match on the correct leg. Owned by Task 5 (`out-and-back return leg`).

---

## Stage 2 — Core engine (`src/core`)

### Task 1: Foundation — types, geo, format, simulation, purity lint

**Files:**
- Create: `src/core/types.ts`, `src/core/geo.ts`, `src/core/format.ts`, `src/core/sim/prng.ts`, `src/core/sim/routes.ts`, `src/core/sim/trace.ts`, `src/core/sim/events.ts`, `src/core/index.ts`, `eslint.config.js`
- Delete: `src/core/__tests__/smoke.test.ts`
- Test: `src/core/__tests__/geo.test.ts`, `format.test.ts`, `sim.test.ts` (all with `/** @jest-environment node */`)

**Interfaces — Produces (`src/core/types.ts`, verbatim contract):**

```ts
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
```

**`src/core/geo.ts`:** `haversine(a: LatLon, b: LatLon): number` (R = 6371008.8 m); `bearing(a, b): number` [0,360); `angleDiff(a, b): number` [0,180]; `makeProjection(origin: LatLon): { toXY(p: LatLon): { x: number; y: number }; toLatLon(x: number, y: number): LatLon }` (equirectangular, metres); `projectOntoSegment(p, a, b): { f: number; dist: number; x: number; y: number }` (f ∈ [0,1]); `cumulativeDistances(points: LatLon[]): number[]`.

**`src/core/format.ts`:** `formatClock(sec)` → `"12:30"`, `"1:02:03"` (floor); `formatDelta(sec)` → `"+00:25"`, `"−00:18"`, `"00:00"` (round to nearest s, U+2212); `formatPace(secPerKm | null)` → `"5:07"` / `"–:––"`; `formatDistance(m)` → `"850 m"` (< 1000) / `"4.82 km"`; `deltaPhrase(sec, band = 2)` → `"ON TARGET"` | `"12 SEC AHEAD"` | `"1:05 BEHIND"` (≥ 60 s uses m:ss); `spokenDelta(sec)` → `"12 seconds ahead"`.

**`src/core/sim`:** `mulberry32(seed): () => number`; `gaussian(rand): number`; `makeRoute(kind: 'straight' | 'loop' | 'outAndBack' | 'figureEight' | 'hairpin', opts?: { length?: number; origin?: LatLon; elevation?: (d: number) => number }): { lat: number; lon: number; ele: number | null }[]` (points every ≈2 m); `twoHills(length: number): (d: number) => number` (two climbs of ≈10 % grade over 200 m at 25 % and 65 % of length); `simulateRun(route, opts: { speed: (d: number, grade: number) => number; startMs: number; hz?: number; noiseM?: number; seed?: number; hAcc?: number; gaps?: { fromSec: number; toSec: number }[]; stops?: { atSec: number; durationSec: number }[]; altitude?: 'ok' | 'missing' | 'garbage' }): { fixes: GpsFix[]; truthAtSec(sec: number): number }` (truth = along-route distance; course and speed fields filled from truth; gaps emit no fixes); `toEvents(fixes, opts?: { pauses?: { fromMs: number; toMs: number }[]; finishMs?: number }): SessionEvent[]` (start at first fix t, pause/resume markers merged by time, finish at `finishMs ?? last fix t`).

- [ ] Write tests: haversine 1° lat ≈ 111195 m (±1); bearing north = 0, east = 90; projectOntoSegment clamps f to [0,1]; formatDelta(30) = "+00:30", formatDelta(-30) = "−00:30", formatDelta(0.4) = "00:00", formatDelta(-75) = "−01:15"; formatClock(3723) = "1:02:03"; formatPace(307) = "5:07"; deltaPhrase(1.5) = "ON TARGET", deltaPhrase(12) = "12 SEC AHEAD", deltaPhrase(-65) = "1:05 BEHIND"; simulateRun with constant 3 m/s on 1000 m straight gives last fix ≈ 333 s after first and truthAtSec(100) ≈ 300; same seed → identical fixes.
- [ ] Run `npx jest src/core/__tests__/geo.test.ts src/core/__tests__/format.test.ts src/core/__tests__/sim.test.ts` → FAIL, implement, → PASS.
- [ ] Create `eslint.config.js` extending `eslint-config-expo/flat` with `no-restricted-imports` for `src/core/**` (patterns `react`, `react-native*`, `expo*`, `@/data*`, `@/services*`, `@/state*`, `@/ui*`, `@/features*`, `@/app*`); `npx expo lint` passes.

### Task 2: GPS filtering, distance, pace (`filter.ts`, `distance.ts`, `pace.ts`)

**Interfaces — Consumes:** Task 1 types/geo/sim. **Produces:**
- `classifyFix(fix: GpsFix, prev: GpsFix | null): { accept: boolean; quality: GpsQuality; reason?: 'accuracy' | 'speed' | 'stale' }`. Quality: hAcc ≤ 10 good, ≤ 25 fair, else poor; null hAcc → fair. Reject: hAcc > 50 (`accuracy`); `t ≤ prev.t` (`stale`); implied speed from prev > 12 m/s (`speed`).
- `class DistanceAccumulator { add(fix: GpsFix): { delta: number; total: number }; reset(): void /* drops anchor, keeps total */; get total(): number }`. Anchor-based: distance is added only when displacement from the anchor ≥ max(3, 0.5 × max(hAcc_anchor, hAcc_fix)) (null hAcc → 10); then the anchor moves.
- `class PaceEstimator { push(runSec: number, distance: number): void; reset(): void; current(runSec: number): number | null }`. Trailing 20 s window, extended back until ≥ 30 m; null if window distance < 15 m, speed < 0.8 m/s, or last push > 10 s ago; EMA α = 0.3 on sec/km.
- `MOVING_SPEED = 0.8` (m/s) exported.

- [ ] Tests: stale/duplicate fix rejected; 80 m-accuracy fix rejected; teleport 500 m in 1 s rejected; **stationary 10 min with 8 m noise accumulates < 20 m**; 1 km straight with 3 m noise totals 1000 ± 25 m; pace at constant 3 m/s ≈ 333 s/km ± 15; pace null during a 30 s gap and recovers within 25 s after it with no value < 250 or > 450 s/km.

### Task 3: Route geometry and elevation (`track.ts`, `elevation.ts`)

**Produces:**
- `resample(points: { lat: number; lon: number; ele: number | null }[], spacing: number): RoutePoint[]`.
- `buildRouteGeometry(fixes: GpsFix[], opts?: { spacing?: number }): RouteGeometry`: accepted fixes only (Task 2 `classifyFix`), stationary clusters collapsed (anchor rule), resampled every 5 m. Elevation comes from `smoothElevation` when `assessElevation` is reliable, else `ele = null` everywhere. `isLoop` = start–end ≤ 50 m and length ≥ 400 m.
- `assessElevation(fixes: GpsFix[]): boolean`: ≥ 60 % of fixes have alt with vAcc null or ≤ 20, and the smoothed series has no step > 15 m per 5 m.
- `smoothElevation(d: number[], ele: (number | null)[], windowM = 40): (number | null)[]`: median-of-5 then distance-window mean; gaps ≤ 100 m interpolated.
- `gainLoss(ele: number[], hysteresis = 3): { gain: number; loss: number }`.
- `grades(d: number[], ele: number[], windowM = 50): number[]`.
- `detectClimbs(points: RoutePoint[], opts?: { minGrade?: number; minLength?: number; minGain?: number }): Climb[]` (defaults 0.04, 80, 6; `[]` if any ele null).
- `upcomingClimb(climbs: Climb[], progress: number, lookahead = 250): { distanceTo: number; climb: Climb } | null` (only climbs starting ahead).

- [ ] Tests: resampled straight 1000 m route has 201 points and length 1000 ± 1; a 10-minute stationary start doesn't add spurs (length within 2 % of truth); twoHills route yields exactly 2 climbs with gain 20 ± 4 m each; `altitude: 'garbage'` → `elevationReliable = false`, all ele null, `detectClimbs` → []; `upcomingClimb` returns the next climb at 200 m out and null once past its start.

### Task 4: Profiles, ghost, comparison, splits, projection, bar (`profile.ts`, `comparison.ts`, `splits.ts`, `projection.ts`, `bar.ts`)

**Produces:**
- `makeProfile(d: number[], t: number[], length: number): TimeProfile`: prepend (0,0), sort by d, drop non-increasing d, cummax t, end exactly at `length` (extrapolate last pace if the last d ≥ length − 30, else throw `IncompleteProfileError`).
- `timeAt(p: TimeProfile, d: number): number` (linear interpolation, clamped); `distanceAt(p, t): number`; `finishTime(p): number`; `scaleProfile(p, targetFinishSec): TimeProfile`.
- `resolveTargetFinish(referenceFinishSec: number, spec: TargetSpec): number` (`improvementPercent` 2 → ×0.98).
- `advantageAt(p: TimeProfile, progress: number, runSec: number): number`; `statusOf(advantage: number, band = 2): AdvantageStatus`.
- `checkpointInterval(length: number): number` (≤1500→100, ≤5000→250, ≤12000→500, else 1000); `buildCheckpoints(length, target: TimeProfile, reference: TimeProfile, interval?): Checkpoint[]`. Multiples of the interval, plus a final checkpoint at `length`; a trailing gap < 0.4 × interval merges into the finish.
- `class SplitTracker { constructor(cps: Checkpoint[]); update(prevProgress: number, prevRunSec: number, progress: number, runSec: number): SplitResult[]; next(progress: number): Checkpoint | null; results(): SplitResult[] }`: linear-interpolated crossing times, several per update allowed.
- `class PerformanceTracker { constructor(reference: TimeProfile); push(runSec: number, progress: number): void; ratio(): number | null }`: actual ÷ reference time over the trailing 400 m of progress; null until ≥ 150 m and ≥ 45 s; EMA α = 0.3; clamp [0.5, 2].
- `projectFinish(reference: TimeProfile, progress: number, runSec: number, ratio: number | null): number | null` = runSec + (finish(ref) − timeAt(ref, progress)) × ratio.
- `requiredPace(args: { length: number; progress: number; runSec: number; targetFinishSec: number; reference: TimeProfile; ratio: number | null }): RequiredPace`. remainingM < 50 → `unavailable`; remainingSec ≤ 0 → `missed`; pace = remainingSec / remainingM × 1000. `atRisk` if pace < 150 s/km OR (ratio ≠ null AND requiredRatio < 0.92 × ratio), where requiredRatio = remainingSec / (finish(ref) − timeAt(ref, progress)). secPerKm = null unless `ok`.
- `BAR_STEPS = [10, 20, 30, 60, 120, 300, 600]`; `barScale(absAdvantage: number, prevScale: number | null): number`: grows to the smallest step ≥ 1.25 × |adv|; shrinks one step only when |adv| < 0.4 × the next-lower step. `barGeometry(advantage: number | null, scale: number): { side: 'ahead' | 'behind' | 'none'; fraction: number }`: ahead extends right, fraction ∈ [0,1], |adv| < 0.5 → none.

- [ ] Tests (spec acceptance in **bold**): **#1** ref 12:30 at d, run 12:00 → +30; **#2** run 13:00 → −30; **#3** run 12:30 → 0; **#4** ghost of a 30:00 reference with target 29:30 → `timeAt(ghost,0)=0`, `finishTime=1770`; **#5** each ghost checkpoint targetElapsed = ref × 1770/1800 and targetSplit shrinks by the same factor; **#6** with a reference slower on two hills, the ghost's hill split share equals the reference's (ratio of hill split to total equal within 1e-9); **#12** 2000 m remaining, 600 s left → 300 s/km `ok`; 0 s left → `missed`; required 140 s/km → `atRisk` with null pace; **#14 (logic)** barGeometry(+12, 20) → right, 0.6; (−12, 20) → left, 0.6; (0, 20) → none, 0; scale stays ≥ previous for ±1 s jitter; `makeProfile` throws on a run ending 300 m short.

### Task 5: Route matcher (`matcher.ts`)

**Produces:** `class RouteMatcher { constructor(route: RouteGeometry, opts?: Partial<MatcherOptions>); update(fix: GpsFix, runSec: number): MatchResult; noteTime(nowMs: number): MatchResult; current(): MatchResult; resetMotion(): void }` and `MatcherOptions` with defaults `{ maxSpeed: 7, offRouteDistance: 35, offRouteConfirmSec: 6, backTolerance: 15, startWindow: 150, lostAfterSec: 10, finishTolerance: 20 }`.

Algorithm (not determined by the signature; implement as written and document in the file header):
1. σ = clamp(hAcc ?? 20, 5, 50). Project the fix to local XY (origin = first route point). Precompute XY for route points once.
2. Window along progress `[lo, hi]`: when `acquiring`, `[0, startWindow]`; otherwise `lo = s − backTolerance`, `hi = s + maxSpeed × dtWall + 2σ + 20`, with dtWall = seconds since the last on-route fix (gaps and pauses widen it).
3. For each segment overlapping the window, project the fix onto it: candidate `(d_c, offset_c, bearing_c)`.
4. Cost = (offset/σ)² + ((d_c − predicted)/(σ + 15 + 0.5·v·dtRun))² + heading, where predicted = s + v·dtRun (dtRun = run-time seconds since the last match, so 0 across a pause), and heading = 2·(angleDiff(course, bearing_c)/90)² when fix speed ≥ 1.5 and course is known, else 0. Take the minimum.
5. If the best offset > max(offRouteDistance, 2.5σ): start the off-route timer. After offRouteConfirmSec the state becomes `offRoute` (`acquiring` stays `acquiring`), and s doesn't change.
6. Otherwise `onRoute` with an alpha-beta update: r = d_best − predicted; α = 0.5 (σ ≤ 10), 0.3 (σ ≤ 25), else 0.15; β = α²/(2−α); v += β·r/dtRun (dtRun > 0), clamped to [0, maxSpeed]; s = max(s_prev, predicted + α·r), clamped to [0, length]. On first acquisition, and on re-acquisition when |r| > 50, set s = max(s_prev, d_best) and v = fix speed ?? 0.
7. `noteTime(now)`: no fix for > lostAfterSec → `lost`. `atFinish` = s ≥ length − finishTolerance.

- [ ] Tests (simulated, seeded, 1 Hz): **#7** 5 m-noise run on a 2 km route: max |progress − truth| ≤ 15 m after acquisition, progress never decreases, and no step exceeds 3 × true step + 10 m; **#8** loop route crossing its start twice (2 laps of a 1 km loop as a 2 km route): progress at the second pass of the start point is 1000 ± 20, not 0; figureEight crossing point maps to the correct branch; **Review #5** out-and-back return leg: progress > length/2 throughout the return; **#11** a 150 m detour 60 m off the route → `offRoute` within offRouteConfirmSec + 2 s, progress frozen, `onRoute` again within 5 s of rejoining; **#10 (matcher part)** a 30 s gap → `lost`, then re-acquires the correct progress (±20 m) within 3 fixes; **Review #3** starting 300 m from the start stays `acquiring`; sharp hairpin turns don't jump across to the other side.

### Task 6: Run session, reference building, cues, stats, GPX, Live Activity payload

**Files:** `src/core/session.ts`, `route-builder.ts`, `cues.ts`, `stats.ts`, `gpx.ts`, `live-activity-payload.ts`; tests `session.test.ts`, `acceptance.test.ts` (one `describe` per spec criterion #1–#12, #15, #16, run end-to-end through `RunSession` on simulated traces), `cues.test.ts`, `stats.test.ts`, `gpx.test.ts`.

**Consumes:** Tasks 2–5. **Produces:**
- `class RunSession { constructor(config: SessionConfig); apply(e: SessionEvent): void; tick(nowMs: number): LiveSnapshot; snapshot(): LiveSnapshot; summary(): RunSummary /* after finish */; setPrimary(p: PrimaryComparison): void; static replay(config: SessionConfig, events: SessionEvent[]): RunSession }`.
  Rules: `runSec(t)` = (t − start − paused ms before t)/1000. Fixes while paused update GPS quality only. On resume, `DistanceAccumulator.reset()`, `PaceEstimator.reset()` and `matcher.resetMotion()`. Fixes with `t ≤` the last accepted are dropped. Comparisons are computed only on fixes where the match is `onRoute`, and the last value is held otherwise. Route finish happens when the match first has `atFinish`: finishedSec = runSec + clamp((length − progress)/max(v,1), 0, 10), and comparisons freeze there. `summary().route.completed = finishedSec !== null`. The reference used for splits and projections is the ghost when a target exists, else the baseline.
- `buildRouteFromRecording(events: SessionEvent[]): { geometry: RouteGeometry; climbs: Climb[]; profile: TimeProfile; summary: RunSummary }`: geometry from fixes during active time, then a replay of the same events in route mode against that geometry, with a trivial reference, to get the profile.
- `computeRunProfile(geometry: RouteGeometry, climbs: Climb[], reference: TimeProfile, events: SessionEvent[]): RunSummary`: replay helper.
- `class CueEngine { constructor(opts?: { thresholdSec?: number; cooldownSec?: number; checkpoints?: boolean; hills?: boolean }); evaluate(s: LiveSnapshot): Cue[] }` with `Cue = { kind: 'checkpoint' | 'statusChange' | 'hillAhead' | 'offRoute' | 'backOnRoute' | 'gpsLost' | 'targetAtRisk' | 'routeComplete'; text: string; haptic: 'success' | 'warning' | 'light' | 'none' }`. Defaults: thresholdSec 5, cooldownSec 30. A checkpoint cue fires per new `lastSplit` (≥ 20 s apart), with text like "250 metres. 12 seconds ahead." A status change fires on a sign change with |adv| ≥ threshold, then waits out the cooldown. Hill ahead fires once per climb at ≤ 150 m. offRoute/backOnRoute and gpsLost fire once per transition. targetAtRisk fires at most once per 120 s. routeComplete fires once.
- `routeStats(runs: { id: string; startedAt: number; finishSec: number | null; distance: number }[], baselineRunId: string): RouteStats` with `RouteStats = { count; totalDistance; best: { runId; finishSec } | null; latest: { runId; finishSec } | null; averageSec: number | null; baselineSec: number | null; changeFromBaselineSec: number | null /* latest − baseline */; trend: 'improving' | 'declining' | 'steady' | null; series: { runId; startedAt; finishSec }[] }`. Trend = least-squares slope over the last ≤ 6 finishes: < −1 s/run improving, > +1 declining, null if < 3.
- `compareProfiles(a: TimeProfile, b: TimeProfile, at: number[]): { d: number; a: number; b: number; diff: number }[]` (diff = b − a).
- `toGpx(args: { name: string; points: { lat: number; lon: number; ele?: number | null; t?: number }[] }): string`: GPX 1.1 with `creator="Ghost Pace"`, an XML-escaped name, `<ele>` and `<time>` only when present.
- `toLiveActivityPayload(s: LiveSnapshot, routeName: string): LiveActivityPayload` with `LiveActivityPayload = { routeName: string; startedAtMs: number; pausedAtMs: number | null; runSec: number; paceText: string; deltaText: string; deltaSec: number | null; status: AdvantageStatus | 'none'; comparisonLabel: 'GHOST' | 'BASELINE' | ''; barFraction: number /* −1..1 */; distanceText: string }`. `startedAtMs` is shifted by paused time so `now − startedAtMs = runSec` while running.

- [ ] Acceptance tests (end-to-end, simulated): #1–#3 at a mid-route checkpoint with runs offset by +30/−30/0 s; **#9** pausing for 120 s mid-run, then resuming at the same spot, leaves the advantage within ±1 s of the unpaused twin run; **#10** a 30 s GPS gap gives no pace value during the gap, distance error ≤ 3 %, and no pace sample outside [0.8×, 1.25×] true pace after recovery; **#15** a run with a target has baseline ≠ ghost advantage, and each matches its own formula ±1 s; **#16** `altitude: 'missing'` and `'garbage'` traces still produce correct ±30 s advantages; **Review #1** feeding the same batch twice gives the identical snapshot; **Review #4** Finish tapped 40 s after crossing the end → `finishSec` within ±3 s of the crossing; replay determinism, where `RunSession.replay(cfg, events).snapshot()` deep-equals the live session's snapshot.

---

## Stage 4 — Persistence, GPS, run controller

### Task 7: SQLite persistence (`src/data`)

**Files:** `src/data/sql.ts` (interface), `schema.ts` (migrations), `routes.ts`, `runs.ts`, `settings.ts`, `expo-db.ts`, `ids.ts`, `testing/node-sqlite.ts`; tests `src/data/__tests__/*.test.ts` (`@jest-environment node`).

**Produces:**
- `interface SqlDb { execAsync(sql: string): Promise<void>; runAsync(sql: string, params?: SqlParam[]): Promise<{ lastInsertRowId: number; changes: number }>; getAllAsync<T>(sql: string, params?: SqlParam[]): Promise<T[]>; getFirstAsync<T>(sql: string, params?: SqlParam[]): Promise<T | null>; withTransactionAsync(fn: () => Promise<void>): Promise<void>; closeAsync(): Promise<void> }`, where `SqlParam = string | number | null`. `openAppDb(): Promise<SqlDb>` wraps expo-sqlite `openDatabaseAsync('ghostpace.db')`, sets `PRAGMA journal_mode = WAL`, and runs `migrate`. `openNodeDb(path: string): Promise<SqlDb>` does the same over `node:sqlite` for tests.
- `migrate(db)`: `PRAGMA user_version`-based, ordered migrations. Tables: `routes(id TEXT PK, name, created_at, geometry_json, climbs_json, length_m, elevation_gain, baseline_run_id, reference_run_id, target_json, comparison_mode, is_sample INTEGER)`, `runs(id TEXT PK, route_id, mode, status 'active'|'completed'|'discarded', source 'gps'|'simulated', started_at, ended_at, config_json, summary_json, finish_sec, distance_m, is_sample)`, `run_fixes(run_id, seq, t, lat, lon, h_acc, alt, v_acc, speed, course, PK(run_id, seq))`, `run_markers(run_id, seq, type, t, PK(run_id, seq))`, `settings(key PK, value_json)`.
- `newId(): string`.
- Records: `RouteRecord = { id; name; createdAt; geometry: RouteGeometry; climbs: Climb[]; elevationGain: number | null; baselineRunId: string; referenceRunId: string; target: TargetSpec | null; comparisonMode: ComparisonMode; isSample: boolean }`; `RouteListItem = { id; name; length; elevationGain: number | null; bestSec: number | null; lastRunAt: number | null; runCount: number; isSample: boolean }`; `PersistedRunConfig = { mode: 'record' | 'route'; routeId: string | null; referenceRunId: string | null; targetFinishSec: number | null; primary: PrimaryComparison; checkpointInterval: number | null; source: 'gps' | 'simulated' }`; `RunRecord = { id; routeId: string | null; mode; status; source; startedAt; endedAt: number | null; config: PersistedRunConfig; summary: RunSummary | null; finishSec: number | null; distance: number | null; isSample: boolean }`.
- Repos (all `(db: SqlDb, …)`):
  - `createActiveRun(db, { id, startedAt, config, isSample? })`; `appendEvents(db, runId, events: SessionEvent[])` (one transaction; fixes go to `run_fixes`, others to `run_markers`, with a continuing seq); `getActiveRun(db): Promise<{ run: RunRecord; events: SessionEvent[] } | null>`; `getRunEvents(db, runId): Promise<SessionEvent[]>` (merged in time order, markers before fixes on equal t); `completeRun(db, runId, summary, routeId?)`; `discardRun(db, runId)`; `getRun`; `listRuns(db, { routeId? , status? })`; `deleteRun`.
  - `createRouteFromRun(db, { name, runId, geometry, climbs, profileSummary: RunSummary }): Promise<RouteRecord>` (baseline = reference = runId; stores the recomputed summary on the run and links the run to the route); `listRoutes`; `getRoute`; `renameRoute`; `duplicateRoute(db, id, name)`; `deleteRoute` (cascades to its runs); `setReferenceRun(db, routeId, runId)` (throws unless the run is completed on that route with `summary.route.completed`); `replaceBaseline(db, routeId, runId)` (same check, explicit); `setTarget(db, routeId, target: TargetSpec | null, mode: ComparisonMode)`. Nothing ever changes `baseline_run_id` except `replaceBaseline`.
  - `Settings = { haptics: boolean; audioCues: boolean; cueThresholdSec: number; cueCooldownSec: number; appearance: 'system' | 'dark' | 'light'; runScreenAlwaysDark: boolean; keepAwake: boolean; liveActivity: boolean; defaultPrimary: PrimaryComparison; checkpointInterval: 'auto' | 100 | 250 | 500 | 1000 }`, defaults `{ true, true, 5, 30, 'system', true, true, true, 'ghost', 'auto' }`; `getSettings(db): Promise<Settings>`; `saveSettings(db, patch: Partial<Settings>): Promise<Settings>`.
  - `exportBackup(db): Promise<BackupV1>` (all routes, runs and fixes as plain JSON, `{ version: 1, exportedAt, routes, runs }`).

- [ ] Tests: **#13** create run → append 600 events → complete → `closeAsync` → reopen the same file → `getRun` returns an identical summary and `getRunEvents` returns the 600 events in order; an active run survives a reopen (`getActiveRun`); `completeRun` never changes the route's baseline; `setReferenceRun` rejects an incomplete run; deleting a route deletes its runs and fixes; migration is idempotent (running `migrate` twice is a no-op).

### Task 8: Location service and run controller

**Files:** `src/services/location.ts`, `src/services/location-task.ts` (top-level `TaskManager.defineTask`, imported first by `src/app/_layout.tsx`), `src/services/feedback.ts`, `src/services/live-activity.ts` (no-op implementation until Task 12), `src/state/run-controller.ts`, `src/state/use-run.ts`, `src/state/data-store.tsx`; tests `src/state/__tests__/run-controller.test.ts` with fake deps + node-sqlite.

**Produces:**
- `LOCATION_TASK = 'ghost-pace-location'`; `toGpsFix(loc: LocationObject): GpsFix`; `getPermissionState(): Promise<{ foreground: 'granted' | 'denied' | 'undetermined'; background: 'granted' | 'denied' | 'undetermined' }>`; `requestRunPermissions()` (foreground first, then background, with an explanation screen before each prompt); `startBackgroundUpdates()` with options `{ accuracy: Location.Accuracy.BestForNavigation, activityType: Location.ActivityType.Fitness, distanceInterval: 0, pausesUpdatesAutomatically: false, showsBackgroundLocationIndicator: true }`; `stopBackgroundUpdates()`; `watchWarmup(cb: (fix: GpsFix) => void): Promise<() => void>` (foreground, pre-run accuracy).
- `interface RunControllerDeps { db: () => Promise<SqlDb>; location: { start(): Promise<void>; stop(): Promise<void> }; feedback: { play(cues: Cue[], settings: Settings): void; tap(kind: 'start' | 'pause' | 'resume' | 'finish'): void }; liveActivity: { start(p: LiveActivityPayload): void; update(p: LiveActivityPayload): void; end(p: LiveActivityPayload | null): void }; keepAwake: { on(): void; off(): void }; now: () => number }`.
- `class RunController { constructor(deps); getSnapshot(): ControllerState; subscribe(fn: () => void): () => void; startRun(opts: { mode: 'record' | 'route'; routeId?: string; targetFinishSec?: number | null; primary?: PrimaryComparison; source?: 'gps' | 'simulated' }): Promise<void>; ingestFixes(fixes: GpsFix[]): Promise<void>; pause(): Promise<void>; resume(): Promise<void>; finish(): Promise<{ runId: string; summary: RunSummary }>; discard(): Promise<void>; setPrimary(p): void; recover(): Promise<boolean>; tick(): void }`, where `ControllerState = { status: 'idle' | 'active' | 'finishing'; runId: string | null; routeName: string | null; source: 'gps' | 'simulated'; snapshot: LiveSnapshot | null }`. Events persist through `appendEvents`, flushing every 5 s or 10 events and immediately on pause, resume and finish. `ingestFixes` with no in-memory session calls `recover()` first, because iOS can relaunch the JS context for the background task. Live Activity updates are throttled to ≥ 5 s apart, or immediately when the status changes. Singleton `runController` wired to the real deps; `useRun()` hook via `useSyncExternalStore`.
- `src/state/data-store.tsx`: `<DataProvider>` opens the DB once and exposes `useDb()`, `useRoutes()`, `useRoute(id)`, `useRuns(routeId?)`, `useRun(id)` and `useSettings()` (`[settings, save]`), invalidated through a tiny `emitDataChanged()` event bus.

- [ ] Tests: start (route mode) → ingest 300 simulated fixes → a new controller over the same DB → `recover()` → the snapshot equals the original's (progress ±1 m, advantage ±0.5 s) → ingest the rest → finish; summary.route.completed is true. Duplicate batch → no double distance. finish() in record mode leaves the run `completed` with no route until the user saves it.

---

## Stage 3/5 — Interface (`src/ui`, `src/features`, `src/app`)

Design tokens and Apple idioms apply to every UI task: system font (SF Pro) with `fontVariant: ['tabular-nums']` on every changing number; SF Pro Rounded (`ui-rounded`) for the hero delta. Inset-grouped lists like Settings.app on secondary screens. The live screen is always dark (black) by default. The mint/turquoise accent is `#5EE6D0` (dark) / `#00A99D` (light). Ahead = mint, behind = `#FF9F0A` (systemOrange); the difference is never carried by colour alone, so sign, bar direction and the label carry it too. Support Dynamic Type via `allowFontScaling` with `maxFontSizeMultiplier` caps on hero numerals, honour Reduce Motion, use `accessibilityLabel`s on every metric, and keep hit targets ≥ 44 pt.

### Task 9: Design system and run-screen components

**Files:** `src/ui/theme.ts` (tokens: colors light/dark/run, spacing 4/8/12/16/20/24/32/48, radii 10/14/22, type scale largeTitle 34 … caption 12, `numeric` style), `src/ui/use-theme.ts`, `src/ui/components/{Text,Screen,ListSection,ListRow,Button,SegmentedControl,Chip,EmptyState}.tsx`, `src/features/run/{DeltaHero,DivergingBar,MetricPair,StatusChips,RunControls}.tsx`; delete the template's `src/components`, `src/constants`, `src/hooks`, `src/global.css`, `scripts/reset-project.js` and unused images. Test: `src/features/run/__tests__/DivergingBar.test.tsx`.

**Produces:** `DivergingBar({ advantage: number | null, scale: number, label: 'GHOST' | 'BASELINE', onPress?: () => void })` uses `barGeometry`. It keeps the zero line always visible, with tick labels "BEHIND" left and "AHEAD" right, and shows the signed number beside the bar. Width animates over 300 ms, or not at all with Reduce Motion. `DeltaHero({ reading: ComparisonReading | null, reliable: boolean, reason?: string })`.

- [ ] **#14** render tests: +12 s fills right with `accessibilityLabel` "12 seconds ahead of ghost"; −12 s fills left with "12 seconds behind"; 0 → no fill, zero line present, "on target"; null → zero line only, "—".

### Task 10: App shell, Run tab setup, target sheet, live screen

**Files:** `src/app/_layout.tsx` (imports `@/services/location-task` first, then `DataProvider`, theme, a root `Stack` with `(tabs)`, `live` (`presentation: 'fullScreenModal'`, `gestureEnabled: false`), `summary/[runId]` (`presentation: 'modal'`) and `target` (`presentation: 'formSheet'`), and calls `runController.recover()` on mount); `src/app/(tabs)/_layout.tsx` (`NativeTabs` with Run, Routes, History, Settings and SF Symbol icons via `expo-symbols` / sf props); `src/app/(tabs)/run/{_layout,index}.tsx`; `src/app/target.tsx`; `src/app/live.tsx`; `src/features/run/{RouteSelector,TargetSummary,GpsWarmup,PermissionPrimer}.tsx`.

- Run tab: route picker (or "Record new route"), reference run, target (finish time / −s / −% via `target` sheet), comparison mode, GPS warm-up accuracy, and a large Start button. On first start, a permission primer explains why "Always" location is needed for a locked phone.
- Live screen, in hierarchy order: DeltaHero → status → DivergingBar (tap to switch ghost/baseline when both exist) → pace | next split ("NEXT SPLIT 1:42 · 120 m") → run time | distance → remaining | required pace (or "TARGET AT RISK") → StatusChips (GPS, route state, "SIMULATED" when the source is simulated) → controls: Pause/Resume, and Finish (confirm action sheet: Finish / Discard run / Cancel; Discard needs a second confirmation). Keep-awake while mounted when enabled. Record mode shows the run time hero, distance, pace and GPS. Nothing scrolls on a 375×667 pt screen.

### Task 11: Routes, post-run summary, history, settings, export, sample data

**Files:** `src/app/(tabs)/routes/{_layout,index,[id]}.tsx`, `src/app/summary/[runId].tsx`, `src/app/(tabs)/history/{_layout,index,[routeId],run/[runId],compare}.tsx`, `src/app/(tabs)/settings/{_layout,index}.tsx`, `src/features/charts/{RouteShape,ElevationProfile,FinishTimeChart,AdvantageChart}.tsx` (react-native-svg), `src/services/export.ts` (GPX per route/run; JSON backup → file in `Paths.cache` → `Sharing.shareAsync`), `src/dev/sample-data.ts` (seeds a "Sample · Riverside Hills" route with 5 simulated runs, flagged `is_sample`; `runSimulated(controller, routeId, opts)` feeds `simulateRun` fixes on a timer at 1 Hz with `source: 'simulated'`).

- Summary sheet: in record mode, name the route → `buildRouteFromRecording` → `createRouteFromRun`. In route mode, show the finish time, ±baseline, ±ghost, splits, and a "Use as reference" button (explicit; never automatic).
- Routes: list rows show name, distance, elevation gain, best time and last run date (with a Sample badge when applicable). Detail shows RouteShape, ElevationProfile, runs, set reference, replace baseline (confirm), rename, duplicate, delete (confirm), Export GPX.
- History: per-route stats from `routeStats` (best, latest, average, runs, total distance, change from baseline, trend), FinishTimeChart, a run list, run detail (splits table, AdvantageChart), and compare two runs (`compareProfiles`).
- Settings: Units (Metric, read-only row), Haptics, Audio cues, cue threshold and cooldown, Appearance, Dark run screen, Keep screen awake, Live Activity, default comparison, checkpoint interval, Location permission status (with open Settings), Export backup, Load/Remove sample data, About.

---

## Stage 6 — iOS integration

### Task 12: Live Activity

**Files:** `src/widgets/RunActivity.tsx` (`'widget'` directive; regions `banner`, `compactLeading`, `compactTrailing`, `minimal`, `expanded*`; black background, mint accent, route name, run time, pace, ghost delta, compact bar); `src/services/live-activity.ts` (real implementation via `expo-widgets` `createLiveActivity`, wrapped in try/catch, no-op off iOS); `app.json` plugin `["expo-widgets", { "groupIdentifier": "group.com.lexsclav.ghostpace", "frequentUpdates": true }]`. Read `node_modules/expo-widgets` and `node_modules/@expo/ui` type definitions before writing; use a timer-style text for run time if @expo/ui supports it, else update text every ≥ 5 s.

### Task 13: App config, EAS, docs

**Files:** `app.json` (name "Ghost Pace", slug `ghost-pace`, scheme `ghostpace`, `ios.bundleIdentifier` `com.lexsclav.ghostpace`, `ios.supportsTablet: false`, `ios.infoPlist.UIBackgroundModes: ["location", "audio"]`, the expo-location plugin with `isIosBackgroundLocationEnabled: true` and user-facing permission strings, black splash, `web.output: "single"`), `eas.json` (development, preview and production profiles), `README.md` (no-Mac workflow: Apple Developer Program, `eas device:create`, Developer Mode, dev build vs preview build, TestFlight; what has and hasn't been verified on a real device), `CLAUDE.md`.

- [ ] Verify: `npx expo-doctor`; `npx expo export --platform ios`; `npx expo prebuild --platform ios --no-install` in a scratch copy shows `UIBackgroundModes` with location, the `NSLocationAlwaysAndWhenInUseUsageDescription` string, the widget extension target and the app group entitlement; `npx jest`; `npx tsc --noEmit`; `npx expo lint`.
