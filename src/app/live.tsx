import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActionSheetIOS, Alert, Platform, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  formatClock,
  formatDistance,
  formatPace,
  type LiveSnapshot,
  type PrimaryComparison,
} from '@/core';
import { DeltaHero } from '@/features/run/DeltaHero';
import { DivergingBar } from '@/features/run/DivergingBar';
import { MetricCell } from '@/features/run/MetricCell';
import { RunControls } from '@/features/run/RunControls';
import { StatusChips } from '@/features/run/StatusChips';
import { runController } from '@/state/controller-instance';
import { useRun } from '@/state/use-run';
import { Badge, Icon, Text, fonts, numeric, palettes, space, useTheme } from '@/ui';

const dark = palettes.dark;

/** Why the live comparison can't be trusted right now, in plain words (null when it can). */
function unreliableReason(s: LiveSnapshot): string | null {
  const r = s.route;
  if (!r || r.reliable) return null;
  if (r.match === 'acquiring') return 'Head to the route start';
  if (r.match === 'offRoute') return 'Off route · comparison paused';
  if (r.match === 'lost' || s.gps.quality === 'none') return 'GPS signal lost';
  if (s.gps.quality === 'poor') return 'Weak GPS · readings may jump';
  return 'Waiting for GPS';
}

function confirmFinish(onFinish: () => void, onDiscard: () => void) {
  const discard = () =>
    Alert.alert('Discard This Run?', 'It will be deleted and not saved to your history.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: onDiscard },
    ]);
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      { options: ['Finish Run', 'Discard Run', 'Cancel'], destructiveButtonIndex: 1, cancelButtonIndex: 2, title: 'End this run?' },
      (i) => (i === 0 ? onFinish() : i === 1 ? discard() : undefined),
    );
  } else {
    Alert.alert('End This Run?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: discard },
      { text: 'Finish', onPress: onFinish },
    ]);
  }
}

