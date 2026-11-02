import type { LiveActivityPayload } from '@/core';

/**
 * Lock Screen Live Activity bridge. The run controller calls start/update/end with plain payloads
 * (toLiveActivityPayload); this no-op is replaced by the expo-widgets implementation in Stage 6.
 */
export interface LiveActivityBridge {
  start(p: LiveActivityPayload): void;
  update(p: LiveActivityPayload): void;
  end(p: LiveActivityPayload | null): void;
}

export const liveActivityService: LiveActivityBridge = {
  start() {},
  update() {},
  end() {},
};
