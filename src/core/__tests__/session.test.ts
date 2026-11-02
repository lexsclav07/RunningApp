/** @jest-environment node */
import { describe, expect, it } from '@jest/globals';
import { cumulativeDistances, makeProjection } from '../geo';
import { scaleProfile, timeAt } from '../profile';
import { activeFixes, buildRouteFromRecording, computeRunProfile, MIN_ROUTE_LENGTH } from '../route-builder';
import { primaryReading, RunSession, SERIES_MAX_POINTS } from '../session';
import { toEvents } from '../sim/events';
import { DEFAULT_SIM_ORIGIN, makeRoute, twoHills } from '../sim/routes';
import { simulateRun } from '../sim/trace';
import type { GpsFix, LiveSnapshot, RouteGeometry, SessionConfig, SessionEvent, TimeProfile } from '../types';

const START = Date.UTC(2026, 9, 29, 7, 0, 0);
const proj = makeProjection(DEFAULT_SIM_ORIGIN);
const at = (sec: number) => START + sec * 1000;

/** Straight route due north from the sim origin (points every ≈ 2 m), used as-is as the geometry. */
function straight(length: number): RouteGeometry {
  const pts = makeRoute('straight', { length });
  const d = cumulativeDistances(pts);
  return {
    points: pts.map((p, i) => ({ lat: p.lat, lon: p.lon, ele: null, d: d[i] })),
    length: d[d.length - 1],
    isLoop: false,
    elevationReliable: false,
  };
}
const ROUTE = straight(1000);
const LEN = ROUTE.length;
/** Reference: a constant 3 m/s run (≈ 333 s). */
const REF: TimeProfile = { d: [0, LEN], t: [0, LEN / 3] };

/** A fix `sec` s after START, `north` m along the route and `east` m beside it (ideal, 5 m accuracy). */
function fix(sec: number, north: number, o: Partial<GpsFix> & { east?: number } = {}): GpsFix {
  const { east = 0, ...rest } = o;
  const p = proj.toLatLon(east, north);
  return { t: at(sec), lat: p.lat, lon: p.lon, hAcc: 5, alt: null, vAcc: null, speed: 3, course: 0, ...rest };
}
/** Ideal fixes every second from sec a to b inclusive at `speed` m/s, at d0 + speed·(sec − a). */
function steady(a: number, b: number, speed: number, d0: number): GpsFix[] {
  const out: GpsFix[] = [];
  for (let s = a; s <= b; s++) out.push(fix(s, d0 + speed * (s - a), { speed }));
  return out;
}
const fixEvents = (fixes: GpsFix[]): SessionEvent[] => fixes.map((f) => ({ type: 'fix', fix: f }));
const routeConfig = (o: Partial<SessionConfig> = {}): SessionConfig => ({
  mode: 'route',
  route: { geometry: ROUTE, climbs: [] },
  reference: REF,
  ...o,
});
const replay = (cfg: SessionConfig, events: SessionEvent[]) => RunSession.replay(cfg, events);
const route = (s: LiveSnapshot) => {
  if (!s.route) throw new Error('expected a route block');
  return s.route;
};

