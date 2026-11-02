import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { space } from '../theme';
import { useTheme } from '../use-theme';
import { Text } from './Text';

/**
 * Scrolling screen body under a native large-title header (contentInsetAdjustmentBehavior lets the
 * title collapse on scroll and keeps content clear of the tab bar).
 */
export function Screen({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.flex, { backgroundColor: colors.background }]}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={styles.flex}
        contentContainerStyle={styles.content}
        keyboardDismissMode="interactive"
      >
        {children}
      </ScrollView>
      {footer}
    </View>
  );
}

/** Centred message for empty lists. */
export function EmptyState({ title, message, action }: { title: string; message: string; action?: ReactNode }) {
  return (
    <View style={styles.empty}>
      <Text variant="title3" align="center">
        {title}
      </Text>
      <Text variant="subheadline" color="secondaryLabel" align="center">
        {message}
      </Text>
      {action ? <View style={styles.emptyAction}>{action}</View> : null}
    </View>
  );
}

/** Small pill label (e.g. "Sample", "SIMULATED"). */
export function Badge({ label, tone = 'neutral', forceDark }: { label: string; tone?: 'neutral' | 'accent' | 'warning'; forceDark?: boolean }) {
  const { colors } = useTheme(forceDark);
  const fg = tone === 'accent' ? colors.accent : tone === 'warning' ? colors.warning : colors.secondaryLabel;
  return (
    <View style={[styles.badge, { backgroundColor: colors.fill }]}>
      <Text variant="caption2" weight="700" style={{ color: fg, letterSpacing: 0.5 }}>
        {label.toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingTop: space.s, paddingBottom: space.huge },
  empty: { alignItems: 'center', gap: space.s, paddingHorizontal: space.xxxl, paddingVertical: space.huge },
  emptyAction: { marginTop: space.l, alignSelf: 'stretch' },
  badge: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, alignSelf: 'flex-start' },
});
