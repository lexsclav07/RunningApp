# Ghost Pace

An iPhone running app for improving your time on routes you run regularly. Your first run of a route records it. On every later run, Ghost Pace matches your position along the route and tells you, second by second, how far ahead of or behind you are:

- your **reference run**: what you ran last time at this exact point of the route;
- a **ghost target**: your reference run scaled to a target finish time, so it keeps your pacing on the hills.

Everything works offline and stays on the phone. There is no account, server or subscription.

## Status

| Area | State |
| --- | --- |
| Route matching, ghost pacing, splits, required pace, projected finish | Implemented and tested on simulated GPS (loops, out-and-backs, hairpins, noise, gaps, pauses) |
| Background GPS with the phone locked | Implemented (background location task, "Always" permission flow, crash recovery); **needs a real iPhone run to confirm** |
| Run screen, routes, history, settings | Implemented; layout not yet checked on a device |
| Spoken cues and haptics | Implemented; spoken cues with the screen locked **need on-device confirmation** |
| Lock Screen Live Activity and Dynamic Island | Implemented with `expo-widgets`; **only visible on a real iPhone** |
| GPX and JSON backup export | Implemented |
| Apple Watch, Android | Out of scope for v1 (the engine has no UI dependencies, so they can be added later) |

Automated checks: `npm test` (309 tests, including the brief's acceptance criteria 1–16), `npm run typecheck`, `npm run lint`, and `npx expo export --platform ios`, which compiles the iOS bundle.

## Put it on your iPhone without a Mac

The app needs a **development build**. Expo Go can't run background location or Live Activities. Apple only lets you install your own builds through a **paid Apple Developer Program membership** ($99/year). EAS Build compiles and signs the app in the cloud, so a Mac is never required.

1. Join the [Apple Developer Program](https://developer.apple.com/programs/) with your Apple ID.
2. Create a free [Expo account](https://expo.dev/signup).
3. In this folder:
   ```bash
   npm install
   npx eas-cli@latest login
   npx eas-cli@latest init                 # links the project to your Expo account
   npx eas-cli@latest device:create        # open the link on your iPhone and install the profile
   ```
4. On the iPhone, turn on **Settings › Privacy & Security › Developer Mode**. The phone restarts.
5. Build:
   ```bash
   npx eas-cli@latest build --profile development --platform ios
   ```
   EAS asks to sign in to your Apple account and creates the certificates and provisioning profile. When the build finishes (the free plan queue can take a while), open the link or QR code on the iPhone to install.
6. Day to day, start the dev server and open the app on the phone. The phone and computer must be on the same Wi-Fi; otherwise add `--tunnel`.
   ```bash
   npx expo start --dev-client
   ```
   JavaScript changes reload instantly. You only rebuild after changing native configuration (`app.json` plugins or native packages).

For a build that runs without the dev server, use `--profile preview`. For TestFlight, run `npx eas-cli@latest build --profile production --platform ios`, then `npx eas-cli@latest submit -p ios`.

The free EAS plan allows 15 iOS builds a month, at low priority.

## Try it without running

**Settings › Load Sample Data** adds a simulated 2.4 km hill loop with five simulated runs, all marked *Sample*. On the Run tab, **Try a Simulated Run** plays a live run with simulated GPS at real speed, marked *SIMULATED*. Neither ever mixes with your real runs.

## What to test on a real iPhone

Things that can't be verified without the device:

1. Record a route with the phone **locked in your pocket**. Grant **Always** location when asked (you'll see the blue location indicator). Then check that the route looks right.
2. Run the route again with a ghost target. Check that the gap and the bar respond sensibly, especially on the hills.
3. Pause, wait, resume: the gap should not jump.
4. Spoken cues with the screen locked (checkpoints, "Hill ahead", status changes).
5. The Live Activity on the Lock Screen and in the Dynamic Island, including the run timer while paused.
6. Force-quit the app mid-run: it should resume the run on the next location update or app launch.
7. Battery use over a 30–60 minute run.

## Development

```bash
npm test             # all tests
npm run test:core    # engine only
npx jest src/core/__tests__/matcher.test.ts   # one file
npm run typecheck
npm run lint
npx expo-doctor
```

On Windows, the same commands work in PowerShell.

How the code is organised is described in `CLAUDE.md`; the full design is in `docs/superpowers/specs/`.
