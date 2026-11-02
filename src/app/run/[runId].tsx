import { Stack, router, useLocalSearchParams } from 'expo-router';
import { Alert, StyleSheet, View } from 'react-native';

import { deleteRun, replaceBaseline, setReferenceRun } from '@/data';
import { RunReport } from '@/features/runs/RunReport';
import { shareRunGpx } from '@/services/export';
import { useMutation, useRoute, useRunRecord } from '@/state/data-store';
import { Button, ListRow, ListSection, Screen, space } from '@/ui';
import { formatDay } from '@/ui/dates';

/** One completed run, with the explicit reference/baseline actions. */
export default function RunDetail() {
  const { runId } = useLocalSearchParams<{ runId: string }>();
  const { data: run } = useRunRecord(runId);
  const { data: route } = useRoute(run?.routeId ?? undefined);
  const mutate = useMutation();
  const header = <Stack.Screen options={{ headerShown: true, title: run ? formatDay(run.startedAt) : 'Run', headerRight: () => <Button variant="plain" title="Done" onPress={() => router.back()} /> }} />;
  if (!run) return <Screen>{header}</Screen>;

  const completed = !!run.summary?.route?.completed;
  const isReference = route?.referenceRunId === run.id;
  const isBaseline = route?.baselineRunId === run.id;
  const fail = (e: unknown) => Alert.alert('Not Possible', e instanceof Error ? e.message : String(e));

  const useAsReference = () => route && void mutate((db) => setReferenceRun(db, route.id, run.id)).catch(fail);
  const makeBaseline = () =>
    route &&
    Alert.alert('Replace the Original Baseline?', 'History will measure your change from this run instead. Your runs are not deleted.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Replace', style: 'destructive', onPress: () => void mutate((db) => replaceBaseline(db, route.id, run.id)).catch(fail) },
    ]);
  const remove = () =>
    Alert.alert('Delete This Run?', isReference || isBaseline ? 'It is this route’s reference or baseline, so it cannot be deleted. Choose another reference first.' : 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      ...(isReference || isBaseline
        ? []
        : [
            {
              text: 'Delete',
              style: 'destructive' as const,
              onPress: async () => {
                await mutate((db) => deleteRun(db, run.id));
                router.back();
              },
            },
          ]),
    ]);

  return (
    <Screen>
      {header}
      <RunReport run={run} route={route ?? null} />
      {route ? (
        <ListSection footer={completed ? undefined : 'Only a run that completed the whole route can be a reference.'}>
          {isReference ? (
            <ListRow icon="checkmark.circle.fill" title="Current Reference" />
          ) : (
            <ListRow icon="scope" title="Use as Reference" onPress={useAsReference} chevron={false} accent disabled={!completed} />
          )}
          {isBaseline ? (
            <ListRow icon="flag.checkered" title="Original Baseline" />
          ) : (
            <ListRow icon="flag.checkered" title="Replace Original Baseline" onPress={makeBaseline} chevron={false} accent disabled={!completed} />
          )}
        </ListSection>
      ) : null}
      <ListSection>
        <ListRow
          icon="square.and.arrow.up"
          title="Export GPX"
          onPress={() => void mutate((db) => shareRunGpx(db, run.id, `${route?.name ?? 'Run'} ${formatDay(run.startedAt)}`)).catch(fail)}
          chevron={false}
          accent
        />
        <ListRow icon="trash" title="Delete Run" onPress={remove} chevron={false} destructive />
      </ListSection>
      <View style={styles.pad} />
    </Screen>
  );
}

const styles = StyleSheet.create({ pad: { height: space.l } });
