import type { SessionEvent } from './types';

export type RunPhase = 'idle' | 'running' | 'paused' | 'finished';
export type LifecycleEvent = Exclude<SessionEvent, { type: 'fix' }>;

/**
 * Run lifecycle and the run clock. Phases go idle → running ⇄ paused → finished; an event that does not
 * fit the current phase (a second start, a resume while running, anything after the finish) is ignored.
 * Run time excludes manual pauses: runSec(t) = (t − start − paused ms before t) / 1000, frozen at the finish.
 */
export class RunClock {
  private state: RunPhase = 'idle';
  private start: number | null = null;
  private end: number | null = null;
  /** Start (ms) of the current running segment: the start or the latest resume. */
  private segmentStart = Number.POSITIVE_INFINITY;
  private readonly spans: { start: number; end: number | null }[] = [];

  get phase(): RunPhase {
    return this.state;
  }

  /** Epoch ms of the start event, or null before it. */
  get startedAt(): number | null {
    return this.start;
  }

  /** Epoch ms of the finish event, or null before it. */
  get endedAt(): number | null {
    return this.end;
  }

  /** Applies a lifecycle event; returns whether it changed the phase. */
  apply(e: LifecycleEvent): boolean {
    switch (e.type) {
      case 'start':
        if (this.state !== 'idle') return false;
        this.start = e.t;
        this.segmentStart = e.t;
        this.state = 'running';
        return true;
      case 'pause':
        if (this.state !== 'running') return false;
        this.spans.push({ start: Math.max(e.t, this.segmentStart), end: null });
        this.state = 'paused';
        return true;
      case 'resume':
        if (this.state !== 'paused') return false;
        this.segmentStart = this.closePause(e.t);
        this.state = 'running';
        return true;
      case 'finish':
        if (this.state !== 'running' && this.state !== 'paused') return false;
        this.end = this.state === 'paused' ? this.closePause(e.t) : Math.max(e.t, this.segmentStart);
        this.state = 'finished';
        return true;
    }
  }

  /** Whether a fix taken at `t` belongs to active time: running, and not before the latest start/resume. */
  isActive(t: number): boolean {
    return this.state === 'running' && t >= this.segmentStart;
  }

  /** Run time (s) at epoch ms `t`, excluding pauses; 0 before the start, frozen after the finish. */
  runSecAt(t: number): number {
    if (this.start === null) return 0;
    const tt = this.end === null ? t : Math.min(t, this.end);
    let paused = 0; // ms of pause between the start and tt
    for (const p of this.spans) {
      if (p.start >= tt) break;
      paused += Math.min(tt, p.end ?? tt) - p.start;
    }
    return Math.max(0, (tt - this.start - paused) / 1000);
  }

  /** Pauses as closed intervals (epoch ms); an open pause ends at `untilMs`. */
  pauses(untilMs: number): { start: number; end: number }[] {
    return this.spans.map((p) => ({ start: p.start, end: p.end ?? Math.max(p.start, untilMs) }));
  }

  private closePause(t: number): number {
    const open = this.spans[this.spans.length - 1];
    open.end = Math.max(t, open.start);
    return open.end;
  }
}
