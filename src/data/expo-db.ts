import * as SQLite from 'expo-sqlite';

import { migrate } from './schema';
import type { SqlDb } from './sql';

const DB_NAME = 'ghostpace.db';

let opening: Promise<SqlDb> | null = null;

/** The app's database (opened once, WAL mode, migrated). */
export function openAppDb(): Promise<SqlDb> {
  opening ??= (async () => {
    const db = await SQLite.openDatabaseAsync(DB_NAME);
    await db.execAsync('PRAGMA journal_mode = WAL');
    await migrate(db);
    return db;
  })();
  return opening;
}
