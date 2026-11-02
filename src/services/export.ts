import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { activeFixes, toGpx } from '@/core';
import { exportBackup, getRunEvents, type RouteRecord, type SqlDb } from '@/data';

const safeName = (s: string) => s.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'route';

async function writeAndShare(name: string, content: string, mimeType: string, UTI: string): Promise<void> {
  const file = new File(Paths.cache, name);
  if (file.exists) file.delete();
  await file.write(content);
  await Sharing.shareAsync(file.uri, { mimeType, UTI, dialogTitle: name });
}

/** Shares a route as GPX: its recorded track (with times) when available, else its geometry. */
export async function shareRouteGpx(db: SqlDb, route: RouteRecord): Promise<void> {
  const fixes = activeFixes(await getRunEvents(db, route.baselineRunId));
  const points =
    fixes.length > 1
      ? fixes.map((f) => ({ lat: f.lat, lon: f.lon, ele: f.alt, t: f.t }))
      : route.geometry.points.map((p) => ({ lat: p.lat, lon: p.lon, ele: p.ele }));
  await writeAndShare(`${safeName(route.name)}.gpx`, toGpx({ name: route.name, points }), 'application/gpx+xml', 'com.topografix.gpx');
}

/** Shares one run's GPS track as GPX. */
export async function shareRunGpx(db: SqlDb, runId: string, name: string): Promise<void> {
  const fixes = activeFixes(await getRunEvents(db, runId));
  await writeAndShare(
    `${safeName(name)}.gpx`,
    toGpx({ name, points: fixes.map((f) => ({ lat: f.lat, lon: f.lon, ele: f.alt, t: f.t })) }),
    'application/gpx+xml',
    'com.topografix.gpx',
  );
}

/** Shares a JSON backup of every route and run, with their raw GPS events. */
export async function shareBackup(db: SqlDb): Promise<void> {
  const backup = await exportBackup(db);
  const stamp = new Date(backup.exportedAt).toISOString().slice(0, 10);
  await writeAndShare(`ghost-pace-backup-${stamp}.json`, JSON.stringify(backup), 'application/json', 'public.json');
}
