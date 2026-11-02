import type {
  Climb,
  ComparisonMode,
  PrimaryComparison,
  RouteGeometry,
  RunSummary,
  SessionEvent,
  TargetSpec,
} from '@/core';

export interface RouteRecord {
  id: string;
  name: string;
  createdAt: number;
  geometry: RouteGeometry;
  climbs: Climb[];
  elevationGain: number | null;
  /** The original baseline; only replaceBaseline changes it. */
  baselineRunId: string;
  /** The run future runs are compared against (defaults to the baseline). */
  referenceRunId: string;
  target: TargetSpec | null;
  comparisonMode: ComparisonMode;
  isSample: boolean;
}

export interface RouteListItem {
  id: string;
  name: string;
  length: number;
  elevationGain: number | null;
  bestSec: number | null;
  lastRunAt: number | null;
  runCount: number;
  isSample: boolean;
}

export type RunSource = 'gps' | 'simulated';

export interface PersistedRunConfig {
  mode: 'record' | 'route';
  routeId: string | null;
  referenceRunId: string | null;
  targetFinishSec: number | null;
  primary: PrimaryComparison;
  checkpointInterval: number | null;
  source: RunSource;
}

export type RunStatus = 'active' | 'completed';

export interface RunRecord {
  id: string;
  routeId: string | null;
  mode: 'record' | 'route';
  status: RunStatus;
  source: RunSource;
  startedAt: number;
  endedAt: number | null;
  config: PersistedRunConfig;
  summary: RunSummary | null;
  /** Run time (s) at the route-end crossing; null when the run did not complete a route. */
  finishSec: number | null;
  distance: number | null;
  isSample: boolean;
}

export interface Settings {
  haptics: boolean;
  audioCues: boolean;
  cueThresholdSec: number;
  cueCooldownSec: number;
  appearance: 'system' | 'dark' | 'light';
  runScreenAlwaysDark: boolean;
  keepAwake: boolean;
  liveActivity: boolean;
  defaultPrimary: PrimaryComparison;
  checkpointInterval: 'auto' | 100 | 250 | 500 | 1000;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  haptics: true,
  audioCues: true,
  cueThresholdSec: 5,
  cueCooldownSec: 30,
  appearance: 'system',
  runScreenAlwaysDark: true,
  keepAwake: true,
  liveActivity: true,
  defaultPrimary: 'ghost',
  checkpointInterval: 'auto',
});

export interface BackupV1 {
  version: 1;
  exportedAt: number;
  routes: RouteRecord[];
  runs: (RunRecord & { events: SessionEvent[] })[];
}
