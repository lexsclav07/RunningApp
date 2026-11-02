import { StyleSheet, View } from 'react-native';

import { Text, fonts, metricLabel, numeric, useTheme } from '@/ui';

/** A labelled metric on the dark run screen. `size` sets the visual weight in the hierarchy. */
export function MetricCell({
  label,
  value,
  unit,
  size = 'm',
  tone = 'label',
  align = 'left',
  accessibilityLabel,
}: {
  label: string;
  value: string;
  unit?: string;
  size?: 'l' | 'm' | 's';
  tone?: 'label' | 'accent' | 'warning' | 'secondary';
  align?: 'left' | 'right';
  accessibilityLabel?: string;
}) {
  const { colors } = useTheme(true);
  const color =
    tone === 'accent' ? colors.accent : tone === 'warning' ? colors.warning : tone === 'secondary' ? colors.secondaryLabel : colors.label;
  const fontSize = size === 'l' ? 40 : size === 'm' ? 30 : 22;
  return (
    <View
      style={[styles.cell, { alignItems: align === 'right' ? 'flex-end' : 'flex-start' }]}
      accessible
      accessibilityLabel={accessibilityLabel ?? `${label} ${value}${unit ? ` ${unit}` : ''}`}
    >
      <Text forceDark color="secondaryLabel" style={metricLabel} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.valueRow}>
        <Text
          forceDark
          numberOfLines={1}
          adjustsFontSizeToFit
          maxFontSizeMultiplier={1.3}
          style={[numeric, { fontFamily: fonts.rounded, fontSize, lineHeight: fontSize * 1.15, fontWeight: '600', color }]}
        >
          {value}
        </Text>
        {unit ? (
          <Text forceDark variant="footnote" color="secondaryLabel" weight="600" style={styles.unit}>
            {unit}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  cell: { flex: 1, gap: 2 },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  unit: { marginBottom: 2 },
});
