import type { SymbolViewProps } from 'expo-symbols';
import { StyleSheet, View } from 'react-native';

import type { GpsQuality, MatchState } from '@/core';
import { Icon, Text, space, useTheme } from '@/ui';

type Tone = 'ok' | 'neutral' | 'warning' | 'danger';

function Chip({ icon, text, tone, a11y }: { icon: SymbolViewProps['name']; text: string; tone: Tone; a11y: string }) {
  const { colors } = useTheme(true);
  const color = tone === 'ok' ? colors.accent : tone === 'warning' ? colors.warning : tone === 'danger' ? colors.danger : colors.secondaryLabel;
  return (
    <View style={[styles.chip, { backgroundColor: colors.fill }]} accessible accessibilityLabel={a11y}>
      <Icon name={icon} size={11} color={color} weight="semibold" />
      <Text forceDark variant="caption2" weight="700" style={{ color, letterSpacing: 0.4 }}>
        {text}
      </Text>
    </View>
  );
}

const GPS: Record<GpsQuality, { text: string; tone: Tone }> = {
  good: { text: 'GPS', tone: 'ok' },
  fair: { text: 'GPS', tone: 'neutral' },
  poor: { text: 'WEAK GPS', tone: 'warning' },
  none: { text: 'NO GPS', tone: 'danger' },
};

const MATCH: Record<MatchState, { text: string; tone: Tone; icon: SymbolViewProps['name'] }> = {
  onRoute: { text: 'ON ROUTE', tone: 'ok', icon: 'point.topleft.down.to.point.bottomright.curvepath' },
  acquiring: { text: 'HEAD TO START', tone: 'neutral', icon: 'flag' },
  offRoute: { text: 'OFF ROUTE', tone: 'warning', icon: 'exclamationmark.triangle.fill' },
  lost: { text: 'SIGNAL LOST', tone: 'danger', icon: 'location.slash' },
};

/** Small GPS / route / source indicators for the top of the run screen. */
export function StatusChips({
  gps,
  accuracy,
  match,
  simulated,
  foregroundOnly,
}: {
  gps: GpsQuality;
  accuracy: number | null;
  match: MatchState | null;
  simulated: boolean;
  foregroundOnly: boolean;
}) {
  const g = GPS[gps];
  return (
    <View style={styles.row}>
      {simulated ? <Chip icon="wand.and.stars" text="SIMULATED" tone="warning" a11y="Simulated GPS, not a real run" /> : null}
      {foregroundOnly ? (
        <Chip icon="lock.open" text="KEEP APP OPEN" tone="warning" a11y="Only While Using location access: tracking stops if you lock the phone" />
      ) : null}
      <Chip
        icon="location.fill"
        text={g.text}
        tone={g.tone}
        a11y={`GPS ${gps}${accuracy !== null ? `, accurate to ${Math.round(accuracy)} metres` : ''}`}
      />
      {match ? <Chip icon={MATCH[match].icon} text={MATCH[match].text} tone={MATCH[match].tone} a11y={MATCH[match].text.toLowerCase()} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs + 2, justifyContent: 'flex-end' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999 },
});
