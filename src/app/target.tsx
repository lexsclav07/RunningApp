import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { formatClock, formatPace, resolveTargetFinish, type TargetSpec } from '@/core';
import { setTarget } from '@/data';
import { useMutation, useRoute, useRunRecord } from '@/state/data-store';
import { Button, Icon, ListRow, ListSection, Screen, SegmentedControl, Text, fonts, numeric, space, useTheme } from '@/ui';

type Kind = 'none' | TargetSpec['kind'];

function Stepper({ value, onMinus, onPlus, label }: { value: string; onMinus: () => void; onPlus: () => void; label: string }) {
  const { colors } = useTheme();
  const btn = (icon: 'minus' | 'plus', onPress: () => void, a11y: string) => (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      style={({ pressed }) => [styles.step, { backgroundColor: colors.fill, opacity: pressed ? 0.6 : 1 }]}
    >
      <Icon name={icon} size={20} weight="semibold" color={colors.accent} fallback={icon === 'minus' ? '−' : '+'} />
    </Pressable>
  );
  return (
    <View style={styles.stepper} accessible={false}>
      {btn('minus', onMinus, `Decrease ${label}`)}
      <Text accessibilityLabel={`${label} ${value}`} style={[styles.big, numeric, { color: colors.label }]}>
        {value}
      </Text>
      {btn('plus', onPlus, `Increase ${label}`)}
    </View>
  );
}

export default function TargetSheet() {
  const { routeId } = useLocalSearchParams<{ routeId: string }>();
  const { data: route } = useRoute(routeId);
  const { data: reference } = useRunRecord(route?.referenceRunId);
  const mutate = useMutation();
  const refFinish = reference?.finishSec ?? null;

  const initial = route?.target ?? null;
  const [kind, setKind] = useState<Kind | null>(null);
  const [finish, setFinish] = useState<number | null>(null);
  const [seconds, setSeconds] = useState<number | null>(null);
  const [percent, setPercent] = useState<number | null>(null);

  if (!route || refFinish === null) return <Screen>{null}</Screen>;

  const k: Kind = kind ?? initial?.kind ?? 'improvementSeconds';
  const fin = finish ?? (initial?.kind === 'finishTime' ? initial.seconds : Math.round(refFinish - 30));
  const sec = seconds ?? (initial?.kind === 'improvementSeconds' ? initial.seconds : 30);
  const pct = percent ?? (initial?.kind === 'improvementPercent' ? initial.percent : 2);

  const spec: TargetSpec | null =
    k === 'none' ? null : k === 'finishTime' ? { kind: k, seconds: fin } : k === 'improvementSeconds' ? { kind: k, seconds: sec } : { kind: k, percent: pct };
  const target = spec ? resolveTargetFinish(refFinish, spec) : null;
  const diff = target !== null ? refFinish - target : 0;

  const save = async () => {
    await mutate((db) => setTarget(db, route.id, spec, spec ? route.comparisonMode : 'baseline'));
    router.back();
  };

  return (
    <Screen>
      <ListSection>
        <ListRow title="Reference Finish" value={formatClock(refFinish)} numericValue />
      </ListSection>
      <View style={styles.segment}>
        <SegmentedControl<Kind>
          accessibilityLabel="Target type"
          value={k}
          onChange={setKind}
          options={[
            { value: 'none', label: 'None' },
            { value: 'improvementSeconds', label: 'Seconds' },
            { value: 'improvementPercent', label: 'Percent' },
            { value: 'finishTime', label: 'Time' },
          ]}
        />
      </View>
      {k === 'finishTime' ? (
        <Stepper label="Target finish time" value={formatClock(fin)} onMinus={() => setFinish(Math.max(60, fin - 5))} onPlus={() => setFinish(fin + 5)} />
      ) : k === 'improvementSeconds' ? (
        <Stepper label="Seconds faster" value={`−${sec} s`} onMinus={() => setSeconds(Math.max(5, sec - 5))} onPlus={() => setSeconds(Math.min(Math.floor(refFinish / 2), sec + 5))} />
      ) : k === 'improvementPercent' ? (
        <Stepper label="Percent faster" value={`−${pct.toFixed(1)}%`} onMinus={() => setPercent(Math.max(0.5, pct - 0.5))} onPlus={() => setPercent(Math.min(20, pct + 0.5))} />
      ) : null}

      {target !== null ? (
        <ListSection
          header="Ghost"
          footer="The ghost keeps your reference run's pacing, slower on the hills, faster on the flat, scaled evenly to finish at the target."
        >
          <ListRow title="Target Finish" value={formatClock(target)} numericValue />
          <ListRow title={diff >= 0 ? 'Faster Than Reference' : 'Slower Than Reference'} value={`${Math.round(Math.abs(diff))} s`} numericValue />
          <ListRow title="Average Pace" value={`${formatPace((target / route.geometry.length) * 1000)} /km`} numericValue />
        </ListSection>
      ) : (
        <Text variant="footnote" color="secondaryLabel" style={styles.note}>
          Without a target you’ll be compared with your reference run only.
        </Text>
      )}
      <View style={styles.save}>
        <Button size="large" title="Save" onPress={() => void save()} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  segment: { marginHorizontal: space.l, marginBottom: space.xxl },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xxl, marginBottom: space.xxl },
  step: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  big: { fontFamily: fonts.rounded, fontSize: 44, fontWeight: '600', minWidth: 150, textAlign: 'center' },
  note: { marginHorizontal: space.xxxl, marginBottom: space.xxl },
  save: { marginHorizontal: space.l },
});
