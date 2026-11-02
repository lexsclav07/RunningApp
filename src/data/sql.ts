export type SqlParam = string | number | null;

/**
 * The subset of expo-sqlite's async database API the app uses. expo-sqlite's SQLiteDatabase satisfies it
 * structurally; tests use the node:sqlite adapter in ./testing/node-sqlite.
 * Writes are not exclusive: callers serialise them (RunController queues its writes).
 */
export interface SqlDb {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params?: SqlParam[]): Promise<{ lastInsertRowId: number; changes: number }>;
  getAllAsync<T>(sql: string, params?: SqlParam[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, params?: SqlParam[]): Promise<T | null>;
  withTransactionAsync(fn: () => Promise<void>): Promise<void>;
  closeAsync(): Promise<void>;
}
