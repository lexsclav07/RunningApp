# Route Ghost Pacing — Design Spec

> Source: the user's brief, pasted verbatim on 2026-10-29 (sections 1–15 and "Final priorities" below).
> The section **"Decisions made during planning"** at the end records choices Claude made where the
> brief left room; each is Claude's call, not something the user stated.

---

# Build a Premium iPhone Running App — Route Ghost Pacing

Act as a senior mobile app engineer, product designer, GPS tracking specialist, and software architect. Build a polished, functional running app focused on helping me improve my running time on saved GPS routes.

I want an app that records a route on my first run, then acts as a real-time pacing coach on future runs. It must tell me how far ahead or behind I am compared with a previous run and a chosen target finish time, accounting for the fact that hills affect my pace.

I have attached a reference image of a running interface. Use it to understand the type of running data I want displayed, but redesign the interface using Apple's design philosophy.

**The most important requirements are accurate route-specific pace comparison, ghost-run pacing, reliable GPS tracking on a locked iPhone, and a beautiful native-feeling Apple-inspired interface.**

Do not build a generic fitness app. Make this feel like a focused, premium Apple-quality running instrument.

---

## 1. Platform and technical approach

I develop on Windows and do not own a Mac. I want to install and use the finished app on my iPhone.

Before choosing the architecture, inspect the existing project and explain the implementation plan. Then begin building the app rather than stopping at a proposal.

Preferred technical approach:

- React Native with Expo and TypeScript, unless another architecture offers a clear advantage.
- Use native iOS capabilities where necessary for reliable GPS background tracking and Lock Screen Live Activities.
- Use local storage for routes, settings, and run history.
- The core app must work offline, including during a run.
- Do not require a backend, user account, subscription, or cloud service for core functionality.
- Minimise dependencies, complexity, and recurring costs.
- Use a maintainable architecture with clear separation between GPS tracking, route matching, pace calculations, elevation processing, persistence, and presentation.

Investigate Expo Application Services (EAS) or another appropriate cloud build service to build and sign iOS applications without owning a Mac. Explain any Apple Developer account, signing, testing, or distribution requirements that apply.

Do not claim that a web prototype is equivalent to a native iOS application. A Progressive Web App may be used temporarily for prototyping, but reliable background GPS and native Live Activities are important reasons to build a real iPhone app.

Prioritise the iPhone experience. Do not implement Apple Watch, Wear OS, Garmin, or other smartwatch integrations in the initial version. I may add wearable support in the future, so keep the core tracking and comparison engine independent of the UI.

An iOS Lock Screen Live Activity is desirable but can be implemented after the core application works reliably.

---

## 2. Design philosophy: Apple-quality, minimalist, premium

The visual design is a major requirement, not an afterthought.

Study my attached running-interface reference image. Preserve its emphasis on large numerical metrics, immediate readability, and a compact performance indicator, but create a distinct iPhone interface inspired by Apple's design philosophy.

The app should feel like something that could belong in Apple's own ecosystem: considered, restrained, precise, intuitive, and exceptionally polished.

### Visual direction

- Use Apple's design principles: clarity, deference to content, consistency, simplicity, and excellent typography.
- Use native iOS interaction patterns and platform conventions wherever possible.
- Prefer SF Pro typography and appropriate system typography where available.
- Use generous spacing, carefully aligned elements, refined proportions, and a clear visual hierarchy.
- Use subtle transitions and purposeful animations, never decoration for its own sake.
- Use rounded shapes and restrained separators rather than excessive cards, borders, shadows, or gradients.
- Use native-feeling navigation, sheets, haptics, controls, and permission flows.
- Respect safe areas, Dynamic Island, device dimensions, and system accessibility settings.
- Support light and dark appearances, with a refined dark running screen as the default if appropriate.

### Colour and reference-image interpretation

The attached reference uses a predominantly black screen, vivid turquoise accents, white numerical displays, and a compact horizontal performance bar.

Translate that visual language into an Apple-inspired design system:

- Use black or deep charcoal for the main running screen in dark mode.
- Use a restrained turquoise or mint accent for the primary running metric and active states.
- Use white and secondary system colours for legibility.
- Use semantic colours for ahead/behind states where appropriate, without relying on colour alone.
- Keep secondary screens cleaner and more spacious, consistent with Apple's native apps.

