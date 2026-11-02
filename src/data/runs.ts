import type { GpsFix, RunSummary, SessionEvent } from '@/core';

import type { SqlDb, SqlParam } from './sql';
import type { PersistedRunConfig, RunRecord, RunStatus, RunSource } from './types';

interface RunRow {
  id: string;
  route_id: string | null;
  mode: 'record' | 'route';
  status: RunStatus;
  source: RunSource;
  started_at: number;
  ended_at: number | null;
  config_json: string;
  summary_json: string | null;
  finish_sec: number | null;
  distance_m: number | null;
  is_sample: number;
}

interface FixRow {
  seq: number;
  t: number;
  lat: number;
  lon: number;
  h_acc: number | null;
  alt: number | null;
  v_acc: number | null;
  speed: number | null;
  course: number | null;
}

interface MarkerRow {
  seq: number;
  type: 'start' | 'pause' | 'resume' | 'finish';
  t: number;
}

const RUN_COLUMNS =
  'id, route_id, mode, status, source, started_at, ended_at, config_json, summary_json, finish_sec, distance_m, is_sample';

function toRecord(r: RunRow): RunRecord {
  return {
    id: r.id,
    routeId: r.route_id,
    mode: r.mode,
    status: r.status,
    source: r.source,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    config: JSON.parse(r.config_json) as PersistedRunConfig,
    summary: r.summary_json ? (JSON.parse(r.summary_json) as RunSummary) : null,
    finishSec: r.finish_sec,
    distance: r.distance_m,
    isSample: r.is_sample === 1,
  };
}

export async function createActiveRun(
  db: SqlDb,
  args: { id: string; startedAt: number; config: PersistedRunConfig; isSample?: boolean },
): Promise<void> {
  const { id, startedAt, config } = args;
  await db.runAsync(
    `INSERT INTO runs (${RUN_COLUMNS}) VALUES (?, ?, ?, 'active', ?, ?, NULL, ?, NULL, NULL, NULL, ?)`,
    [id, config.routeId, config.mode, config.source, startedAt, JSON.stringify(config), args.isSample ? 1 : 0],
  );
}

/**
 * Appends events in one transaction, continuing the run's sequence. Fixes and markers share one seq, so
 * reading them back by seq restores exactly the order the session applied them in.
 */
export async function appendEvents(db: SqlDb, runId: string, events: readonly SessionEvent[]): Promise<void> {
  if (events.length === 0) return;
  await db.withTransactionAsync(async () => {
    const row = await db.getFirstAsync<{ last: number | null }>(
      `SELECT MAX(seq) AS last FROM (SELECT seq FROM run_fixes WHERE run_id = ? UNION ALL SELECT seq FROM run_markers WHERE run_id = ?)`,
      [runId, runId],
    );
    let seq = (row?.last ?? -1) + 1;
    for (const e of events) {
      if (e.type === 'fix') {
        const f = e.fix;
        await db.runAsync(
          'INSERT INTO run_fixes (run_id, seq, t, lat, lon, h_acc, alt, v_acc, speed, course) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [runId, seq++, f.t, f.lat, f.lon, f.hAcc, f.alt, f.vAcc, f.speed, f.course],
        );
      } else {
        await db.runAsync('INSERT INTO run_markers (run_id, seq, type, t) VALUES (?, ?, ?, ?)', [runId, seq++, e.type, e.t]);
      }
    }
  });
}

/** All events of a run in the order they were applied. */
export async function getRunEvents(db: SqlDb, runId: string): Promise<SessionEvent[]> {
  const fixes = await db.getAllAsync<FixRow>(
    'SELECT seq, t, lat, lon, h_acc, alt, v_acc, speed, course FROM run_fixes WHERE run_id = ? ORDER BY seq',
    [runId],
  );
  const markers = await db.getAllAsync<MarkerRow>('SELECT seq, type, t FROM run_markers WHERE run_id = ? ORDER BY seq', [runId]);
  const out: { seq: number; e: SessionEvent }[] = [];
  for (const f of fixes) {
    const fix: GpsFix = { t: f.t, lat: f.lat, lon: f.lon, hAcc: f.h_acc, alt: f.alt, vAcc: f.v_acc, speed: f.speed, course: f.course };
    out.push({ seq: f.seq, e: { type: 'fix', fix } });
  }
  for (const m of markers) out.push({ seq: m.seq, e: { type: m.type, t: m.t } });
  out.sort((a, b) => a.seq - b.seq);
  return out.map((x) => x.e);
}

