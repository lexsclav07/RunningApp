/** @jest-environment node */
/**
 * Spec §14 acceptance criteria, end to end. Each scenario simulates seeded 1 Hz GPS traces, turns them
 * into a session event log (`toEvents`) and runs it through `RunSession` with a 1 Hz clock tick, as the
 * run controller does. References come from simulated recordings via `buildRouteFromRecording`, so
 * geometry building, matching and profiles are exercised as in the app. "Truth" is the simulator's
 * along-route distance; a true advantage is the reference runner's true time to the current runner's
 * true position minus the current run time.
 *
 * Tolerances: ideal (noise-free) traces must display the exact value. With the simulator's realistic
 * 3 m error (a slowly varying bias, independent in the reference and the current run) the along-route
 * position of each run is off by a few metres, i.e. ~1 s RMS at 3 m/s; measured worst cases are ≈ 1.7 s
 * at a checkpoint (interpolated) and ≈ 2.7 s for a single live reading. Hence ±2 s at checkpoints (the
 * on-target band) and ±3 s live.
 */
import { describe, expect, it } from '@jest/globals';
import { CueEngine, type Cue } from '../cues';
import { deltaPhrase, formatDelta } from '../format';
import { makeProjection, projectOntoSegment, type XY } from '../geo';
import { toLiveActivityPayload } from '../live-activity-payload';
import { finishTime, resolveTargetFinish, scaleProfile, timeAt } from '../profile';
import { buildRouteFromRecording } from '../route-builder';
import { RunSession } from '../session';
import { buildCheckpoints, checkpointInterval } from '../splits';
import { toEvents } from '../sim/events';
import { mulberry32 } from '../sim/prng';
import { DEFAULT_SIM_ORIGIN, makeRoute, twoHills, type SimRoutePoint } from '../sim/routes';
import { simulateRun, type SimulateRunOptions, type SimulatedRun } from '../sim/trace';
import type { GpsFix, LatLon, LiveSnapshot, RunSummary, SessionConfig, SessionEvent } from '../types';

const START = Date.UTC(2026, 9, 29, 7, 0, 0);
const atSec = (sec: number) => START + sec * 1000;
const secOf = (ms: number) => (ms - START) / 1000;
const timeOf = (e: SessionEvent) => (e.type === 'fix' ? e.fix.t : e.t);
const SEEDS = [1, 2, 3];
const proj = makeProjection(DEFAULT_SIM_ORIGIN);

type Speed = (d: number, grade: number) => number;
type Route = NonNullable<LiveSnapshot['route']>;

function memo<T>(f: () => T): () => T {
  let v: T | undefined;
  return () => (v ??= f());
}

// --- references --------------------------------------------------------------------------------------

interface Recorded extends ReturnType<typeof buildRouteFromRecording> {
  points: SimRoutePoint[];
  speed: Speed;
  sim: SimulatedRun;
  endSec: number;
}

/** Records a reference: simulates a run on `points` (3 m noise unless overridden) and builds the route. */
function record(points: SimRoutePoint[], speed: Speed, seed: number, extra: Partial<SimulateRunOptions> = {}): Recorded {
  const sim = simulateRun(points, { speed, startMs: START, noiseM: 3, seed, ...extra });
  const endSec = secOf(sim.fixes[sim.fixes.length - 1].t);
  return { ...buildRouteFromRecording(toEvents(sim.fixes)), points, speed, sim, endSec };
}

/** Seconds after its first fix at which a simulated runner first reaches true distance `d` (bisection). */
function reachSec(sim: SimulatedRun, d: number, endSec: number): number {
  let lo = 0;
  let hi = endSec;
  for (let k = 0; k < 50; k++) {
    const mid = (lo + hi) / 2;
    if (sim.truthAtSec(mid) < d) lo = mid;
    else hi = mid;
  }
  return hi;
}

const twoLaps = (lap: number) => {
  const pts = makeRoute('loop', { length: lap });
  return [...pts, ...pts.slice(1)];
};

/** Reference speed: 3 m/s ± 0.4 over a 700 m cycle. */
const REF_SPEED: Speed = (d) => 3 + 0.4 * Math.sin((2 * Math.PI * d) / 700);
/** Uneven current-run speed: 3 m/s ± 0.6 over a 500 m cycle. */
const WAVY: Speed = (d) => 3 + 0.6 * Math.sin((2 * Math.PI * d) / 500);
const constant = (v: number): Speed => () => v;
/** Slows on climbs: 3.2 m/s on the flat, 2 m/s at a 10 % grade. */
const HILL_SPEED: Speed = (_d, grade) => 3.2 / (1 + 6 * Math.max(0, grade));

const STRAIGHT_2K = makeRoute('straight', { length: 2000 });
const HILLS_2K = makeRoute('straight', { length: 2000, elevation: twoHills(2000) });
const ref2k = memo(() => record(STRAIGHT_2K, REF_SPEED, 101));
const ideal2k = memo(() => record(STRAIGHT_2K, REF_SPEED, 101, { noiseM: 0 }));
const refLoop = memo(() => record(makeRoute('loop', { length: 2000 }), REF_SPEED, 102));
const refTwoLaps = memo(() => record(twoLaps(1000), constant(3), 103));
const refHills = memo(() => record(HILLS_2K, HILL_SPEED, 104));
/** 5 km loop run in 30:00 (constant 2.78 m/s). */
const ref5k = memo(() => record(makeRoute('loop', { length: 5000 }), constant(5000 / 1800), 105));

// --- driving a session -------------------------------------------------------------------------------

