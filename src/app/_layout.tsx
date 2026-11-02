// Must run first: defines the background location task before anything renders (see the file header).
import '@/services/location-task';

import { DarkTheme, DefaultTheme, Stack, ThemeProvider, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Appearance, View, useColorScheme } from 'react-native';

import { runController } from '@/state/controller-instance';
import { DataProvider, useSettings } from '@/state/data-store';
import { palettes } from '@/ui';

function navTheme(dark: boolean) {
  const base = dark ? DarkTheme : DefaultTheme;
  const p = palettes[dark ? 'dark' : 'light'];
  return {
    ...base,
    colors: { ...base.colors, primary: p.accent, background: p.background, card: p.background, text: p.label, border: p.separator },
  };
}

function RootStack() {
  const [settings] = useSettings();
  const scheme = useColorScheme();
  const appearance = settings?.appearance;

  useEffect(() => {
    if (appearance) Appearance.setColorScheme(appearance === 'system' ? 'auto' : appearance);
  }, [appearance]);

  // A run interrupted by a crash or iOS termination resumes where it left off.
  useEffect(() => {
    runController.recover().then(
      (found) => found && router.push('/live'),
      () => undefined,
    );
  }, []);

  return (
    <ThemeProvider value={navTheme(scheme === 'dark')}>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="live" options={{ presentation: 'fullScreenModal', gestureEnabled: false, animation: 'fade' }} />
        <Stack.Screen name="summary/[runId]" options={{ presentation: 'modal', gestureEnabled: false }} />
        <Stack.Screen
          name="target"
          options={{ presentation: 'formSheet', headerShown: true, title: 'Ghost Target', sheetAllowedDetents: [0.8, 1], sheetGrabberVisible: true }}
        />
        <Stack.Screen name="select-route" options={{ presentation: 'modal', headerShown: true, title: 'Choose Route' }} />
        <Stack.Screen name="run/[runId]" options={{ presentation: 'modal' }} />
      </Stack>
    </ThemeProvider>
  );
}

export default function RootLayout() {
  const scheme = useColorScheme();
  return (
    <DataProvider fallback={<View style={{ flex: 1, backgroundColor: palettes[scheme === 'dark' ? 'dark' : 'light'].background }} />}>
      <RootStack />
    </DataProvider>
  );
}
