import { useEffect, useState } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';

import { barGeometry, formatDelta, type PrimaryComparison } from '@/core';
import { Icon, Text, metricLabel, numeric, space, useTheme } from '@/ui';
import { useReduceMotion } from '@/ui/use-reduce-motion';

import { spokenAdvantage } from './labels';

export interface DivergingBarProps {
  /** Seconds ahead (+) or behind (−); null before the first comparison. */
  advantage: number | null;
  /** Half-range of the bar in seconds (from barScale). */
  scale: number;
  kind: PrimaryComparison;
  /** Switches ghost ↔ baseline when both exist. */
  onPress?: () => void;
  dimmed?: boolean;
}

/**
 * Horizontal diverging bar with a fixed zero line: ahead fills to the right, behind to the left. Direction,
 * the signed number and the end labels carry the meaning, so it reads without colour.
 */
export function DivergingBar({ advantage, scale, kind, onPress, dimmed }: DivergingBarProps) {
  const { colors } = useTheme(true);
  const reduceMotion = useReduceMotion();
  const geo = barGeometry(advantage, scale);
  const [anim] = useState(() => new Animated.Value(geo.fraction));

  useEffect(() => {
    Animated.timing(anim, { toValue: geo.fraction, duration: reduceMotion ? 0 : 300, useNativeDriver: true }).start();
  }, [anim, geo.fraction, reduceMotion]);

  const fillColor = geo.side === 'ahead' ? colors.ahead : colors.behind;
  const label = advantage === null ? `No comparison with ${kind} yet` : spokenAdvantage(advantage, kind);
  const body = (
    <View style={{ opacity: dimmed ? 0.45 : 1 }}>
      <View style={styles.head}>
        <View style={styles.kind}>
          <Text forceDark color="secondaryLabel" style={metricLabel}>
            {kind === 'ghost' ? 'vs Ghost' : 'vs Baseline'}
          </Text>
          {onPress ? <Icon name="arrow.left.arrow.right" size={11} color={colors.secondaryLabel} fallback="⇄" /> : null}
        </View>
        <Text forceDark variant="headline" style={[numeric, { color: geo.side === 'none' ? colors.label : fillColor }]}>
          {advantage === null ? '—' : formatDelta(advantage)}
        </Text>
      </View>
      <View style={[styles.track, { backgroundColor: colors.fill }]}>
        <View style={styles.half}>
          {geo.side === 'behind' ? (
            <Animated.View
              testID="bar-fill-behind"
              style={[styles.fill, styles.fillLeft, { backgroundColor: fillColor, transform: [{ scaleX: anim }] }]}
            />
          ) : null}
        </View>
        <View style={styles.half}>
          {geo.side === 'ahead' ? (
            <Animated.View
              testID="bar-fill-ahead"
              style={[styles.fill, styles.fillRight, { backgroundColor: fillColor, transform: [{ scaleX: anim }] }]}
            />
          ) : null}
        </View>
        <View testID="bar-zero" style={[styles.zero, { backgroundColor: colors.label }]} />
      </View>
      <View style={styles.scale}>
        <Text forceDark variant="caption2" color="tertiaryLabel" weight="600">
          BEHIND
        </Text>
        <Text forceDark variant="caption2" color="tertiaryLabel" numeric>
          ±{scale < 60 ? `${scale} s` : `${scale / 60} min`}
        </Text>
        <Text forceDark variant="caption2" color="tertiaryLabel" weight="600">
          AHEAD
        </Text>
      </View>
    </View>
  );
  const a11y = {
    accessible: true,
    accessibilityLabel: label,
    accessibilityValue: { min: -scale, max: scale, now: advantage === null ? 0 : Math.round(advantage) },
  };
  return onPress ? (
    <Pressable {...a11y} onPress={onPress} accessibilityRole="button" accessibilityHint="Switches between ghost and baseline">
      {body}
    </Pressable>
  ) : (
    <View {...a11y}>{body}</View>
  );
}

const TRACK = 12;

const styles = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: space.s },
  kind: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  track: { height: TRACK, borderRadius: TRACK / 2, flexDirection: 'row', overflow: 'visible' },
  half: { flex: 1, overflow: 'hidden' },
  fill: { position: 'absolute', top: 0, bottom: 0, width: '100%' },
  fillLeft: { right: 0, transformOrigin: 'right', borderTopLeftRadius: TRACK / 2, borderBottomLeftRadius: TRACK / 2 },
  fillRight: { left: 0, transformOrigin: 'left', borderTopRightRadius: TRACK / 2, borderBottomRightRadius: TRACK / 2 },
  zero: { position: 'absolute', left: '50%', marginLeft: -1, width: 2, top: -7, bottom: -7, borderRadius: 1 },
  scale: { flexDirection: 'row', justifyContent: 'space-between', marginTop: space.s + 2 },
});
