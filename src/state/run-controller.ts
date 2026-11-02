import {
  CueEngine,
  RunSession,
  checkpointInterval as autoCheckpointInterval,
  resolveTargetFinish,
  toLiveActivityPayload,
  type Cue,
  type GpsFix,
  type LiveActivityPayload,
  type LiveSnapshot,
  type PrimaryComparison,
  type RunSummary,
  type SessionConfig,
  type SessionEvent,
} from '@/core';
import {
  appendEvents,
  completeRun,
  createActiveRun,
  discardRun,
  getActiveRun,
  getRoute,
  getRunProfile,
  getSettings,
  newId,
  type PersistedRunConfig,
  type RunSource,
  type Settings,
  type SqlDb,
} from '@/data';

export type TapKind = 'start' | 'pause' | 'resume' | 'finish';

/** Everything platform-specific the controller uses, injected so it can be tested without a phone. */
export interface RunControllerDeps {
  db: () => Promise<SqlDb>;
  /** Starts/stops OS location delivery; fixes come back through ingestFixes. */
  location: { start(onFixes: (fixes: GpsFix[]) => void): Promise<'background' | 'foreground'>; stop(): Promise<void> };
  feedback: { play(cues: Cue[], settings: Settings): void; tap(kind: TapKind, settings: Settings): void };
  liveActivity: { start(p: LiveActivityPayload): void; update(p: LiveActivityPayload): void; end(p: LiveActivityPayload | null): void };
  keepAwake: { on(): void; off(): void };
  now: () => number;
  /** Optional 1 Hz ticker (setInterval in the app); returns a stop function. */
  ticker?: (fn: () => void) => () => void;
  /** Called after anything is written, so data views can refresh. */
  onDataChanged?: () => void;
}

export interface ControllerState {
  status: 'idle' | 'active';
  runId: string | null;
  mode: 'record' | 'route' | null;
  routeId: string | null;
  routeName: string | null;
  source: RunSource;
  /** 'foreground' = only "While Using" permission: tracking stops when the app leaves the screen. */
  tracking: 'background' | 'foreground' | 'simulated' | null;
  hasBaselineAndGhost: boolean;
  snapshot: LiveSnapshot | null;
}

export interface StartRunOptions {
  mode: 'record' | 'route';
  routeId?: string;
  /** Ghost target finish time (s); undefined = use the route's saved target; null = no ghost. */
  targetFinishSec?: number | null;
  primary?: PrimaryComparison;
  source?: RunSource;
}

const IDLE: ControllerState = {
  status: 'idle',
  runId: null,
  mode: null,
  routeId: null,
  routeName: null,
  source: 'gps',
  tracking: null,
  hasBaselineAndGhost: false,
  snapshot: null,
};

/** Events are written at least this often (s) and whenever this many are pending. */
const FLUSH_INTERVAL_SEC = 5;
const FLUSH_EVENTS = 10;
/** Live Activity updates are at least this far apart (s) unless the comparison status changes. */
const LIVE_ACTIVITY_INTERVAL_SEC = 5;

interface Active {
  runId: string;
  session: RunSession;
  persisted: PersistedRunConfig;
  routeName: string;
  settings: Settings;
  cues: CueEngine;
  pending: SessionEvent[];
  lastFlushMs: number;
  lastFixT: number;
  lastActivityMs: number;
  lastActivityKey: string;
  stopTicker: (() => void) | null;
  tracking: ControllerState['tracking'];
}

/**
 * Owns the active run: applies events to a RunSession, persists them incrementally (so an interrupted
 * run loses at most a few seconds), drives cues, keep-awake and the Live Activity, and publishes
 * snapshots for useSyncExternalStore. Every public operation runs through one queue, so GPS batches
 * from the background task, button taps and recovery never interleave.
 */
