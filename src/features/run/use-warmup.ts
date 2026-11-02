import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { qualityOf, type GpsQuality } from '@/core';
import { getPermissionState, watchWarmup } from '@/services/location';

export interface Warmup {
  permission: 'granted' | 'denied' | 'undetermined' | null;
  quality: GpsQuality;
  accuracy: number | null;
}

/** GPS readiness while the Run tab is on screen (foreground only, stops when you leave). */
export function useWarmup(enabled: boolean): Warmup {
  const [state, setState] = useState<Warmup>({ permission: null, quality: 'none', accuracy: null });
  useFocusEffect(
    useCallback(() => {
      if (!enabled) return undefined;
      let stop: (() => void) | null = null;
      let live = true;
      (async () => {
        const perm = await getPermissionState();
        if (!live) return;
        setState((s) => ({ ...s, permission: perm.foreground }));
        if (perm.foreground !== 'granted') return;
        const unsub = await watchWarmup((fix) => setState({ permission: 'granted', quality: qualityOf(fix.hAcc), accuracy: fix.hAcc }));
        if (live) stop = unsub;
        else unsub();
      })().catch(() => undefined);
      return () => {
        live = false;
        stop?.();
      };
    }, [enabled]),
  );
  return state;
}
