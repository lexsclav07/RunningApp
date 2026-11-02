import { useColorScheme } from 'react-native';

import { palettes, type Palette } from './theme';

export interface Theme {
  dark: boolean;
  colors: Palette;
}

/** Current palette. The Appearance setting is applied app-wide with Appearance.setColorScheme. */
export function useTheme(forceDark = false): Theme {
  const scheme = useColorScheme();
  const dark = forceDark || scheme === 'dark';
  return { dark, colors: palettes[dark ? 'dark' : 'light'] };
}
