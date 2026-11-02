/** @jest-environment node */
import { describe, expect, it } from '@jest/globals';
import { CueEngine, type Cue } from '../cues';
import type { Climb, LiveSnapshot, MatchState, RequiredPace, SplitResult } from '../types';

type Route = NonNullable<LiveSnapshot['route']>;

const CLIMB: Climb = { startD: 500, endD: 700, gain: 20, avgGrade: 0.1, maxGrade: 0.12 };

function split(index: number, d: number, cumulativeDiff: number): SplitResult {
  return {
    index,
    d,
    targetElapsed: d * 0.3,
    targetSplit: 75,
    referenceElapsed: d * 0.3,
    actualElapsed: d * 0.3 - cumulativeDiff,
    actualSplit: 75,
    splitDiff: 0,
    cumulativeDiff,
  };
}

/** A running route-mode snapshot with a ghost target; `adv` sets both readings. */
function snap(
  o: {
    runSec?: number;
    phase?: LiveSnapshot['phase'];
    adv?: number | null;
    match?: MatchState;
    reliable?: boolean;
    lastSplit?: SplitResult | null;
    progress?: number;
    climb?: { distanceTo: number; climb: Climb } | null;
    required?: RequiredPace | null;
    finishedSec?: number | null;
    quality?: LiveSnapshot['gps']['quality'];
    mode?: 'record' | 'route';
    primary?: Route['primary'];
  } = {},
): LiveSnapshot {
  const adv = o.adv === undefined ? 0 : o.adv;
  const reading = adv === null ? null : { advantage: adv, status: adv >= 2 ? 'ahead' : adv <= -2 ? 'behind' : 'onTarget' } as const;
  const route: Route = {
    match: o.match ?? 'onRoute',
    progress: o.progress ?? 300,
    length: 2000,
    remaining: 2000 - (o.progress ?? 300),
    offset: 3,
    finishedSec: o.finishedSec ?? null,
    reliable: o.reliable ?? true,
    baseline: reading,
    ghost: reading ? { ...reading, targetFinishSec: 600 } : null,
    primary: o.primary ?? 'ghost',
    nextCheckpoint: null,
    lastSplit: o.lastSplit ?? null,
    required: o.required ?? null,
    projectedFinishSec: null,
    upcomingClimb: o.climb ?? null,
  };
  return {
    phase: o.phase ?? 'running',
    mode: o.mode ?? 'route',
    startedAt: 0,
    runSec: o.runSec ?? 100,
    movingSec: o.runSec ?? 100,
    wallSec: o.runSec ?? 100,
    distance: 300,
    paceSecPerKm: 300,
    avgPaceSecPerKm: 300,
    gps: { quality: o.quality ?? 'good', accuracy: 5, lastFixAgeSec: 0 },
    route: o.mode === 'record' ? null : route,
  };
}
const kinds = (cues: Cue[]) => cues.map((c) => c.kind);

describe('CueEngine checkpoints', () => {
  it('announces each new split once with distance and cumulative difference', () => {
    const e = new CueEngine();
    expect(e.evaluate(snap({ runSec: 70 }))).toEqual([]);
    const cues = e.evaluate(snap({ runSec: 80, lastSplit: split(0, 250, 12) }));
    expect(cues).toEqual([{ kind: 'checkpoint', text: '250 metres. 12 seconds ahead.', haptic: 'light' }]);
    expect(e.evaluate(snap({ runSec: 81, lastSplit: split(0, 250, 12) }))).toEqual([]);
    const km = e.evaluate(snap({ runSec: 300, lastSplit: split(3, 1000, -65) }));
    expect(km[0].text).toBe('1 kilometre. 1 minute 5 seconds behind.');
    expect(e.evaluate(snap({ runSec: 400, lastSplit: split(4, 1250, 1) }))[0].text).toBe('1.25 kilometres. On target.');
  });

  it('keeps checkpoint cues at least 20 s apart', () => {
    const e = new CueEngine();
    expect(kinds(e.evaluate(snap({ runSec: 30, lastSplit: split(0, 100, 3) })))).toEqual(['checkpoint']);
    expect(e.evaluate(snap({ runSec: 45, lastSplit: split(1, 200, 3) }))).toEqual([]);
    expect(kinds(e.evaluate(snap({ runSec: 60, lastSplit: split(2, 300, 3) })))).toEqual(['checkpoint']);
  });

  it('can be switched off', () => {
    const e = new CueEngine({ checkpoints: false });
    expect(e.evaluate(snap({ runSec: 80, lastSplit: split(0, 250, 12) }))).toEqual([]);
  });
});