Avoid making the app look like a cyberpunk dashboard, a gaming interface, a generic neon fitness app, or an imitation of a smartwatch screen. The goal is **Apple-level refinement with the distinctive running metrics from my reference image**.

Use reusable components and a consistent design system. Build the actual interface rather than merely generating mockups.

---

## 3. Core application structure

Provide four primary sections:

1. **Run** — start a run, select a route, select a target, and see live performance.
2. **Routes** — record, select, rename, and manage saved routes.
3. **History** — compare completed runs and track improvement.
4. **Settings** — configure units, targets, haptics, audio feedback, display preferences, and permissions.

Keep navigation simple and native-feeling.

The running screen is the most important screen in the entire application. Secondary features must not distract from it.

---

## 4. Route recording and management

The first time I run a route, the app should record it using the iPhone's GPS.

Record:

- Latitude and longitude.
- Timestamps.
- Horizontal GPS accuracy.
- Altitude when available.
- Cumulative distance.
- Elevation changes.
- The time elapsed at different positions along the route.

After the run, let me save and name the route.

I must be able to create and save multiple routes for different neighbourhoods, parks, holidays, and running locations. Each route must have its own reference runs, targets, and history.

The route library should show useful information such as distance, elevation gain, best time, and last-run date without becoming a cluttered dashboard.

Allow me to:

- Record a new route.
- Select an existing route.
- Rename, duplicate, or delete a route.
- Select a completed run as the reference.
- Replace a baseline explicitly.
- Export route data where practical, including GPX.
- Export or back up run history.

Do not silently overwrite a baseline after completing a run.

---

## 5. Route matching and the comparison engine

This is the most technically important part of the app. Implement and test it independently of the UI.

When I repeat a route, compare my current position with the corresponding position along the selected reference route.

Do not simply compare instantaneous GPS speed with average route pace.

### Route matching requirements

- Represent each route as a sequence of GPS coordinates and cumulative distances.
- Project GPS readings onto nearby route segments.
- Match the current position to a plausible point along the route.
- Use forward progress, heading, distance, and previous matched positions to reduce GPS jitter.
- Avoid jumps backwards and forwards due to noisy GPS readings.
- Handle sharp turns, temporary GPS loss, intersections, and deviations from the route.
- Handle loop routes where the same geographical position occurs more than once.
- Smooth noisy GPS measurements without concealing meaningful changes in performance.
- Avoid accumulating substantial distance while stationary.

Use a robust, testable map-matching strategy appropriate for running GPS accuracy. Do not introduce an unnecessarily complicated algorithm if a simpler approach performs reliably.

### Baseline comparison

For the current matched route position, interpolate the elapsed time recorded by the reference run at the equivalent cumulative distance.

Calculate:

**Baseline advantage = reference elapsed time at current position − current elapsed time.**

Examples:

- Reference: 12:30; current: 12:00; result: +00:30, meaning 30 seconds ahead.
- Reference: 12:30; current: 13:00; result: −00:30, meaning 30 seconds behind.
- Reference: 12:30; current: 12:30; result: 00:00, meaning on pace.

The comparison must be based on elapsed time at the equivalent route position, not average pace for the entire route.

Display the result continuously during the run.

Use clear terminology so the user can distinguish total time advantage from instantaneous pace and projected finish time.

---

## 6. Ghost-run pacing — a core feature

Ghost-run pacing is central to the product. The app must actively guide me toward a chosen finish time rather than simply report performance.

### Choosing a ghost target

When selecting a route, allow me to choose:

- A reference run.
- A target finish time.
- Optionally, an improvement over the reference, expressed in seconds or percentage.
- Whether I want to compare against the original reference, the ghost target, or both.

For example, if my reference run took 30:00, I might choose a ghost target of 29:30.

The app should construct a target elapsed-time profile along the entire route.

For the initial implementation, proportionally scale the reference timing profile:

**Target elapsed time at route position = reference elapsed time at that position × (target finish time / reference finish time).**

This distributes the required improvement along the route while retaining the reference run's relative timing pattern, including slower uphill sections.

The target profile must begin at zero and finish at the selected target time.

### Live ghost comparison

At every matched route position, calculate:

**Ghost advantage = target elapsed time at current position − actual elapsed time.**

A positive result means I am ahead of my ghost target. A negative result means I am behind it.