interface Sample {
  sec: number;
  snap: LiveSnapshot;
  route: Route;
  /** A fix was applied in this second (so readings are fresh at `sec`). */
  fix: boolean;
  truth: number;
  cues: Cue[];
}
interface Run {
  cfg: SessionConfig;
  events: SessionEvent[];
  session: RunSession;
  samples: Sample[];
  summary: RunSummary;
}

const configFor = (ref: Recorded, targetFinishSec: number | null = null): SessionConfig => ({
  mode: 'route',
  route: { geometry: ref.geometry, climbs: ref.climbs },
  reference: ref.profile,
  targetFinishSec,
});

/** Applies `events` with a 1 Hz clock tick (events at or before each tick first), evaluating cues per tick. */
function drive(ref: Recorded, events: SessionEvent[], truth: (sec: number) => number, target: number | null = null): Run {
  const cfg = configFor(ref, target);
  const session = new RunSession(cfg);
  const cues = new CueEngine();
  const samples: Sample[] = [];
  const lastSec = Math.ceil(secOf(timeOf(events[events.length - 1])));
  let i = 0;
  for (let sec = 0; sec <= lastSec; sec++) {
    let fix = false;
    while (i < events.length && timeOf(events[i]) <= atSec(sec)) {
      fix ||= events[i].type === 'fix';
      session.apply(events[i++]);
    }
    const snap = session.tick(atSec(sec));
    samples.push({ sec, snap, route: snap.route as Route, fix, truth: truth(sec), cues: cues.evaluate(snap) });
  }
  return { cfg, events, session, samples, summary: session.summary() };
}

interface RunOpts extends Partial<Omit<SimulateRunOptions, 'speed' | 'startMs'>> {
  speed: Speed;
  seed: number;
  points?: SimRoutePoint[];
  target?: number | null;
  pauses?: { fromSec: number; toSec: number }[];
  finishSec?: number;
}

/** Simulates a run (3 m noise unless overridden) on the reference's route points and drives a session. */
function runOn(ref: Recorded, o: RunOpts): Run & { sim: SimulatedRun } {
  const { speed, seed, points, target, pauses, finishSec, ...simOpts } = o;
  const sim = simulateRun(points ?? ref.points, { noiseM: 3, ...simOpts, speed, seed, startMs: START });
  const events = toEvents(sim.fixes, {
    pauses: pauses?.map((p) => ({ fromMs: atSec(p.fromSec), toMs: atSec(p.toSec) })),
    finishMs: finishSec === undefined ? undefined : atSec(finishSec),
  });
  return { ...drive(ref, events, sim.truthAtSec, target ?? null), sim };
}

/** True advantage at a sample: the reference runner's true time to this true position − run time. */
const trueAdv = (ref: Recorded, s: Sample) => reachSec(ref.sim, s.truth, ref.endSec) - s.snap.runSec;
/** Samples with a fresh on-route reading. */
const matched = (run: Run) => run.samples.filter((s) => s.fix && s.route.match === 'onRoute' && s.route.baseline);

/** The reference's speed, but `offsetSec` faster (negative = slower) to `atD` m, then the same again. */
function offsetSpeed(ref: Recorded, offsetSec: number, atD = 1000): Speed {
  const T = reachSec(ref.sim, atD, ref.endSec);
  const c = T / (T - offsetSec); // time to atD = T / c = T − offsetSec
  return (d, g) => ref.speed(d, g) * (d < atD ? c : 1);
}

/** #1–#3, #16: a run offset by `offsetSec` at the mid-route checkpoint (1000 m) of a 2 km route. */
function offsetScenario(ref: Recorded, offsetSec: number, o: Omit<RunOpts, 'speed'>) {
  const run = runOn(ref, { ...o, speed: offsetSpeed(ref, offsetSec) });
  const cp = run.summary.route!.splits.find((s) => s.d === 1000);
  if (!cp) throw new Error('no checkpoint at 1000 m');
  // live readings over the second half, where the runner holds the offset
  const live = matched(run).filter((s) => s.truth >= 1050 && s.truth <= 1900);
  return { run, cp, live };
}

// --- spec §14 ------------------------------------------------------------------------------------------

describe('#1 "A runner 30 seconds ahead of the reference displays +30 seconds."', () => {
  it('ideal trace: the mid-route checkpoint and the live reading show +00:30', () => {
    const { cp, live } = offsetScenario(ideal2k(), 30, { seed: 1, noiseM: 0 });
    expect(formatDelta(cp.cumulativeDiff)).toBe('+00:30');
    expect(deltaPhrase(cp.cumulativeDiff)).toBe('30 SEC AHEAD');
    expect(live.length).toBeGreaterThan(200);
    for (const s of live) {
      expect(formatDelta(s.route.baseline!.advantage)).toBe('+00:30');
      expect(s.route.baseline!.status).toBe('ahead');
    }
  });

  it('3 m GPS noise: +30 ± 2 s at the checkpoint, ± 3 s live', () => {
    for (const seed of SEEDS) {
      const { cp, live } = offsetScenario(ref2k(), 30, { seed });
      expect(Math.abs(cp.cumulativeDiff - 30)).toBeLessThan(2);
      for (const s of live) {
        expect(Math.abs(s.route.baseline!.advantage - 30)).toBeLessThanOrEqual(3);
        expect(s.route.baseline!.status).toBe('ahead');
      }
    }
  });
});

