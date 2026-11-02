import type { ComponentProps } from 'react';
import type { Stack } from 'expo-router';

type StackOptions = NonNullable<ComponentProps<typeof Stack>['screenOptions']>;

/** Native large-title headers that collapse on scroll, with the system blur, as in Apple's apps. */
export function largeTitleOptions(): Exclude<StackOptions, (...args: never[]) => unknown> {
  return {
    headerLargeTitleEnabled: true,
    headerLargeTitleShadowVisible: false,
    headerShadowVisible: false,
    headerTransparent: true,
    headerBlurEffect: 'systemChromeMaterial',
    headerBackButtonDisplayMode: 'minimal',
  };
}
