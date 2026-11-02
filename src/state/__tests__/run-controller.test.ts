/** @jest-environment node */
/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunSession, buildRouteFromRecording, makeRoute, simulateRun, toEvents, twoHills, type GpsFix } from '@/core';
import {
  appendEvents,
  completeRun,
  createActiveRun,
  createRouteFromRun,
  getActiveRun,
  getRun,
  getRunEvents,
  listRuns,
  type SqlDb,
} from '@/data';
import { openNodeDb } from '@/data/testing/node-sqlite';

import { RunController, type RunControllerDeps } from '../run-controller';

const T0 = 1_800_000_000_000;
const ROUTE = makeRoute('loop', { length: 1500, elevation: twoHills(1500) });

let dir: string;
let db: SqlDb;
let clock: number;
let calls: string[];

function deps(): RunControllerDeps {
  return {
    db: async () => db,
    location: {
      start: async () => {
        calls.push('location.start');
        return 'background';
      },
      stop: async () => {
        calls.push('location.stop');
      },
    },
    feedback: { play: (cues) => calls.push(`cue:${cues.map((c) => c.kind).join(',')}`), tap: (k) => calls.push(`tap:${k}`) },
    liveActivity: {
      start: () => calls.push('la.start'),
      update: () => calls.push('la.update'),
      end: () => calls.push('la.end'),
    },
    keepAwake: { on: () => calls.push('awake.on'), off: () => calls.push('awake.off') },
    now: () => clock,
  };
}

/** Saves a recorded 1.5 km loop as a route; returns its id. */
async function seedRoute(): Promise<string> {
  const events = toEvents(simulateRun(ROUTE, { speed: () => 3, startMs: T0 - 86_400_000, seed: 11 }).fixes);
  await createActiveRun(db, {
    id: 'rec',
    startedAt: T0 - 86_400_000,
    config: { mode: 'record', routeId: null, referenceRunId: null, targetFinishSec: null, primary: 'baseline', checkpointInterval: null, source: 'simulated' },
  });
  await appendEvents(db, 'rec', events);
  await completeRun(db, 'rec', RunSession.replay({ mode: 'record' }, events).summary());
  const built = buildRouteFromRecording(events);
  const route = await createRouteFromRun(db, { name: 'Hills loop', runId: 'rec', geometry: built.geometry, climbs: built.climbs, profileSummary: built.summary });
  return route.id;
}

function secondRun(): GpsFix[] {
  return simulateRun(ROUTE, { speed: () => 3.1, startMs: T0 + 1000, seed: 12 }).fixes;
}

async function feed(c: RunController, fixes: GpsFix[], batch = 10): Promise<void> {
  for (let i = 0; i < fixes.length; i += batch) {
    const chunk = fixes.slice(i, i + batch);
    clock = chunk[chunk.length - 1].t;
    await c.ingestFixes(chunk);
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ghostpace-ctl-'));
  db = await openNodeDb(join(dir, 'test.db'));
  clock = T0;
  calls = [];
});

afterEach(async () => {
  await db.closeAsync();
  rmSync(dir, { recursive: true, force: true });
});

