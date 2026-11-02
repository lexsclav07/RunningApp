import { HStack, Image, Rectangle, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import { cornerRadius, font, foregroundStyle, frame, monospacedDigit, padding } from '@expo/ui/swift-ui/modifiers';
import { createLiveActivity, type LiveActivityEnvironment } from 'expo-widgets';

import type { LiveActivityPayload } from '@/core';

/**
 * Lock Screen / Dynamic Island Live Activity for a run. Widget code runs in the iOS widget extension:
 * it may not use imports at runtime, hooks or outer variables, so every value it shows comes from the
 * payload (pre-formatted by toLiveActivityPayload) and constants are declared inside the function.
 * The run clock is a SwiftUI timer text, so it ticks on the Lock Screen without app updates.
 */
const RunActivity = (p: LiveActivityPayload, env: LiveActivityEnvironment) => {
  'widget';
  const mint = env.isLuminanceReduced ? '#FFFFFF' : '#5EE6D0';
  const orange = env.isLuminanceReduced ? '#FFFFFF' : '#FF9F0A';
  const grey = '#8E8E93';
  const deltaColor = p.status === 'ahead' ? mint : p.status === 'behind' ? orange : '#FFFFFF';
  const statusText =
    p.status === 'ahead'
      ? `AHEAD OF ${p.comparisonLabel}`
      : p.status === 'behind'
        ? `BEHIND ${p.comparisonLabel}`
        : p.status === 'onTarget'
          ? 'ON TARGET'
          : 'RECORDING';
  const started = new Date(p.startedAtMs);
  const timer = (
    <Text
      timerInterval={{ lower: started, upper: new Date(p.startedAtMs + 24 * 3600 * 1000) }}
      countsDown={false}
      pauseTime={p.pausedAtMs !== null ? new Date(p.pausedAtMs) : undefined}
      modifiers={[font({ size: 22, weight: 'semibold', design: 'rounded' }), monospacedDigit(), foregroundStyle('#FFFFFF')]}
    />
  );
  // diverging bar: two 120 pt halves around a zero line; behind fills leftwards, ahead rightwards
  const half = 120;
  const behindW = p.barFraction < 0 ? Math.round(-p.barFraction * half) : 0;
  const aheadW = p.barFraction > 0 ? Math.round(p.barFraction * half) : 0;
  const bar = (
    <HStack spacing={2} alignment="center">
      <HStack spacing={0} modifiers={[cornerRadius(3)]}>
        <Rectangle modifiers={[foregroundStyle('#3A3A3C'), frame({ width: half - behindW, height: 6 })]} />
        <Rectangle modifiers={[foregroundStyle(orange), frame({ width: behindW, height: 6 })]} />
      </HStack>
      <Rectangle modifiers={[foregroundStyle('#FFFFFF'), frame({ width: 2, height: 14 })]} />
      <HStack spacing={0} modifiers={[cornerRadius(3)]}>
        <Rectangle modifiers={[foregroundStyle(mint), frame({ width: aheadW, height: 6 })]} />
        <Rectangle modifiers={[foregroundStyle('#3A3A3C'), frame({ width: half - aheadW, height: 6 })]} />
      </HStack>
    </HStack>
  );
  const delta = (size: number) => (
    <Text modifiers={[font({ size, weight: 'semibold', design: 'rounded' }), monospacedDigit(), foregroundStyle(deltaColor)]}>{p.deltaText || '—'}</Text>
  );

  return {
    banner: (
      <VStack alignment="leading" spacing={8} modifiers={[padding({ all: 16 })]}>
        <HStack spacing={6}>
          <Image systemName="figure.run" color={mint} size={14} />
          <Text modifiers={[font({ size: 15, weight: 'semibold' }), foregroundStyle('#FFFFFF')]}>{p.routeName}</Text>
          <Spacer />
          <Text modifiers={[font({ size: 11, weight: 'bold' }), foregroundStyle(grey)]}>{p.distanceText}</Text>
        </HStack>
        <HStack alignment="firstTextBaseline">
          <VStack alignment="leading" spacing={0}>
            {delta(34)}
            <Text modifiers={[font({ size: 11, weight: 'bold' }), foregroundStyle(deltaColor)]}>{statusText}</Text>
          </VStack>
          <Spacer />
          <VStack alignment="trailing" spacing={0}>
            {timer}
            <Text modifiers={[font({ size: 13, weight: 'medium' }), monospacedDigit(), foregroundStyle(grey)]}>{`${p.paceText} /km`}</Text>
          </VStack>
        </HStack>
        {p.comparisonLabel ? bar : null}
      </VStack>
    ),
    compactLeading: <Image systemName="figure.run" color={mint} />,
    compactTrailing: delta(14),
    minimal: <Image systemName="figure.run" color={deltaColor} />,
    expandedLeading: (
      <VStack alignment="leading" spacing={0} modifiers={[padding({ leading: 4 })]}>
        {delta(28)}
        <Text modifiers={[font({ size: 11, weight: 'bold' }), foregroundStyle(deltaColor)]}>{statusText}</Text>
      </VStack>
    ),
    expandedTrailing: (
      <VStack alignment="trailing" spacing={0} modifiers={[padding({ trailing: 4 })]}>
        {timer}
        <Text modifiers={[font({ size: 13, weight: 'medium' }), monospacedDigit(), foregroundStyle(grey)]}>{`${p.paceText} /km`}</Text>
      </VStack>
    ),
    expandedBottom: p.comparisonLabel ? (
      <VStack spacing={6} modifiers={[padding({ top: 6 })]}>
        {bar}
        <Text modifiers={[font({ size: 12, weight: 'semibold' }), foregroundStyle(grey)]}>{p.routeName}</Text>
      </VStack>
    ) : (
      <Text modifiers={[font({ size: 12, weight: 'semibold' }), foregroundStyle(grey)]}>{p.routeName}</Text>
    ),
  };
};

export default createLiveActivity<LiveActivityPayload>('RunActivity', RunActivity);