describe('CueEngine status changes', () => {
  it('first side is set silently; a sign change beyond the threshold fires, then the cooldown applies', () => {
    const e = new CueEngine(); // threshold 5, cooldown 30
    expect(e.evaluate(snap({ runSec: 10, adv: 6 }))).toEqual([]);
    expect(e.evaluate(snap({ runSec: 20, adv: -4 }))).toEqual([]); // below threshold
    expect(e.evaluate(snap({ runSec: 30, adv: -6 }))).toEqual([
      { kind: 'statusChange', text: 'Now 6 seconds behind.', haptic: 'warning' },
    ]);
    expect(e.evaluate(snap({ runSec: 40, adv: 7 }))).toEqual([]); // cooldown
    expect(e.evaluate(snap({ runSec: 59, adv: 7 }))).toEqual([]);
    expect(e.evaluate(snap({ runSec: 60, adv: 7 }))).toEqual([
      { kind: 'statusChange', text: 'Now 7 seconds ahead.', haptic: 'success' },
    ]);
    expect(e.evaluate(snap({ runSec: 200, adv: 9 }))).toEqual([]); // same side
  });

  it('honours custom threshold and cooldown, follows the primary comparison', () => {
    const e = new CueEngine({ thresholdSec: 10, cooldownSec: 5 });
    e.evaluate(snap({ runSec: 10, adv: 12 }));
    expect(e.evaluate(snap({ runSec: 20, adv: -8 }))).toEqual([]);
    expect(kinds(e.evaluate(snap({ runSec: 30, adv: -10 })))).toEqual(['statusChange']);
    const b = new CueEngine();
    const s = snap({ runSec: 10, adv: 8, primary: 'baseline' });
    b.evaluate(s);
    const flipped = snap({ runSec: 50, adv: 8, primary: 'baseline' });
    flipped.route!.baseline = { advantage: -8, status: 'behind' };
    expect(kinds(b.evaluate(flipped))).toEqual(['statusChange']);
  });

  it('is silent while the comparison is unreliable', () => {
    const e = new CueEngine();
    e.evaluate(snap({ runSec: 10, adv: 6 }));
    expect(e.evaluate(snap({ runSec: 50, adv: -9, reliable: false }))).toEqual([]);
  });

  it('a checkpoint cue counts as the status announcement', () => {
    const e = new CueEngine();
    e.evaluate(snap({ runSec: 10, adv: 6 }));
    expect(kinds(e.evaluate(snap({ runSec: 50, adv: -7, lastSplit: split(0, 250, -7) })))).toEqual(['checkpoint']);
    expect(e.evaluate(snap({ runSec: 51, adv: -7 }))).toEqual([]);
  });
});

