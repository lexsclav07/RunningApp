import * as SQLite from 'expo-sqlite';

import { migrate } from './schema';
import type { SqlDb } from './sql';

const DB_NAME = 'ghostpace.db';

let opening: Promise<SqlDb> | null = null;

function adapt(db: SQLite.SQLiteDatabase): SqlDb {
  return {
    execAsync: (sql) => db.execAsync(sql),
    runAsync: async (sql, params = []) => {
      const r = await db.runAsync(sql, params);
      return { lastInsertRowId: r.lastInsertRowId, changes: r.changes };
    },
    getAllAsync: <T,>(sql: string, params: (string | number | null)[] = []) => db.getAllAsync<T>(sql, params),
    getFirstAsync: <T,>(sql: string, params: (string | number | null)[] = []) => db.getFirstAsync<T>(sql, params),
    withTransactionAsync: (fn) => db.withTransactionAsync(fn),
    closeAsync: () => db.closeAsync(),
  };
}

/** The app's database (opened once, WAL mode, migrated). */
export function openAppDb(): Promise<SqlDb> {
  if (!opening) {
    opening = (async () => {
      const db = adapt(await SQLite.openDatabaseAsync(DB_NAME));
      await db.execAsync('PRAGMA journal_mode = WAL');
      await migrate(db);
      return db;
    })();
  }
  return opening;
}
