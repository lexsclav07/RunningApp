import { Platform, type TextStyle } from 'react-native';

/**
 * Design tokens. Colours follow Apple's semantic system colours (grouped backgrounds, labels, separators)
 * with one restrained accent: mint/turquoise for the primary metric and active states. "Ahead" uses the
 * accent and "behind" uses system orange; neither is ever the only signal (signs, bar direction and words
 * carry the meaning too).
 */
export interface Palette {
  background: string;
  surface: string;
  surfaceElevated: string;
  label: string;
  secondaryLabel: string;
  tertiaryLabel: string;
  separator: string;
  fill: string;
  fillStrong: string;
  accent: string;
  onAccent: string;
  ahead: string;
  behind: string;
  danger: string;
  warning: string;
}

export const palettes: Record<'light' | 'dark', Palette> = {
  light: {
    background: '#F2F2F7',
    surface: '#FFFFFF',
    surfaceElevated: '#FFFFFF',
    label: '#000000',
    secondaryLabel: 'rgba(60,60,67,0.6)',
    tertiaryLabel: 'rgba(60,60,67,0.3)',
    separator: 'rgba(60,60,67,0.29)',
    fill: 'rgba(120,120,128,0.12)',
    fillStrong: 'rgba(120,120,128,0.2)',
    accent: '#00A99D',
    onAccent: '#FFFFFF',
    ahead: '#00A99D',
    behind: '#E07800',
    danger: '#FF3B30',
    warning: '#FF9500',
  },
  dark: {
    background: '#000000',
    surface: '#1C1C1E',
    surfaceElevated: '#2C2C2E',
    label: '#FFFFFF',
    secondaryLabel: 'rgba(235,235,245,0.6)',
    tertiaryLabel: 'rgba(235,235,245,0.3)',
    separator: 'rgba(84,84,88,0.65)',
    fill: 'rgba(120,120,128,0.24)',
    fillStrong: 'rgba(120,120,128,0.36)',
    accent: '#5EE6D0',
    onAccent: '#000000',
    ahead: '#5EE6D0',
    behind: '#FF9F0A',
    danger: '#FF453A',
    warning: '#FF9F0A',
  },
};

export const space = { xxs: 2, xs: 4, s: 8, m: 12, l: 16, xl: 20, xxl: 24, xxxl: 32, huge: 48 } as const;
export const radius = { s: 10, m: 14, l: 22, pill: 999 } as const;

/** SF Pro (system) and SF Pro Rounded, which Apple uses for workout metrics. */
export const fonts = {
  system: Platform.select({ ios: 'System', default: undefined }),
  rounded: Platform.select({ ios: 'ui-rounded', default: undefined }),
};

/** iOS Dynamic Type default sizes (points). */
export const type = {
  largeTitle: { fontSize: 34, lineHeight: 41, fontWeight: '700' },
  title1: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  title2: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
  title3: { fontSize: 20, lineHeight: 25, fontWeight: '600' },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  body: { fontSize: 17, lineHeight: 22, fontWeight: '400' },
  callout: { fontSize: 16, lineHeight: 21, fontWeight: '400' },
  subheadline: { fontSize: 15, lineHeight: 20, fontWeight: '400' },
  footnote: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '400' },
  caption2: { fontSize: 11, lineHeight: 13, fontWeight: '400' },
} satisfies Record<string, TextStyle>;

export type TypeVariant = keyof typeof type;

/** Changing numbers must not jitter as digits change width. */
export const numeric: TextStyle = { fontVariant: ['tabular-nums'] };

/** Small uppercase labels above metrics. */
export const metricLabel: TextStyle = { fontSize: 12, lineHeight: 16, fontWeight: '600', letterSpacing: 0.6, textTransform: 'uppercase' };

/** Minimum touch target (pt). */
export const HIT = 44;
