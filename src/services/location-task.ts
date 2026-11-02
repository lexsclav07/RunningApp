/**
 * Background location task. Must be defined at module scope before the app renders: when iOS relaunches
 * the app in the background to deliver locations, this is the code that receives them. Imported first by
 * src/app/_layout.tsx.
 */
import type { LocationObject } from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { runController } from '@/state/controller-instance';

import { LOCATION_TASK, toGpsFix } from './location';

if (Platform.OS !== 'web' && !TaskManager.isTaskDefined(LOCATION_TASK)) {
  TaskManager.defineTask<{ locations: LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
    if (error || !data?.locations?.length) return;
    await runController.ingestFixes(data.locations.map(toGpsFix));
  });
}
