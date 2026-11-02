import { Text as RNText, type TextProps as RNTextProps } from 'react-native';

import { numeric as numericStyle, type, type TypeVariant } from '../theme';
import { useTheme, type Theme } from '../use-theme';

export interface TextProps extends RNTextProps {
  variant?: TypeVariant;
  color?: keyof Theme['colors'] | (string & {});
  numeric?: boolean;
  weight?: '400' | '500' | '600' | '700' | '800';
  align?: 'left' | 'center' | 'right';
  forceDark?: boolean;
}

/** Text in the iOS type scale; colour names refer to the semantic palette. */
export function Text({ variant = 'body', color = 'label', numeric, weight, align, forceDark, style, ...rest }: TextProps) {
  const { colors } = useTheme(forceDark);
  const resolved = color in colors ? colors[color as keyof Theme['colors']] : color;
  return (
    <RNText
      maxFontSizeMultiplier={2}
      {...rest}
      style={[
        type[variant],
        { color: resolved },
        numeric && numericStyle,
        weight && { fontWeight: weight },
        align && { textAlign: align },
        style,
      ]}
    />
  );
}
