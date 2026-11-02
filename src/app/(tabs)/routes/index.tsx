import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { formatClock, formatDistance } from '@/core';
import { useRoutes } from '@/state/data-store';
import { Button, EmptyState, ListRow, ListSection, Screen, space } from '@/ui';
import { formatRelativeDay } from '@/ui/dates';

export default function RoutesScreen() {
  const { data: routes } = useRoutes();
  if (routes && routes.length === 0) {
    return (
      <Screen>
        <EmptyState
          title="No Routes Yet"
          message="Record a route on your first run. Each route keeps its own reference, ghost target and history."
          action={<Button size="large" title="Record a Route" icon="record.circle" onPress={() => router.navigate('/')} />}
        />
      </Screen>
    );
  }
  return (
    <Screen>
      <ListSection>
        {(routes ?? []).map((r) => (
          <ListRow
            key={r.id}
            title={r.name}
            subtitle={[
              formatDistance(r.length),
              r.elevationGain !== null ? `↑ ${Math.round(r.elevationGain)} m` : null,
              r.lastRunAt ? formatRelativeDay(r.lastRunAt) : null,
              r.isSample ? 'Sample' : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            value={r.bestSec !== null ? formatClock(r.bestSec) : undefined}
            numericValue
            onPress={() => router.push(`/routes/${r.id}`)}
          />
        ))}
      </ListSection>
      <View style={styles.add}>
        <Button variant="tinted" title="Record New Route" icon="plus" onPress={() => router.navigate('/')} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({ add: { marginHorizontal: space.l } });