describe('#2 "A runner 30 seconds behind displays −30 seconds."', () => {
  it('ideal trace: the mid-route checkpoint and the live reading show −00:30', () => {
    const { cp, live } = offsetScenario(ideal2k(), -30, { seed: 1, noiseM: 0 });
    expect(formatDelta(cp.cumulativeDiff)).toBe('−00:30');
    expect(deltaPhrase(cp.cumulativeDiff)).toBe('30 SEC BEHIND');
    expect(live.length).toBeGreaterThan(200);
    for (const s of live) {
      expect(formatDelta(s.route.baseline!.advantage)).toBe('−00:30');
      expect(s.route.baseline!.status).toBe('behind');
    }
  });

  it('3 m GPS noise: −30 ± 2 s at the checkpoint, ± 3 s live', () => {
    for (const seed of SEEDS) {
      const { cp, live } = offsetScenario(ref2k(), -30, { seed });
      expect(Math.abs(cp.cumulativeDiff + 30)).toBeLessThan(2);
      for (const s of live) {
        expect(Math.abs(s.route.baseline!.advantage + 30)).toBeLessThanOrEqual(3);
        expect(s.route.baseline!.status).toBe('behind');
      }
    }
  });
});

describe('#3 "Matching the reference displays zero."', () => {
  it('ideal trace: 00:00 and ON TARGET throughout', () => {
    const { cp, live, run } = offsetScenario(ideal2k(), 0, { seed: 1, noiseM: 0 });
    expect(formatDelta(cp.cumulativeDiff)).toBe('00:00');
    expect(deltaPhrase(cp.cumulativeDiff)).toBe('ON TARGET');
    for (const s of matched(run)) {
      expect(formatDelta(s.route.baseline!.advantage)).toBe('00:00');
      expect(s.route.baseline!.status).toBe('onTarget');
    }
    expect(live.length).toBeGreaterThan(200);
    expect(formatDelta(run.summary.route!.baselineFinalAdvantage!)).toBe('00:00');
  });

  it('3 m GPS noise: ON TARGET at the checkpoint; live readings within ± 3 s and mostly on target', () => {
    for (const seed of SEEDS) {
      const { cp, live } = offsetScenario(ref2k(), 0, { seed });
      expect(deltaPhrase(cp.cumulativeDiff)).toBe('ON TARGET');
      for (const s of live) expect(Math.abs(s.route.baseline!.advantage)).toBeLessThanOrEqual(3);
      const onTarget = live.filter((s) => s.route.baseline!.status === 'onTarget').length;
      expect(onTarget / live.length).toBeGreaterThanOrEqual(0.85);
    }
  });
});

describe('#4 "The ghost-target profile starts at zero and finishes at the selected target time."', () => {
  const TARGET = 1770; // 29:30 against a 30:00 reference
  /** A runner who follows the ghost: the reference pace scaled to the target. */
  const ghostRun = memo(() => {
    const ref = ref5k();
    const k = finishTime(ref.profile) / TARGET;
    return runOn(ref, { speed: (d, g) => ref.speed(d, g) * k, seed: 41, target: TARGET });
  });

  it('the ghost profile runs from (0, 0) to the target finish', () => {
    const ref = ref5k();
    expect(Math.abs(finishTime(ref.profile) - 1800)).toBeLessThan(3);
    const ghost = scaleProfile(ref.profile, TARGET);
    expect(timeAt(ghost, 0)).toBe(0);
    expect(finishTime(ghost)).toBe(TARGET);
    expect(ghost.d[ghost.d.length - 1]).toBe(ref.geometry.length);
  });

  it('a runner on the ghost reads ≈ 0 from the start and finishes at the target time', () => {
    const run = ghostRun();
    const m = matched(run);
    expect(m[0].route.ghost!.targetFinishSec).toBe(TARGET);
    expect(m[0].sec).toBeLessThanOrEqual(2);
    expect(Math.abs(m[0].route.ghost!.advantage)).toBeLessThan(2);
    for (const s of m) expect(Math.abs(s.route.ghost!.advantage)).toBeLessThanOrEqual(3);
    const r = run.summary.route!;
    expect(r.completed).toBe(true);
    expect(Math.abs((r.finishSec as number) - TARGET)).toBeLessThanOrEqual(3);
    expect(Math.abs(r.ghostFinalAdvantage as number)).toBeLessThanOrEqual(3);
    // the last checkpoint is the finish, at exactly the target time
    expect(r.splits[r.splits.length - 1].d).toBe(run.cfg.route!.geometry.length);
    expect(r.splits[r.splits.length - 1].targetElapsed).toBe(TARGET);
  });
});

describe('#5 "A faster target generates proportionally faster checkpoint times."', () => {
  it('every checkpoint’s target time and split shrink by target / reference finish', () => {
    const ref = ref5k();
    for (const target of [1770, resolveTargetFinish(finishTime(ref.profile), { kind: 'improvementPercent', percent: 2 })]) {
      const k = target / finishTime(ref.profile);
      const run = runOn(ref, { speed: ref.speed, seed: 51, target });
      const splits = run.summary.route!.splits;
      const interval = checkpointInterval(ref.geometry.length);
      expect(splits.map((s) => s.d)).toEqual(
        buildCheckpoints(ref.geometry.length, scaleProfile(ref.profile, target), ref.profile, interval).map((c) => c.d),
      );
      expect(splits.length).toBeGreaterThanOrEqual(10);
      let prevRef = 0;
      for (const s of splits) {
        expect(s.referenceElapsed).toBeCloseTo(timeAt(ref.profile, s.d), 9);
        expect(s.targetElapsed).toBeCloseTo(s.referenceElapsed * k, 9);
        expect(s.targetSplit).toBeCloseTo((s.referenceElapsed - prevRef) * k, 9);
        expect(s.targetElapsed).toBeLessThan(s.referenceElapsed);
        prevRef = s.referenceElapsed;
      }
      // the live "next split" agrees
      for (const s of matched(run).slice(0, 400)) {
        const next = s.route.nextCheckpoint!;
        expect(next.targetElapsed).toBeCloseTo(timeAt(ref.profile, next.d) * k, 9);
      }
    }
  });
});

