import type { LiveActivity } from 'expo-widgets';

import type { LiveActivityPayload } from '@/core';
import RunActivity from '@/widgets/RunActivity';

import type { LiveActivityBridge } from './live-activity';

export type { LiveActivityBridge } from './live-activity';

/**
 * ActivityKit via expo-widgets. Failures (Live Activities turned off in Settings, unsupported device)
 * are ignored: a run never depends on its Live Activity.
 */
let current: LiveActivity<LiveActivityPayload> | null = null;

/** After an app relaunch the activity still exists; reattach to it instead of starting another. */
function instance(): LiveActivity<LiveActivityPayload> | null {
  if (current) return current;
  try {
    current = RunActivity.getInstances()[0] ?? null;
  } catch {
    current = null;
  }
  return current;
}

export const liveActivityService: LiveActivityBridge = {
  start(p) {
    try {
      current = instance() ?? RunActivity.start(p, 'ghostpace://live');
    } catch {
      current = null;
    }
  },
  update(p) {
    instance()
      ?.update(p)
      .catch(() => undefined);
  },
  end(p) {
    const a = instance();
    current = null;
    a?.end('default', p ?? undefined).catch(() => undefined);
  },
};
