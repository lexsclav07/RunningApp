import * as Location from 'expo-location';
import { Linking, Platform } from 'react-native';

import type { GpsFix } from '@/core';

export const LOCATION_TASK = 'ghost-pace-location';

export type PermissionLevel = 'granted' | 'denied' | 'undetermined';

export function toGpsFix(loc: Location.LocationObject): GpsFix {
  const c = loc.coords;
  return {
    t: loc.timestamp,
    lat: c.latitude,
    lon: c.longitude,
    hAcc: c.accuracy ?? null,
    alt: c.altitude ?? null,
    vAcc: c.altitudeAccuracy ?? null,
    speed: c.speed ?? null,
    course: c.heading ?? null,
  };
}

const level = (s: Location.PermissionStatus): PermissionLevel =>
  s === Location.PermissionStatus.GRANTED ? 'granted' : s === Location.PermissionStatus.DENIED ? 'denied' : 'undetermined';

export async function getPermissionState(): Promise<{ foreground: PermissionLevel; background: PermissionLevel }> {
  const [fg, bg] = await Promise.all([Location.getForegroundPermissionsAsync(), Location.getBackgroundPermissionsAsync()]);
  return { foreground: level(fg.status), background: level(bg.status) };
}

export async function requestForegroundPermission(): Promise<PermissionLevel> {
  return level((await Location.requestForegroundPermissionsAsync()).status);
}

/** iOS asks to upgrade "While Using" to "Always"; it silently stays denied after "Allow Once". */
export async function requestBackgroundPermission(): Promise<PermissionLevel> {
  return level((await Location.requestBackgroundPermissionsAsync()).status);
}

export function openAppSettings(): Promise<void> {
  return Linking.openSettings();
}

let foregroundWatch: Location.LocationSubscription | null = null;

/**
 * Starts run tracking. With "Always" permission the OS delivers fixes to the background task
 * (location-task.ts) even with the screen locked. With only "While Using", it falls back to a foreground
 * watch: tracking pauses whenever the app is not on screen, which the run screen says.
 * Returns which mode is active.
 */
export async function startRunTracking(onForegroundFix: (fixes: GpsFix[]) => void): Promise<'background' | 'foreground'> {
  const { background } = await getPermissionState();
  if (background === 'granted' && Platform.OS !== 'web') {
    if (!(await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK))) {
      await Location.startLocationUpdatesAsync(LOCATION_TASK, {
        accuracy: Location.Accuracy.BestForNavigation,
        activityType: Location.ActivityType.Fitness,
        distanceInterval: 0,
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true,
        foregroundService: { notificationTitle: 'Ghost Pace', notificationBody: 'Recording your run' },
      });
    }
    return 'background';
  }
  foregroundWatch?.remove();
  foregroundWatch = await Location.watchPositionAsync(
    { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 0, timeInterval: 1000 },
    (loc) => onForegroundFix([toGpsFix(loc)]),
  );
  return 'foreground';
}

export async function stopRunTracking(): Promise<void> {
  foregroundWatch?.remove();
  foregroundWatch = null;
  if (Platform.OS !== 'web' && (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false))) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
}

/** Foreground fixes before a run, to show GPS accuracy while the user gets ready. Returns an unsubscribe. */
export async function watchWarmup(cb: (fix: GpsFix) => void): Promise<() => void> {
  const sub = await Location.watchPositionAsync(
    { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 0, timeInterval: 1000 },
    (loc) => cb(toGpsFix(loc)),
  );
  return () => sub.remove();
}
