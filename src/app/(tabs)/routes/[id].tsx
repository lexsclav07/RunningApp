import { Stack, router, useLocalSearchParams } from 'expo-router';
import { Alert, Platform, StyleSheet, View } from 'react-native';

import { formatClock, formatDistance, resolveTargetFinish } from '@/core';
import { deleteRoute, duplicateRoute, renameRoute } from '@/data';
import { ElevationProfile, RouteShape } from '@/features/charts/Charts';
import { shareRouteGpx } from '@/services/export';
import { useMutation, useRoute, useRuns } from '@/state/data-store';
import { selectRoute } from '@/state/selection';
import { Button, ListRow, ListSection, Screen, space } from '@/ui';
import { formatDayTime } from '@/ui/dates';

export default function RouteDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: route } = useRoute(id);
  const { data: runs } = useRuns(id);
  const mutate = useMutation();

  if (!route) return <Screen>{null}</Screen>;
  const reference = runs?.find((r) => r.id === route.referenceRunId);
  const baseline = runs?.find((r) => r.id === route.baselineRunId);
  const refFinish = reference?.finishSec ?? null;
  const target = route.target && refFinish !== null ? resolveTargetFinish(refFinish, route.target) : null;
  const best = runs?.reduce<number | null>((m, r) => (r.finishSec !== null && (m === null || r.finishSec < m) ? r.finishSec : m), null) ?? null;

  const rename = () => {
    if (Platform.OS !== 'ios') return;
    Alert.prompt('Rename Route', undefined, (text) => text && void mutate((db) => renameRoute(db, route.id, text)), 'plain-text', route.name);
  };
  const duplicate = async () => {
    const copy = await mutate((db) => duplicateRoute(db, route.id, `${route.name} copy`));
    router.push(`/routes/${copy.id}`);
  };
  const remove = () =>
    Alert.alert(`Delete “${route.name}”?`, 'The route and all of its runs will be deleted. This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await mutate((db) => deleteRoute(db, route.id));
          router.back();
        },
      },
    ]);
  const exportGpx = () =>
    void mutate((db) => shareRouteGpx(db, route)).catch((e: unknown) => Alert.alert('Export Failed', e instanceof Error ? e.message : String(e)));

  return (
    <Screen>
      <Stack.Screen options={{ title: route.name, headerLargeTitleEnabled: false }} />
      <ListSection>
        <View style={styles.chart}>
          <RouteShape points={route.geometry.points} />
        </View>
      </ListSection>
      <ListSection
        header="Elevation"
        footer={route.geometry.elevationReliable ? undefined : 'GPS altitude was too noisy on the recording to draw a profile. Pacing still uses your recorded timing, so hills are compared fairly.'}
      >
        {route.geometry.elevationReliable ? (
          <View style={styles.chart}>
            <ElevationProfile points={route.geometry.points} climbs={route.climbs} />
          </View>
        ) : (
          <ListRow title="Elevation" value="Unavailable" />
        )}
      </ListSection>

      <ListSection header="Route">
        <ListRow title="Distance" value={formatDistance(route.geometry.length)} numericValue />
        {route.elevationGain !== null ? <ListRow title="Elevation Gain" value={`${Math.round(route.elevationGain)} m`} numericValue /> : null}
        {route.climbs.length > 0 ? <ListRow title="Climbs" value={String(route.climbs.length)} numericValue /> : null}
        <ListRow title="Loop" value={route.geometry.isLoop ? 'Yes' : 'No'} />
        <ListRow title="Best Time" value={best !== null ? formatClock(best) : '—'} numericValue />
      </ListSection>

      <ListSection header="Pacing" footer="Change the reference from a run's page. The original baseline only changes if you replace it there.">
        <ListRow
          title="Reference"
          subtitle={reference ? formatDayTime(reference.startedAt) : undefined}
          value={refFinish !== null ? formatClock(refFinish) : '—'}
          numericValue
          onPress={reference ? () => router.push(`/run/${reference.id}`) : undefined}
        />
        <ListRow
          title="Original Baseline"
          subtitle={baseline ? formatDayTime(baseline.startedAt) : undefined}
          value={baseline?.finishSec != null ? formatClock(baseline.finishSec) : '—'}
          numericValue
          onPress={baseline ? () => router.push(`/run/${baseline.id}`) : undefined}
        />
        <ListRow
          title="Ghost Target"
          value={target !== null ? formatClock(target) : 'None'}
          numericValue
          onPress={() => router.push({ pathname: '/target', params: { routeId: route.id } })}
        />
      </ListSection>

      <ListSection header={`Runs (${runs?.length ?? 0})`}>
        {(runs ?? []).map((r) => (
          <ListRow
            key={r.id}
            title={formatDayTime(r.startedAt)}
            subtitle={[r.id === route.referenceRunId ? 'Reference' : null, r.id === route.baselineRunId ? 'Baseline' : null, r.source === 'simulated' ? 'Simulated' : null]
              .filter(Boolean)
              .join(' · ') || undefined}
            value={r.finishSec !== null ? formatClock(r.finishSec) : 'DNF'}
            numericValue
            onPress={() => router.push(`/run/${r.id}`)}
          />
        ))}
      </ListSection>

      <View style={styles.primary}>
        <Button
          size="large"
          title="Run This Route"
          icon="play.fill"
          onPress={() => {
            selectRoute(route.id);
            router.navigate('/');
          }}
        />
      </View>
      <ListSection>
        {Platform.OS === 'ios' ? <ListRow icon="pencil" title="Rename" onPress={rename} chevron={false} accent /> : null}
        <ListRow icon="plus.square.on.square" title="Duplicate" onPress={() => void duplicate()} chevron={false} accent />
        <ListRow icon="square.and.arrow.up" title="Export GPX" onPress={exportGpx} chevron={false} accent />
        <ListRow icon="trash" title="Delete Route" onPress={remove} chevron={false} destructive />
      </ListSection>
    </Screen>
  );
}

const styles = StyleSheet.create({
  chart: { padding: space.m },
  primary: { marginHorizontal: space.l, marginBottom: space.xxl },
});
