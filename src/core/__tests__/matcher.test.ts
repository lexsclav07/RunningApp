/** @jest-environment node */
import { describe, expect, it } from '@jest/globals';
import { cumulativeDistances, haversine, makeProjection, type XY } from '../geo';
import { DEFAULT_MATCHER_OPTIONS, RouteMatcher } from '../matcher';
import { DEFAULT_SIM_ORIGIN, makeRoute, type SimRoutePoint } from '../sim/routes';
import { simulateRun } from '../sim/trace';
import type { GpsFix, MatchResult, RouteGeometry } from '../types';

const START = Date.UTC(2026, 9, 29, 7, 0, 0);
const SEEDS = [1, 2, 3];
const constant = (v: number) => () => v;
/** Realistic uneven running: 3 m/s ± 0.6 m/s over a 500 m cycle. */
const wavy = (d: number) => 3 + 0.6 * Math.sin((2 * Math.PI * d) / 500);

// --- helpers ------------------------------------------------------------------------------------

/** RouteGeometry straight from simulated route points (no resampling; the matcher is spacing-agnostic). */
function geometryOf(points: readonly SimRoutePoint[]): RouteGeometry {
  const d = cumulativeDistances(points);
  const length = d[d.length - 1];
  return {
    points: points.map((p, i) => ({ lat: p.lat, lon: p.lon, ele: p.ele, d: d[i] })),
    length,
    isLoop: haversine(points[0], points[points.length - 1]) <= 50 && length >= 400,
    elevationReliable: false,
  };
}

/** Route points every ≈ 2 m along straight legs between XY vertices (metres around the sim origin). */
function polyline(vertices: XY[]): { points: SimRoutePoint[]; at(s: number): XY } {
  const proj = makeProjection(DEFAULT_SIM_ORIGIN);
  const xy: XY[] = [vertices[0]];
  for (let i = 1; i < vertices.length; i++) {
    const a = vertices[i - 1];
    const b = vertices[i];
    const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 2));
    for (let k = 1; k <= n; k++) xy.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  const cum = [0];
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i].x - xy[i - 1].x, xy[i].y - xy[i - 1].y));
  const at = (s: number): XY => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const f = Math.max(0, Math.min(1, (s - cum[i - 1]) / (cum[i] - cum[i - 1])));
    return { x: xy[i - 1].x + f * (xy[i].x - xy[i - 1].x), y: xy[i - 1].y + f * (xy[i].y - xy[i - 1].y) };
  };
  return { points: xy.map((p) => ({ ...proj.toLatLon(p.x, p.y), ele: null })), at };
}

interface Sample {
  sec: number;
  /** True route progress, m. */
  truth: number;
  fix: GpsFix | null;
  r: MatchResult;
}

/**
 * Drives the matcher like RunSession does: update() for each fix, then noteTime() on a 1 Hz wall-clock
 * tick (so GPS gaps are seen). `truth(sec)` is the true route progress, `runSec(sec)` the run clock.
 */
function drive(
  m: RouteMatcher,
  fixes: readonly GpsFix[],
  truth: (sec: number) => number,
  runSec: (sec: number) => number = (sec) => sec,
  skip: (sec: number) => boolean = () => false,
  beforeSec?: (sec: number) => void,
): Sample[] {
  const bySec = new Map(fixes.map((f) => [Math.round((f.t - START) / 1000), f]));
  const last = Math.round((fixes[fixes.length - 1].t - START) / 1000);
  const out: Sample[] = [];
  for (let sec = 0; sec <= last; sec++) {
    beforeSec?.(sec);
    const fix = skip(sec) ? null : (bySec.get(sec) ?? null);
    if (fix) m.update(fix, runSec(sec));
    out.push({ sec, truth: truth(sec), fix, r: m.noteTime(START + sec * 1000) });
  }
  return out;
}

interface Tracking {
  maxErr: number;
  decreases: number;
  /** Largest (progress step − (3 × true step + 10 m)) between consecutive fixes; ≤ 0 passes #7. */
  worstStepExcess: number;
}

