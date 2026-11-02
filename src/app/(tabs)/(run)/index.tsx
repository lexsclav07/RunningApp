import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { formatClock, formatDelta, formatDistance, resolveTargetFinish, type ComparisonMode } from '@/core';
import { sampleRouteShape, startSimulatedRun } from '@/dev/sample-data';
import { setTarget } from '@/data';
import { ensureRunPermissions } from '@/features/run/permissions';
import { useWarmup } from '@/features/run/use-warmup';
import { runController } from '@/state/controller-instance';
import { useMutation, useRoute, useRoutes, useRunRecord } from '@/state/data-store';
import { selectRoute, useSelectedRouteId } from '@/state/selection';
import { useRun } from '@/state/use-run';
import { Button, ListRow, ListSection, Screen, SegmentedControl, Text, space } from '@/ui';
import { formatDay } from '@/ui/dates';

type Mode = 'route' | 'record';

const GPS_TEXT = { good: 'Ready', fair: 'Fair', poor: 'Weak', none: 'Searching…' } as const;

export default function RunSetup() {
  const run = useRun();
  const { data: routes } = useRoutes();
  const selectedId = useSelectedRouteId();
  const [mode, setMode] = useState<Mode>('route');
  const [starting, setStarting] = useState(false);
  const mutate = useMutation();

  // default to the most recently used route
  useEffect(() => {
    if (!routes) return;
    if (selectedId && routes.some((r) => r.id === selectedId)) return;
    selectRoute(routes[0]?.id ?? null);
  }, [routes, selectedId]);

  const hasRoutes = (routes?.length ?? 0) > 0;
  const effectiveMode: Mode = hasRoutes ? mode : 'record';
  const { data: route } = useRoute(effectiveMode === 'route' ? (selectedId ?? undefined) : undefined);
  const { data: reference } = useRunRecord(route?.referenceRunId);
  const warmup = useWarmup(run.status === 'idle');

  const refFinish = reference?.finishSec ?? null;
  const targetSec = route?.target && refFinish !== null ? resolveTargetFinish(refFinish, route.target) : null;
  const compare: ComparisonMode = targetSec === null ? 'baseline' : (route?.comparisonMode ?? 'both');

  async function start(simulated: boolean) {
    if (starting) return;
    setStarting(true);
    try {
      const opts =
        effectiveMode === 'route' && route
          ? {
              mode: 'route' as const,
              routeId: route.id,
              targetFinishSec: compare === 'baseline' ? null : targetSec,
              primary: compare === 'baseline' ? ('baseline' as const) : ('ghost' as const),
            }
          : { mode: 'record' as const };
      if (simulated) {
        await startSimulatedRun(runController, route && effectiveMode === 'route' ? route.geometry.points : sampleRouteShape(), opts);
      } else {
        if (!(await ensureRunPermissions())) return;
        await runController.startRun({ ...opts, source: 'gps' });
      }
      router.push('/live');
    } catch (e) {
      Alert.alert('Could Not Start', e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }

  const setCompare = (m: ComparisonMode) => route && mutate((db) => setTarget(db, route.id, route.target, m));

  return (
    <Screen>
      {run.status === 'active' ? (
        <ListSection>
          <ListRow
            icon="figure.run"
            title="Run in Progress"
            subtitle={run.routeName ?? undefined}
            value={run.snapshot ? formatClock(run.snapshot.runSec) : undefined}
            numericValue
            onPress={() => router.push('/live')}
            accent
          />
        </ListSection>
      ) : null}

      {hasRoutes ? (
        <View style={styles.segment}>
          <SegmentedControl<Mode>
            accessibilityLabel="Run type"
            value={effectiveMode}
            onChange={setMode}
            options={[
              { value: 'route', label: 'Saved Route' },
              { value: 'record', label: 'New Route' },
            ]}
          />
        </View>
      ) : null}

      {effectiveMode === 'route' && route ? (
        <>
          <ListSection header="Route">
            <ListRow
              title={route.name}
              subtitle={`${formatDistance(route.geometry.length)}${route.elevationGain !== null ? ` · ↑ ${Math.round(route.elevationGain)} m` : ''}`}
              onPress={() => router.push('/select-route')}
              accessibilityHint="Choose another route"
            />
            <ListRow
              title="Reference"
              value={reference && refFinish !== null ? `${formatClock(refFinish)} · ${formatDay(reference.startedAt)}` : '—'}
              numericValue
              onPress={() => router.push(`/routes/${route.id}`)}
            />
          </ListSection>
          <ListSection
            header="Ghost"
            footer={
              targetSec !== null && refFinish !== null
                ? `The ghost runs your reference ${formatDelta(refFinish - targetSec).replace('+', '')} faster, keeping its pacing on the hills.`
                : 'Set a target finish time to race a ghost of your reference run.'
            }
          >
            <ListRow
              title="Target"
              value={targetSec !== null ? formatClock(targetSec) : 'None'}
              numericValue
              onPress={() => router.push({ pathname: '/target', params: { routeId: route.id } })}
            />
          </ListSection>
          {targetSec !== null ? (
            <ListSection header="Compare Against">
              <View style={styles.segmentInset}>
                <SegmentedControl<ComparisonMode>
                  accessibilityLabel="Compare against"
                  value={compare}
                  onChange={setCompare}
                  options={[
                    { value: 'ghost', label: 'Ghost' },
                    { value: 'baseline', label: 'Reference' },
                    { value: 'both', label: 'Both' },
                  ]}
                />
              </View>
            </ListSection>
          ) : null}
        </>
      ) : null}

      {effectiveMode === 'record' ? (
        <ListSection
          header="New Route"
          footer="Run the route once. Ghost Pace records the path, the hills and your timing, so every later run is compared position by position."
        >
          <ListRow icon="point.topleft.down.to.point.bottomright.curvepath" title="Record as you run" subtitle="You'll name it when you finish" />
        </ListSection>
      ) : null}

      {run.status === 'idle' ? (
        <ListSection header="GPS">
          {warmup.permission === 'granted' ? (
            <ListRow
              icon="location.fill"
              title={GPS_TEXT[warmup.quality]}
              value={warmup.accuracy !== null ? `±${Math.round(warmup.accuracy)} m` : undefined}
              numericValue
            />
          ) : (
            <ListRow
              icon="location.slash"
              title="Location Access"
              subtitle="Needed to record runs"
              value={warmup.permission === 'denied' ? 'Off' : 'Not Set'}
              onPress={() => void ensureRunPermissions()}
            />
          )}
        </ListSection>
      ) : null}

      {run.status === 'idle' ? (
      <View style={styles.footer}>
        <Button
          size="large"
          title={effectiveMode === 'record' ? 'Start Recording' : 'Start Run'}
          icon={effectiveMode === 'record' ? 'record.circle' : 'play.fill'}
          onPress={() => start(false)}
          loading={starting}
          disabled={effectiveMode === 'route' && !route}
        />
        <Button
          variant="plain"
          title="Try a Simulated Run"
          onPress={() => start(true)}
          disabled={starting || (effectiveMode === 'route' && !route)}
          accessibilityHint="Runs with simulated GPS so you can preview the run screen"
        />
      </View>
      ) : null}

      {!hasRoutes && run.status === 'idle' ? (
        <Text variant="footnote" color="secondaryLabel" align="center" style={styles.hint}>
          Want to look around first? Load sample data in Settings.
        </Text>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  segment: { marginHorizontal: space.l, marginBottom: space.xxl },
  segmentInset: { padding: space.s },
  footer: { paddingHorizontal: space.l, paddingTop: space.s, paddingBottom: space.s, gap: space.xs },
  hint: { marginHorizontal: space.xxxl },
});