Update the result as new GPS readings arrive.

The app should communicate:

- Whether I am ahead of or behind the ghost.
- The time difference in seconds or minutes and seconds.
- My current pace.
- The target split for the next checkpoint.
- The average pace required over the remaining route to reach my target finish time, when a reliable estimate is possible.

Clearly distinguish the original reference comparison from the ghost-target comparison.

### Required pace and projected finish

Calculate the average pace required to achieve the target using remaining distance and remaining target time.

Where possible, also estimate a projected finish time from recent, filtered performance and remaining route conditions.

Do not treat instantaneous GPS pace as a reliable prediction. Smooth estimates and clearly identify projections as estimates.

If the target is no longer achievable at the current pace, show that the target is at risk instead of displaying a misleading or impossible pace recommendation.

### Target splits

Divide the route into sensible checkpoints, such as 100-metre or 250-metre segments, adapting to GPS accuracy and route length.

For each checkpoint, calculate:

- Target elapsed time.
- Target split time.
- Actual elapsed time.
- Split difference.
- Cumulative advantage or deficit.

Show the next checkpoint's target time and whether I am on track.

Use short, useful feedback, such as:

- ON TARGET
- 12 SEC AHEAD
- 18 SEC BEHIND
- NEXT SPLIT 1:42
- HILL AHEAD

Optional audio and haptic feedback may announce meaningful checkpoints or significant changes. Include thresholds, cooldowns, and an easy way to disable feedback.

Do not bombard me with notifications.

---

## 7. Elevation-aware pacing

My regular route contains two very steep hills that significantly affect my pace.

The app must compare equivalent positions on the route so the hills are handled fairly.

Record and process elevation data where reliable. Smooth noisy GPS altitude readings and identify meaningful climbs, descents, and gradients.

Use the reference run's actual elapsed-time profile as the primary basis for both baseline comparison and ghost-target pacing.

This means that if the reference runner slowed down on a hill, the target profile reflects that slower section instead of expecting a constant flat-ground pace.

Optionally show upcoming elevation changes and the target split for the next section.

Keep actual time advantage separate from any grade-adjusted pace estimate. Do not claim to measure physiological effort accurately from GPS elevation alone.

If elevation data is unavailable or unreliable, the app must still work using route position and recorded timing.

---

## 8. Live performance bar chart

Create a prominent, real-time diverging bar chart on the running screen.

It must have a clear zero reference:

- Positive values indicate being ahead.
- Negative values indicate being behind.
- Zero indicates matching the selected target.

Choose the most legible horizontal layout for an iPhone screen, inspired by the reference image.

Requirements:

- Display the numerical time difference alongside the bar.
- Update smoothly as new GPS data arrives.
- Keep the zero line visible.
- Scale the range sensibly so changes remain meaningful.
- Avoid excessive animation and distracting visual movement.
- Make the chart readable at a glance.
- Distinguish positive and negative states through direction, signed numbers, and labels, not colour alone.

Use the selected comparison mode to determine what the main bar represents: baseline performance or ghost-target performance.

The default running screen should prioritise ghost-target performance if a target has been selected.

If useful, include a simple control to switch the comparison reference without cluttering the interface.

Do not create a complex analytics dashboard during a run.

---

## 9. Main running screen

Design the running screen around the information I need to understand immediately.

### Visual hierarchy

1. **Large time difference:** For example, +00:25 or −00:18.
2. **Clear status:** AHEAD, BEHIND, or ON TARGET.
3. **Live diverging performance bar.**
4. **Current pace:** In min/km.
5. **Ghost target pace or next split.**
6. **Elapsed time and distance.**
7. **Remaining distance and required pace**, where appropriate.
8. **Small GPS and route status indicators.**
9. **Simple pause, resume, and finish controls.**

Do not give every metric equal prominence.

Use large, carefully typeset numbers, compact secondary labels, refined spacing, and minimal visual clutter.

The most important performance information should be visible without scrolling.

Keep maps secondary. A map may be available before and after the run, but it should not dominate the live running interface.

Make touch controls sufficiently large and accessible, with confirmation before discarding a run or ending it accidentally.

Keep the display awake during a run where practical and permitted, with sensible battery considerations.

---

## 10. Lock Screen Live Activity

Implement an iOS Lock Screen Live Activity after the core tracking system works.