/** Error statistics over fixes from the first on-route match onwards (optionally only where `include`). */
function tracking(samples: readonly Sample[], include: (s: Sample) => boolean = () => true): Tracking {
  const fixes = samples.filter((s) => s.fix);
  const i0 = fixes.findIndex((s) => s.r.state === 'onRoute');
  expect(i0).toBeGreaterThanOrEqual(0);
  let maxErr = 0;
  let decreases = 0;
  let worstStepExcess = -Infinity;
  for (let i = i0; i < fixes.length; i++) {
    if (include(fixes[i])) maxErr = Math.max(maxErr, Math.abs(fixes[i].r.progress - fixes[i].truth));
    if (i === i0) continue;
    const dp = fixes[i].r.progress - fixes[i - 1].r.progress;
    if (dp < 0) decreases++;
    worstStepExcess = Math.max(worstStepExcess, dp - (3 * Math.abs(fixes[i].truth - fixes[i - 1].truth) + 10));
  }
  return { maxErr, decreases, worstStepExcess };
}

/** Simulates a run along `points` and matches it against the same points as the route. */
function runOnRoute(
  points: readonly SimRoutePoint[],
  o: { noise: number; seed: number; speed?: (d: number) => number; gaps?: { fromSec: number; toSec: number }[] },
) {
  const geometry = geometryOf(points);
  const sim = simulateRun(points, {
    speed: o.speed ?? constant(3),
    startMs: START,
    noiseM: o.noise,
    seed: o.seed,
    gaps: o.gaps,
  });
  const matcher = new RouteMatcher(geometry);
  return { geometry, sim, samples: drive(matcher, sim.fixes, sim.truthAtSec) };
}

const twoLaps = (lapLength: number) => {
  const lap = makeRoute('loop', { length: lapLength });
  return [...lap, ...lap.slice(1)];
};

// --- scenarios (shared by the acceptance tests and the noise stress matrix) -----------------------

/** #7: progress follows truth closely, never decreases, and has no step > 3 × true step + 10 m. */
function jitterScenario(kind: 'straight' | 'loop', noise: number, seed: number): Tracking {
  return tracking(runOnRoute(makeRoute(kind, { length: 2000 }), { noise, seed, speed: wavy }).samples);
}

/** #8: 2 laps of a 1 km loop; returns the progress at the fix nearest the second pass of the start. */
function loopScenario(noise: number, seed: number) {
  const { samples, geometry } = runOnRoute(twoLaps(1000), { noise, seed });
  const fixes = samples.filter((s) => s.fix);
  const atLap = fixes.reduce((a, b) => (Math.abs(b.truth - 1000) < Math.abs(a.truth - 1000) ? b : a));
  const earlyFinish = fixes.some((s) => s.r.atFinish && s.truth < geometry.length - 50);
  return { tracking: tracking(samples), atLap, earlyFinish, last: fixes[fixes.length - 1] };
}

/** #8: figure eight, crossing itself at L/4 and 3L/4. */
function figureEightScenario(noise: number, seed: number) {
  const L = 2000;
  const { samples } = runOnRoute(makeRoute('figureEight', { length: L }), { noise, seed });
  const crossingErr = Math.max(
    ...samples.filter((s) => s.fix && (Math.abs(s.truth - L / 4) < 6 || Math.abs(s.truth - (3 * L) / 4) < 6))
      .map((s) => Math.abs(s.r.progress - s.truth)),
  );
  return { tracking: tracking(samples), crossingErr };
}

/** Review #5: out-and-back; smallest progress seen once the runner is ≥ 15 m into the return leg. */
function outAndBackScenario(noise: number, seed: number) {
  const L = 2000;
  const { samples } = runOnRoute(makeRoute('outAndBack', { length: L }), { noise, seed, speed: wavy });
  const returning = samples.filter((s) => s.fix && s.truth >= L / 2 + 15);
  return { tracking: tracking(samples), minReturnProgress: Math.min(...returning.map((s) => s.r.progress)), L };
}

/** Sharp turns: 1.5 km of 150 m legs 25 m apart joined by 180° switchbacks. */
function hairpinScenario(noise: number, seed: number): Tracking {
  return tracking(runOnRoute(makeRoute('hairpin', { length: 1500 }), { noise, seed }).samples);
}

