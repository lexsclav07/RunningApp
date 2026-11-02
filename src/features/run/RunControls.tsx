import type { SymbolViewProps } from 'expo-symbols';
import { Pressable, StyleSheet, View } from 'react-native';

import { Icon, Text, space, useTheme } from '@/ui';

function RoundButton({
  icon,
  label,
  onPress,
  filled,
}: {
  icon: SymbolViewProps['name'];
  label: string;
  onPress: () => void;
  filled?: boolean;
}) {
  const { colors } = useTheme(true);
  return (
    <View style={styles.item}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
        hitSlop={8}
        style={({ pressed }) => [
          styles.round,
          { backgroundColor: filled ? colors.accent : colors.fillStrong, transform: [{ scale: pressed ? 0.94 : 1 }] },
        ]}
      >
        <Icon name={icon} size={28} weight="bold" color={filled ? colors.onAccent : colors.label} />
      </Pressable>
      <Text forceDark variant="caption" weight="600" color="secondaryLabel">
        {label}
      </Text>
    </View>
  );
}

/** Pause/Resume and Finish. Finishing (and discarding) is confirmed by the screen. */
export function RunControls({
  phase,
  onPause,
  onResume,
  onFinish,
}: {
  phase: 'running' | 'paused' | 'idle' | 'finished';
  onPause: () => void;
  onResume: () => void;
  onFinish: () => void;
}) {
  return (
    <View style={styles.row}>
      <RoundButton icon="stop.fill" label="Finish" onPress={onFinish} />
      {phase === 'paused' ? (
        <RoundButton icon="play.fill" label="Resume" onPress={onResume} filled />
      ) : (
        <RoundButton icon="pause.fill" label="Pause" onPress={onPause} filled />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'center', gap: space.huge + space.l },
  item: { alignItems: 'center', gap: space.xs + 2 },
  round: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center' },
});
