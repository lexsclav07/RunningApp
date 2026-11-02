import { detectClimbs } from './elevation';
import { makeProfile } from './profile';
import { RunClock } from './run-clock';
import { RunSession } from './session';
import { buildRouteGeometry } from './track';
import type { Climb, GpsFix, RouteGeometry, RunSummary, SessionEvent, TimeProfile } from './types';

/** Shortest recording (m) that can be saved as a route. */
export const MIN_ROUTE_LENGTH = 100;
/** Speed (m/s) of the placeholder reference used while measuring a recording against its own route. */
const PLACEHOLDER_SPEED = 3;

/** The fixes of a run's active time: after the start, outside pauses, before the finish (log order). */
export function activeFixes(events: readonly SessionEvent[]): GpsFix[] {
  const clock = new RunClock();
  const out: GpsFix[] = [];
  for (const e of events) {
    if (e.type !== 'fix') clock.apply(e);
    else if (clock.isActive(e.fix.t)) out.push(e.fix);
  }
  return out;
}

/** Replays a run's events in route mode against `geometry` and `reference`: the run's summary on that route. */
export function computeRunProfile(
  geometry: RouteGeometry,
  climbs: Climb[],
  reference: TimeProfile,
  events: readonly SessionEvent[],
): RunSummary {
  return RunSession.replay({ mode: 'route', route: { geometry, climbs }, reference }, events).summary();
}

/**
 * Turns a recording into a route:
 * 1. geometry from the fixes of active time (`buildRouteGeometry`), climbs from its elevation;
 * 2. the recording replayed in route mode against that geometry, with a placeholder reference, which
 *    yields the run's own time profile (measured by the matcher exactly as any later run will be);
 * 3. a second replay against that profile, so the stored summary (splits, comparisons ≈ 0) describes
 *    the run relative to itself. The profile does not depend on the reference, so both passes agree.
 * Throws a RangeError when the recording covers less than MIN_ROUTE_LENGTH.
 */
export function buildRouteFromRecording(events: readonly SessionEvent[]): {
  geometry: RouteGeometry;
  climbs: Climb[];
  profile: TimeProfile;
  summary: RunSummary;
} {
  const geometry = buildRouteGeometry(activeFixes(events));
  if (geometry.points.length < 2 || !(geometry.length >= MIN_ROUTE_LENGTH)) {
    throw new RangeError(
      `buildRouteFromRecording: the recording covers ${Math.round(geometry.length)} m; a route needs at least ${MIN_ROUTE_LENGTH} m`,
    );
  }
  const climbs = detectClimbs(geometry.points);
  const placeholder: TimeProfile = { d: [0, geometry.length], t: [0, geometry.length / PLACEHOLDER_SPEED] };
  const own = computeRunProfile(geometry, climbs, placeholder, events).route;
  if (!own) throw new Error('buildRouteFromRecording: route replay produced no route summary');
  // A recording ends at its own route end, so the replay completes; if the matcher stopped just short,
  // makeProfile extrapolates the last ≤ 30 m (or throws IncompleteProfileError).
  const profile = own.completed ? own.profile : makeProfile(own.profile.d, own.profile.t, geometry.length);
  const summary = computeRunProfile(geometry, climbs, profile, events);
  return { geometry, climbs, profile, summary };
}