/**
 * #11: on a 2 km route due north, the runner leaves at 800 m, runs `away` m sideways, 150 m parallel to
 * the route, and comes back at 950 m.
 */
function detourScenario(noise: number, seed: number, away: number) {
  const A = 800;
  const B = 950;
  const route = geometryOf(makeRoute('straight', { length: 2000 }));
  const path = polyline([
    { x: 0, y: 0 },
    { x: 0, y: A },
    { x: away, y: A },
    { x: away, y: B },
    { x: 0, y: B },
    { x: 0, y: 2000 },
  ]);
  const sim = simulateRun(path.points, { speed: constant(3), startMs: START, noiseM: noise, seed });
  const truthXY = (sec: number) => path.at(sim.truthAtSec(sec));
  const samples = drive(new RouteMatcher(route), sim.fixes, (sec) => Math.min(2000, Math.max(0, truthXY(sec).y)));
  const sigma = Math.min(50, Math.max(5, sim.fixes[0].hAcc ?? 20));
  const limit = Math.max(DEFAULT_MATCHER_OPTIONS.offRouteDistance, 2.5 * sigma);
  // moment the true offset first exceeds the off-route limit, and moment the runner is back on the route
  const leftAt = samples.find((s) => truthXY(s.sec).x > limit)!.sec;
  const rejoinedAt = samples.find((s) => s.sec > leftAt && truthXY(s.sec).x < 0.01)!.sec;
  const firstOff = samples.find((s) => s.r.state === 'offRoute');
  // start of the run of consecutive beyond-limit fixes that led to 'offRoute'
  let streakStart = firstOff?.sec ?? 0;
  while (streakStart > 0 && (samples[streakStart - 1].r.offset ?? 0) > limit) streakStart--;
  const off = samples.filter((s) => s.r.state === 'offRoute');
  const onAgainAt = samples.find((s) => s.sec > (firstOff?.sec ?? Infinity) && s.r.state === 'onRoute')?.sec;
  const afterRejoin = samples.filter((s) => s.sec >= rejoinedAt + 5);
  return {
    A,
    leftAt,
    rejoinedAt,
    firstOffAt: firstOff?.sec ?? null,
    confirmedAfterSec: (firstOff?.sec ?? 0) - streakStart,
    frozen: off.map((s) => s.r.progress),
    onAgainAt: onAgainAt ?? null,
    allOnAfterRejoin: afterRejoin.every((s) => s.r.state === 'onRoute'),
    errAfterRejoin: Math.max(...afterRejoin.filter((s) => s.fix).map((s) => Math.abs(s.r.progress - s.truth))),
    onRouteBefore: samples.filter((s) => s.sec < leftAt - 15).every((s) => s.r.state === 'onRoute'),
    tracking: tracking(samples),
  };
}

/** #10: a 30 s GPS gap across a corner of a 2-lap loop. */
function gapScenario(noise: number, seed: number) {
  const gap = { fromSec: 200, toSec: 230 };
  const { samples } = runOnRoute(twoLaps(1000), { noise, seed, gaps: [gap] });
  const during = samples.filter((s) => s.sec > gap.fromSec && s.sec < gap.toSec);
  const after = samples.filter((s) => s.fix && s.sec >= gap.toSec);
  const third = after[2];
  return {
    lostDuringGap: during.some((s) => s.r.state === 'lost'),
    lostWithin: during.find((s) => s.r.state === 'lost')!.sec - gap.fromSec,
    third,
    thirdErr: Math.abs(third.r.progress - third.truth),
    laterErr: Math.max(...after.slice(3).map((s) => Math.abs(s.r.progress - s.truth))),
    tracking: tracking(samples),
  };
}

/** Review #3: the runner starts 300 m along the route (mid-route) and runs on from there. */
function farStartScenario(noise: number, seed: number) {
  const route = makeRoute('straight', { length: 2000 });
  const cum = cumulativeDistances(route);
  const rest = route.filter((_, i) => cum[i] >= 300 - 1e-6);
  const sim = simulateRun(rest, { speed: constant(3), startMs: START, noiseM: noise, seed });
  return drive(new RouteMatcher(geometryOf(route)), sim.fixes, (sec) => 300 + sim.truthAtSec(sec));
}

