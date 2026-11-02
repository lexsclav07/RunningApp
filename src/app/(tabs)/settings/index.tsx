import Constants from 'expo-constants';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, StyleSheet, Switch, View } from 'react-native';

import type { PrimaryComparison } from '@/core';
import type { Settings } from '@/data';
import { hasSampleData, removeSampleData, seedSampleData } from '@/dev/sample-data';
import { shareBackup } from '@/services/export';
import { getPermissionState, openAppSettings, type PermissionLevel } from '@/services/location';
import { useDb, useMutation, useQuery, useSettings } from '@/state/data-store';
import { ListRow, ListSection, Screen, SegmentedControl, space, useTheme } from '@/ui';

const THRESHOLDS = [3, 5, 10, 15];
const COOLDOWNS = [20, 30, 60, 120];
const INTERVALS: Settings['checkpointInterval'][] = ['auto', 100, 250, 500, 1000];
const next = <T,>(xs: readonly T[], x: T) => xs[(xs.indexOf(x) + 1) % xs.length];

export default function SettingsScreen() {
  const [settings, save] = useSettings();
  const { colors } = useTheme();
  const db = useDb();
  const mutate = useMutation();
  const { data: sample } = useQuery('sample', hasSampleData);
  const [perm, setPerm] = useState<{ foreground: PermissionLevel; background: PermissionLevel } | null>(null);
  const [busy, setBusy] = useState(false);

  useFocusEffect(
    useCallback(() => {
      getPermissionState().then(setPerm, () => undefined);
    }, []),
  );

  if (!settings) return <Screen>{null}</Screen>;

  const toggle = (key: keyof Settings, label: string) => (
    <Switch
      value={settings[key] as boolean}
      onValueChange={(v) => void save({ [key]: v })}
      trackColor={{ true: colors.accent }}
      accessibilityLabel={label}
    />
  );

  const location =
    perm === null ? '…' : perm.background === 'granted' ? 'Always' : perm.foreground === 'granted' ? 'While Using' : perm.foreground === 'denied' ? 'Off' : 'Not Set';

  const sampleAction = async () => {
    setBusy(true);
    try {
      await mutate((d) => (sample ? removeSampleData(d) : seedSampleData(d).then(() => undefined)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <ListSection header="Feedback" footer="Spoken cues reach you with the phone locked; iOS plays no haptics while the app is in the background.">
        <ListRow title="Haptics" accessory={toggle('haptics', 'Haptics')} />
        <ListRow title="Spoken Cues" accessory={toggle('audioCues', 'Spoken cues')} />
        <ListRow
          title="Announce Changes Over"
          value={`${settings.cueThresholdSec} s`}
          numericValue
          onPress={() => void save({ cueThresholdSec: next(THRESHOLDS, settings.cueThresholdSec) })}
          accessibilityHint="Cycles through 3, 5, 10 and 15 seconds"
        />
        <ListRow
          title="Minimum Gap Between Cues"
          value={`${settings.cueCooldownSec} s`}
          numericValue
          onPress={() => void save({ cueCooldownSec: next(COOLDOWNS, settings.cueCooldownSec) })}
          accessibilityHint="Cycles through 20, 30, 60 and 120 seconds"
        />
      </ListSection>

      <ListSection header="Pacing">
        <View style={styles.inset}>
          <SegmentedControl<PrimaryComparison>
            accessibilityLabel="Lead with"
            value={settings.defaultPrimary}
            onChange={(v) => void save({ defaultPrimary: v })}
            options={[
              { value: 'ghost', label: 'Lead with Ghost' },
              { value: 'baseline', label: 'Lead with Reference' },
            ]}
          />
        </View>
        <ListRow
          title="Checkpoints"
          value={settings.checkpointInterval === 'auto' ? 'Automatic' : `Every ${settings.checkpointInterval} m`}
          onPress={() => void save({ checkpointInterval: next(INTERVALS, settings.checkpointInterval) })}
          accessibilityHint="Cycles through automatic, 100, 250, 500 and 1000 metres"
        />
        <ListRow title="Units" value="Metric (km, min/km, m)" />
      </ListSection>

      <ListSection header="Display">
        <View style={styles.inset}>
          <SegmentedControl<Settings['appearance']>
            accessibilityLabel="Appearance"
            value={settings.appearance}
            onChange={(v) => void save({ appearance: v })}
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </View>
        <ListRow title="Keep Screen Awake During Runs" accessory={toggle('keepAwake', 'Keep screen awake during runs')} />
        <ListRow title="Lock Screen Live Activity" accessory={toggle('liveActivity', 'Lock Screen Live Activity')} />
      </ListSection>

      <ListSection
        header="Location"
        footer="Choose Always so runs keep recording with your iPhone locked. Location is only used during runs and never leaves this device."
      >
        <ListRow title="Location Access" value={location} onPress={() => void openAppSettings()} />
      </ListSection>

      <ListSection header="Data" footer="Sample data is a simulated route with five simulated runs, marked “Sample”, so you can explore without running.">
        <ListRow
          icon="square.and.arrow.up"
          title="Export Backup"
          onPress={() => void shareBackup(db).catch((e: unknown) => Alert.alert('Export Failed', e instanceof Error ? e.message : String(e)))}
          chevron={false}
          accent
        />
        <ListRow
          icon={sample ? 'trash' : 'tray.and.arrow.down'}
          title={sample ? 'Remove Sample Data' : 'Load Sample Data'}
          onPress={() => void sampleAction()}
          chevron={false}
          accent={!sample}
          destructive={!!sample}
          disabled={busy || sample === undefined}
        />
      </ListSection>

      <ListSection header="About">
        <ListRow title="Version" value={Constants.expoConfig?.version ?? '—'} />
        <ListRow title="Storage" value="On this iPhone only" />
      </ListSection>
    </Screen>
  );
}

const styles = StyleSheet.create({ inset: { padding: space.s } });
