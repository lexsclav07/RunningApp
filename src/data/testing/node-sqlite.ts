import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../schema';
import type { SqlDb, SqlParam } from '../sql';

/** SqlDb over Node's built-in SQLite, for tests (same SQL, same migrations as the app). */
export async function openNodeDb(path: string): Promise<SqlDb> {
  const raw = new DatabaseSync(path);
  const db: SqlDb = {
    async execAsync(sql) {
      raw.exec(sql);
    },
    async runAsync(sql, params: SqlParam[] = []) {
      const r = raw.prepare(sql).run(...params);
      return { lastInsertRowId: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    async getAllAsync<T>(sql: string, params: SqlParam[] = []) {
      return raw.prepare(sql).all(...params) as T[];
    },
    async getFirstAsync<T>(sql: string, params: SqlParam[] = []) {
      return (raw.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    async withTransactionAsync(fn) {
      raw.exec('BEGIN');
      try {
        await fn();
        raw.exec('COMMIT');
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
    async closeAsync() {
      raw.close();
    },
  };
  await migrate(db);
  return db;
}