export class RunController {
  private state: ControllerState = IDLE;
  private active: Active | null = null;
  private readonly listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: RunControllerDeps) {}

  getSnapshot = (): ControllerState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  startRun(opts: StartRunOptions): Promise<void> {
    return this.enqueue(async () => {
      if (this.active) throw new Error('A run is already in progress.');
      const db = await this.deps.db();
      const settings = await getSettings(db);
      const source = opts.source ?? 'gps';
      let persisted: PersistedRunConfig = {
        mode: opts.mode,
        routeId: null,
        referenceRunId: null,
        targetFinishSec: null,
        primary: 'baseline',
        checkpointInterval: settings.checkpointInterval === 'auto' ? null : settings.checkpointInterval,
        source,
      };
      if (opts.mode === 'route') {
        if (!opts.routeId) throw new Error('Choose a route first.');
        const route = await getRoute(db, opts.routeId);
        if (!route) throw new Error('That route no longer exists.');
        const reference = await getRunProfile(db, route.referenceRunId);
        if (!reference) throw new Error('This route has no usable reference run.');
        const refFinish = reference.t[reference.t.length - 1];
        const target =
          opts.targetFinishSec !== undefined
            ? opts.targetFinishSec
            : route.target
              ? resolveTargetFinish(refFinish, route.target)
              : null;
        persisted = {
          ...persisted,
          routeId: route.id,
          referenceRunId: route.referenceRunId,
          targetFinishSec: target,
          primary: opts.primary ?? (target !== null ? settings.defaultPrimary : 'baseline'),
        };
      }
      const { config, routeName } = await this.sessionConfig(db, persisted);
      const runId = newId();
      const startedAt = this.deps.now();
      const session = new RunSession(config);
      const start: SessionEvent = { type: 'start', t: startedAt };
      session.apply(start);
      await createActiveRun(db, { id: runId, startedAt, config: persisted });
      await appendEvents(db, runId, [start]);
      this.active = this.makeActive(runId, session, persisted, routeName, settings, startedAt);
      await this.beginTracking();
      this.deps.feedback.tap('start', settings);
      if (settings.liveActivity) this.safe(() => this.deps.liveActivity.start(this.payload()));
      this.publish();
      this.deps.onDataChanged?.();
    });
  }

  /** Applies a batch of fixes (from the background task, the foreground watch or the simulator). */
  ingestFixes(fixes: GpsFix[]): Promise<void> {
    return this.enqueue(async () => {
      if (!this.active) await this.recoverInner();
      const a = this.active;
      if (!a) return;
      const fresh = [...fixes].sort((x, y) => x.t - y.t).filter((f) => f.t > a.lastFixT);
      for (const fix of fresh) {
        const e: SessionEvent = { type: 'fix', fix };
        a.session.apply(e);
        a.pending.push(e);
        a.lastFixT = fix.t;
      }
      if (fresh.length === 0) return;
      const now = this.deps.now();
      if (a.pending.length >= FLUSH_EVENTS || (now - a.lastFlushMs) / 1000 >= FLUSH_INTERVAL_SEC) await this.flush();
      this.afterChange();
    });
  }

  pause(): Promise<void> {
    return this.marker('pause');
  }

  resume(): Promise<void> {
    return this.marker('resume');
  }

  /** Ends the run and saves it. In record mode the run is saved without a route until the user names it. */
  finish(): Promise<{ runId: string; summary: RunSummary }> {
    return this.enqueue(async () => {
      const a = this.requireActive();
      const e: SessionEvent = { type: 'finish', t: Math.max(this.deps.now(), a.lastFixT) };
      a.session.apply(e);
      a.pending.push(e);
      await this.flush();
      const summary = a.session.summary();
      const db = await this.deps.db();
      await completeRun(db, a.runId, summary, a.persisted.routeId);
      this.deps.feedback.tap('finish', a.settings);
      this.safe(() => this.deps.liveActivity.end(this.payload()));
      await this.teardown();
      this.deps.onDataChanged?.();
      return { runId: a.runId, summary };
    });
  }

  /** Throws the active run away (after the UI's confirmation). */
  discard(): Promise<void> {
    return this.enqueue(async () => {
      const a = this.requireActive();
      this.safe(() => this.deps.liveActivity.end(null));
      await this.teardown();
      await discardRun(await this.deps.db(), a.runId);
      this.deps.onDataChanged?.();
    });
  }

  setPrimary(p: PrimaryComparison): void {
    if (!this.active) return;
    this.active.session.setPrimary(p);
    this.active.persisted = { ...this.active.persisted, primary: p };
    this.afterChange();
  }

  /** Restores a run interrupted by a crash or iOS termination, replaying its stored events. */
  recover(): Promise<boolean> {
    return this.enqueue(() => this.recoverInner());
  }

  /** Advances the clock between fixes (1 Hz while the app is on screen). */
  tick(): void {
    if (!this.active) return;
    this.active.session.tick(this.deps.now());
    this.afterChange();
  }

  // ---- internals ----

  private marker(type: 'pause' | 'resume'): Promise<void> {
    return this.enqueue(async () => {
      const a = this.requireActive();
      const phase = a.session.snapshot().phase;
      if ((type === 'pause' && phase !== 'running') || (type === 'resume' && phase !== 'paused')) return;
      const e: SessionEvent = { type, t: Math.max(this.deps.now(), a.lastFixT) };
      a.session.apply(e);
      a.pending.push(e);
      await this.flush();
      this.deps.feedback.tap(type, a.settings);
      this.afterChange(true);
    });
  }

  private async recoverInner(): Promise<boolean> {
    if (this.active) return true;
    const db = await this.deps.db();
    const found = await getActiveRun(db);
    if (!found) return false;
    const settings = await getSettings(db);
    const persisted = found.run.config;
    const { config, routeName } = await this.sessionConfig(db, persisted);
    const session = RunSession.replay(config, found.events);
    session.setPrimary(persisted.primary);
    const lastFixT = found.events.reduce((m, e) => (e.type === 'fix' ? Math.max(m, e.fix.t) : m), -Infinity);
    this.active = this.makeActive(found.run.id, session, persisted, routeName, settings, this.deps.now());
    this.active.lastFixT = lastFixT;
    // the replayed cue state starts fresh; prime it so past events are not announced again
    this.active.cues.evaluate(session.snapshot());
    await this.beginTracking();
    this.publish();
    return true;
  }

  private async sessionConfig(db: SqlDb, p: PersistedRunConfig): Promise<{ config: SessionConfig; routeName: string }> {
    if (p.mode === 'record' || !p.routeId) return { config: { mode: 'record' }, routeName: 'New route' };
    const route = await getRoute(db, p.routeId);
    const reference = p.referenceRunId ? await getRunProfile(db, p.referenceRunId) : null;
    if (!route || !reference) throw new Error('The route or its reference run is missing.');
    return {
      routeName: route.name,
      config: {
        mode: 'route',
        route: { geometry: route.geometry, climbs: route.climbs },
        reference,
        targetFinishSec: p.targetFinishSec,
        primary: p.primary,
        checkpointInterval: p.checkpointInterval ?? autoCheckpointInterval(route.geometry.length),
      },
    };
  }

  private makeActive(
    runId: string,
    session: RunSession,
    persisted: PersistedRunConfig,
    routeName: string,
    settings: Settings,
    now: number,
  ): Active {
    return {
      runId,
      session,
      persisted,
      routeName,
      settings,
      cues: new CueEngine({ thresholdSec: settings.cueThresholdSec, cooldownSec: settings.cueCooldownSec }),
      pending: [],
      lastFlushMs: now,
      lastFixT: -Infinity,
      lastActivityMs: -Infinity,
      lastActivityKey: '',
      stopTicker: null,
      tracking: null,
    };
  }

  private async beginTracking(): Promise<void> {
    const a = this.active;
    if (!a) return;
    if (a.persisted.source === 'gps') {
      a.tracking = await this.deps.location.start((fixes) => void this.ingestFixes(fixes));
    } else {
      a.tracking = 'simulated';
    }
    if (a.settings.keepAwake) this.safe(() => this.deps.keepAwake.on());
    a.stopTicker = this.deps.ticker?.(() => this.tick()) ?? null;
  }

  private async teardown(): Promise<void> {
    const a = this.active;
    if (!a) return;
    a.stopTicker?.();
    if (a.persisted.source === 'gps') await this.deps.location.stop().catch(() => undefined);
    this.safe(() => this.deps.keepAwake.off());
    this.active = null;
    this.state = IDLE;
    this.emit();
  }

  private async flush(): Promise<void> {
    const a = this.active;
    if (!a || a.pending.length === 0) return;
    const batch = a.pending;
    a.pending = [];
    a.lastFlushMs = this.deps.now();
    await appendEvents(await this.deps.db(), a.runId, batch);
  }

  /** Cues, Live Activity and listeners after the session changed. */
  private afterChange(forceActivity = false): void {
    const a = this.active;
    if (!a) return;
    const snap = a.session.snapshot();
    const cues = a.cues.evaluate(snap);
    if (cues.length > 0) this.safe(() => this.deps.feedback.play(cues, a.settings));
    if (a.settings.liveActivity) {
      const p = this.payload();
      const key = `${snap.phase}|${p.status}`;
      const now = this.deps.now();
      if (forceActivity || key !== a.lastActivityKey || (now - a.lastActivityMs) / 1000 >= LIVE_ACTIVITY_INTERVAL_SEC) {
        a.lastActivityKey = key;
        a.lastActivityMs = now;
        this.safe(() => this.deps.liveActivity.update(p));
      }
    }
    this.publish();
  }

  private payload(): LiveActivityPayload {
    const a = this.active as Active;
    return toLiveActivityPayload(a.session.snapshot(), a.routeName);
  }

  private publish(): void {
    const a = this.active;
    if (!a) return;
    const snap = a.session.snapshot();
    this.state = {
      status: 'active',
      runId: a.runId,
      mode: a.persisted.mode,
      routeId: a.persisted.routeId,
      routeName: a.routeName,
      source: a.persisted.source,
      tracking: a.tracking,
      hasBaselineAndGhost: snap.route !== null && snap.route.ghost !== null,
      snapshot: snap,
    };
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private requireActive(): Active {
    if (!this.active) throw new Error('No run in progress.');
    return this.active;
  }

  /** Side effects (haptics, speech, Live Activity, keep-awake) must never break a run. */
  private safe(fn: () => void): void {
    try {
      fn();
    } catch {
      // ignored: feedback is best-effort
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
