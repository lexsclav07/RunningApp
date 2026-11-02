import { useSyncExternalStore } from 'react';

/** The route chosen on the Run tab (shared with the route picker sheet). */
let selectedRouteId: string | null = null;
const listeners = new Set<() => void>();

export function selectRoute(id: string | null): void {
  selectedRouteId = id;
  for (const l of listeners) l();
}

export function useSelectedRouteId(): string | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => selectedRouteId,
  );
}
