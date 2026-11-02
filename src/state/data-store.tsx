import { createContext, use, useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';

import {
  getRoute,
  getRun,
  getSettings,
  listRoutes,
  listRuns,
  saveSettings,
  type RouteListItem,
  type RouteRecord,
  type RunRecord,
  type Settings,
  type SqlDb,
} from '@/data';
import { openAppDb } from '@/data/expo-db';

import { dataVersion, emitDataChanged, subscribeDataChanged } from './data-events';

const DbContext = createContext<SqlDb | null>(null);

/** Opens the database once and provides it; children render after it is ready. */
export function DataProvider({ children, fallback }: { children: ReactNode; fallback?: ReactNode }) {
  const [db, setDb] = useState<SqlDb | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    openAppDb().then(setDb, (e: unknown) => setError(e instanceof Error ? e : new Error(String(e))));
  }, []);
  if (error) throw error;
  if (!db) return fallback ?? null;
  return <DbContext value={db}>{children}</DbContext>;
}

export function useDb(): SqlDb {
  const db = use(DbContext);
  if (!db) throw new Error('useDb must be used inside <DataProvider>');
  return db;
}

export interface QueryResult<T> {
  data: T | undefined;
  loading: boolean;
  error: Error | null;
}

/** Runs `fn` against the database and re-runs it whenever data changes or `key` changes. */
export function useQuery<T>(key: string, fn: (db: SqlDb) => Promise<T>): QueryResult<T> {
  const db = useDb();
  const version = useSyncExternalStore(subscribeDataChanged, dataVersion);
  const [state, setState] = useState<{ key: string; version: number; data?: T; error: Error | null } | null>(null);
  useEffect(() => {
    let live = true;
    fn(db).then(
      (data) => live && setState({ key, version, data, error: null }),
      (e: unknown) => live && setState({ key, version, error: e instanceof Error ? e : new Error(String(e)) }),
    );
    return () => {
      live = false;
    };
    // fn is recreated each render; key + version identify the query
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, key, version]);
  const fresh = state?.key === key;
  return { data: fresh ? state?.data : undefined, loading: !fresh || state?.version !== version, error: fresh ? (state?.error ?? null) : null };
}

export const useRoutes = () => useQuery<RouteListItem[]>('routes', listRoutes);
export const useRoute = (id: string | undefined) =>
  useQuery<RouteRecord | null>(`route:${id}`, (db) => (id ? getRoute(db, id) : Promise.resolve(null)));
export const useRuns = (routeId?: string) =>
  useQuery<RunRecord[]>(`runs:${routeId ?? '*'}`, (db) => listRuns(db, routeId ? { routeId, status: 'completed' } : { status: 'completed' }));
export const useRunRecord = (id: string | undefined) =>
  useQuery<RunRecord | null>(`run:${id}`, (db) => (id ? getRun(db, id) : Promise.resolve(null)));

export function useSettings(): [Settings | undefined, (patch: Partial<Settings>) => Promise<void>] {
  const db = useDb();
  const { data } = useQuery<Settings>('settings', getSettings);
  const save = useCallback(
    async (patch: Partial<Settings>) => {
      await saveSettings(db, patch);
      emitDataChanged();
    },
    [db],
  );
  return [data, save];
}

/** Runs a write and refreshes every data view afterwards. */
export function useMutation(): <T>(fn: (db: SqlDb) => Promise<T>) => Promise<T> {
  const db = useDb();
  return useCallback(
    async <T,>(fn: (db: SqlDb) => Promise<T>) => {
      try {
        return await fn(db);
      } finally {
        emitDataChanged();
      }
    },
    [db],
  );
}
