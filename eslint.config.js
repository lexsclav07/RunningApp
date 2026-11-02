// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

/** src/core is the pure-TypeScript engine: no React, React Native, Expo or app-layer imports. */
const corePurity = {
  files: ['src/core/**'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: [
              'react',
              'react-native*',
              'expo*',
              '@expo/*',
              '@/data*',
              '@/services*',
              '@/state*',
              '@/ui*',
              '@/features*',
              '@/app*',
            ],
            message: 'src/core must stay pure TypeScript: no React, React Native, Expo or app-layer imports.',
          },
          {
            // any "@/" alias, or a relative path climbing into an app-layer folder
            regex: '^(@/|(\\.\\./)+(data|services|state|ui|features|app|components|hooks|constants|dev|widgets)(/|$))',
            caseSensitive: true,
            message: 'src/core imports only from src/core, using relative paths.',
          },
        ],
      },
    ],
  },
};

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
  corePurity,
  {
    // Expo template file (removed with the template in Task 9); it sets a hydration flag in an effect on purpose.
    files: ['src/hooks/use-color-scheme.web.ts'],
    rules: { 'react-hooks/set-state-in-effect': 'off' },
  },
]);