describe('#6 "Steep hills retain the reference run\'s relative timing characteristics."', () => {
  const scenario = memo(() => {
    const ref = refHills();
    const refFinish = finishTime(ref.profile);
    const target = resolveTargetFinish(refFinish, { kind: 'improvementPercent', percent: 2 });
    // follows the ghost: slows on the climbs like the reference, 2 % faster throughout
    const ghostLike = runOn(ref, { speed: (d, g) => HILL_SPEED(d, g) / 0.98, seed: 61, target });
    // same finish time, but an even pace
    const even = runOn(ref, { speed: constant(ref.geometry.length / target), seed: 62, target });
    return { ref, refFinish, target, ghostLike, even };
  });

  it('the recorded route has both climbs', () => {
    const { ref } = scenario();
    expect(ref.geometry.elevationReliable).toBe(true);
    expect(ref.climbs).toHaveLength(2);
    expect(Math.abs(ref.climbs[0].startD - 500)).toBeLessThan(30);
    expect(Math.abs(ref.climbs[1].startD - 1300)).toBeLessThan(30);
  });

  it('the ghost’s split share on each hill equals the reference’s, and hill splits stay slower', () => {
    const { ref, refFinish, target, ghostLike } = scenario();
    const splits = ghostLike.summary.route!.splits;
    let prevD = 0;
    let prevRef = 0;
    const hill: number[] = [];
    const flat: number[] = [];
    for (const s of splits) {
      const refSplit = s.referenceElapsed - prevRef;
      // share of the whole route's time spent in this split: ghost vs reference
      expect(s.targetSplit / target).toBeCloseTo(refSplit / refFinish, 9);
      // a hill split: at least 100 m of it lies on a climb
      const onHill = ref.climbs.some((c) => Math.min(c.endD, s.d) - Math.max(c.startD, prevD) >= 100);
      (onHill ? hill : flat).push(s.targetSplit / (s.d - prevD));
      prevD = s.d;
      prevRef = s.referenceElapsed;
    }
    expect(hill.length).toBeGreaterThanOrEqual(2);
    const flatPace = flat.sort((a, b) => a - b)[Math.floor(flat.length / 2)];
    for (const h of hill) expect(h).toBeGreaterThan(1.2 * flatPace);
  });

  it('a runner who slows on the hills like the reference stays on the ghost; an even pace swings', () => {
    const { ghostLike, even } = scenario();
    const ghostAdv = (r: Run) => matched(r).map((s) => s.route.ghost!.advantage);
    for (const a of ghostAdv(ghostLike)) expect(Math.abs(a)).toBeLessThanOrEqual(3);
    const e = ghostAdv(even);
    expect(Math.max(...e) - Math.min(...e)).toBeGreaterThan(10);
    // the hills were announced once each
    expect(ghostLike.samples.flatMap((s) => s.cues).filter((c) => c.kind === 'hillAhead')).toHaveLength(2);
  });
});

describe('#7 "GPS jitter does not cause erratic route matching or large performance jumps."', () => {
  it.each([
    ['straight', ref2k],
    ['loop', refLoop],
  ] as const)('5 m noise on a 2 km %s route: monotonic progress, bounded steps, smooth advantage', (_kind, refOf) => {
    const ref = refOf();
    for (const seed of SEEDS) {
      const run = runOn(ref, { speed: WAVY, seed, noiseM: 5 });
      // up to the route finish (whose progress is set to the end: the extrapolated crossing, not a jump)
      const m = matched(run).filter((s) => s.route.finishedSec === null);
      expect(m.length).toBeGreaterThan(600);
      for (let i = 1; i < run.samples.length; i++) {
        expect(run.samples[i].route.progress).toBeGreaterThanOrEqual(run.samples[i - 1].route.progress);
      }
      for (let i = 1; i < m.length; i++) {
        const step = m[i].route.progress - m[i - 1].route.progress;
        expect(step).toBeLessThanOrEqual(3 * Math.abs(m[i].truth - m[i - 1].truth) + 10);
        const jump = m[i].route.baseline!.advantage - m[i - 1].route.baseline!.advantage;
        expect(Math.abs(jump)).toBeLessThanOrEqual(1.5 * (m[i].sec - m[i - 1].sec));
      }
      // The advantage error is a position error divided by the reference's speed there. As in the matcher's
      // noise tests the position bound is 3 × RMS noise, here combined: 3 × √(5² + 3²) ≈ 17.5 m (≈ 6 s at 2.6 m/s;
      // measured worst ≈ 15 m).
      const bound = 3 * Math.hypot(5, 3);
      for (const s of m) {
        expect(Math.abs(s.route.baseline!.advantage - trueAdv(ref, s)) * ref.speed(s.truth, 0)).toBeLessThanOrEqual(bound);
      }
      expect(run.summary.route!.completed).toBe(true);
    }
  });
});

