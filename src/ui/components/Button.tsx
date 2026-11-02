import type { SymbolViewProps } from 'expo-symbols';
import { ActivityIndicator, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';

import { HIT, radius, space } from '../theme';
import { useTheme } from '../use-theme';
import { Icon } from './Icon';
import { Text } from './Text';

export interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: 'filled' | 'tinted' | 'plain' | 'destructive';
  size?: 'large' | 'regular';
  icon?: SymbolViewProps['name'];
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
  forceDark?: boolean;
  accessibilityHint?: string;
}

export function Button({ title, onPress, variant = 'filled', size = 'regular', icon, disabled, loading, style, forceDark, accessibilityHint }: ButtonProps) {
  const { colors } = useTheme(forceDark);
  const bg =
    variant === 'filled' ? colors.accent : variant === 'tinted' ? colors.fill : variant === 'destructive' ? colors.fill : 'transparent';
  const fg = variant === 'filled' ? colors.onAccent : variant === 'destructive' ? colors.danger : colors.accent;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!(disabled || loading), busy: !!loading }}
      style={({ pressed }) => [
        styles.base,
        size === 'large' ? styles.large : styles.regular,
        { backgroundColor: bg, opacity: disabled ? 0.4 : pressed ? 0.75 : 1 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <View style={styles.content}>
          {icon ? <Icon name={icon} color={fg} size={size === 'large' ? 19 : 16} weight="semibold" /> : null}
          <Text variant={size === 'large' ? 'headline' : 'body'} weight="600" style={{ color: fg }}>
            {title}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
  large: { minHeight: 54, borderRadius: radius.m, paddingHorizontal: space.xl },
  regular: { minHeight: HIT, borderRadius: radius.s, paddingHorizontal: space.l },
  content: { flexDirection: 'row', alignItems: 'center', gap: space.s },
});
