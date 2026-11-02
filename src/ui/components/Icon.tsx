import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import type { ColorValue } from 'react-native';

import { Text } from './Text';

/** SF Symbol (iOS); elsewhere a small text fallback so previews still show something. */
export function Icon({
  name,
  size = 17,
  color,
  weight = 'medium',
  fallback,
}: {
  name: SymbolViewProps['name'];
  size?: number;
  color: ColorValue;
  weight?: SymbolViewProps['weight'];
  fallback?: string;
}) {
  return (
    <SymbolView
      name={name}
      size={size}
      tintColor={color}
      weight={weight}
      resizeMode="scaleAspectFit"
      style={{ width: size, height: size }}
      fallback={
        <Text variant="caption" style={{ color: color as string, width: size, textAlign: 'center' }}>
          {fallback ?? '•'}
        </Text>
      }
    />
  );
}