describe('RunController', () => {
  it('recovers an interrupted route run from storage and finishes it', async () => {
    const routeId = await seedRoute();
    const fixes = secondRun();
    const a = new RunController(deps());
    await a.startRun({ mode: 'route', routeId, targetFinishSec: 480, source: 'gps' });
    await feed(a, fixes.slice(0, 300));
    const before = a.getSnapshot().snapshot!;
    expect(before.route?.match).toBe('onRoute');

    // the app is killed; iOS relaunches it for the next location batch
    const b = new RunController(deps());
    expect(await b.recover()).toBe(true);
    const after = b.getSnapshot().snapshot!;
    expect(after.route!.progress).toBeCloseTo(before.route!.progress, 6);
    expect(after.route!.baseline!.advantage).toBeCloseTo(before.route!.baseline!.advantage, 6);
    expect(after.route!.ghost!.advantage).toBeCloseTo(before.route!.ghost!.advantage, 6);
    expect(after.distance).toBeCloseTo(before.distance, 6);

    await feed(b, fixes.slice(300));
    clock = fixes[fixes.length - 1].t + 5000;
    const { runId, summary } = await b.finish();
    expect(summary.route?.completed).toBe(true);
    const stored = await getRun(db, runId);
    expect(stored?.status).toBe('completed');
    expect(stored?.routeId).toBe(routeId);
    expect(stored?.finishSec).toBeCloseTo(summary.route!.finishSec!, 6);
    expect(await getActiveRun(db)).toBeNull();
    expect(b.getSnapshot().status).toBe('idle');
  });

  it('a recovered run picks up from the background task without an explicit recover()', async () => {
    const routeId = await seedRoute();
    const fixes = secondRun();
    const a = new RunController(deps());
    await a.startRun({ mode: 'route', routeId, source: 'gps' });
    await feed(a, fixes.slice(0, 100));
    const b = new RunController(deps());
    await feed(b, fixes.slice(100, 110));
    expect(b.getSnapshot().status).toBe('active');
    expect((await getRunEvents(db, b.getSnapshot().runId!)).filter((e) => e.type === 'fix')).toHaveLength(110);
  });

  it('ignores a duplicated GPS batch', async () => {
    const routeId = await seedRoute();
    const fixes = secondRun().slice(0, 60);
    const c = new RunController(deps());
    await c.startRun({ mode: 'route', routeId, source: 'gps' });
    await feed(c, fixes);
    const d1 = c.getSnapshot().snapshot!.distance;
    await c.ingestFixes(fixes.slice(40));
    expect(c.getSnapshot().snapshot!.distance).toBe(d1);
    await c.pause(); // flushes
    expect((await getRunEvents(db, c.getSnapshot().runId!)).filter((e) => e.type === 'fix')).toHaveLength(60);
  });

  it('record mode finishes as a completed run without a route', async () => {
    const c = new RunController(deps());
    await c.startRun({ mode: 'record', source: 'gps' });
    await feed(c, simulateRun(ROUTE, { speed: () => 3, startMs: T0 + 500, seed: 3 }).fixes);
    const { runId, summary } = await c.finish();
    expect(summary.route).toBeNull();
    expect(summary.distance).toBeGreaterThan(1400);
    const run = await getRun(db, runId);
    expect(run).toMatchObject({ status: 'completed', routeId: null, mode: 'record' });
    expect(calls).toEqual(expect.arrayContaining(['location.start', 'location.stop', 'awake.on', 'awake.off', 'tap:start', 'tap:finish', 'la.start', 'la.end']));
  });

  it('pause and resume are persisted immediately and do not move the run clock', async () => {
    const c = new RunController(deps());
    await c.startRun({ mode: 'record', source: 'gps' });
    const fixes = simulateRun(ROUTE, { speed: () => 3, startMs: T0 + 500, seed: 4 }).fixes;
    await feed(c, fixes.slice(0, 30));
    clock += 1000;
    await c.pause();
    const runSec = c.getSnapshot().snapshot!.runSec;
    clock += 120_000;
    c.tick();
    expect(c.getSnapshot().snapshot!.runSec).toBeCloseTo(runSec, 6);
    await c.resume();
    const events = await getRunEvents(db, c.getSnapshot().runId!);
    expect(events.map((e) => e.type).filter((t) => t !== 'fix')).toEqual(['start', 'pause', 'resume']);
  });

  it('discard removes the run entirely', async () => {
    const c = new RunController(deps());
    await c.startRun({ mode: 'record', source: 'gps' });
    await feed(c, secondRun().slice(0, 20));
    await c.discard();
    expect(await listRuns(db)).toHaveLength(0);
    expect(c.getSnapshot().status).toBe('idle');
  });

  it('refuses to start a second run', async () => {
    const c = new RunController(deps());
    await c.startRun({ mode: 'record', source: 'gps' });
    await expect(c.startRun({ mode: 'record', source: 'gps' })).rejects.toThrow(/already/);
  });
});
