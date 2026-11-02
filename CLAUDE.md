# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## What this is

Ghost Pace: an offline iPhone running app (Expo SDK 58, React Native 0.88, TypeScript strict, Expo Router). It records a route on the first run, then compares later runs position by position against a reference run and a proportionally scaled "ghost" target. The design spec, including decisions not stated in code, is `docs/superpowers/specs/2026-10-29-route-ghost-pacing-design.md`. The implementation plan is in `docs/superpowers/plans/`.

There is no Mac: iOS builds go through EAS (`eas.json`). Background GPS and the Live Activity don't run in Expo Go or on web, so features there can only be checked on a device. See README "What to test on a real iPhone".

## Commands

```bash
npm test                                   # jest (jest-expo preset)
npx jest src/core/__tests__/matcher.test.ts -t "out-and-back"   # single test
npm run typecheck                          # tsc --noEmit
npm run lint                               # expo lint (ESLint flat config)
npx expo export --platform ios --output-dir <tmp>   # proves the iOS JS bundle compiles
CI=1 npx expo prebuild --platform ios --no-install   # inspect generated native config, then delete ios/
```

Tests that use Node APIs (`node:sqlite`, `node:fs`) start with `/** @jest-environment node */` and `/// <reference types="node" />`. They import `describe/it/expect` from `@jest/globals` (TS 6 doesn't load jest globals). `@testing-library/react-native` v14's `render` is async: `await render(...)`.

## Architecture

The layers depend on each other in this order only: `src/core` ← `src/data` ← `src/state` ← `src/app` / `src/features` / `src/ui`.

- **`src/core`: pure TypeScript engine.** It never imports React, React Native, Expo or app folders; `eslint.config.js` enforces this. Import it via `@/core`.
  - A run is an ordered **event log** (`SessionEvent`: start/pause/resume/finish/fix). `RunSession.replay(config, events)` reproduces a run exactly. That replay is how crash recovery works, how a recording becomes a route (`buildRouteFromRecording`), and how any run is measured against a route (`computeRunProfile`).
  - `RouteMatcher` (`matcher.ts`, algorithm in its header) turns fixes into monotonic route progress. A search window along the route is what keeps loops and out-and-backs on the correct leg.
  - A `TimeProfile` maps route progress (m) to run time (s). Advantage = `timeAt(profile, progress) − runSec`, positive = ahead. The ghost is `scaleProfile(reference, target)`.
  - Units: fix timestamps are epoch **ms**; every duration is **seconds**. `runSec` excludes manual pauses and is used for all comparisons. The finish time is the route-end crossing, not the moment Finish was tapped.
  - `sim/` holds the deterministic GPS simulator used by tests and by the app's sample data.
- **`src/data`: SQLite.** It works through the `SqlDb` interface: expo-sqlite in the app (`expo-db.ts`), `node:sqlite` in tests (`testing/node-sqlite.ts`). Migrations are keyed to `PRAGMA user_version` in `schema.ts`; append new ones, never edit shipped ones.
  - Runs store raw fixes and markers. Summaries are derived data.
  - A route has an original `baselineRunId`, which only `replaceBaseline` changes, and a separately chosen `referenceRunId`.
- **`src/state`.**
  - `RunController` owns the active run. It applies GPS batches, flushes events to SQLite every 5 s or 10 events, recovers by replay, and drives cues, keep-awake and the Live Activity. Every operation goes through one queue.
  - It's platform-free and tested with fakes. `controller-instance.ts` wires it to device services.
  - `data-store.tsx` provides query hooks that refetch on `emitDataChanged()`.
- **`src/services`: device integrations.**
  - `location-task.ts` defines the background location task at module scope. It must stay the first import of `src/app/_layout.tsx`, because iOS can relaunch the app in the background straight into that task.
  - The Live Activity uses platform files: `live-activity.ios.ts` (expo-widgets) and a no-op `live-activity.ts`.
- **`src/widgets/RunActivity.tsx`: the Live Activity layout.** It's a `'widget'` function, so no runtime imports, hooks or outer variables are allowed. Everything it shows comes pre-formatted from `toLiveActivityPayload`.
- **UI.**
  - `src/ui` holds the design tokens (`theme.ts`: iOS semantic colours, a mint accent, an orange "behind" colour, the iOS type scale) and shared components.
  - The run screen (`src/app/live.tsx`) is always dark, using `useTheme(true)` / `forceDark`.
  - Changing numbers use `numeric` (tabular figures) and `fonts.rounded`.
  - Ahead/behind must never rely on colour alone: use the sign, the bar direction and words.

## Conventions

- Add packages with `npx expo install` (dev: `npx expo install -- --save-dev`). Keep dependencies minimal: no backend, accounts or analytics.
- `ios/` and `android/` are generated and gitignored. Configure native behaviour in `app.json` (location background mode, permission texts, the `expo-widgets` app group).
- Sample data and simulated runs must stay visibly labelled (`is_sample`, `source: 'simulated'`).
