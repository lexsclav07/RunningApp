import { Alert } from 'react-native';

import {
  getPermissionState,
  openAppSettings,
  requestBackgroundPermission,
  requestForegroundPermission,
} from '@/services/location';

function ask(title: string, message: string, action: string): Promise<boolean> {
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: 'Not Now', style: 'cancel', onPress: () => resolve(false) },
      { text: action, onPress: () => resolve(true) },
    ]),
  );
}

/**
 * Asks for location the way iOS expects: first "While Using", then the upgrade to "Always", each preceded
 * by a plain explanation. Returns false only if the run cannot start (no location at all). "While Using"
 * alone still works, with tracking limited to while the app is on screen.
 */
export async function ensureRunPermissions(): Promise<boolean> {
  let state = await getPermissionState();
  if (state.foreground === 'undetermined') {
    const go = await ask(
      'Location for Your Runs',
      'Ghost Pace uses GPS to measure where you are on your route and compare you with your ghost. Your location never leaves this iPhone.',
      'Continue',
    );
    if (!go) return false;
    await requestForegroundPermission();
    state = await getPermissionState();
  }
  if (state.foreground !== 'granted') {
    const open = await ask(
      'Location Is Off',
      'Turn on location for Ghost Pace in Settings to record runs.',
      'Open Settings',
    );
    if (open) await openAppSettings();
    return false;
  }
  if (state.background === 'undetermined') {
    const go = await ask(
      'Keep Tracking When Locked',
      'To keep recording with your iPhone locked in your pocket, choose "Change to Always Allow" on the next prompt. You will see the blue location indicator while a run is active.',
      'Continue',
    );
    if (go) await requestBackgroundPermission();
  }
  return true;
}
