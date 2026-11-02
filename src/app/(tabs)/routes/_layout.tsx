import { Stack } from 'expo-router';

import { largeTitleOptions } from '@/ui/navigation';

export default function RoutesLayout() {
  return (
    <Stack screenOptions={largeTitleOptions()}>
      <Stack.Screen name="index" options={{ title: 'Routes' }} />
    </Stack>
  );
}
