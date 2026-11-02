import { StyleSheet, View } from 'react-native';

import { formatDelta, statusOf, type ComparisonReading, type PrimaryComparison } from '@/core';
import { Text, fonts, numeric, space, useTheme } from '@/ui';

import { spokenAdvantage, statusLine } from './labels';

/**
 * The run screen's headline: the signed time difference in large rounded numerals, and the status in
 * words. When the reading is not reliable (weak GPS, off route) it dims and says why.
 */
export function DeltaHero({
  reading,
  kind,
  reliable,
  reason,
}: {
  reading: ComparisonReading | null;
  kind: PrimaryComparison;
  reliable: boolean;
  reason?: string | null;
}) {
  const { colors } = useTheme(true);
  const adv = reading?.advantage ?? null;
  const status = adv === null ? null : statusOf(adv);
  const color = status === 'ahead' ? colors.ahead : status === 'behind' ? colors.behind : colors.label;
  return (
    <View
      style={styles.wrap}
      accessible
      accessibilityRole="header"
      accessibilityLabel={adv === null ? 'Waiting for the first comparison' : spokenAdvantage(adv, kind)}
      accessibilityHint={!reliable && reason ? reason : undefined}
    >
      <Text
        forceDark
        numberOfLines={1}
        adjustsFontSizeToFit
        maxFontSizeMultiplier={1.15}
        style={[styles.hero, numeric, { color, opacity: reliable || adv === null ? 1 : 0.45 }]}
      >
        {adv === null ? '−−:−−' : formatDelta(adv)}
      </Text>
      <Text forceDark variant="subheadline" weight="700" style={[styles.status, { color: adv === null ? colors.secondaryLabel : color }]}>
        {adv === null ? (reason ?? 'WAITING FOR ROUTE') : statusLine(adv, kind)}
      </Text>
      {adv !== null && !reliable && reason ? (
        <Text forceDark variant="footnote" color="warning" style={styles.reason}>
          {reason}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  hero: { fontFamily: fonts.rounded, fontSize: 92, lineHeight: 104, fontWeight: '600', letterSpacing: -1 },
  status: { letterSpacing: 1.6, marginTop: -space.xs },
  reason: { marginTop: space.xs },
});
