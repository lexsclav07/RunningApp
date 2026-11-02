import { router } from 'expo-router';

import { formatClock } from '@/core';
import { useRoutes } from '@/state/data-store';
import { EmptyState, ListRow, ListSection, Screen } from '@/ui';
import { formatRelativeDay } from '@/ui/dates';

export default function HistoryScreen() {
  const { data: routes } = useRoutes();
  const withRuns = (routes ?? []).filter((r) => r.runCount > 0);
  if (routes && withRuns.length === 0) {
    return (
      <Screen>
        <EmptyState title="No Runs Yet" message="Your completed runs appear here, grouped by route, with your progress over time." />
      </Screen>
    );
  }
  return (
    <Screen>
      <ListSection header="Routes">
        {withRuns.map((r) => (
          <ListRow
            key={r.id}
            title={r.name}
            subtitle={[`${r.runCount} run${r.runCount === 1 ? '' : 's'}`, r.lastRunAt ? formatRelativeDay(r.lastRunAt) : null, r.isSample ? 'Sample' : null]
              .filter(Boolean)
              .join(' · ')}
            value={r.bestSec !== null ? `Best ${formatClock(r.bestSec)}` : undefined}
            numericValue
            onPress={() => router.push(`/history/${r.id}`)}
          />
        ))}
      </ListSection>
    </Screen>
  );
}
