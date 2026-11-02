import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

import { openAppDb } from '@/data/expo-db';
import { feedbackService } from '@/services/feedback';
import { liveActivityService } from '@/services/live-activity';
import { startRunTracking, stopRunTracking } from '@/services/location';

import { emitDataChanged } from './data-events';
import { RunController } from './run-controller';

const KEEP_AWAKE_TAG = 'ghost-pace-run';

/** The app's single run controller, wired to the real device services. */
export const runController = new RunController({
  db: openAppDb,
  location: { start: startRunTracking, stop: stopRunTracking },
  feedback: feedbackService,
  liveActivity: liveActivityService,
  keepAwake: {
    on: () => void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined),
    off: () => void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined),
  },
  now: () => Date.now(),
  ticker: (fn) => {
    const id = setInterval(fn, 1000);
    return () => clearInterval(id);
  },
  onDataChanged: emitDataChanged,
});