describe('#8 "Loop routes match the correct occurrence of repeated positions."', () => {
  it('2 laps of a 1 km loop: the second pass of the start is matched at ≈ 1000 m, not 0', () => {
    const ref = refTwoLaps();
    for (const seed of SEEDS) {
      const run = runOn(ref, { speed: constant(3.1), seed, noiseM: 5 });
      const m = matched(run);
      const atLap = m.reduce((a, b) => (Math.abs(b.truth - 1000) < Math.abs(a.truth - 1000) ? b : a));
      expect(Math.abs(atLap.truth - 1000)).toBeLessThan(4);
      expect(Math.abs(atLap.route.progress - 1000)).toBeLessThanOrEqual(25);
      // matching the first occurrence would read ≈ −320 s
      expect(Math.abs(atLap.route.baseline!.advantage - trueAdv(ref, atLap))).toBeLessThanOrEqual(4);
      expect(run.samples.some((s) => s.route.finishedSec !== null && s.truth < ref.geometry.length - 50)).toBe(false);
      expect(run.summary.route!.completed).toBe(true);
    }
  });

  it('figure eight: both passes through the crossing keep the right branch', () => {
    const ref = record(makeRoute('figureEight', { length: 2000 }), constant(3), 106);
    const run = runOn(ref, { speed: constant(3.1), seed: 7, noiseM: 5 });
    const near = matched(run).filter((s) => Math.abs(s.truth - 500) < 6 || Math.abs(s.truth - 1500) < 6);
    expect(near.length).toBeGreaterThan(4);
    for (const s of near) expect(Math.abs(s.route.baseline!.advantage - trueAdv(ref, s))).toBeLessThanOrEqual(4);
  });
});

describe('#9 "Pausing and resuming does not create artificial time differences."', () => {
  /**
   * The same trace twice: as recorded, and with the runner stopping at P s, pausing for 120 s and
   * resuming at the same spot (the fixes after the pause are the twin's, 120 s later; standing fixes in
   * between). Run times therefore match exactly, and any difference comes from the pause handling.
   */
  function twins(seed: number) {
    const ref = ref2k();
    const P = 300;
    const D = 120;
    const sim = simulateRun(ref.points, { speed: WAVY, startMs: START, noiseM: 3, seed });
    const twin = drive(ref, toEvents(sim.fixes), sim.truthAtSec);
    const stopAt = sim.fixes.find((f) => secOf(f.t) === P) as GpsFix;
    const rand = mulberry32(seed);
    const standing: GpsFix[] = Array.from({ length: D }, (_, k) => {
      const xy = proj.toXY(stopAt);
      const ll = proj.toLatLon(xy.x + 4 * (rand() - 0.5), xy.y + 4 * (rand() - 0.5));
      return { ...stopAt, ...ll, t: atSec(P + 1 + k), speed: 0, course: -1 };
    });
    const events: SessionEvent[] = [
      { type: 'start', t: START },
      ...sim.fixes.filter((f) => secOf(f.t) <= P).map((fix): SessionEvent => ({ type: 'fix', fix })),
      { type: 'pause', t: atSec(P + 0.5) },
      ...standing.map((fix): SessionEvent => ({ type: 'fix', fix })),
      { type: 'resume', t: atSec(P + D + 0.5) },
      ...sim.fixes.filter((f) => secOf(f.t) > P).map((fix): SessionEvent => ({ type: 'fix', fix: { ...fix, t: fix.t + D * 1000 } })),
    ];
    events.push({ type: 'finish', t: timeOf(events[events.length - 1]) });
    const truth = (sec: number) => sim.truthAtSec(sec <= P ? sec : sec < P + D ? P : sec - D);
    const paused = drive(ref, events, truth);
    return { twin, paused, P, D };
  }

  it('a 120 s pause mid-run leaves the advantage within ±1 s of the unpaused twin', () => {
    for (const seed of SEEDS) {
      const { twin, paused, P, D } = twins(seed);
      // same run time and distance; wall time differs by the pause
      expect(paused.summary.runSec).toBeCloseTo(twin.summary.runSec, 9);
      expect(paused.summary.wallSec - twin.summary.wallSec).toBeCloseTo(D, 9);
      expect(paused.summary.pauses).toEqual([{ start: atSec(P + 0.5), end: atSec(P + D + 0.5) }]);
      // the resume drops the distance anchor (plan rule): ≤ 2 anchor steps (≈ 3 m each) are not credited
      expect(Math.abs(paused.summary.distance - twin.summary.distance)).toBeLessThanOrEqual(6.5);
      // the paused snapshots hold still
      const during = paused.samples.filter((s) => s.sec > P + 1 && s.sec <= P + D);
      expect(new Set(during.map((s) => s.snap.runSec)).size).toBe(1);
      expect(new Set(during.map((s) => s.route.baseline!.advantage)).size).toBe(1);
      expect(during.every((s) => s.snap.phase === 'paused' && s.snap.paceSecPerKm === null)).toBe(true);
      // after the resume: the advantage at the same run time matches the twin's
      const twinAt = new Map(twin.samples.map((s) => [s.sec, s]));
      for (const s of paused.samples.filter((x) => x.sec > P + D && x.fix)) {
        const t = twinAt.get(s.sec - D) as Sample;
        expect(s.snap.runSec).toBeCloseTo(t.snap.runSec, 9);
        expect(Math.abs(s.route.baseline!.advantage - t.route.baseline!.advantage)).toBeLessThanOrEqual(1);
      }
      const a = paused.summary.route!;
      const b = twin.summary.route!;
      expect(a.splits.length).toBe(b.splits.length);
      a.splits.forEach((s, i) => expect(Math.abs(s.cumulativeDiff - b.splits[i].cumulativeDiff)).toBeLessThanOrEqual(1));
      expect(Math.abs((a.finishSec as number) - (b.finishSec as number))).toBeLessThanOrEqual(1);
      // the pause triggers no status cue of its own: the same status cues as the twin (both use run time)
      const statusCues = (r: Run) => r.samples.flatMap((s) => s.cues).filter((c) => c.kind === 'statusChange');
      expect(statusCues(paused)).toEqual(statusCues(twin));
    }
  });
});

