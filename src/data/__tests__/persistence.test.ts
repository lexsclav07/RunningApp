/** @jest-environment node */
/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RunSession,
  buildRouteFromRecording,
  makeRoute,
  simulateRun,
  toEvents,
  type SessionEvent,
} from '@/core';

import {
  appendEvents,
  completeRun,
  createActiveRun,
  createRouteFromRun,
  deleteRoute,
  duplicateRoute,
  exportBackup,
  getActiveRun,
  getRoute,
  getRun,
  getRunEvents,
  getSettings,
  listRoutes,
  listRuns,
  migrate,
  replaceBaseline,
  saveSettings,
  setReferenceRun,
  type PersistedRunConfig,
  type SqlDb,
} from '..';
import { openNodeDb } from '../testing/node-sqlite';

const RECORD: PersistedRunConfig = {
  mode: 'record',
  routeId: null,
  referenceRunId: null,
  targetFinishSec: null,
  primary: 'baseline',
  checkpointInterval: null,
  source: 'simulated',
};

function recording(seed: number, speed = 3, length = 1200): SessionEvent[] {
  const route = makeRoute('loop', { length });
  const { fixes } = simulateRun(route, { speed: () => speed, startMs: 1_800_000_000_000, seed });
  return toEvents(fixes);
}

let dir: string;
let path: string;
let db: SqlDb;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ghostpace-'));
  path = join(dir, 'test.db');
  db = await openNodeDb(path);
});

