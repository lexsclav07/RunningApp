import { getRoute } from './routes';
import { getRunEvents, listRuns } from './runs';
import type { SqlDb } from './sql';
import type { BackupV1, RouteRecord } from './types';

/** Everything the app stores (routes, runs with their raw GPS events), as plain JSON. */
export async function exportBackup(db: SqlDb): Promise<BackupV1> {
  const ids = await db.getAllAsync<{ id: string }>('SELECT id FROM routes ORDER BY created_at');
  const routes = (await Promise.all(ids.map((r) => getRoute(db, r.id)))).filter((r): r is RouteRecord => r !== null);
  const runs = await listRuns(db, { status: 'completed' });
  const withEvents = [];
  for (const run of runs) withEvents.push({ ...run, events: await getRunEvents(db, run.id) });
  return { version: 1, exportedAt: Date.now(), routes, runs: withEvents };
}