describe('#10 "Temporary GPS loss does not produce misleading pace or distance readings."', () => {
  it('a 30 s gap: no pace once the fix is stale, distance within 3 %, pace after recovery within [0.8×, 1.25×]', () => {
    const ref = refTwoLaps();
    const truePace = 1000 / 3;
    const gap = { fromSec: 200, toSec: 230 };
    for (const seed of SEEDS) {
      const run = runOn(ref, { speed: constant(3), seed, gaps: [gap] });
      const during = run.samples.filter((s) => s.sec > gap.fromSec && s.sec < gap.toSec);
      for (const s of during) {
        const pace = s.snap.paceSecPerKm;
        // the last pre-gap value may show briefly, then nothing once no fix has come for 10 s
        if (s.sec > gap.fromSec + 10) expect(pace).toBeNull();
        else if (pace !== null) expect(pace / truePace).toBeGreaterThanOrEqual(0.8);
        if (s.sec > gap.fromSec + 10) {
          expect(s.route.match).toBe('lost');
          expect(s.snap.gps.quality).toBe('none');
          expect(s.route.reliable).toBe(false);
        }
      }
      const after = run.samples.filter((s) => s.sec >= gap.toSec);
      const firstPace = after.find((s) => s.snap.paceSecPerKm !== null);
      expect(firstPace!.sec).toBeLessThanOrEqual(gap.toSec + 25);
      for (const s of after) {
        const pace = s.snap.paceSecPerKm;
        if (pace === null) continue;
        expect(pace / truePace).toBeGreaterThanOrEqual(0.8);
        expect(pace / truePace).toBeLessThanOrEqual(1.25);
      }
      // distance bridges the gap without inventing or losing more than 3 %
      expect(Math.abs(run.summary.distance - 2000) / 2000).toBeLessThanOrEqual(0.03);
      // re-acquired at the right place within 3 fixes
      const back = matched(run).filter((s) => s.sec >= gap.toSec);
      expect(back[0].sec).toBeLessThanOrEqual(gap.toSec + 2);
      for (const s of back) expect(Math.abs(s.route.baseline!.advantage - trueAdv(ref, s))).toBeLessThanOrEqual(4);
      expect(run.summary.gps.gaps).toBe(1);
      expect(run.samples.flatMap((s) => s.cues).filter((c) => c.kind === 'gpsLost')).toHaveLength(1);
    }
  });
});

describe('#11 "Route deviations are detected appropriately."', () => {
  /** Distance (m) from a position to the recorded route polyline. */
  function offsetFrom(points: LatLon[]): (p: LatLon) => number {
    const xy = points.map((q) => proj.toXY(q));
    return (p) => {
      const q = proj.toXY(p);
      let best = Infinity;
      for (let i = 0; i + 1 < xy.length; i++) best = Math.min(best, projectOntoSegment(q, xy[i], xy[i + 1]).dist);
      return best;
    };
  }

  /** Route points every ≈ 2 m along straight legs between XY vertices (m around the sim origin). */
  function polyline(vertices: XY[]): SimRoutePoint[] {
    const out: SimRoutePoint[] = [];
    for (let i = 1; i < vertices.length; i++) {
      const a = vertices[i - 1];
      const b = vertices[i];
      const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 2));
      for (let k = i === 1 ? 0 : 1; k <= n; k++) {
        out.push({ ...proj.toLatLon(a.x + ((b.x - a.x) * k) / n, a.y + ((b.y - a.y) * k) / n), ele: null });
      }
    }
    return out;
  }

  it('a 150 m detour 60 m off the route: offRoute within 6 + 2 s, held readings, back on route within 5 s', () => {
    const ref = ref2k();
    const offset = offsetFrom(ref.geometry.points);
    const path = polyline([
      { x: 0, y: 0 },
      { x: 0, y: 800 },
      { x: 60, y: 800 },
      { x: 60, y: 950 },
      { x: 0, y: 950 },
      { x: 0, y: 2000 },
    ]);
    for (const seed of SEEDS) {
      const sim = simulateRun(path, { speed: constant(3), startMs: START, noiseM: 3, seed });
      // the noise-free twin gives the true position at each second
      const ideal = simulateRun(path, { speed: constant(3), startMs: START, noiseM: 0, seed }).fixes;
      const trueOffset = new Map(ideal.map((f) => [secOf(f.t), offset(f)]));
      const trueNorth = new Map(ideal.map((f) => [secOf(f.t), proj.toXY(f).y]));
      const run = drive(ref, toEvents(sim.fixes), (sec) => Math.min(2000, Math.max(0, trueNorth.get(sec) ?? 2000)));
      const leftAt = run.samples.find((s) => (trueOffset.get(s.sec) ?? 0) > 35)!.sec;
      const rejoinedAt = run.samples.find((s) => s.sec > leftAt && (trueOffset.get(s.sec) ?? 0) < 1)!.sec;
      const off = run.samples.filter((s) => s.route.match === 'offRoute');
      expect(off.length).toBeGreaterThan(30);
      expect(off[0].sec).toBeLessThanOrEqual(leftAt + 6 + 2);
      expect(run.samples.filter((s) => s.sec < leftAt).every((s) => s.route.match !== 'offRoute')).toBe(true);
      // progress and comparisons are held while off route
      expect(new Set(off.map((s) => s.route.progress)).size).toBe(1);
      expect(new Set(off.map((s) => s.route.baseline!.advantage)).size).toBe(1);
      expect(off.every((s) => !s.route.reliable)).toBe(true);
      const onAgain = run.samples.find((s) => s.sec > off[0].sec && s.route.match === 'onRoute')!;
      expect(onAgain.sec).toBeLessThanOrEqual(rejoinedAt + 5);
      expect(run.samples.filter((s) => s.sec >= rejoinedAt + 5).every((s) => s.route.match === 'onRoute')).toBe(true);
      // afterwards the comparison reflects the extra distance run (≈ 120 m)
      for (const s of matched(run).filter((x) => x.sec >= rejoinedAt + 5)) {
        expect(Math.abs(s.route.baseline!.advantage - trueAdv(ref, s))).toBeLessThanOrEqual(4);
      }
      const cues = run.samples.flatMap((s) => s.cues).map((c) => c.kind);
      expect(cues.filter((k) => k === 'offRoute')).toHaveLength(1);
      expect(cues.filter((k) => k === 'backOnRoute')).toHaveLength(1);
      expect(run.summary.route!.offRouteSec).toBeGreaterThan(off.length - 5);
      expect(run.summary.route!.offRouteSec).toBeLessThan(off.length + 5);
      expect(run.summary.route!.completed).toBe(true);
    }
  });
});

