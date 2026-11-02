import type { LiveActivityPayload } from '@/core';

/**
 * Lock Screen Live Activity bridge. The run controller calls start/update/end with plain payloads
 * (toLiveActivityPayload). The iOS implementation is live-activity.ios.ts (expo-widgets / ActivityKit);
 * this no-op serves every other platform and tests.
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