describe('RunSession lifecycle and run clock', () => {
  it('is idle before the start event', () => {
    const s = new RunSession(routeConfig()).snapshot();
    expect(s.phase).toBe('idle');
    expect(s.startedAt).toBeNull();
    expect(s.runSec).toBe(0);
    expect(s.distance).toBe(0);
    expect(route(s).match).toBe('acquiring');
    expect(route(s).progress).toBe(0);
    expect(route(s).baseline).toBeNull();
    expect(s.gps.quality).toBe('none');
  });

  it('run time excludes manual pauses; wall time includes them', () => {
    const s = new RunSession(routeConfig());
    const events: SessionEvent[] = [
      { type: 'start', t: at(0) },
      ...fixEvents(steady(0, 100, 3, 0)),
      { type: 'pause', t: at(100.5) },
    ];
    events.forEach((e) => s.apply(e));
    const paused = s.tick(at(150));
    expect(paused.phase).toBe('paused');
    expect(paused.runSec).toBeCloseTo(100.5, 9);
    expect(paused.wallSec).toBeCloseTo(150, 9);
    s.apply({ type: 'resume', t: at(220.5) });
    fixEvents(steady(221, 300, 3, 303)).forEach((e) => s.apply(e));
    const running = s.tick(at(300));
    expect(running.phase).toBe('running');
    expect(running.runSec).toBeCloseTo(180, 9);
    expect(running.wallSec).toBeCloseTo(300, 9);
    s.apply({ type: 'finish', t: at(301) });
    const sum = s.summary();
    expect(sum.pauses).toEqual([{ start: at(100.5), end: at(220.5) }]);
    expect(sum.runSec).toBeCloseTo(181, 9);
    expect(sum.wallSec).toBeCloseTo(301, 9);
    expect(sum.startedAt).toBe(at(0));
    expect(sum.endedAt).toBe(at(301));
  });

  it('fixes while paused update GPS quality only', () => {
    const s = replay(routeConfig(), [
      { type: 'start', t: at(0) },
      ...fixEvents(steady(0, 60, 3, 0)),
      { type: 'pause', t: at(60.5) },
    ]);
    const before = s.snapshot();
    // walking on 60 m during the pause with poor accuracy
    for (let k = 61; k <= 120; k++) s.apply({ type: 'fix', fix: fix(k, 180 + (k - 60), { hAcc: 30, speed: 1 }) });
    const after = s.tick(at(120));
    expect(after.distance).toBe(before.distance);
    expect(route(after).progress).toBe(route(before).progress);
    expect(route(after).baseline).toEqual(route(before).baseline);
    expect(after.movingSec).toBe(before.movingSec);
    expect(after.gps.quality).toBe('poor');
    expect(after.gps.accuracy).toBe(30);
    expect(after.gps.lastFixAgeSec).toBe(0);
    expect(after.paceSecPerKm).toBeNull();
  });

  it('resume resets the distance anchor, the pace estimator and the matcher motion', () => {
    const s = replay(routeConfig(), [
      { type: 'start', t: at(0) },
      ...fixEvents(steady(0, 60, 3, 0)),
      { type: 'pause', t: at(60.5) },
      ...fixEvents(steady(61, 120, 1, 181)), // walks 60 m while paused
      { type: 'resume', t: at(120.5) },
    ]);
    const atResume = s.snapshot();
    expect(atResume.paceSecPerKm).toBeNull();
    fixEvents(steady(121, 200, 3, 241)).forEach((e) => s.apply(e));
    const later = s.tick(at(200));
    // 180 m before the pause + 237 m after it (± two 3 m anchor steps); the 60 m walked while paused is not run
    expect(Math.abs(later.distance - (180 + 237))).toBeLessThanOrEqual(6.5);
    expect(later.paceSecPerKm).not.toBeNull();
    expect(Math.abs((later.paceSecPerKm as number) - 1000 / 3)).toBeLessThan(5);
    // route progress follows where the runner is (it re-acquires further along), never backwards
    expect(Math.abs(route(later).progress - 478)).toBeLessThan(5);
  });

  it('drops duplicate and out-of-order fixes (t ≤ the last processed fix)', () => {
    const base: SessionEvent[] = [{ type: 'start', t: at(0) }, ...fixEvents(steady(0, 50, 3, 0))];
    const noisy: SessionEvent[] = [
      ...base,
      ...fixEvents(steady(20, 50, 3, 60)), // the same batch again
      { type: 'fix', fix: fix(30.5, 500) }, // late, out of order (and a teleport if accepted)
      { type: 'fix', fix: fix(50, 400) }, // same t as the last fix
    ];
    const a = replay(routeConfig(), base);
    const b = replay(routeConfig(), noisy);
    expect(b.snapshot()).toEqual(a.snapshot());
    expect(b.summary()).toEqual(a.summary());
  });

  it('ignores events after the finish; a finish while paused closes the pause', () => {
    const s = replay(routeConfig(), [
      { type: 'start', t: at(0) },
      ...fixEvents(steady(0, 30, 3, 0)),
      { type: 'pause', t: at(30.5) },
      { type: 'finish', t: at(40) },
      ...fixEvents(steady(41, 60, 3, 93)),
      { type: 'resume', t: at(61) },
    ]);
    const snap = s.tick(at(100));
    expect(snap.phase).toBe('finished');
    expect(snap.runSec).toBeCloseTo(30.5, 9);
    expect(snap.wallSec).toBeCloseTo(40, 9);
    expect(Math.abs(snap.distance - 90)).toBeLessThanOrEqual(3.5);
    expect(s.summary().pauses).toEqual([{ start: at(30.5), end: at(40) }]);
  });

  it('ignores a second start, a pause while paused and a resume while running', () => {
    const a = replay(routeConfig(), [{ type: 'start', t: at(0) }, ...fixEvents(steady(0, 20, 3, 0))]);
    const b = replay(routeConfig(), [
      { type: 'start', t: at(0) },
      { type: 'resume', t: at(0) },
      ...fixEvents(steady(0, 20, 3, 0)),
      { type: 'start', t: at(20) },
    ]);
    expect(b.snapshot()).toEqual(a.snapshot());
  });

  it('record mode has no route block and still tracks distance, pace and time', () => {
    const s = replay({ mode: 'record' }, [{ type: 'start', t: at(0) }, ...fixEvents(steady(0, 100, 3, 0))]);
    const snap = s.snapshot();
    expect(snap.mode).toBe('record');
    expect(snap.route).toBeNull();
    expect(Math.abs(snap.distance - 300)).toBeLessThanOrEqual(3.5); // credited in ≈ 3 m anchor steps
    expect(Math.abs((snap.paceSecPerKm as number) - 1000 / 3)).toBeLessThan(5);
    expect(snap.avgPaceSecPerKm).toBeCloseTo((snap.runSec / snap.distance) * 1000, 9);
    expect(s.summary().route).toBeNull();
  });

  it('route mode requires a route and a reference', () => {
    expect(() => new RunSession({ mode: 'route', route: { geometry: ROUTE, climbs: [] } })).toThrow();
    expect(() => new RunSession({ mode: 'route', reference: REF })).toThrow();
  });

  it('summary() needs a started run', () => {
    expect(() => new RunSession({ mode: 'record' }).summary()).toThrow();
  });

  it('moving time excludes standing still', () => {
    const fixes = [
      ...steady(0, 60, 3, 0),
      ...Array.from({ length: 60 }, (_, k) => fix(61 + k, 180, { speed: 0, course: -1 })),
      ...steady(121, 180, 3, 183),
    ];
    const s = replay({ mode: 'record' }, [{ type: 'start', t: at(0) }, ...fixEvents(fixes)]);
    const snap = s.snapshot();
    expect(snap.runSec).toBe(180);
    expect(snap.movingSec).toBeGreaterThanOrEqual(118);
    expect(snap.movingSec).toBeLessThanOrEqual(122);
  });
});

