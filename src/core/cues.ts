import { spokenDelta } from './format';
import { primaryReading } from './session';
import type { LiveSnapshot } from './types';

export type CueKind =
  | 'checkpoint'
  | 'statusChange'
  | 'hillAhead'
  | 'offRoute'
  | 'backOnRoute'
  | 'gpsLost'
  | 'targetAtRisk'
  | 'routeComplete';
export type CueHaptic = 'success' | 'warning' | 'light' | 'none';
export interface Cue { kind: CueKind; text: string; haptic: CueHaptic }
export interface CueOptions {
  /** |advantage| (s) a status change must reach on the new side. */
  thresholdSec?: number;
  /** Minimum run time (s) between status-change cues. */
  cooldownSec?: number;
  /** Announce checkpoint splits. */
  checkpoints?: boolean;
  /** Announce upcoming climbs. */
  hills?: boolean;
}

/** Minimum run time (s) between checkpoint cues. */
const CHECKPOINT_GAP_SEC = 20;
/** A climb is announced once it is this close (m). */
const HILL_ANNOUNCE_M = 150;
/** Minimum run time (s) between target-at-risk cues. */
const AT_RISK_GAP_SEC = 120;

/**
 * Decides which audio/haptic cues a new snapshot deserves, sparingly. Call `evaluate` with each snapshot;
 * it remembers what was announced. Nothing fires while idle or paused (state is left as it was).
 * - checkpoint: each new split, "250 metres. 12 seconds ahead." (cumulative difference), ≥ 20 s apart;
 * - statusChange: the primary comparison crosses to the other side by ≥ thresholdSec while reliable,
 *   then a cooldown; the first side reached is noted silently, and a checkpoint cue counts as an update;
 * - hillAhead: once per climb, within 150 m of its start;
 * - offRoute / backOnRoute, gpsLost: once per transition (gpsLost only after GPS was seen);
 * - targetAtRisk: at most once per 120 s; routeComplete: once, replacing the final checkpoint cue.
 */
export class CueEngine {
  private readonly threshold: number;
  private readonly cooldown: number;
  private readonly checkpoints: boolean;
  private readonly hills: boolean;

  private lastSplitIndex: number | null = null;
  private lastCheckpointCueSec: number | null = null;
  /** Side of the primary comparison last announced or noted: +1 ahead, −1 behind, 0 none yet. */
  private side = 0;
  private lastStatusCueSec: number | null = null;
  private readonly announcedClimbs = new Set<number>();
  private offRouteAnnounced = false;
  private gpsSeen = false;
  private gpsLostAnnounced = false;
  private lastRiskCueSec: number | null = null;
  private completeAnnounced = false;

  constructor(opts: CueOptions = {}) {
    this.threshold = opts.thresholdSec ?? 5;
    this.cooldown = opts.cooldownSec ?? 30;
    this.checkpoints = opts.checkpoints ?? true;
    this.hills = opts.hills ?? true;
  }

  evaluate(s: LiveSnapshot): Cue[] {
    const cues: Cue[] = [];
    const r = s.route;
    if (s.phase === 'finished') {
      if (r) this.routeComplete(s, cues);
      return cues;
    }
    if (s.phase !== 'running') return cues;

    this.gps(s, cues);
    if (!r) return cues;
    this.routeComplete(s, cues);
    this.offRoute(r.match, cues);
    const checkpointFired = this.checkpoint(s, cues);
    this.status(s, checkpointFired, cues);
    this.atRisk(s, cues);
    this.hill(s, cues);
    return cues;
  }

  private gps(s: LiveSnapshot, cues: Cue[]): void {
    if (s.gps.quality !== 'none') {
      this.gpsSeen = true;
      this.gpsLostAnnounced = false;
    } else if (this.gpsSeen && !this.gpsLostAnnounced) {
      this.gpsLostAnnounced = true;
      cues.push({ kind: 'gpsLost', text: 'GPS signal lost.', haptic: 'warning' });
    }
  }

  private routeComplete(s: LiveSnapshot, cues: Cue[]): void {
    const r = s.route;
    if (!r || r.finishedSec === null || this.completeAnnounced) return;
    this.completeAnnounced = true;
    if (r.lastSplit) this.lastSplitIndex = r.lastSplit.index; // the final split is part of this cue
    const adv = primaryReading(s)?.reading?.advantage;
    const delta = adv === undefined ? '' : ` ${sentence(spokenDelta(adv))}`;
    cues.push({ kind: 'routeComplete', text: `Route complete in ${spokenDuration(r.finishedSec)}.${delta}`, haptic: 'success' });
  }

