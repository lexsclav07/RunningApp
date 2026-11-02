import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { buildCheckpoints, checkpointInterval, compareProfiles, formatClock, formatDelta, formatDistance } from '@/core';
import { useRoute, useRuns } from '@/state/data-store';
import { Icon, ListRow, ListSection, Screen, Text, space, useTheme } from '@/ui';
import { formatDay } from '@/ui/dates';

/** Two completed runs side by side at each checkpoint of the route. */
export default function CompareRuns() {
  const { routeId } = useLocalSearchParams<{ routeId: string }>();
  const { data: route } = useRoute(routeId);
  const { data: runs } = useRuns(routeId);
  const { colors } = useTheme();
  const [picked, setPicked] = useState<string[] | null>(null);
  if (!route || !runs) return <Screen>{null}</Screen>;

  const done = runs.filter((r) => r.summary?.route?.completed);
  const defaults = [route.baselineRunId, done.find((r) => r.id !== route.baselineRunId)?.id].filter((x): x is string => !!x);
  const sel = picked ?? defaults;
  const [a, b] = sel.map((id) => done.find((r) => r.id === id));

  const toggle = (id: string) => {
    const cur = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id].slice(-2);
    setPicked(cur);
  };

  const rows =
    a?.summary?.route && b?.summary?.route
      ? compareProfiles(
          a.summary.route.profile,
          b.summary.route.profile,
          buildCheckpoints(
            route.geometry.length,
            a.summary.route.profile,
            a.summary.route.profile,
            checkpointInterval(route.geometry.length),
          ).map((c) => c.d),
        )
      : [];

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Compare', headerLargeTitleEnabled: false }} />
      <ListSection header="Choose Two Runs">
        {done.map((r) => (
          <ListRow
            key={r.id}
            title={formatDay(r.startedAt)}
            subtitle={r.id === route.baselineRunId ? 'Baseline' : r.id === route.referenceRunId ? 'Reference' : undefined}
            value={r.finishSec !== null ? formatClock(r.finishSec) : undefined}
            numericValue
            chevron={false}
            onPress={() => toggle(r.id)}
            accessory={
              sel.includes(r.id) ? (
                <Text variant="footnote" weight="700" color="accent">
                  {sel[0] === r.id ? 'A' : 'B'}
                </Text>
              ) : (
                <Icon name="circle" size={16} color={colors.tertiaryLabel} fallback="○" />
              )
            }
          />
        ))}
      </ListSection>

      {rows.length > 0 && a && b ? (
        <ListSection
          header={`A ${formatDay(a.startedAt)} · B ${formatDay(b.startedAt)}`}
          footer="Elapsed time at each checkpoint. The last column is how far B was ahead (+) or behind (−) of A at that point."
        >
          <View style={styles.row}>
            {['', 'A', 'B', 'B vs A'].map((h, i) => (
              <Text key={h || i} variant="caption2" weight="600" color="secondaryLabel" style={i ? styles.col : styles.first}>
                {h}
              </Text>
            ))}
          </View>
          {rows.map((r) => (
            <View
              key={r.d}
              style={styles.row}
              accessible
              accessibilityLabel={`${formatDistance(r.d)}: A ${formatClock(r.a)}, B ${formatClock(r.b)}, B ${formatDelta(-r.diff)}`}
            >
              <Text variant="subheadline" numeric style={styles.first}>
                {formatDistance(r.d)}
              </Text>
              <Text variant="subheadline" numeric style={styles.col}>
                {formatClock(r.a)}
              </Text>
              <Text variant="subheadline" numeric style={styles.col}>
                {formatClock(r.b)}
              </Text>
              <Text variant="subheadline" numeric weight="600" style={[styles.col, { color: r.diff <= 0 ? colors.ahead : colors.behind }]}>
                {formatDelta(-r.diff)}
              </Text>
            </View>
          ))}
        </ListSection>
      ) : (
        <Text variant="footnote" color="secondaryLabel" align="center" style={styles.hint}>
          Select two runs that completed the route.
        </Text>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.l, paddingVertical: space.s + 1 },
  first: { flex: 1.2 },
  col: { flex: 1, textAlign: 'right' },
  hint: { marginHorizontal: space.xxxl },
});