describe('CueEngine route and GPS events', () => {
  it('hill ahead fires once per climb within 150 m', () => {
    const e = new CueEngine();
    expect(e.evaluate(snap({ climb: { distanceTo: 200, climb: CLIMB } }))).toEqual([]);
    expect(e.evaluate(snap({ climb: { distanceTo: 150, climb: CLIMB } }))).toEqual([
      { kind: 'hillAhead', text: 'Hill ahead. 20 metre climb over 200 metres.', haptic: 'light' },
    ]);
    expect(e.evaluate(snap({ climb: { distanceTo: 100, climb: CLIMB } }))).toEqual([]);
    const next = { ...CLIMB, startD: 1300, endD: 1500 };
    expect(kinds(e.evaluate(snap({ climb: { distanceTo: 120, climb: next } })))).toEqual(['hillAhead']);
    expect(new CueEngine({ hills: false }).evaluate(snap({ climb: { distanceTo: 100, climb: CLIMB } }))).toEqual([]);
  });

  it('off route and back on route fire once per transition', () => {
    const e = new CueEngine();
    expect(e.evaluate(snap({ match: 'onRoute' }))).toEqual([]);
    expect(e.evaluate(snap({ match: 'offRoute', reliable: false }))).toEqual([
      { kind: 'offRoute', text: 'Off route.', haptic: 'warning' },
    ]);
    expect(e.evaluate(snap({ match: 'offRoute', reliable: false }))).toEqual([]);
    expect(e.evaluate(snap({ match: 'onRoute' }))).toEqual([{ kind: 'backOnRoute', text: 'Back on route.', haptic: 'light' }]);
    expect(e.evaluate(snap({ match: 'onRoute' }))).toEqual([]);
    expect(kinds(e.evaluate(snap({ match: 'offRoute' })))).toEqual(['offRoute']);
  });

  it('GPS lost fires once per loss, after GPS has been seen', () => {
    const e = new CueEngine();
    expect(e.evaluate(snap({ quality: 'none', match: 'acquiring', adv: null }))).toEqual([]);
    e.evaluate(snap({ quality: 'good' }));
    expect(e.evaluate(snap({ quality: 'none', match: 'lost', reliable: false }))).toEqual([
      { kind: 'gpsLost', text: 'GPS signal lost.', haptic: 'warning' },
    ]);
    expect(e.evaluate(snap({ quality: 'none', match: 'lost', reliable: false }))).toEqual([]);
    e.evaluate(snap({ quality: 'fair' }));
    expect(kinds(e.evaluate(snap({ quality: 'none', match: 'lost', reliable: false })))).toEqual(['gpsLost']);
  });

  it('target at risk fires at most once per 120 s', () => {
    const atRisk: RequiredPace = { status: 'atRisk', secPerKm: null, remainingSec: 100, remainingM: 900 };
    const e = new CueEngine();
    expect(e.evaluate(snap({ runSec: 100, required: atRisk }))).toEqual([
      { kind: 'targetAtRisk', text: 'Target at risk.', haptic: 'warning' },
    ]);
    expect(e.evaluate(snap({ runSec: 219, required: atRisk }))).toEqual([]);
    expect(kinds(e.evaluate(snap({ runSec: 220, required: atRisk })))).toEqual(['targetAtRisk']);
    const ok: RequiredPace = { status: 'ok', secPerKm: 300, remainingSec: 300, remainingM: 1000 };
    expect(e.evaluate(snap({ runSec: 400, required: ok }))).toEqual([]);
  });

  it('route complete fires once and replaces the final checkpoint cue', () => {
    const e = new CueEngine();
    const done = snap({ runSec: 610, adv: 25, finishedSec: 605, progress: 2000, lastSplit: split(7, 2000, 25) });
    expect(e.evaluate(done)).toEqual([
      { kind: 'routeComplete', text: 'Route complete in 10 minutes 5 seconds. 25 seconds ahead.', haptic: 'success' },
    ]);
    expect(e.evaluate(done)).toEqual([]);
    // a finish tapped right at the end still gets the cue once
    const f = new CueEngine();
    expect(kinds(f.evaluate(snap({ phase: 'finished', finishedSec: 3725, adv: -3 })))).toEqual(['routeComplete']);
    expect(new CueEngine().evaluate(snap({ phase: 'finished', finishedSec: 3725, adv: -3 }))[0].text).toBe(
      'Route complete in 1 hour 2 minutes 5 seconds. 3 seconds behind.',
    );
  });

  it('stays quiet while idle or paused, and in record mode only GPS cues fire', () => {
    const e = new CueEngine();
    expect(e.evaluate(snap({ phase: 'idle', match: 'offRoute', lastSplit: split(0, 250, 3) }))).toEqual([]);
    expect(e.evaluate(snap({ phase: 'paused', match: 'offRoute', lastSplit: split(0, 250, 3) }))).toEqual([]);
    const r = new CueEngine();
    r.evaluate(snap({ mode: 'record' }));
    expect(kinds(r.evaluate(snap({ mode: 'record', quality: 'none' })))).toEqual(['gpsLost']);
  });
});