// --- tests ----------------------------------------------------------------------------------------

describe('RouteMatcher basics', () => {
  const straight = geometryOf(makeRoute('straight', { length: 1000 }));
  const fixAt = (sec: number, y: number, extra: Partial<GpsFix> = {}): GpsFix => {
    const ll = makeProjection(DEFAULT_SIM_ORIGIN).toLatLon(0, y);
    return { t: START + sec * 1000, lat: ll.lat, lon: ll.lon, hAcc: 5, alt: null, vAcc: null, speed: 3, course: 0, ...extra };
  };

  it('exposes the plan defaults', () => {
    expect(DEFAULT_MATCHER_OPTIONS).toEqual({
      maxSpeed: 7,
      offRouteDistance: 35,
      offRouteConfirmSec: 6,
      backTolerance: 15,
      startWindow: 150,
      lostAfterSec: 10,
      finishTolerance: 20,
    });
  });

  it('starts acquiring with no progress', () => {
    expect(new RouteMatcher(straight).current()).toEqual({ state: 'acquiring', progress: 0, offset: null, atFinish: false });
  });

  it('acquires at the start and tracks an ideal trace exactly to the finish', () => {
    const sim = simulateRun(makeRoute('straight', { length: 1000 }), { speed: constant(3), startMs: START, noiseM: 0 });
    const m = new RouteMatcher(straight);
    const samples = drive(m, sim.fixes, sim.truthAtSec);
    expect(samples[0].r.state).toBe('onRoute');
    for (const s of samples) {
      expect(Math.abs(s.r.progress - s.truth)).toBeLessThan(1);
      expect(s.r.atFinish).toBe(s.r.progress >= 1000 - DEFAULT_MATCHER_OPTIONS.finishTolerance);
    }
    expect(m.current().atFinish).toBe(true);
    expect(m.current().progress).toBeCloseTo(1000, 0);
  });

  it('ignores duplicate and out-of-order fixes', () => {
    const m = new RouteMatcher(straight);
    m.update(fixAt(0, 0), 0);
    m.update(fixAt(1, 3), 1);
    const before = m.update(fixAt(2, 6), 2);
    expect(m.update(fixAt(2, 6), 2)).toEqual(before);
    expect(m.update(fixAt(1, 40), 1)).toEqual(before);
    expect(m.current()).toEqual(before);
  });

  it('noteTime reports lost only after lostAfterSec without a fix, and clears the offset', () => {
    const m = new RouteMatcher(straight);
    m.update(fixAt(0, 0), 0);
    expect(m.noteTime(START + 10_000).state).toBe('onRoute');
    const lost = m.noteTime(START + 10_001);
    expect(lost.state).toBe('lost');
    expect(lost.offset).toBeNull();
    expect(m.update(fixAt(12, 30), 12).state).toBe('onRoute');
  });

  it('never reports lost before the first fix', () => {
    expect(new RouteMatcher(straight).noteTime(START + 60_000).state).toBe('acquiring');
  });

  it('GPS lost before acquisition goes back to acquiring (not offRoute) when far fixes return', () => {
    const m = new RouteMatcher(straight);
    expect(m.update(fixAt(0, 400), 0).state).toBe('acquiring');
    expect(m.noteTime(START + 20_000).state).toBe('lost');
    for (let sec = 21; sec < 40; sec++) expect(m.update(fixAt(sec, 400 + sec), sec).state).toBe('acquiring');
    expect(m.update(fixAt(40, 5), 40).state).toBe('onRoute');
  });

  it('honours custom options (a wider start window acquires mid-route)', () => {
    const m = new RouteMatcher(straight, { startWindow: 400 });
    const r = m.update(fixAt(0, 300), 0);
    expect(r.state).toBe('onRoute');
    expect(r.progress).toBeCloseTo(300, 0);
    expect(new RouteMatcher(straight).update(fixAt(0, 300), 0).state).toBe('acquiring');
  });

  it('a stationary runner (5 min stop, 8 m noise) does not accumulate progress', () => {
    const route = makeRoute('straight', { length: 2000 });
    for (const seed of SEEDS) {
      const sim = simulateRun(route, {
        speed: constant(3),
        startMs: START,
        noiseM: 8,
        seed,
        stops: [{ atSec: 200, durationSec: 300 }],
      });
      const samples = drive(new RouteMatcher(geometryOf(route)), sim.fixes, sim.truthAtSec);
      const stop = samples.filter((s) => s.fix && s.sec >= 200 && s.sec < 500);
      const gained = stop[stop.length - 1].r.progress - stop[0].r.progress;
      expect(gained).toBeLessThan(20);
      expect(Math.max(...stop.map((s) => s.r.progress - s.truth))).toBeLessThan(25);
      expect(stop.every((s) => s.r.state === 'onRoute')).toBe(true);
      expect(tracking(samples).maxErr).toBeLessThan(25);
    }
  });

  it('resetMotion on resume: no jump from a 2-minute pause, then tracks again', () => {
    const route = makeRoute('straight', { length: 2000 });
    for (const seed of SEEDS) {
      // the runner stops at 200 s for 120 s, while the run is paused; fixes during the pause are not matched
      const sim = simulateRun(route, {
        speed: wavy,
        startMs: START,
        noiseM: 5,
        seed,
        stops: [{ atSec: 200, durationSec: 120 }],
      });
      const m = new RouteMatcher(geometryOf(route));
      const paused = (sec: number) => sec > 200 && sec < 320;
      const runSec = (sec: number) => (sec <= 200 ? sec : sec < 320 ? 200 : sec - 120);
      const samples = drive(m, sim.fixes, sim.truthAtSec, runSec, paused, (sec) => {
        if (sec === 320) m.resetMotion();
      });
      const t = tracking(samples, (s) => !paused(s.sec));
      expect(t.maxErr).toBeLessThan(15);
      expect(t.decreases).toBe(0);
      expect(t.worstStepExcess).toBeLessThanOrEqual(0);
      const resumed = samples.find((s) => s.sec === 321)!;
      expect(resumed.r.state).toBe('onRoute');
    }
  });
});