The ideal Live Activity displays:

- Route name.
- Elapsed time.
- Current pace.
- Time ahead or behind the ghost target.
- A compact performance indicator.

Keep it glanceable and consistent with the app's design.

Use ActivityKit and native iOS code where required. Respect platform limits on update frequency, background execution, and Live Activity duration.

Do not assume Live Activities can run identically on every platform.

If implementation is deferred, document the native integration point and ensure the tracking engine exposes the data needed to support it later.

Smartwatch support is explicitly out of scope for the initial release.

---

## 11. GPS reliability and background tracking

The app must work while my iPhone is in my pocket and the screen is locked.

Implement appropriate native location permissions and background-location configuration.

Requirements:

- Continue recording during normal screen locking and app backgrounding, subject to iOS restrictions and permissions.
- Handle temporary GPS loss.
- Detect poor location accuracy and avoid false performance changes.
- Smooth current pace and distance.
- Correctly handle pause and resume.
- Distinguish elapsed time from moving time.
- Avoid introducing artificial time differences when a run is paused.
- Handle incoming interruptions and app lifecycle changes.
- Save data incrementally so an interruption does not destroy the whole run.
- Preserve completed runs across app restarts and device reboots.
- Use reasonable battery consumption.
- Explain when GPS conditions limit comparison accuracy.

Request permissions at appropriate times and explain why background location is necessary.

Do not promise perfect GPS accuracy or unrestricted background operation.

---

## 12. Route history and improvement tracking

Save every completed run locally.

Each run should include:

- Route identifier.
- Start date and time.
- Elapsed time.
- Moving time.
- Distance.
- Average pace.
- GPS track.
- Elevation profile, where available.
- Reference comparison over the route.
- Ghost-target comparison over the route.
- Split times.
- Pause history.
- GPS-quality information.

The History section should show:

- Best finish time.
- Most recent finish time.
- Average finish time.
- Total runs.
- Total distance.
- Change from the original baseline.
- Improvement or decline over time.
- A simple finish-time-over-time chart.
- Comparisons between selected runs.

Allow a completed run to be selected as a future reference.

Never silently change the original baseline or delete run history when changing a target.

Use metric units throughout:

- Kilometres and metres.
- Minutes per kilometre.
- Elevation in metres.
- Time in minutes and seconds.
- Kilometres per hour only where useful.

Store everything locally, using an appropriate database or persistent storage layer. Ensure the app remains usable offline.

---

## 13. Architecture and maintainability

Use TypeScript and strict typing.

Keep the following modules independent of the presentation layer:

- GPS collection.
- GPS filtering.
- Route recording.
- Cumulative distance calculation.
- Route matching.
- Baseline time interpolation.
- Ghost-target generation.
- Ahead/behind calculation.
- Split generation.
- Pace estimation.
- Elevation processing.
- Run lifecycle and pause/resume.
- Local persistence and migrations.
- History and statistics.
- Live Activity data integration.

Write readable, maintainable code and document important calculations.

Do not build a backend unless a concrete requirement justifies it.

Do not add social networking, accounts, leaderboards, subscriptions, achievements, or unrelated fitness features.

---

## 14. Testing and acceptance criteria

Create automated tests for the comparison engine using simulated routes and GPS traces.

At minimum, verify:

1. A runner 30 seconds ahead of the reference displays +30 seconds.
2. A runner 30 seconds behind displays −30 seconds.
3. Matching the reference displays zero.
4. The ghost-target profile starts at zero and finishes at the selected target time.
5. A faster target generates proportionally faster checkpoint times.
6. Steep hills retain the reference run's relative timing characteristics.
7. GPS jitter does not cause erratic route matching or large performance jumps.
8. Loop routes match the correct occurrence of repeated positions.
9. Pausing and resuming does not create artificial time differences.
10. Temporary GPS loss does not produce misleading pace or distance readings.
11. Route deviations are detected appropriately.
12. Required remaining pace is calculated correctly.
13. A completed run persists after restarting the application.
14. The performance chart correctly displays positive, negative, and zero values.
15. Baseline and ghost-target comparisons remain distinct.
16. Poor elevation data does not prevent the core comparison engine from working.

Test the UI on realistic iPhone screen sizes and handle safe areas, dark mode, and accessibility settings.

