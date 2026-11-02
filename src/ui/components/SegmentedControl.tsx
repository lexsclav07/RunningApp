import { Pressable, StyleSheet, View } from 'react-native';

import { space } from '../theme';
import { useTheme } from '../use-theme';
import { Text } from './Text';

/** iOS-style segmented control. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  forceDark,
  accessibilityLabel,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  forceDark?: boolean;
  accessibilityLabel?: string;
}) {
  const { colors, dark } = useTheme(forceDark);
  return (
    <View style={[styles.track, { backgroundColor: colors.fill }]} accessibilityRole="tablist" accessibilityLabel={accessibilityLabel}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={o.label}
            style={[
              styles.segment,
              selected && [styles.selected, { backgroundColor: dark ? colors.surfaceElevated : colors.surface }],
            ]}
          >
            <Text variant="subheadline" weight={selected ? '600' : '500'} forceDark={forceDark} numberOfLines={1}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { flexDirection: 'row', borderRadius: 9, padding: 2, borderCurve: 'continuous' },
  segment: { flex: 1, minHeight: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 7, paddingHorizontal: space.s },
  selected: {
    boxShadow: '0px 3px 8px rgba(0,0,0,0.12), 0px 3px 1px rgba(0,0,0,0.04)',
    borderCurve: 'continuous',
  },
});
