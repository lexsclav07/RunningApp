import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import type { SymbolViewProps } from 'expo-symbols';

import { HIT, radius, space } from '../theme';
import { useTheme } from '../use-theme';
import { Icon } from './Icon';
import { Text } from './Text';

/** Inset-grouped section, as in Settings.app: optional header, rounded surface, hairline separators. */
export function ListSection({ header, footer, children, style }: { header?: string; footer?: ReactNode; children: ReactNode; style?: ViewStyle }) {
  const { colors } = useTheme();
  const rows = Children.toArray(children).filter(isValidElement);
  return (
    <View style={[styles.section, style]}>
      {header ? (
        <Text variant="footnote" color="secondaryLabel" style={styles.header} accessibilityRole="header">
          {header.toUpperCase()}
        </Text>
      ) : null}
      <View style={[styles.group, { backgroundColor: colors.surface }]}>
        {rows.map((row, i) => (
          <Fragment key={row.key ?? i}>
            {i > 0 ? <View style={[styles.separator, { backgroundColor: colors.separator }]} /> : null}
            {row}
          </Fragment>
        ))}
      </View>
      {footer ? (
        typeof footer === 'string' ? (
          <Text variant="footnote" color="secondaryLabel" style={styles.footer}>
            {footer}
          </Text>
        ) : (
          <View style={styles.footer}>{footer}</View>
        )
      ) : null}
    </View>
  );
}

export interface ListRowProps {
  title: string;
  subtitle?: string;
  value?: string;
  /** Monospaced digits for the value. */
  numericValue?: boolean;
  icon?: SymbolViewProps['name'];
  iconColor?: string;
  onPress?: () => void;
  chevron?: boolean;
  destructive?: boolean;
  accent?: boolean;
  accessory?: ReactNode;
  disabled?: boolean;
  accessibilityHint?: string;
}

export function ListRow({
  title,
  subtitle,
  value,
  numericValue,
  icon,
  iconColor,
  onPress,
  chevron = !!onPress,
  destructive,
  accent,
  accessory,
  disabled,
  accessibilityHint,
}: ListRowProps) {
  const { colors } = useTheme();
  const titleColor = destructive ? colors.danger : accent ? colors.accent : colors.label;
  const content = (pressed: boolean) => (
    <View style={[styles.row, pressed && { backgroundColor: colors.fill }, disabled && { opacity: 0.4 }]}>
      {icon ? (
        <View style={styles.icon}>
          <Icon name={icon} color={iconColor ?? (destructive ? colors.danger : colors.accent)} size={20} />
        </View>
      ) : null}
      <View style={styles.rowText}>
        <Text variant="body" style={{ color: titleColor }}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="footnote" color="secondaryLabel">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text variant="body" color="secondaryLabel" numeric={numericValue} numberOfLines={1} style={styles.value}>
          {value}
        </Text>
      ) : null}
      {accessory}
      {chevron ? <Icon name="chevron.right" size={13} weight="semibold" color={colors.tertiaryLabel} fallback="›" /> : null}
    </View>
  );
  if (!onPress) {
    return (
      <View accessible accessibilityLabel={[title, subtitle, value].filter(Boolean).join(', ')}>
        {content(false)}
      </View>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={[title, subtitle, value].filter(Boolean).join(', ')}
      accessibilityHint={accessibilityHint}
    >
      {({ pressed }) => content(pressed)}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { marginHorizontal: space.l, marginBottom: space.xxl },
  header: { marginLeft: space.l, marginBottom: space.xs + 2 },
  footer: { marginHorizontal: space.l, marginTop: space.xs + 2 },
  group: { borderRadius: radius.s, overflow: 'hidden', borderCurve: 'continuous' },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: space.l },
  row: { minHeight: HIT, flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.l, paddingVertical: space.s + 3, gap: space.m },
  icon: { width: 28, alignItems: 'center' },
  rowText: { flex: 1, gap: 1 },
  value: { flexShrink: 1, textAlign: 'right' },
});
