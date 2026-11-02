import * as Haptics from 'expo-haptics';
import * as Speech from 'expo-speech';

import type { Cue, CueHaptic } from '@/core';
import type { Settings } from '@/data';

export type TapKind = 'start' | 'pause' | 'resume' | 'finish';

function haptic(kind: CueHaptic | TapKind): void {
  const run = () => {
    switch (kind) {
      case 'success':
      case 'finish':
        return Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      case 'warning':
        return Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      case 'start':
      case 'resume':
        return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      case 'pause':
      case 'light':
        return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      case 'none':
        return undefined;
    }
  };
  // haptics are unavailable in the background or on some devices; never let feedback break a run
  Promise.resolve(run()).catch(() => undefined);
}

/**
 * Audio and haptic cues. iOS plays no haptics while the app is in the background, so spoken cues are what
 * reach a runner with the phone in a pocket. When several cues arrive together only the last is spoken.
 */
export const feedbackService = {
  play(cues: Cue[], settings: Settings): void {
    if (cues.length === 0) return;
    const last = cues[cues.length - 1];
    if (settings.haptics) haptic(last.haptic);
    if (settings.audioCues) Speech.speak(last.text, { rate: 0.5 });
  },
  tap(kind: TapKind, settings: Settings): void {
    if (settings.haptics) haptic(kind);
  },
};
