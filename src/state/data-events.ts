/** Tiny change bus: anything that writes to the database calls emitDataChanged so views refetch. */
const listeners = new Set<() => void>();
let version = 0;

export function emitDataChanged(): void {
  version++;
  for (const l of listeners) l();
}

export function subscribeDataChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function dataVersion(): number {
  return version;
}