/** The run left active by an interrupted session (crash, iOS termination), with its events. */
export async function getActiveRun(db: SqlDb): Promise<{ run: RunRecord; events: SessionEvent[] } | null> {
  const row = await db.getFirstAsync<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM runs WHERE status = 'active' ORDER BY started_at DESC LIMIT 1`,
  );
  if (!row) return null;
  return { run: toRecord(row), events: await getRunEvents(db, row.id) };
}

export async function completeRun(db: SqlDb, runId: string, summary: RunSummary, routeId?: string | null): Promise<void> {
  await db.runAsync(
    `UPDATE runs SET status = 'completed', ended_at = ?, summary_json = ?, finish_sec = ?, distance_m = ?,
       route_id = COALESCE(?, route_id) WHERE id = ?`,
    [summary.endedAt, JSON.stringify(summary), summary.route?.finishSec ?? null, summary.distance, routeId ?? null, runId],
  );
}

/** Replaces a completed run's summary (e.g. after recomputing it against its new route). */
export async function updateRunSummary(db: SqlDb, runId: string, summary: RunSummary, routeId?: string | null): Promise<void> {
  await db.runAsync(
    'UPDATE runs SET summary_json = ?, finish_sec = ?, distance_m = ?, route_id = COALESCE(?, route_id) WHERE id = ?',
    [JSON.stringify(summary), summary.route?.finishSec ?? null, summary.distance, routeId ?? null, runId],
  );
}

/** Deletes a run and everything recorded for it. */
export async function deleteRun(db: SqlDb, runId: string): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM run_fixes WHERE run_id = ?', [runId]);
    await db.runAsync('DELETE FROM run_markers WHERE run_id = ?', [runId]);
    await db.runAsync('DELETE FROM runs WHERE id = ?', [runId]);
  });
}

/** Discarding an unfinished run removes it entirely. */
export const discardRun = deleteRun;

export async function getRun(db: SqlDb, id: string): Promise<RunRecord | null> {
  const row = await db.getFirstAsync<RunRow>(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`, [id]);
  return row ? toRecord(row) : null;
}

/** Runs, newest first. */
export async function listRuns(db: SqlDb, filter: { routeId?: string; status?: RunStatus } = {}): Promise<RunRecord[]> {
  const where: string[] = [];
  const params: SqlParam[] = [];
  if (filter.routeId !== undefined) {
    where.push('route_id = ?');
    params.push(filter.routeId);
  }
  if (filter.status !== undefined) {
    where.push('status = ?');
    params.push(filter.status);
  }
  const rows = await db.getAllAsync<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC`,
    params,
  );
  return rows.map(toRecord);
}

/** Copies a run (row, fixes, markers) under a new id and route. */
export async function copyRun(db: SqlDb, runId: string, newRunId: string, routeId: string): Promise<void> {
  await db.runAsync(
    `INSERT INTO runs (${RUN_COLUMNS}) SELECT ?, ?, mode, status, source, started_at, ended_at, config_json, summary_json,
       finish_sec, distance_m, is_sample FROM runs WHERE id = ?`,
    [newRunId, routeId, runId],
  );
  await db.runAsync(
    `INSERT INTO run_fixes (run_id, seq, t, lat, lon, h_acc, alt, v_acc, speed, course)
       SELECT ?, seq, t, lat, lon, h_acc, alt, v_acc, speed, course FROM run_fixes WHERE run_id = ?`,
    [newRunId, runId],
  );
  await db.runAsync(
    'INSERT INTO run_markers (run_id, seq, type, t) SELECT ?, seq, type, t FROM run_markers WHERE run_id = ?',
    [newRunId, runId],
  );
}
