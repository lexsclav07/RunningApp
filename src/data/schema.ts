import type { SqlDb } from './sql';

/**
 * Ordered migrations; migration i brings the database from user_version i to i + 1. Never edit a shipped
 * migration — append a new one.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE routes (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    geometry_json TEXT NOT NULL,
    climbs_json TEXT NOT NULL,
    length_m REAL NOT NULL,
    elevation_gain REAL,
    baseline_run_id TEXT NOT NULL,
    reference_run_id TEXT NOT NULL,
    target_json TEXT,
    comparison_mode TEXT NOT NULL DEFAULT 'both',
    is_sample INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE runs (
    id TEXT PRIMARY KEY NOT NULL,
    route_id TEXT,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    source TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    config_json TEXT NOT NULL,
    summary_json TEXT,
    finish_sec REAL,
    distance_m REAL,
    is_sample INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX runs_route ON runs (route_id, status, started_at);
  CREATE INDEX runs_status ON runs (status);
  CREATE TABLE run_fixes (
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    t INTEGER NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    h_acc REAL,
    alt REAL,
    v_acc REAL,
    speed REAL,
    course REAL,
    PRIMARY KEY (run_id, seq)
  );
  CREATE TABLE run_markers (
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    t INTEGER NOT NULL,
    PRIMARY KEY (run_id, seq)
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY NOT NULL,
    value_json TEXT NOT NULL
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Applies any migrations newer than the database's PRAGMA user_version, each in its own transaction. */
export async function migrate(db: SqlDb): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  let version = row?.user_version ?? 0;
  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version];
    const next = version + 1;
    await db.withTransactionAsync(async () => {
      await db.execAsync(sql);
      await db.execAsync(`PRAGMA user_version = ${next}`);
    });
    version = next;
  }
}
