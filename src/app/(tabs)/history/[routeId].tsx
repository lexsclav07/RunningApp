import { Stack, router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { formatClock, formatDelta, formatDistance, routeStats } from '@/core';
import { FinishTimeChart } from '@/features/charts/Charts';
import { useRoute, useRuns } from '@/state/data-store';
import { Button, ListRow, ListSection, Screen, Text, fonts, numeric, radius, space, useTheme } from '@/ui';
import { formatDayTime } from '@/ui/dates';

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.tile, { backgroundColor: colors.surface }]} accessible accessibilityLabel={`${label} ${value}${detail ? `, ${detail}` : ''}`}>
      <Text variant="footnote" color="secondaryLabel" weight="600">
        {label}
      </Text>
      <Text style={[styles.tileValue, numeric, { color: colors.label }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      {detail ? (
        <Text variant="caption" color="secondaryLabel" numberOfLines={1}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

const TREND = { improving: 'Improving', declining: 'Slowing', steady: 'Steady' } as const;

export default function RouteHistory() {
  const { routeId } = useLocalSearchParams<{ routeId: string }>();
  const { data: route } = useRoute(routeId);
  const { data: runs } = useRuns(routeId);
  if (!route || !runs) return <Screen>{null}</Screen>;

  const stats = routeStats(
    runs.map((r) => ({ id: r.id, startedAt: r.startedAt, finishSec: r.finishSec, distance: r.distance ?? 0 })),
    route.baselineRunId,
  );
  const change = stats.changeFromBaselineSec;

  return (
    <Screen>
      <Stack.Screen options={{ title: route.name, headerLargeTitleEnabled: false }} />
      <View style={styles.grid}>
        <Tile label="Best" value={stats.best ? formatClock(stats.best.finishSec) : '—'} />
        <Tile label="Latest" value={stats.latest ? formatClock(stats.latest.finishSec) : '—'} />
        <Tile label="Average" value={stats.averageSec !== null ? formatClock(stats.averageSec) : '—'} />
        <Tile
          label="vs Baseline"
          value={change !== null ? formatDelta(-change) : '—'}
          detail={change === null ? undefined : change < 0 ? 'faster than baseline' : change > 0 ? 'slower than baseline' : 'same as baseline'}
        />
      </View>

      {stats.series.length > 0 ? (
        <ListSection header="Finish Times" footer={stats.series.length > 1 ? 'Faster runs plot higher. The dashed line is your original baseline.' : undefined}>
          <View style={styles.chart}>
            <FinishTimeChart series={stats.series} baselineSec={stats.baselineSec} bestRunId={stats.best?.runId ?? null} />
          </View>
        </ListSection>
      ) : null}

      <ListSection header="Summary">
        <ListRow title="Runs" value={String(stats.count)} numericValue />
        <ListRow title="Total Distance" value={formatDistance(stats.totalDistance)} numericValue />
        <ListRow title="Trend" value={stats.trend ? TREND[stats.trend] : 'Needs 3+ runs'} />
      </ListSection>

      <ListSection header="Runs">
        {runs.map((r) => (
          <ListRow
            key={r.id}
            title={formatDayTime(r.startedAt)}
            subtitle={[r.id === route.baselineRunId ? 'Baseline' : null, r.id === route.referenceRunId ? 'Reference' : null, r.source === 'simulated' ? 'Simulated' : null]
              .filter(Boolean)
              .join(' · ') || undefined}
            value={r.finishSec !== null ? formatClock(r.finishSec) : 'DNF'}
            numericValue
            onPress={() => router.push(`/run/${r.id}`)}
          />
        ))}
      </ListSection>
      {stats.series.length >= 2 ? (
        <View style={styles.compare}>
          <Button variant="tinted" title="Compare Two Runs" icon="arrow.left.arrow.right" onPress={() => router.push({ pathname: '/history/compare', params: { routeId: route.id } })} />
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.m, marginHorizontal: space.l, marginBottom: space.xxl },
  tile: { flexBasis: '47%', flexGrow: 1, borderRadius: radius.m, padding: space.l, gap: space.xxs, borderCurve: 'continuous' },
  tileValue: { fontFamily: fonts.rounded, fontSize: 28, lineHeight: 34, fontWeight: '600' },
  chart: { padding: space.m },
  compare: { marginHorizontal: space.l },
});
