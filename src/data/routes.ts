import { gainLoss, type Climb, type ComparisonMode, type RouteGeometry, type RunSummary, type TargetSpec, type TimeProfile } from '@/core';

import { newId } from './ids';
import { copyRun, getRun, updateRunSummary } from './runs';
import type { SqlDb } from './sql';
import type { RouteListItem, RouteRecord } from './types';

interface RouteRow {
  id: string;
  name: string;
  created_at: number;
  geometry_json: string;
  climbs_json: string;
  length_m: number;
  elevation_gain: number | null;
  baseline_run_id: string;
  reference_run_id: string;
  target_json: string | null;
  comparison_mode: ComparisonMode;
  is_sample: number;
}

const ROUTE_COLUMNS =
  'id, name, created_at, geometry_json, climbs_json, length_m, elevation_gain, baseline_run_id, reference_run_id, target_json, comparison_mode, is_sample';

function toRecord(r: RouteRow): RouteRecord {
  return {
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    geometry: JSON.parse(r.geometry_json) as RouteGeometry,
    climbs: JSON.parse(r.climbs_json) as Climb[],
    elevationGain: r.elevation_gain,
    baselineRunId: r.baseline_run_id,
    referenceRunId: r.reference_run_id,
    target: r.target_json ? (JSON.parse(r.target_json) as TargetSpec) : null,
    comparisonMode: r.comparison_mode,
    isSample: r.is_sample === 1,
  };
}

/** Elevation gain (m) of a route's smoothed profile, or null when its elevation is unreliable. */
function routeGain(geometry: RouteGeometry): number | null {
  if (!geometry.elevationReliable) return null;
  const ele = geometry.points.map((p) => p.ele).filter((e): e is number => e !== null);
  return ele.length === geometry.points.length ? gainLoss(ele).gain : null;
}

/**
 * Saves a recording as a new route. The recording becomes both the original baseline and the current
 * reference; its stored summary is replaced by `profileSummary` (the run measured against its own route).
 */
export async function createRouteFromRun(
  db: SqlDb,
  args: { name: string; runId: string; geometry: RouteGeometry; climbs: Climb[]; profileSummary: RunSummary; isSample?: boolean },
): Promise<RouteRecord> {
  const id = newId();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `INSERT INTO routes (${ROUTE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'both', ?)`,
      [
        id,
        args.name.trim() || 'Untitled route',
        Date.now(),
        JSON.stringify(args.geometry),
        JSON.stringify(args.climbs),
        args.geometry.length,
        routeGain(args.geometry),
        args.runId,
        args.runId,
        args.isSample ? 1 : 0,
      ],
    );
    await updateRunSummary(db, args.runId, args.profileSummary, id);
  });
  return (await getRoute(db, id)) as RouteRecord;
}

/** Route library rows with best time, last run and count over completed runs. */
export async function listRoutes(db: SqlDb): Promise<RouteListItem[]> {
  const rows = await db.getAllAsync<{
    id: string;
    name: string;
    length_m: number;
    elevation_gain: number | null;
    is_sample: number;
    best: number | null;
    last_run: number | null;
    runs: number;
  }>(
    `SELECT r.id, r.name, r.length_m, r.elevation_gain, r.is_sample,
            MIN(u.finish_sec) AS best, MAX(u.started_at) AS last_run, COUNT(u.id) AS runs
       FROM routes r LEFT JOIN runs u ON u.route_id = r.id AND u.status = 'completed'
      GROUP BY r.id ORDER BY COALESCE(MAX(u.started_at), r.created_at) DESC`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    length: r.length_m,
    elevationGain: r.elevation_gain,
    bestSec: r.best,
    lastRunAt: r.last_run,
    runCount: r.runs,
    isSample: r.is_sample === 1,
  }));
}

export async function getRoute(db: SqlDb, id: string): Promise<RouteRecord | null> {
  const row = await db.getFirstAsync<RouteRow>(`SELECT ${ROUTE_COLUMNS} FROM routes WHERE id = ?`, [id]);
  return row ? toRecord(row) : null;
}

export async function renameRoute(db: SqlDb, id: string, name: string): Promise<void> {
  await db.runAsync('UPDATE routes SET name = ? WHERE id = ?', [name.trim() || 'Untitled route', id]);
}

/**
 * Copies a route with its baseline and reference runs (so the copy is independent of the original),
 * but without the rest of its history.
 */
export async function duplicateRoute(db: SqlDb, id: string, name: string): Promise<RouteRecord> {
  const src = await getRoute(db, id);
  if (!src) throw new Error(`duplicateRoute: no route ${id}`);
  const newRouteId = newId();
  const baselineCopy = newId();
  const referenceCopy = src.referenceRunId === src.baselineRunId ? baselineCopy : newId();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `INSERT INTO routes (${ROUTE_COLUMNS}) SELECT ?, ?, ?, geometry_json, climbs_json, length_m, elevation_gain, ?, ?,
         target_json, comparison_mode, is_sample FROM routes WHERE id = ?`,
      [newRouteId, name.trim() || `${src.name} copy`, Date.now(), baselineCopy, referenceCopy, id],
    );
    await copyRun(db, src.baselineRunId, baselineCopy, newRouteId);
    if (referenceCopy !== baselineCopy) await copyRun(db, src.referenceRunId, referenceCopy, newRouteId);
  });
  return (await getRoute(db, newRouteId)) as RouteRecord;
}

/** Deletes a route with all its runs. */
export async function deleteRoute(db: SqlDb, id: string): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM run_fixes WHERE run_id IN (SELECT id FROM runs WHERE route_id = ?)', [id]);
    await db.runAsync('DELETE FROM run_markers WHERE run_id IN (SELECT id FROM runs WHERE route_id = ?)', [id]);
    await db.runAsync('DELETE FROM runs WHERE route_id = ?', [id]);
    await db.runAsync('DELETE FROM routes WHERE id = ?', [id]);
  });
}

/** The time profile of a completed run on its route, or null if it cannot serve as a reference. */
export async function getRunProfile(db: SqlDb, runId: string): Promise<TimeProfile | null> {
  const run = await getRun(db, runId);
  const r = run?.status === 'completed' ? run.summary?.route : null;
  return r && r.completed ? r.profile : null;
}

async function assertUsableReference(db: SqlDb, routeId: string, runId: string): Promise<void> {
  const run = await getRun(db, runId);
  if (!run || run.routeId !== routeId) throw new Error('That run is not on this route.');
  if (run.status !== 'completed' || !run.summary?.route?.completed) {
    throw new Error('Only a run that completed the whole route can be a reference.');
  }
}

/** Chooses which completed run future runs compare against. Never touches the original baseline. */
export async function setReferenceRun(db: SqlDb, routeId: string, runId: string): Promise<void> {
  await assertUsableReference(db, routeId, runId);
  await db.runAsync('UPDATE routes SET reference_run_id = ? WHERE id = ?', [runId, routeId]);
}

/** Explicitly replaces the original baseline (history's "change from baseline" then uses this run). */
export async function replaceBaseline(db: SqlDb, routeId: string, runId: string): Promise<void> {
  await assertUsableReference(db, routeId, runId);
  await db.runAsync('UPDATE routes SET baseline_run_id = ? WHERE id = ?', [runId, routeId]);
}

export async function setTarget(db: SqlDb, routeId: string, target: TargetSpec | null, mode: ComparisonMode): Promise<void> {
  await db.runAsync('UPDATE routes SET target_json = ?, comparison_mode = ? WHERE id = ?', [
    target ? JSON.stringify(target) : null,
    mode,
    routeId,
  ]);
}