describe('spec acceptance (5 m noise, 1 Hz, seeded)', () => {
  it.each(['straight', 'loop'] as const)(
    '#7 GPS jitter: 5 m noise on a 2 km %s route stays within 15 m of truth, never decreases, no step > 3 × true step + 10 m',
    (kind) => {
      for (const seed of SEEDS) {
        const t = jitterScenario(kind, 5, seed);
        expect(t.maxErr).toBeLessThanOrEqual(15);
        expect(t.decreases).toBe(0);
        expect(t.worstStepExcess).toBeLessThanOrEqual(0);
      }
    },
  );

  it('#8 loop route: 2 laps of a 1 km loop match the second pass of the start at 1000 ± 20 m, not 0', () => {
    for (const seed of SEEDS) {
      const r = loopScenario(5, seed);
      expect(Math.abs(r.atLap.truth - 1000)).toBeLessThan(3);
      expect(Math.abs(r.atLap.r.progress - 1000)).toBeLessThanOrEqual(20);
      expect(r.earlyFinish).toBe(false);
      expect(r.last.r.atFinish).toBe(true);
      expect(r.tracking.maxErr).toBeLessThanOrEqual(15);
      expect(r.tracking.decreases).toBe(0);
    }
  });

  it('#8 figure eight: the crossing point maps to the correct branch', () => {
    for (const seed of SEEDS) {
      const r = figureEightScenario(5, seed);
      expect(r.crossingErr).toBeLessThanOrEqual(20);
      expect(r.tracking.maxErr).toBeLessThanOrEqual(15);
      expect(r.tracking.decreases).toBe(0);
    }
  });

  it('Review #5 out-and-back return leg: progress stays > length/2 throughout the return', () => {
    for (const seed of SEEDS) {
      const r = outAndBackScenario(5, seed);
      expect(r.minReturnProgress).toBeGreaterThan(r.L / 2);
      expect(r.tracking.maxErr).toBeLessThanOrEqual(15);
      expect(r.tracking.decreases).toBe(0);
    }
  });

  it('#11 route deviation: a 150 m detour 60 m off the route → offRoute within confirm + 2 s, progress frozen, onRoute within 5 s of rejoining', () => {
    for (const seed of SEEDS) {
      const r = detourScenario(5, seed, 60);
      expect(r.onRouteBefore).toBe(true);
      expect(r.firstOffAt).not.toBeNull();
      expect(r.firstOffAt!).toBeLessThanOrEqual(r.leftAt + DEFAULT_MATCHER_OPTIONS.offRouteConfirmSec + 2);
      expect(r.confirmedAfterSec).toBe(DEFAULT_MATCHER_OPTIONS.offRouteConfirmSec);
      // frozen: one value for the whole off-route spell, near where the runner left the route
      expect(new Set(r.frozen).size).toBe(1);
      expect(r.frozen[0]).toBeGreaterThan(r.A - 15);
      expect(r.frozen[0]).toBeLessThan(r.A + 20);
      expect(r.onAgainAt!).toBeLessThanOrEqual(r.rejoinedAt + 5);
      expect(r.allOnAfterRejoin).toBe(true);
      expect(r.errAfterRejoin).toBeLessThanOrEqual(15);
      expect(r.tracking.decreases).toBe(0);
    }
  });

  it('#10 temporary GPS loss: a 30 s gap → lost, then re-acquires the correct progress (±20 m) within 3 fixes', () => {
    for (const seed of SEEDS) {
      const r = gapScenario(5, seed);
      expect(r.lostDuringGap).toBe(true);
      expect(r.lostWithin).toBeLessThanOrEqual(DEFAULT_MATCHER_OPTIONS.lostAfterSec + 1);
      expect(r.third.r.state).toBe('onRoute');
      expect(r.thirdErr).toBeLessThanOrEqual(20);
      expect(r.laterErr).toBeLessThanOrEqual(15);
      expect(r.tracking.decreases).toBe(0);
    }
  });

  it('Review #3 starting 300 m from the start stays acquiring', () => {
    for (const seed of SEEDS) {
      const samples = farStartScenario(5, seed);
      for (const s of samples) {
        expect(s.r.state).toBe('acquiring');
        expect(s.r.progress).toBe(0);
        expect(s.r.atFinish).toBe(false);
      }
      expect(samples[0].r.offset!).toBeGreaterThan(100);
    }
  });

  it('Review #3 a runner who starts 300 m away acquires on reaching the start, then tracks', () => {
    for (const seed of SEEDS) {
      const path = polyline([{ x: 300, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 2000 }]);
      const sim = simulateRun(path.points, { speed: constant(3), startMs: START, noiseM: 5, seed });
      const truthXY = (sec: number) => path.at(sim.truthAtSec(sec));
      const samples = drive(
        new RouteMatcher(geometryOf(makeRoute('straight', { length: 2000 }))),
        sim.fixes,
        (sec) => Math.max(0, truthXY(sec).y),
      );
      // jogging west along y = 0 toward the start, still more than 60 m away
      const approaching = samples.filter((s) => truthXY(s.sec).y < 1e-6 && truthXY(s.sec).x > 60);
      expect(approaching.length).toBeGreaterThan(60);
      expect(approaching.every((s) => s.r.state === 'acquiring' && s.r.progress === 0)).toBe(true);
      const t = tracking(samples);
      expect(t.maxErr).toBeLessThanOrEqual(15);
      expect(samples[samples.length - 1].r.atFinish).toBe(true);
    }
  });

  it('sharp hairpin turns do not jump across to the other leg', () => {
    for (const seed of SEEDS) {
      const t = hairpinScenario(5, seed);
      // the next leg is 25 m away but ≥ 39 m further along the route: a jump shows as a large error
      expect(t.maxErr).toBeLessThanOrEqual(15);
      expect(t.decreases).toBe(0);
      expect(t.worstStepExcess).toBeLessThanOrEqual(0);
    }
  });
});

