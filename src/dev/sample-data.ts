import {
  RunSession,
  buildRouteFromRecording,
  computeRunProfile,
  makeRoute,
  simulateRun,
  toEvents,
  twoHills,
  type GpsFix,
  type SessionEvent,
  type SimRoutePoint,
} from '@/core';
import {
  appendEvents,
  completeRun,
  createActiveRun,
  createRouteFromRun,
  deleteRoute,
  deleteRun,
  newId,
  type PersistedRunConfig,
  type RouteRecord,
  type SqlDb,
} from '@/data';
import type { RunController, StartRunOptions } from '@/state/run-controller';

/**
 * Sample data for trying the app without running: a 2.4 km loop with two steep hills and five
 * simulated runs. Everything here is flagged is_sample and shown with a "Sample" badge; simulated live
 * runs show "SIMULATED" on the run screen. None of it is real GPS.
 */
export const SAMPLE_ROUTE_NAME = 'Sample · Riverside Hills';
const SAMPLE_LENGTH = 2400;
const DAY = 86_400_000;

export function sampleRouteShape(): SimRoutePoint[] {
  return makeRoute('loop', { length: SAMPLE_LENGTH, elevation: twoHills(SAMPLE_LENGTH), origin: { lat: -33.8688, lon: 151.2093 } });
}

/** A runner whose speed (m/s) drops on climbs and picks up a little downhill. */
export function hillRunner(base: number): (d: number, grade: number) => number {
  return (_d, grade) => Math.min(6, Math.max(1.2, base * (grade > 0 ? 1 - 3.2 * grade : 1 - 0.8 * grade)));
}

const SAMPLE_CONFIG: PersistedRunConfig = {
  mode: 'record',
  routeId: null,
  referenceRunId: null,
  targetFinishSec: null,
  primary: 'baseline',
  checkpointInterval: null,
  source: 'simulated',
};

async function saveRun(db: SqlDb, id: string, events: SessionEvent[], config: PersistedRunConfig): Promise<void> {
  const startedAt = (events[0] as { t: number }).t;
  await createActiveRun(db, { id, startedAt, config, isSample: true });
  await appendEvents(db, id, events);
}

export async function seedSampleData(db: SqlDb, now = Date.now()): Promise<RouteRecord> {
  const shape = sampleRouteShape();
  const first = toEvents(simulateRun(shape, { speed: hillRunner(2.85), startMs: now - 35 * DAY, seed: 101 }).fixes);
  const recId = newId();
  await saveRun(db, recId, first, SAMPLE_CONFIG);
  await completeRun(db, recId, RunSession.replay({ mode: 'record' }, first).summary());
  const built = buildRouteFromRecording(first);
  const route = await createRouteFromRun(db, {
    name: SAMPLE_ROUTE_NAME,
    runId: recId,
    geometry: built.geometry,
    climbs: built.climbs,
    profileSummary: built.summary,
    isSample: true,
  });
  const later: [daysAgo: number, base: number, seed: number][] = [
    [28, 2.9, 102],
    [21, 2.97, 103],
    [13, 2.93, 104],
    [6, 3.04, 105],
  ];
  for (const [daysAgo, base, seed] of later) {
    const events = toEvents(simulateRun(shape, { speed: hillRunner(base), startMs: now - daysAgo * DAY, seed }).fixes);
    const id = newId();
    await saveRun(db, id, events, { ...SAMPLE_CONFIG, mode: 'route', routeId: route.id, referenceRunId: recId });
    await completeRun(db, id, computeRunProfile(built.geometry, built.climbs, built.profile, events), route.id);
  }
  return route;
}

export async function removeSampleData(db: SqlDb): Promise<void> {
  const routes = await db.getAllAsync<{ id: string }>('SELECT id FROM routes WHERE is_sample = 1');
  for (const r of routes) await deleteRoute(db, r.id);
  const runs = await db.getAllAsync<{ id: string }>('SELECT id FROM runs WHERE is_sample = 1');
  for (const r of runs) await deleteRun(db, r.id);
}

export async function hasSampleData(db: SqlDb): Promise<boolean> {
  return (await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM routes WHERE is_sample = 1'))!.n > 0;
}

/**
 * Starts a live run fed by simulated GPS at real speed (1 fix per second, stamped with the current time),
 * following `shape` with a hill-aware runner. Holds position while paused. Returns a stop function.
 */
export async function startSimulatedRun(
  controller: RunController,
  shape: SimRoutePoint[],
  opts: Omit<StartRunOptions, 'source'> & { base?: number },
): Promise<() => void> {
  const sim = simulateRun(shape, { speed: hillRunner(opts.base ?? 3.0), startMs: 0, seed: Math.floor(Math.random() * 1e6) });
  await controller.startRun({ ...opts, source: 'simulated' });
  let k = 0;
  const id = setInterval(() => {
    const st = controller.getSnapshot();
    if (st.status !== 'active' || k >= sim.fixes.length) {
      if (st.status !== 'active') clearInterval(id);
      return;
    }
    if (st.snapshot?.phase !== 'running') return;
    const fix: GpsFix = { ...sim.fixes[k++], t: Date.now() };
    void controller.ingestFixes([fix]);
  }, 1000);
  return () => clearInterval(id);
}