  private offRoute(match: NonNullable<LiveSnapshot['route']>['match'], cues: Cue[]): void {
    if (match === 'offRoute' && !this.offRouteAnnounced) {
      this.offRouteAnnounced = true;
      cues.push({ kind: 'offRoute', text: 'Off route.', haptic: 'warning' });
    } else if (match === 'onRoute' && this.offRouteAnnounced) {
      this.offRouteAnnounced = false;
      cues.push({ kind: 'backOnRoute', text: 'Back on route.', haptic: 'light' });
    }
  }

  private checkpoint(s: LiveSnapshot, cues: Cue[]): boolean {
    const split = s.route?.lastSplit;
    if (!split || split.index === this.lastSplitIndex) return false;
    this.lastSplitIndex = split.index;
    if (!this.checkpoints) return false;
    if (this.lastCheckpointCueSec !== null && s.runSec - this.lastCheckpointCueSec < CHECKPOINT_GAP_SEC) return false;
    this.lastCheckpointCueSec = s.runSec;
    cues.push({
      kind: 'checkpoint',
      text: `${spokenDistance(split.d)}. ${sentence(spokenDelta(split.cumulativeDiff))}`,
      haptic: 'light',
    });
    return true;
  }

  private status(s: LiveSnapshot, checkpointFired: boolean, cues: Cue[]): void {
    const adv = primaryReading(s)?.reading?.advantage;
    if (adv === undefined || Math.abs(adv) < this.threshold) return;
    const side = adv > 0 ? 1 : -1;
    if (side === this.side) return;
    if (this.side === 0 || checkpointFired) {
      this.side = side; // first side reached, or just announced by the checkpoint cue
      return;
    }
    if (!s.route?.reliable) return;
    if (this.lastStatusCueSec !== null && s.runSec - this.lastStatusCueSec < this.cooldown) return;
    this.side = side;
    this.lastStatusCueSec = s.runSec;
    cues.push({ kind: 'statusChange', text: `Now ${spokenDelta(adv)}.`, haptic: side > 0 ? 'success' : 'warning' });
  }

  private atRisk(s: LiveSnapshot, cues: Cue[]): void {
    if (s.route?.required?.status !== 'atRisk') return;
    if (this.lastRiskCueSec !== null && s.runSec - this.lastRiskCueSec < AT_RISK_GAP_SEC) return;
    this.lastRiskCueSec = s.runSec;
    cues.push({ kind: 'targetAtRisk', text: 'Target at risk.', haptic: 'warning' });
  }

  private hill(s: LiveSnapshot, cues: Cue[]): void {
    const up = s.route?.upcomingClimb;
    if (!this.hills || !up || up.distanceTo > HILL_ANNOUNCE_M || this.announcedClimbs.has(up.climb.startD)) return;
    this.announcedClimbs.add(up.climb.startD);
    const gain = Math.round(up.climb.gain);
    const over = Math.round(up.climb.endD - up.climb.startD);
    cues.push({ kind: 'hillAhead', text: `Hill ahead. ${gain} metre climb over ${over} metres.`, haptic: 'light' });
  }
}

/** "250 metres", "1 kilometre", "1.25 kilometres". */
function spokenDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} metres`;
  const km = Math.round(m / 10) / 100; // 2 decimals
  return km === 1 ? '1 kilometre' : `${km} kilometres`;
}

/** "10 minutes 5 seconds", "1 hour 2 minutes 5 seconds". */
function spokenDuration(sec: number): string {
  const r = Math.max(0, Math.round(sec));
  const parts: [number, string][] = [
    [Math.floor(r / 3600), 'hour'],
    [Math.floor((r % 3600) / 60), 'minute'],
    [r % 60, 'second'],
  ];
  const words = parts.filter(([n]) => n > 0).map(([n, unit]) => `${n} ${unit}${n === 1 ? '' : 's'}`);
  return words.length > 0 ? words.join(' ') : '0 seconds';
}

/** Capitalised, with a full stop. */
function sentence(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}
