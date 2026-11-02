import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, TextInput, View } from 'react-native';

import { buildRouteFromRecording, formatClock, formatDistance } from '@/core';
import { createRouteFromRun, deleteRun, getRunEvents, setReferenceRun } from '@/data';
import { RunReport } from '@/features/runs/RunReport';
import { useMutation, useRoute, useRunRecord } from '@/state/data-store';
import { selectRoute } from '@/state/selection';
import { Button, ListSection, Screen, Text, space, type as typeScale, useTheme } from '@/ui';
import { formatDay } from '@/ui/dates';

export default function Summary() {
  const { runId } = useLocalSearchParams<{ runId: string }>();
  const { data: run } = useRunRecord(runId);
  const { data: route } = useRoute(run?.routeId ?? undefined);
  const mutate = useMutation();
  const { colors } = useTheme();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const done = () => router.dismissAll();
  const header = <Stack.Screen options={{ headerShown: true, title: 'Summary', headerRight: () => (run?.mode === 'record' && !run.routeId ? null : <Button variant="plain" title="Done" onPress={done} />) }} />;

  if (!run) return <Screen>{header}</Screen>;

  // A first recording becomes a route once named.
  if (run.mode === 'record' && !run.routeId) {
    const fallbackName = `Route · ${formatDay(run.startedAt)}`;
    const save = async () => {
      setBusy(true);
      try {
        const created = await mutate(async (db) => {
          const built = buildRouteFromRecording(await getRunEvents(db, run.id));
          return createRouteFromRun(db, {
            name: name.trim() || fallbackName,
            runId: run.id,
            geometry: built.geometry,
            climbs: built.climbs,
            profileSummary: built.summary,
            isSample: run.isSample,
          });
        });
        selectRoute(created.id);
        router.dismissAll();
        router.push(`/routes/${created.id}`);
      } catch (e) {
        Alert.alert('Could Not Save Route', e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    };
    const discard = () =>
      Alert.alert("Don't Save This Route?", 'The recording will be deleted.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => void mutate((db) => deleteRun(db, run.id)).then(done) },
      ]);
    return (
      <Screen>
        {header}
        <View style={styles.intro}>
          <Text variant="title2" align="center">
            Name Your Route
          </Text>
          <Text variant="subheadline" color="secondaryLabel" align="center">
            {run.summary ? `${formatDistance(run.summary.distance)} in ${formatClock(run.summary.runSec)}. ` : ''}
            This run becomes the reference that future runs are compared against.
          </Text>
        </View>
        <ListSection>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder={fallbackName}
            placeholderTextColor={colors.tertiaryLabel}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={() => void save()}
            accessibilityLabel="Route name"
            style={[typeScale.body, styles.input, { color: colors.label }]}
          />
        </ListSection>
        <View style={styles.actions}>
          <Button size="large" title="Save Route" onPress={() => void save()} loading={busy} />
          <Button variant="plain" title="Don't Save" onPress={discard} />
        </View>
      </Screen>
    );
  }

  const isReference = route?.referenceRunId === run.id;
  const canBeReference = !!run.summary?.route?.completed && !!route && !isReference;
  return (
    <Screen>
      {header}
      <RunReport run={run} route={route ?? null} />
      {canBeReference ? (
        <ListSection footer="Future runs on this route will be compared with this run. Your original baseline is kept.">
          <View style={styles.inset}>
            <Button
              variant="tinted"
              title="Use as Reference"
              onPress={() => void mutate((db) => setReferenceRun(db, route.id, run.id))}
            />
          </View>
        </ListSection>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { gap: space.s, paddingHorizontal: space.xxxl, paddingVertical: space.xxl },
  input: { paddingHorizontal: space.l, minHeight: 48 },
  actions: { marginHorizontal: space.l, gap: space.s },
  inset: { padding: space.s },
});
