import { StyleSheet, View } from 'react-native';

import { formatClock, formatDelta, formatDistance, formatPace, type SplitResult } from '@/core';
import type { RouteRecord, RunRecord } from '@/data';
import { AdvantageChart } from '@/features/charts/Charts';
import { Badge, ListRow, ListSection, Text, fonts, numeric, space, useTheme } from '@/ui';
import { formatDayTime } from '@/ui/dates';

function SplitRow({ s }: { s: SplitResult }) {
  const { colors } = useTheme();
  const tone = s.splitDiff >= 0 ? colors.ahead : colors.behind;
  return (
    <View
      style={styles.split}
      accessible
      accessibilityLabel={`${formatDistance(s.d)}: split ${formatClock(s.actualSplit)}, target ${formatClock(s.targetSplit)}, ${formatDelta(s.cumulativeDiff)} overall`}
    >
      <Text variant="subheadline" numeric style={styles.splitD}>
        {formatDistance(s.d)}
      </Text>
      <Text variant="subheadline" numeric style={styles.splitCol}>
        {formatClock(s.actualSplit)}
      </Text>
      <Text variant="subheadline" numeric color="secondaryLabel" style={styles.splitCol}>
        {formatClock(s.targetSplit)}
      </Text>
      <Text variant="subheadline" numeric weight="600" style={[styles.splitCol, { color: tone }]}>
        {formatDelta(s.cumulativeDiff)}
      </Text>
    </View>
  );
}

/** Finish, comparisons, splits and the ahead/behind chart for one completed run. */
export function RunReport({ run, route }: { run: RunRecord; route: RouteRecord | null }) {
  const { colors } = useTheme();
  const s = run.summary;
  if (!s) return null;
  const r = s.route;
  const headline = r?.finishSec ?? s.runSec;
  const ghostSeries = r && r.ghostSeries.length > 1 ? r.ghostSeries : null;
  return (
    <>
      <View style={styles.hero} accessible accessibilityLabel={`${r ? (r.completed ? 'Finish time' : 'Run time, route not completed') : 'Time'} ${formatClock(headline)}`}>
        <Text variant="footnote" color="secondaryLabel" weight="600" style={styles.caps}>
          {r ? (r.completed ? 'FINISH TIME' : 'ROUTE NOT COMPLETED') : 'TIME'}
        </Text>
        <Text style={[styles.time, numeric, { color: colors.label }]}>{formatClock(headline)}</Text>
        <View style={styles.badges}>
          <Text variant="footnote" color="secondaryLabel">
            {formatDayTime(run.startedAt)}
          </Text>
          {run.source === 'simulated' ? <Badge label="Simulated" tone="warning" /> : null}
          {run.isSample ? <Badge label="Sample" /> : null}
        </View>
      </View>

      {r && (r.baselineFinalAdvantage !== null || r.ghostFinalAdvantage !== null) ? (
        <ListSection header="Compared With">
          {r.baselineFinalAdvantage !== null ? (
            <ListRow title="Reference Run" value={formatDelta(r.baselineFinalAdvantage)} numericValue />
          ) : null}
          {r.ghostFinalAdvantage !== null ? <ListRow title="Ghost Target" value={formatDelta(r.ghostFinalAdvantage)} numericValue /> : null}
        </ListSection>
      ) : null}

      <ListSection header="Run">
        <ListRow title="Distance" value={formatDistance(s.distance)} numericValue />
        <ListRow title="Average Pace" value={`${formatPace(s.avgPaceSecPerKm)} /km`} numericValue />
        <ListRow title="Moving Time" value={formatClock(s.movingSec)} numericValue />
        {s.wallSec - s.runSec > 1 ? <ListRow title="Paused" value={formatClock(s.wallSec - s.runSec)} numericValue /> : null}
        {s.elevation ? <ListRow title="Elevation Gain" value={`${Math.round(s.elevation.gain)} m`} numericValue /> : null}
        <ListRow
          title="GPS"
          value={s.gps.meanAccuracy !== null ? `±${Math.round(s.gps.meanAccuracy)} m avg` : '—'}
          subtitle={s.gps.gaps > 0 ? `${s.gps.gaps} signal gap${s.gps.gaps === 1 ? '' : 's'}, longest ${Math.round(s.gps.longestGapSec)} s` : undefined}
          numericValue
        />
        {r && r.offRouteSec > 0 ? <ListRow title="Off Route" value={formatClock(r.offRouteSec)} numericValue /> : null}
      </ListSection>

      {r && r.baselineSeries.length > 1 && route ? (
        <ListSection header={ghostSeries ? 'Ahead / Behind Ghost' : 'Ahead / Behind Reference'}>
          <View style={styles.chart}>
            <AdvantageChart series={ghostSeries ?? r.baselineSeries} length={route.geometry.length} />
          </View>
        </ListSection>
      ) : null}

      {r && r.splits.length > 0 ? (
        <ListSection header="Splits" footer="Split, target split, and overall time ahead (+) or behind (−) at each checkpoint.">
          <View style={styles.split}>
            {['', 'SPLIT', 'TARGET', 'OVERALL'].map((h, i) => (
              <Text key={h || i} variant="caption2" color="secondaryLabel" weight="600" style={i === 0 ? styles.splitD : styles.splitCol}>
                {h}
              </Text>
            ))}
          </View>
          {r.splits.map((sp) => (
            <SplitRow key={sp.index} s={sp} />
          ))}
        </ListSection>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', paddingTop: space.l, paddingBottom: space.xxl, gap: space.xxs },
  caps: { letterSpacing: 1 },
  time: { fontFamily: fonts.rounded, fontSize: 64, lineHeight: 72, fontWeight: '600' },
  badges: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  chart: { padding: space.m },
  split: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.l, paddingVertical: space.s + 1 },
  splitD: { flex: 1.2 },
  splitCol: { flex: 1, textAlign: 'right' },
});