afterEach(async () => {
  await db.closeAsync().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

/** Records `events` as a completed record-mode run and saves it as a route. */
async function saveRecordedRoute(events: SessionEvent[], id = 'rec-1') {
  await createActiveRun(db, { id, startedAt: (events[0] as { t: number }).t, config: RECORD });
  await appendEvents(db, id, events);
  await completeRun(db, id, RunSession.replay({ mode: 'record' }, events).summary());
  const built = buildRouteFromRecording(events);
  const route = await createRouteFromRun(db, {
    name: 'Riverside',
    runId: id,
    geometry: built.geometry,
    climbs: built.climbs,
    profileSummary: built.summary,
  });
  return { route, built };
}

describe('#13 A completed run persists after restarting the application', () => {
  it('reopening the database file returns the identical summary and events in order', async () => {
    const events = recording(1, 3, 2400).slice(0, 600);
    await createActiveRun(db, { id: 'run-1', startedAt: 1_800_000_000_000, config: RECORD });
    // appended in several batches, as the controller flushes them
    for (let i = 0; i < events.length; i += 37) await appendEvents(db, 'run-1', events.slice(i, i + 37));
    const summary = RunSession.replay({ mode: 'record' }, events).summary();
    await completeRun(db, 'run-1', summary);

    await db.closeAsync();
    db = await openNodeDb(path); // "restart"

    const run = await getRun(db, 'run-1');
    expect(run?.status).toBe('completed');
    expect(run?.summary).toEqual(summary);
    expect(run?.config).toEqual(RECORD);
    const back = await getRunEvents(db, 'run-1');
    expect(back).toHaveLength(600);
    expect(back).toEqual(events);
  });

  it('an active (interrupted) run survives a reopen and replays to the same snapshot', async () => {
    const events = recording(2).slice(0, 300);
    await createActiveRun(db, { id: 'run-2', startedAt: 1_800_000_000_000, config: RECORD });
    await appendEvents(db, 'run-2', events);
    await db.closeAsync();
    db = await openNodeDb(path);

    const active = await getActiveRun(db);
    expect(active?.run.id).toBe('run-2');
    expect(active?.events).toEqual(events);
    expect(RunSession.replay({ mode: 'record' }, active!.events).snapshot()).toEqual(
      RunSession.replay({ mode: 'record' }, events).snapshot(),
    );
  });
});

describe('routes and references', () => {
  it('creating a route links the recording as baseline and reference with a complete profile', async () => {
    const { route } = await saveRecordedRoute(recording(3));
    expect(route.baselineRunId).toBe('rec-1');
    expect(route.referenceRunId).toBe('rec-1');
    const run = await getRun(db, 'rec-1');
    expect(run?.routeId).toBe(route.id);
    expect(run?.summary?.route?.completed).toBe(true);
    expect(run?.finishSec).not.toBeNull();
    const [item] = await listRoutes(db);
    expect(item).toMatchObject({ id: route.id, name: 'Riverside', runCount: 1 });
    expect(item.bestSec).toBeCloseTo(run!.finishSec!, 6);
  });

  it('completing another run never changes the baseline; references change only explicitly', async () => {
    const { route, built } = await saveRecordedRoute(recording(4));
    const second = recording(5, 3.2);
    await createActiveRun(db, {
      id: 'run-b',
      startedAt: 1_800_000_000_000,
      config: { ...RECORD, mode: 'route', routeId: route.id, referenceRunId: 'rec-1' },
    });
    await appendEvents(db, 'run-b', second);
    const summary = RunSession.replay(
      { mode: 'route', route: { geometry: built.geometry, climbs: built.climbs }, reference: built.profile },
      second,
    ).summary();
    await completeRun(db, 'run-b', summary, route.id);

    expect((await getRoute(db, route.id))?.baselineRunId).toBe('rec-1');
    await setReferenceRun(db, route.id, 'run-b');
    const after = await getRoute(db, route.id);
    expect(after?.referenceRunId).toBe('run-b');
    expect(after?.baselineRunId).toBe('rec-1');
    await replaceBaseline(db, route.id, 'run-b');
    expect((await getRoute(db, route.id))?.baselineRunId).toBe('run-b');
  });

  it('rejects a run that did not complete the route as a reference', async () => {
    const { route, built } = await saveRecordedRoute(recording(6));
    const partial = recording(7).slice(0, 120); // ~1/3 of the loop
    await createActiveRun(db, { id: 'short', startedAt: 1, config: { ...RECORD, mode: 'route', routeId: route.id } });
    const summary = RunSession.replay(
      { mode: 'route', route: { geometry: built.geometry, climbs: built.climbs }, reference: built.profile },
      partial,
    ).summary();
    await completeRun(db, 'short', summary, route.id);
    await expect(setReferenceRun(db, route.id, 'short')).rejects.toThrow(/whole route/);
    await expect(replaceBaseline(db, route.id, 'short')).rejects.toThrow(/whole route/);
  });

  it('duplicating copies baseline/reference so deleting the original keeps the copy usable', async () => {
    const { route } = await saveRecordedRoute(recording(8));
    const copy = await duplicateRoute(db, route.id, 'Riverside (holiday)');
    await deleteRoute(db, route.id);
    expect(await getRoute(db, route.id)).toBeNull();
    expect(await getRun(db, 'rec-1')).toBeNull();
    const kept = await getRun(db, copy.baselineRunId);
    expect(kept?.routeId).toBe(copy.id);
    expect((await getRunEvents(db, copy.baselineRunId)).length).toBeGreaterThan(300);
    expect(await listRuns(db, { routeId: copy.id })).toHaveLength(1);
  });
});

describe('settings, backup, migrations', () => {
  it('settings merge over defaults and persist', async () => {
    expect((await getSettings(db)).haptics).toBe(true);
    await saveSettings(db, { haptics: false, cueThresholdSec: 8 });
    await db.closeAsync();
    db = await openNodeDb(path);
    const s = await getSettings(db);
    expect(s).toMatchObject({ haptics: false, cueThresholdSec: 8, audioCues: true });
  });

  it('backup contains routes and runs with their events', async () => {
    const events = recording(9);
    const { route } = await saveRecordedRoute(events);
    const backup = await exportBackup(db);
    expect(backup.version).toBe(1);
    expect(backup.routes.map((r) => r.id)).toEqual([route.id]);
    expect(backup.runs[0].events).toEqual(events);
  });

  it('migrate is idempotent', async () => {
    await migrate(db);
    await migrate(db);
    const v = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    expect(v?.user_version).toBe(1);
  });
});
