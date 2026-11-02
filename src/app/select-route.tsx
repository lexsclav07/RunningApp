import { router } from 'expo-router';

import { formatClock, formatDistance } from '@/core';
import { useRoutes } from '@/state/data-store';
import { selectRoute, useSelectedRouteId } from '@/state/selection';
import { EmptyState, Icon, ListRow, ListSection, Screen, useTheme } from '@/ui';

export default function SelectRoute() {
  const { data: routes } = useRoutes();
  const selected = useSelectedRouteId();
  const { colors } = useTheme();
  if (routes && routes.length === 0) return <EmptyState title="No Routes Yet" message="Record a route first from the Run tab." />;
  return (
    <Screen>
      <ListSection>
        {(routes ?? []).map((r) => (
          <ListRow
            key={r.id}
            title={r.name}
            subtitle={[formatDistance(r.length), r.bestSec !== null ? `best ${formatClock(r.bestSec)}` : null, r.isSample ? 'sample' : null]
              .filter(Boolean)
              .join(' · ')}
            chevron={false}
            accessory={r.id === selected ? <Icon name="checkmark" size={16} weight="semibold" color={colors.accent} fallback="✓" /> : undefined}
            onPress={() => {
              selectRoute(r.id);
              router.back();
            }}
          />
        ))}
      </ListSection>
    </Screen>
  );
}