export default function LiveRun() {
  const run = useRun();
  const { colors } = useTheme(true);
  const s = run.snapshot;

  if (run.status !== 'active' || !s) {
    return <View style={[styles.flex, { backgroundColor: dark.background }]} />;
  }

  const r = s.route;
  const kind: PrimaryComparison = r?.primary === 'ghost' && r.ghost ? 'ghost' : 'baseline';
  const reading = r ? (kind === 'ghost' ? r.ghost : r.baseline) : null;
  const scale = run.barScale;
  const reason = unreliableReason(s);
  const canSwitch = !!(r?.ghost && r.baseline);

  const finish = async () => {
    try {
      const { runId } = await runController.finish();
      router.replace({ pathname: '/summary/[runId]', params: { runId } });
    } catch (e) {
      Alert.alert('Could Not Save', e instanceof Error ? e.message : String(e));
    }
  };
  const discard = async () => {
    await runController.discard();
    router.dismissAll();
  };

  const required = r?.required;
  const requiredCell =
    !required || required.status === 'unavailable'
      ? { value: '—', tone: 'secondary' as const }
      : required.status === 'ok'
        ? { value: formatPace(required.secPerKm), tone: 'label' as const }
        : { value: required.status === 'missed' ? 'MISSED' : 'AT RISK', tone: 'warning' as const };
  const climb = r?.upcomingClimb && r.upcomingClimb.distanceTo <= 250 ? r.upcomingClimb : null;

  return (
    <View style={[styles.flex, { backgroundColor: dark.background }]}>
      <StatusBar style="light" />
      <SafeAreaView style={styles.flex} edges={['top', 'bottom']}>
        <View style={styles.top}>
          <View style={styles.title}>
            <Text forceDark variant="headline" numberOfLines={1}>
              {run.routeName}
            </Text>
            {s.phase === 'paused' ? <Badge forceDark label="Paused" tone="warning" /> : null}
            {run.mode === 'record' ? <Badge forceDark label="Recording route" tone="accent" /> : null}
          </View>
          <StatusChips
            gps={s.gps.quality}
            accuracy={s.gps.accuracy}
            match={r?.match ?? null}
            simulated={run.source === 'simulated'}
            foregroundOnly={run.tracking === 'foreground'}
          />
        </View>

        {r ? (
          <View style={styles.hero}>
            <DeltaHero reading={reading} kind={kind} reliable={r.reliable} reason={reason} />
            <View style={styles.bar}>
              <DivergingBar
                advantage={reading?.advantage ?? null}
                scale={scale}
                kind={kind}
                dimmed={!r.reliable && reading !== null}
                onPress={canSwitch ? () => runController.setPrimary(kind === 'ghost' ? 'baseline' : 'ghost') : undefined}
              />
            </View>
          </View>
        ) : (
          <View style={styles.hero} accessible accessibilityLabel={`Run time ${formatClock(s.runSec)}`}>
            <Text forceDark numberOfLines={1} adjustsFontSizeToFit style={[styles.clock, numeric, { color: colors.label }]}>
              {formatClock(s.runSec)}
            </Text>
            <Text forceDark variant="subheadline" weight="700" color="accent" style={styles.recording}>
              RECORDING NEW ROUTE
            </Text>
          </View>
        )}

        <View style={styles.grid}>
          <View style={styles.row}>
            <MetricCell label="Pace" value={formatPace(s.paceSecPerKm)} unit="/km" size="l" tone="accent" />
            {r?.nextCheckpoint ? (
              <MetricCell
                label="Next Split"
                value={formatClock(r.nextCheckpoint.targetSplit)}
                unit={`in ${formatDistance(r.nextCheckpoint.distanceTo)}`}
                align="right"
                accessibilityLabel={`Next split target ${formatClock(r.nextCheckpoint.targetSplit)}, in ${formatDistance(r.nextCheckpoint.distanceTo)}`}
              />
            ) : (
              <MetricCell label="Avg Pace" value={formatPace(s.avgPaceSecPerKm)} unit="/km" align="right" />
            )}
          </View>
          <View style={[styles.rule, { backgroundColor: dark.separator }]} />
          <View style={styles.row}>
            <MetricCell label={r ? 'Time' : 'Distance'} value={r ? formatClock(s.runSec) : formatDistance(s.distance)} />
            <MetricCell
              label={r ? 'Distance' : 'Moving'}
              value={r ? formatDistance(s.distance) : formatClock(s.movingSec)}
              align="right"
            />
          </View>
          {r ? (
            <>
              <View style={[styles.rule, { backgroundColor: dark.separator }]} />
              <View style={styles.row}>
                <MetricCell label="Remaining" value={formatDistance(r.remaining)} size="s" tone="secondary" />
                {r.ghost ? (
                  <MetricCell label="Required" value={requiredCell.value} unit={required?.status === 'ok' ? '/km' : undefined} size="s" tone={requiredCell.tone} align="right" />
                ) : (
                  <MetricCell
                    label="Est. Finish"
                    value={r.projectedFinishSec !== null ? formatClock(r.projectedFinishSec) : '—'}
                    size="s"
                    tone="secondary"
                    align="right"
                  />
                )}
              </View>
            </>
          ) : null}
        </View>

        <View style={styles.notice}>
          {climb ? (
            <View style={[styles.pill, { backgroundColor: dark.fill }]} accessible accessibilityLabel={`Hill ahead in ${formatDistance(climb.distanceTo)}`}>
              <Icon name="mountain.2.fill" size={13} color={dark.warning} />
              <Text forceDark variant="footnote" weight="700" style={[numeric, { color: dark.warning }]}>
                HILL AHEAD · {formatDistance(climb.distanceTo)} · {Math.round(climb.climb.gain)} m
              </Text>
            </View>
          ) : r?.ghost && r.projectedFinishSec !== null ? (
            <Text forceDark variant="footnote" color="secondaryLabel" style={[numeric, { fontFamily: fonts.rounded }]}>
              Projected finish {formatClock(r.projectedFinishSec)} (estimate)
            </Text>
          ) : null}
        </View>

        <View style={styles.controls}>
          <RunControls
            phase={s.phase}
            onPause={() => void runController.pause()}
            onResume={() => void runController.resume()}
            onFinish={() => confirmFinish(() => void finish(), () => void discard())}
          />
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  top: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingHorizontal: space.xl, paddingTop: space.s, gap: space.m },
  title: { flexShrink: 1, gap: space.xs },
  hero: { flex: 1, justifyContent: 'center', paddingHorizontal: space.xl, minHeight: 200 },
  bar: { marginTop: space.xxl },
  clock: { fontFamily: fonts.rounded, fontSize: 92, lineHeight: 104, fontWeight: '600', textAlign: 'center' },
  recording: { textAlign: 'center', letterSpacing: 1.6 },
  grid: { paddingHorizontal: space.xl, gap: space.m },
  row: { flexDirection: 'row', gap: space.l },
  rule: { height: StyleSheet.hairlineWidth },
  notice: { minHeight: 36, alignItems: 'center', justifyContent: 'center', marginTop: space.m },
  pill: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2, paddingHorizontal: space.m, paddingVertical: space.xs + 2, borderRadius: 999 },
  controls: { paddingTop: space.m, paddingBottom: space.l },
});