Where physical GPS testing is unavailable, use simulated location traces and clearly document what still requires testing on a real iPhone.

---

## 15. Development workflow

Work incrementally and keep the project runnable.

### Stage 1 — Feasibility and setup

Inspect the environment, choose the architecture, establish the project, and explain the Windows-to-iPhone development and installation workflow.

Identify platform-specific limitations before depending on them.

### Stage 2 — Core comparison engine

Implement route data models, distance calculation, route matching, reference interpolation, ghost-target generation, and ahead/behind calculations.

Write automated tests before integrating the engine into the UI.

### Stage 3 — Main iPhone interface

Implement the Apple-inspired design system, route selection, main running screen, live performance bar, pace metrics, and basic navigation.

Use realistic sample data during UI development, but clearly distinguish sample data from real GPS data.

### Stage 4 — GPS and persistence

Implement route recording, background tracking, local persistence, pause/resume, and completed-run saving.

Validate the app's behaviour when the phone is locked.

### Stage 5 — Ghost pacing and history

Implement target selection, split calculations, remaining-pace guidance, route history, and performance charts.

### Stage 6 — iOS integration and polish

Investigate and implement Live Activities, refine haptics, improve reliability, and prepare a cloud build for iPhone testing.

At the end of each stage, explain what works, what has been tested, what remains incomplete, and how I can run it.

Do not claim a feature is implemented merely because its UI exists. Distinguish functional features from placeholders.

---

## Final priorities

If trade-offs are necessary, prioritise:

1. Accurate route matching and elapsed-time comparison.
2. Reliable background GPS on iPhone.
3. Ghost-run pacing and useful target splits.
4. The live ahead/behind indicator and performance bar.
5. A refined Apple-inspired iPhone experience.
6. Multiple saved routes and historical improvement.
7. Elevation-aware pacing.
8. Lock Screen Live Activities.
9. Future smartwatch extensibility.

Begin by inspecting the current development environment and project. Give me a concise feasibility assessment, explain the architecture and any limitations caused by not having a Mac, and then proceed with implementation.

**Build a real, testable application incrementally. Do not stop after producing a plan, mockup, or static prototype.**

---

## Decisions made during planning (Claude's calls)

These fill gaps the brief left open. Each is Claude's decision and can be changed.

- **Reference image.** No image was attached in the session. The design follows the brief's written
  description of it: black background, turquoise accent, white numerals, compact horizontal bar.
- **Dev machine.** The brief says Windows; the actual machine is Fedora Linux. The no-Mac workflow is
  identical: JS development locally, iOS builds and signing on EAS Build in the cloud.
- **Stack.** Expo SDK 58 (React Native 0.88, React 19.3), TypeScript strict, Expo Router with native tabs,
  expo-location + expo-task-manager (background GPS), expo-sqlite (storage), expo-haptics, expo-speech,
  expo-keep-awake, expo-file-system + expo-sharing (GPX/backup export), react-native-svg (charts and route
  shape), expo-widgets + @expo/ui (Live Activity). Jest (jest-expo) for tests.
- **App name.** Working display name "Ghost Pace", bundle identifier `com.lexsclav.ghostpace`; both live in
  `app.json` and can be renamed before the first App Store Connect registration.
- **Maps.** No map SDK in v1. Route shape is drawn from the recorded coordinates with SVG, which works
  fully offline. A map view can be added later after the run (it is secondary per §9).
- **Time semantics.** "Run time" is the run clock: wall time minus manual pauses. All comparisons, splits,
  and finish times use run time. "Moving time" additionally excludes periods detected as stationary.
  Wall-clock duration (including pauses) is also stored. No auto-pause in v1.
- **Distance semantics.** "Distance" is filtered GPS distance actually run. "Route progress" is the matched
  position along the saved route; remaining distance = route length − route progress.
- **Reference profile of any run** is computed the same way for every run: replay the run's stored fixes
  through the route matcher against the route geometry. This includes the original recording run, so the
  baseline and later runs are measured identically.
- **Checkpoint interval.** Route ≤ 1.5 km → 100 m; ≤ 5 km → 250 m; ≤ 12 km → 500 m; longer → 1 km.
- **On-target band.** |advantage| < 2 s reads ON TARGET.
- **Comparison default.** Ghost when a target is set, otherwise baseline; a single tap on the bar switches
  between them during a run when both exist.