describe('#12 "Required remaining pace is calculated correctly."', () => {
  const TARGET = 1770;

  it('required pace = (target − run time) / remaining distance on every reading; ok while on course', () => {
    const ref = ref5k();
    const run = runOn(ref, { speed: ref.speed, seed: 71, target: TARGET });
    const m = matched(run).filter((s) => s.route.finishedSec === null);
    let ok = 0;
    for (const s of m) {
      const req = s.route.required!;
      expect(req.remainingM).toBeCloseTo(s.route.length - s.route.progress, 9);
      expect(req.remainingSec).toBeCloseTo(TARGET - s.snap.runSec, 9);
      if (req.status === 'ok') {
        ok++;
        expect(req.secPerKm).toBeCloseTo((req.remainingSec / req.remainingM) * 1000, 9);
      } else {
        expect(req.secPerKm).toBeNull();
      }
      if (req.remainingM < 50) expect(req.status).toBe('unavailable');
    }
    // On the reference's pace, i.e. 1.7 % slower than the ghost: the deficit grows, so the speed-up needed
    // over the rest of the route grows too. It stays "ok" through the first 60 %, then passes 8 % → atRisk.
    expect(ok / m.length).toBeGreaterThan(0.6);
    for (const s of m.filter((x) => x.route.progress < 0.6 * x.route.length)) expect(s.route.required!.status).toBe('ok');
    expect(m.some((s) => s.route.required!.status === 'atRisk')).toBe(true);
    // 'missed' exactly when the target time has passed with ≥ 50 m still to run (here the last ≈ 80 m)
    for (const s of m) {
      const req = s.route.required!;
      expect(req.status === 'missed').toBe(req.remainingSec <= 0 && req.remainingM >= 50);
    }
    const mid = m.find((s) => s.route.progress >= 2500)!;
    expect(mid.route.required!.status).toBe('ok');
    expect(mid.route.required!.secPerKm!).toBeGreaterThan(330);
    expect(mid.route.required!.secPerKm!).toBeLessThan(370);
  });

  it('a runner far off the target pace gets "at risk" (no pace shown), then "missed"', () => {
    const ref = ref5k();
    const run = runOn(ref, { speed: (d, g) => ref.speed(d, g) * 0.8, seed: 72, target: TARGET, finishSec: 1900 });
    const statuses = matched(run).map((s) => s.route.required!);
    expect(statuses.some((r) => r.status === 'atRisk')).toBe(true);
    for (const r of statuses) if (r.status !== 'ok') expect(r.secPerKm).toBeNull();
    const late = matched(run).filter((s) => s.snap.runSec > TARGET);
    expect(late.length).toBeGreaterThan(50);
    for (const s of late) expect(s.route.required!.status).toBe('missed');
    expect(run.samples.flatMap((s) => s.cues).some((c) => c.kind === 'targetAtRisk')).toBe(true);
  });
});

describe('#15 "Baseline and ghost-target comparisons remain distinct."', () => {
  it('each follows its own profile (±1 s on every tick) and they differ by the target scaling', () => {
    const ref = ref5k();
    const target = 1770;
    const ghost = scaleProfile(ref.profile, target);
    const run = runOn(ref, { speed: ref.speed, seed: 81, target });
    const live = run.samples.filter((s) => s.route.baseline && s.route.finishedSec === null && s.route.match === 'onRoute');
    for (const s of live) {
      const p = s.route.progress;
      expect(Math.abs(s.route.baseline!.advantage - (timeAt(ref.profile, p) - s.snap.runSec))).toBeLessThanOrEqual(1);
      expect(Math.abs(s.route.ghost!.advantage - (timeAt(ghost, p) - s.snap.runSec))).toBeLessThanOrEqual(1);
      if (s.fix) {
        // exact on a fresh reading: baseline − ghost = t_ref(p) − t_ghost(p)
        expect(s.route.baseline!.advantage - s.route.ghost!.advantage).toBeCloseTo(timeAt(ref.profile, p) - timeAt(ghost, p), 9);
      }
      if (timeAt(ref.profile, p) > 120) expect(s.route.baseline!.advantage - s.route.ghost!.advantage).toBeGreaterThan(1.9);
    }
    const r = run.summary.route!;
    // on the reference's pace: ≈ level with the baseline, ≈ 30 s behind the ghost
    expect(Math.abs(r.baselineFinalAdvantage as number)).toBeLessThanOrEqual(3);
    expect(Math.abs((r.ghostFinalAdvantage as number) + (finishTime(ref.profile) - target))).toBeLessThanOrEqual(3);
    expect(r.baselineSeries).not.toEqual(r.ghostSeries);
    // the run screen / Live Activity can switch between them; the values stay their own
    const last = run.session.snapshot();
    expect(toLiveActivityPayload(last, 'Loop').comparisonLabel).toBe('GHOST');
    expect(toLiveActivityPayload(last, 'Loop').deltaSec).toBe(last.route!.ghost!.advantage);
    run.session.setPrimary('baseline');
    const switched = run.session.snapshot();
    expect(toLiveActivityPayload(switched, 'Loop').comparisonLabel).toBe('BASELINE');
    expect(toLiveActivityPayload(switched, 'Loop').deltaSec).toBe(last.route!.baseline!.advantage);
    expect(switched.route!.ghost).toEqual(last.route!.ghost);
  });
});