describe('RunSession route comparisons', () => {
  it('baseline and ghost advantages follow t_profile(progress) − runSec on matched fixes', () => {
    const target = 300;
    const ghost = scaleProfile(REF, target);
    const s = new RunSession(routeConfig({ targetFinishSec: target }));
    s.apply({ type: 'start', t: at(0) });
    let checked = 0;
    for (const f of steady(0, 250, 3.3, 0)) {
      s.apply({ type: 'fix', fix: f });
      const snap = s.snapshot();
      const r = route(snap);
      if (r.match !== 'onRoute' || r.finishedSec !== null) continue;
      expect(r.baseline!.advantage).toBeCloseTo(timeAt(REF, r.progress) - snap.runSec, 9);
      expect(r.ghost!.advantage).toBeCloseTo(timeAt(ghost, r.progress) - snap.runSec, 9);
      expect(r.ghost!.targetFinishSec).toBe(target);
      checked++;
    }
    expect(checked).toBeGreaterThan(200);
    const r = route(s.snapshot());
    expect(r.baseline!.status).toBe('ahead');
    expect(r.ghost!.advantage).not.toBeCloseTo(r.baseline!.advantage, 0);
  });

  it('has no comparison before acquisition (head to start)', () => {
    const s = replay(routeConfig({ targetFinishSec: 300 }), [
      { type: 'start', t: at(0) },
      ...fixEvents(Array.from({ length: 30 }, (_, k) => fix(k, 0, { east: 300 - 2 * k, course: 270, speed: 2 }))),
    ]);
    const snap = s.snapshot();
    expect(snap.gps.quality).toBe('good'); // the fixes did arrive
    expect(snap.distance).toBeGreaterThan(50);
    const r = route(snap);
    expect(r.match).toBe('acquiring');
    expect(r.progress).toBe(0);
    expect(r.baseline).toBeNull();
    expect(r.ghost).toBeNull();
    expect(r.required).toBeNull();
    expect(r.projectedFinishSec).toBeNull();
    expect(r.nextCheckpoint).toMatchObject({ index: 0, d: 100, distanceTo: 100 });
  });

  it('holds comparisons while off route, then resumes them', () => {
    const fixes = [
      ...steady(0, 100, 3, 0), // to 300 m
      ...Array.from({ length: 30 }, (_, k) => fix(101 + k, 300, { east: 3 * (k + 1), course: 90 })), // out to 90 m east
      ...Array.from({ length: 30 }, (_, k) => fix(131 + k, 300, { east: 87 - 3 * k, course: 270 })), // back
      ...steady(161, 250, 3, 303),
    ];
    const s = new RunSession(routeConfig());
    s.apply({ type: 'start', t: at(0) });
    const snaps: LiveSnapshot[] = [];
    for (const f of fixes) {
      s.apply({ type: 'fix', fix: f });
      snaps.push(s.snapshot());
    }
    const off = snaps.filter((x) => route(x).match === 'offRoute');
    expect(off.length).toBeGreaterThan(20);
    // held: one baseline value and one progress for the whole spell, although run time advances
    expect(new Set(off.map((x) => route(x).baseline!.advantage)).size).toBe(1);
    expect(new Set(off.map((x) => route(x).progress)).size).toBe(1);
    // the fixes beyond the off-route limit but before confirmation are not used either
    const firstBeyond = snaps.findIndex((x) => (route(x).offset ?? 0) > 35);
    const firstOff = snaps.indexOf(off[0]);
    expect(route(snaps[firstOff]).baseline).toEqual(route(snaps[firstBeyond - 1]).baseline);
    const last = snaps[snaps.length - 1];
    expect(route(last).match).toBe('onRoute');
    expect(route(last).baseline!.advantage).not.toBe(route(off[0]).baseline!.advantage);
    expect(s.summary().route!.offRouteSec).toBeGreaterThan(20);
  });

  it('finish time is the extrapolated crossing time; comparisons freeze there', () => {
    // 3.3 m/s past the end of the route (truth crosses at LEN / 3.3 s); finish tapped 40 s later
    const crossing = LEN / 3.3;
    const s = new RunSession(routeConfig({ targetFinishSec: 320 }));
    s.apply({ type: 'start', t: at(0) });
    let frozen: LiveSnapshot | null = null;
    for (const f of steady(0, Math.round(crossing + 40), 3.3, 0)) {
      s.apply({ type: 'fix', fix: f });
      const snap = s.snapshot();
      if (route(snap).finishedSec === null) continue;
      if (!frozen) frozen = snap;
      const r = route(snap);
      expect(r.baseline).toEqual(route(frozen).baseline);
      expect(r.ghost).toEqual(route(frozen).ghost);
      expect(r.lastSplit).toEqual(route(frozen).lastSplit);
      expect(r.progress).toBe(LEN);
      expect(r.remaining).toBe(0);
      expect(r.nextCheckpoint).toBeNull();
    }
    s.apply({ type: 'finish', t: at(Math.round(crossing + 40)) });
    const r = route(s.snapshot());
    expect(Math.abs((r.finishedSec as number) - crossing)).toBeLessThan(0.5);
    expect(r.baseline!.advantage).toBeCloseTo(LEN / 3 - (r.finishedSec as number), 9);
    expect(r.ghost!.advantage).toBeCloseTo(320 - (r.finishedSec as number), 9);
    expect(r.projectedFinishSec).toBe(r.finishedSec);
    expect(r.lastSplit!.d).toBe(LEN);
    expect(r.lastSplit!.actualElapsed).toBe(r.finishedSec);
    const sum = s.summary();
    expect(sum.runSec).toBeCloseTo(Math.round(crossing + 40), 9);
    expect(sum.route!.completed).toBe(true);
    expect(sum.route!.finishSec).toBe(r.finishedSec);
    expect(sum.route!.profile.d[sum.route!.profile.d.length - 1]).toBe(LEN);
    expect(sum.route!.profile.t[sum.route!.profile.t.length - 1]).toBe(r.finishedSec);
    expect(sum.route!.baselineFinalAdvantage).toBe(r.baseline!.advantage);
    expect(sum.route!.ghostFinalAdvantage).toBe(r.ghost!.advantage);
    expect(sum.route!.splits.map((x) => x.d)).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, LEN]);
    // distance keeps counting what was actually run after the route end
    expect(sum.distance).toBeGreaterThan(LEN + 100);
  });

  it('an unfinished route gives completed = false and a partial profile', () => {
    const s = replay(routeConfig(), [
      { type: 'start', t: at(0) },
      ...fixEvents(steady(0, 100, 3, 0)),
      { type: 'finish', t: at(101) },
    ]);
    const r = s.summary().route!;
    expect(r.completed).toBe(false);
    expect(r.finishSec).toBeNull();
    expect(r.profile.d[0]).toBe(0);
    expect(r.profile.t[0]).toBe(0);
    expect(r.profile.d[r.profile.d.length - 1]).toBeLessThan(310);
    expect(r.profile.d[r.profile.d.length - 1]).toBeGreaterThan(290);
  });

  it('GPS lost: after 10 s without fixes the snapshot reads lost, GPS none and unreliable', () => {
    const s = replay(routeConfig(), [{ type: 'start', t: at(0) }, ...fixEvents(steady(0, 60, 3, 0))]);
    const ok = s.tick(at(60.5));
    expect(route(ok).reliable).toBe(true);
    expect(ok.gps.quality).toBe('good');
    const stale = s.tick(at(66));
    expect(route(stale).reliable).toBe(false); // fix 6 s old
    expect(route(stale).match).toBe('onRoute');
    const lost = s.tick(at(71));
    expect(route(lost).match).toBe('lost');
    expect(route(lost).offset).toBeNull();
    expect(lost.gps.quality).toBe('none');
    expect(lost.gps.lastFixAgeSec).toBe(11);
    expect(lost.paceSecPerKm).toBeNull();
    expect(route(lost).baseline).toEqual(route(ok).baseline); // held
  });

  it('splits and checkpoints use the ghost when a target exists, else the reference', () => {
    const withGhost = replay(routeConfig({ targetFinishSec: 300 }), [
      { type: 'start', t: at(0) },
      ...fixEvents(steady(0, 70, 3, 0)),
    ]);
    const k = 300 / (LEN / 3);
    const r = route(withGhost.snapshot());
    expect(r.lastSplit!.d).toBe(200);
    expect(r.lastSplit!.targetElapsed).toBeCloseTo((200 / 3) * k, 6);
    expect(r.lastSplit!.referenceElapsed).toBeCloseTo(200 / 3, 6);
    expect(r.nextCheckpoint!.d).toBe(300);
    expect(r.nextCheckpoint!.distanceTo).toBeCloseTo(300 - r.progress, 9);
    expect(r.nextCheckpoint!.targetElapsed).toBeCloseTo(100 * k, 6);
    expect(r.nextCheckpoint!.targetSplit).toBeCloseTo((100 / 3) * k, 6);
    expect(r.required).not.toBeNull();

    const plain = route(replay(routeConfig(), [{ type: 'start', t: at(0) }, ...fixEvents(steady(0, 70, 3, 0))]).snapshot());
    expect(plain.lastSplit!.targetElapsed).toBeCloseTo(200 / 3, 6);
    expect(plain.ghost).toBeNull();
    expect(plain.required).toBeNull();
  });

  it('honours a custom checkpoint interval', () => {
    const s = replay(routeConfig({ checkpointInterval: 250 }), [
      { type: 'start', t: at(0) },
      ...fixEvents(steady(0, 400, 3, 0)),
    ]);
    expect(s.summary().route!.splits.map((x) => x.d)).toEqual([250, 500, 750, LEN]);
  });

  it('required pace = remaining target time / remaining distance (sec/km) with a target', () => {
    const target = 330;
    const s = new RunSession(routeConfig({ targetFinishSec: target }));
    s.apply({ type: 'start', t: at(0) });
    let checked = 0;
    for (const f of steady(0, 200, 3, 0)) {
      s.apply({ type: 'fix', fix: f });
      const snap = s.snapshot();
      const r = route(snap);
      if (r.match !== 'onRoute' || !r.required || r.required.status !== 'ok') continue;
      expect(r.required.remainingM).toBeCloseTo(LEN - r.progress, 9);
      expect(r.required.remainingSec).toBeCloseTo(target - snap.runSec, 9);
      expect(r.required.secPerKm).toBeCloseTo(((target - snap.runSec) / (LEN - r.progress)) * 1000, 9);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('primary is the ghost with a target, else the baseline; setPrimary switches when possible', () => {
    const g = new RunSession(routeConfig({ targetFinishSec: 300 }));
    expect(route(g.snapshot()).primary).toBe('ghost');
    g.setPrimary('baseline');
    expect(route(g.snapshot()).primary).toBe('baseline');
    const b = new RunSession(routeConfig());
    expect(route(b.snapshot()).primary).toBe('baseline');
    b.setPrimary('ghost'); // no ghost: ignored
    expect(route(b.snapshot()).primary).toBe('baseline');
    expect(route(new RunSession(routeConfig({ targetFinishSec: 300, primary: 'baseline' })).snapshot()).primary).toBe(
      'baseline',
    );
  });

  it('primaryReading picks the primary comparison', () => {
    const s = replay(routeConfig({ targetFinishSec: 300 }), [{ type: 'start', t: at(0) }, ...fixEvents(steady(0, 60, 3, 0))]);
    const snap = s.snapshot();
    expect(primaryReading(snap)).toEqual({ kind: 'ghost', reading: route(snap).ghost });
    s.setPrimary('baseline');
    expect(primaryReading(s.snapshot())).toEqual({ kind: 'baseline', reading: route(snap).baseline });
    expect(primaryReading(new RunSession({ mode: 'record' }).snapshot())).toBeNull();
  });

  it('summary: GPS statistics, series capped at 200 points', () => {
    const fixes = [
      ...steady(0, 200, 3, 0),
      fix(201, 603, { hAcc: 80 }), // rejected: poor accuracy
      ...steady(215, 350, 3, 645), // a 14 s gap
    ];
    const s = replay(routeConfig(), [{ type: 'start', t: at(0) }, ...fixEvents(fixes), { type: 'finish', t: at(360) }]);
    const sum = s.summary();
    expect(sum.gps.fixes).toBe(fixes.length);
    expect(sum.gps.accepted).toBe(fixes.length - 1);
    expect(sum.gps.meanAccuracy).toBe(5);
    expect(sum.gps.poorFraction).toBeCloseTo(1 / fixes.length, 9);
    expect(sum.gps.gaps).toBe(1);
    expect(sum.gps.longestGapSec).toBe(14);
    expect(sum.route!.completed).toBe(true);
    expect(sum.route!.baselineSeries.length).toBeLessThanOrEqual(SERIES_MAX_POINTS);
    expect(sum.route!.baselineSeries.length).toBeGreaterThan(150);
    expect(sum.route!.ghostSeries).toEqual([]);
    expect(sum.route!.baselineSeries[sum.route!.baselineSeries.length - 1].d).toBe(LEN);
    expect(sum.elevation).toBeNull();
  });

  it('replay reproduces a live session that ticked between events', () => {
    const sim = simulateRun(makeRoute('straight', { length: 1000 }), { speed: () => 3, startMs: START, noiseM: 4, seed: 7 });
    const events = toEvents(sim.fixes, { pauses: [{ fromMs: at(100.2), toMs: at(130.7) }] });
    const cfg = routeConfig({ targetFinishSec: 320 });
    const live = new RunSession(cfg);
    for (let i = 0; i < events.length; i++) {
      live.apply(events[i]);
      const e = events[i];
      const t = e.type === 'fix' ? e.fix.t : e.t;
      live.tick(t + 400); // ticks never move past the next event in a 1 Hz stream
      if (i === 150) expect(live.snapshot()).toEqual(replay(cfg, events.slice(0, 151)).tick(t + 400));
    }
    const again = replay(cfg, events);
    expect(again.snapshot()).toEqual(live.snapshot());
    expect(again.summary()).toEqual(live.summary());
  });
});

describe('buildRouteFromRecording and computeRunProfile', () => {
  const L = 2000;
  const hills = makeRoute('straight', { length: L, elevation: twoHills(L) });
  const rec = simulateRun(hills, { speed: () => 3, startMs: START, noiseM: 3, seed: 21 });
  const runEnd = (rec.fixes[rec.fixes.length - 1].t - START) / 1000;
  const events = toEvents(rec.fixes);
  const built = buildRouteFromRecording(events);

  it('builds the geometry, its climbs and the run’s own completed profile', () => {
    expect(Math.abs(built.geometry.length - L)).toBeLessThan(0.02 * L);
    expect(built.geometry.elevationReliable).toBe(true);
    expect(built.climbs).toHaveLength(2);
    const p = built.profile;
    expect(p.d[0]).toBe(0);
    expect(p.d[p.d.length - 1]).toBe(built.geometry.length);
    expect(Math.abs(p.t[p.t.length - 1] - runEnd)).toBeLessThan(3);
    // the stored summary measures the run against itself
    const r = built.summary.route!;
    expect(r.completed).toBe(true);
    expect(r.profile).toEqual(p);
    expect(Math.abs(r.baselineFinalAdvantage as number)).toBeLessThan(1e-9);
    expect(r.splits.every((x) => Math.abs(x.cumulativeDiff) < 1)).toBe(true);
    expect(built.summary.elevation).not.toBeNull();
    expect(Math.abs(built.summary.elevation!.gain - 40)).toBeLessThan(8);
    expect(Math.abs(built.summary.elevation!.loss - 40)).toBeLessThan(8);
  });

  it('computeRunProfile replays events against a route', () => {
    const sum = computeRunProfile(built.geometry, built.climbs, built.profile, events);
    expect(sum).toEqual(built.summary);
  });

  it('uses only fixes from active time: a walk while paused leaves no spur', () => {
    const straightRoute = makeRoute('straight', { length: 1000 });
    const sim = simulateRun(straightRoute, {
      speed: () => 3,
      startMs: START,
      noiseM: 3,
      seed: 5,
      stops: [{ atSec: 100, durationSec: 80 }],
    });
    // while paused (100.5 s … 179.5 s) the runner wanders 60 m east and back
    const fixes = sim.fixes.map((f) => {
      const sec = (f.t - START) / 1000;
      if (sec <= 100 || sec >= 180) return f;
      const east = 60 - Math.abs(sec - 140) * 1.5;
      const p = proj.toXY(f);
      const q = proj.toLatLon(p.x + east, p.y);
      return { ...f, lat: q.lat, lon: q.lon };
    });
    const ev = toEvents(fixes, { pauses: [{ fromMs: at(100.5), toMs: at(179.5) }] });
    expect(activeFixes(ev).length).toBe(fixes.length - 79);
    const b = buildRouteFromRecording(ev);
    expect(Math.abs(b.geometry.length - 1000)).toBeLessThan(20);
    expect(b.summary.route!.completed).toBe(true);
    expect(Math.abs(b.summary.runSec - ((fixes[fixes.length - 1].t - START) / 1000 - 79))).toBeLessThan(1e-9);
  });

  it('activeFixes skips fixes before the start, while paused and after the finish', () => {
    const f = (sec: number) => fix(sec, sec * 3);
    const ev: SessionEvent[] = [
      { type: 'fix', fix: f(0) },
      { type: 'start', t: at(1) },
      { type: 'fix', fix: f(1) },
      { type: 'fix', fix: f(2) },
      { type: 'pause', t: at(2.5) },
      { type: 'fix', fix: f(3) },
      { type: 'resume', t: at(3.5) },
      { type: 'fix', fix: f(4) },
      { type: 'finish', t: at(4.5) },
      { type: 'fix', fix: f(5) },
    ];
    expect(activeFixes(ev).map((x) => x.t)).toEqual([at(1), at(2), at(4)]);
  });

  it(`rejects a recording shorter than ${MIN_ROUTE_LENGTH} m`, () => {
    expect(() => buildRouteFromRecording([{ type: 'start', t: at(0) }, ...fixEvents(steady(0, 10, 3, 0))])).toThrow(
      RangeError,
    );
    expect(() => buildRouteFromRecording([])).toThrow(RangeError);
  });
});
