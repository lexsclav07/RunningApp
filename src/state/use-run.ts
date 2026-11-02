import { useSyncExternalStore } from 'react';

import { runController } from './controller-instance';
import type { ControllerState } from './run-controller';

/** The active run's state (status, live snapshot), re-rendering on every change. */
export function useRun(): ControllerState {
  return useSyncExternalStore(runController.subscribe, runController.getSnapshot);
}

export { runController };