describe('#16 "Poor elevation data does not prevent the core comparison engine from working."', () => {
  it.each(['missing', 'garbage'] as const)('altitude %s: no elevation, and ±30 s advantages still read correctly', (altitude) => {
    const ref = record(HILLS_2K, REF_SPEED, altitude === 'missing' ? 107 : 108, { altitude });
    expect(ref.geometry.elevationReliable).toBe(false);
    expect(ref.geometry.points.every((p) => p.ele === null)).toBe(true);
    expect(ref.climbs).toEqual([]);
    expect(ref.summary.elevation).toBeNull();
    for (const [offset, seed] of [
      [30, 91],
      [-30, 92],
    ] as const) {
      const { cp, live, run } = offsetScenario(ref, offset, { seed, altitude });
      expect(Math.abs(cp.cumulativeDiff - offset)).toBeLessThan(2);
      for (const s of live) expect(Math.abs(s.route.baseline!.advantage - offset)).toBeLessThanOrEqual(3);
      expect(run.summary.elevation).toBeNull();
      expect(run.samples.every((s) => s.route.upcomingClimb === null)).toBe(true);
      expect(run.summary.route!.completed).toBe(true);
    }
  });
});

// --- review focus ------------------------------------------------------------------------------------

describe('Review #1: batched, stale and duplicate fixes', () => {
  it('session ignores duplicate batch', () => {
    const ref = ref2k();
    const run = runOn(ref, { speed: REF_SPEED, seed: 111 });
    const [start, ...rest] = run.events;
    const fixes = rest.filter((e) => e.type === 'fix');
    const finish = rest[rest.length - 1];
    // iOS-style delivery: batches of 10 fixes, each delivered twice, plus a stale re-send of older fixes
    const batched = new RunSession(run.cfg);
    batched.apply(start);
    for (let i = 0; i < fixes.length; i += 10) {
      const batch = fixes.slice(i, i + 10);
      batch.forEach((e) => batched.apply(e));
      const once = batched.snapshot();
      batch.forEach((e) => batched.apply(e));
      fixes.slice(Math.max(0, i - 25), i).forEach((e) => batched.apply(e));
      expect(batched.snapshot()).toEqual(once);
      if (i === 300) expect(once).toEqual(RunSession.replay(run.cfg, [start, ...fixes.slice(0, i + 10)]).snapshot());
    }
    batched.apply(finish);
    expect(batched.snapshot()).toEqual(run.session.snapshot());
    expect(batched.summary()).toEqual(run.summary);
    expect(batched.summary().gps.fixes).toBe(fixes.length);
  });
});

describe('Review #4: finish tapped late, running past the end', () => {
  it('finish time is crossing time, not tap time', () => {
    const ref = ref2k();
    const beyond = makeRoute('straight', { length: 2300 }); // the same line, 300 m longer
    for (const seed of SEEDS) {
      const probe = simulateRun(beyond, { speed: REF_SPEED, startMs: START, noiseM: 3, seed: 120 + seed });
      const crossing = reachSec(probe, 2000, secOf(probe.fixes[probe.fixes.length - 1].t));
      const tap = Math.round(crossing + 40);
      const run = runOn(ref, { points: beyond, speed: REF_SPEED, seed: 120 + seed, finishSec: tap });
      const r = run.summary.route!;
      expect(r.completed).toBe(true);
      expect(Math.abs((r.finishSec as number) - crossing)).toBeLessThanOrEqual(3);
      expect(run.summary.runSec).toBeCloseTo(tap, 9);
      expect(r.baselineFinalAdvantage).toBeCloseTo(finishTime(ref.profile) - (r.finishSec as number), 9);
      // frozen from the crossing on
      const done = run.samples.filter((s) => s.route.finishedSec !== null);
      expect(done.length).toBeGreaterThan(30);
      expect(new Set(done.map((s) => s.route.baseline!.advantage)).size).toBe(1);
      expect(done.every((s) => s.route.progress === s.route.length && s.route.nextCheckpoint === null)).toBe(true);
      expect(run.samples.flatMap((s) => s.cues).filter((c) => c.kind === 'routeComplete')).toHaveLength(1);
    }
  });
});

describe('Replay determinism', () => {
  it('RunSession.replay(config, events) reproduces the live session exactly', () => {
    const ref = ref2k();
    const runs = [
      runOn(ref, { speed: WAVY, seed: 131, target: 640, pauses: [{ fromSec: 250.3, toSec: 290.8 }], stops: [{ atSec: 250, durationSec: 41 }] }),
      runOn(ref, { speed: REF_SPEED, seed: 132, gaps: [{ fromSec: 100, toSec: 140 }], noiseM: 8 }),
      runOn(ref, { speed: constant(2.5), seed: 133, target: 700, finishSec: 400 }),
    ];
    for (const run of runs) {
      const again = RunSession.replay(run.cfg, run.events);
      expect(again.snapshot()).toEqual(run.session.snapshot());
      expect(again.summary()).toEqual(run.summary);
    }
  });
});