/**
 * Stress matrix: the same scenarios at 3, 8 and 15 m RMS noise (reported hAcc 5, 12, 22.5 m).
 * The simulated error is a slowly varying bias that no matcher can remove: on straight routes its
 * along-route part alone peaks near 2.2 × noise, and the matcher's error tracks it. Bounds are therefore
 * 3 × noise (the plan's 15 m at 5 m) and max(20, 3 × noise) where the plan says ±20 m.
 * Off-route detection is late by the time a lateral bias takes to cross at 3 m/s sideways (≈ noise/2 s
 * at 2 sd), and at 15 m the off-route limit is 2.5σ = 56 m, so that detour goes 100 m out instead of 60.
 */
const STRESS = [
  { noise: 3, detourAway: 60, offSlack: 2 },
  { noise: 8, detourAway: 60, offSlack: 4 },
  { noise: 15, detourAway: 100, offSlack: 8 },
].map((s) => ({ ...s, maxErr: 3 * s.noise, crossErr: Math.max(20, 3 * s.noise) }));
const STRESS_SEEDS = [11, 12, 13];

describe.each(STRESS)('stress at $noise m noise', ({ noise, maxErr, crossErr, detourAway, offSlack }) => {
  it('jitter on straight and loop routes', () => {
    for (const seed of STRESS_SEEDS) {
      for (const kind of ['straight', 'loop'] as const) {
        const t = jitterScenario(kind, noise, seed);
        expect(t.maxErr).toBeLessThanOrEqual(maxErr);
        expect(t.decreases).toBe(0);
        expect(t.worstStepExcess).toBeLessThanOrEqual(0);
      }
    }
  });

  it('loop second pass and figure-eight crossing pick the right occurrence', () => {
    for (const seed of STRESS_SEEDS) {
      const loop = loopScenario(noise, seed);
      expect(Math.abs(loop.atLap.r.progress - 1000)).toBeLessThanOrEqual(crossErr);
      expect(loop.earlyFinish).toBe(false);
      expect(loop.tracking.maxErr).toBeLessThanOrEqual(maxErr);
      const eight = figureEightScenario(noise, seed);
      expect(eight.crossingErr).toBeLessThanOrEqual(crossErr);
      expect(eight.tracking.maxErr).toBeLessThanOrEqual(maxErr);
    }
  });

  it('out-and-back return leg and hairpins', () => {
    for (const seed of STRESS_SEEDS) {
      const oab = outAndBackScenario(noise, seed);
      expect(oab.minReturnProgress).toBeGreaterThan(oab.L / 2);
      expect(oab.tracking.maxErr).toBeLessThanOrEqual(maxErr);
      const hp = hairpinScenario(noise, seed);
      expect(hp.maxErr).toBeLessThanOrEqual(maxErr);
      expect(hp.decreases).toBe(0);
    }
  });

  it('detour is flagged off route and progress resumes after rejoining', () => {
    for (const seed of STRESS_SEEDS) {
      const r = detourScenario(noise, seed, detourAway);
      expect(r.firstOffAt).not.toBeNull();
      expect(r.firstOffAt!).toBeLessThanOrEqual(r.leftAt + DEFAULT_MATCHER_OPTIONS.offRouteConfirmSec + offSlack);
      expect(r.confirmedAfterSec).toBe(DEFAULT_MATCHER_OPTIONS.offRouteConfirmSec);
      expect(new Set(r.frozen).size).toBe(1);
      expect(Math.abs(r.frozen[0] - r.A)).toBeLessThanOrEqual(maxErr);
      expect(r.onAgainAt!).toBeLessThanOrEqual(r.rejoinedAt + 5);
      expect(r.allOnAfterRejoin).toBe(true);
      expect(r.errAfterRejoin).toBeLessThanOrEqual(maxErr);
    }
  });

  it('GPS gap → lost, then re-acquires within 3 fixes', () => {
    for (const seed of STRESS_SEEDS) {
      const r = gapScenario(noise, seed);
      expect(r.lostDuringGap).toBe(true);
      expect(r.third.r.state).toBe('onRoute');
      expect(r.thirdErr).toBeLessThanOrEqual(crossErr);
      expect(r.laterErr).toBeLessThanOrEqual(maxErr);
    }
  });

  it('starting 300 m along the route stays acquiring', () => {
    for (const seed of STRESS_SEEDS) {
      expect(farStartScenario(noise, seed).every((s) => s.r.state === 'acquiring' && s.r.progress === 0)).toBe(true);
    }
  });
});
