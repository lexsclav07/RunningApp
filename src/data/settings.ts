import type { SqlDb } from './sql';
import { DEFAULT_SETTINGS, type Settings } from './types';

const KEY = 'app';

/** Stored settings merged over the defaults (so settings added in later versions get their default). */
export async function getSettings(db: SqlDb): Promise<Settings> {
  const row = await db.getFirstAsync<{ value_json: string }>('SELECT value_json FROM settings WHERE key = ?', [KEY]);
  const stored = row ? (JSON.parse(row.value_json) as Partial<Settings>) : {};
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(db: SqlDb, patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings(db)), ...patch };
  await db.runAsync('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)', [KEY, JSON.stringify(next)]);
  return next;
}
