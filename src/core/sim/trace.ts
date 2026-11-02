import { bearing, cumulativeDistances, makeProjection, normalizeDeg, type XY } from '../geo';
import type { GpsFix, LatLon } from '../types';
import { gaussian, mulberry32 } from './prng';

export type SimAltitudeMode = 'ok' | 'missing' | 'garbage';

export interface SimulateRunOptions {
  /** True running speed (m/s) at along-route distance d (m) and grade (rise/run, 0.1 = 10 %). */
  speed: (d: number, grade: number) => number;
  /** Epoch ms of the first fix. */
  startMs: number;
  /** Fix rate (default 1 Hz). */
  hz?: number;
  /** Horizontal RMS position error in metres (default 3); 0 = ideal sensor (no noise on any field). */
  noiseM?: number;
  /** PRNG seed (default 1). */
  seed?: number;
  /** Reported horizontal accuracy (default max(5, 1.5 × noiseM), iOS-like pessimism). */
  hAcc?: number;
  /** No fixes strictly between fromSec and toSec (seconds since the first fix); the runner keeps moving. */
  gaps?: { fromSec: number; toSec: number }[];
  /** The runner stands still from atSec for durationSec (seconds since the first fix); fixes continue. */
  stops?: { atSec: number; durationSec: number }[];
  /** 'ok' (default): route elevation + small smooth error; 'missing': null; 'garbage': ±30 m jumps, vAcc 30. */
  altitude?: SimAltitudeMode;
}

export interface SimulatedRun {
  fixes: GpsFix[];
  /** True along-route distance (m) at `sec` seconds after the first fix (clamped to [0, length]). */
  truthAtSec(sec: number): number;
}

type SimRoute = readonly (LatLon & { ele?: number | null })[];

// Horizontal error model: per axis a first-order Gauss–Markov process (exponentially correlated, time
// constant NOISE_TAU_SEC) plus a little white jitter. Phone GPS error is dominated by slowly varying
// bias (minutes), so consecutive fixes are offset together rather than jumping independently each second.
const NOISE_TAU_SEC = 300;
const WHITE_SHARE = 0.1; // white jitter sd as a fraction of the per-axis sd
const SPEED_NOISE = 0.1; // m/s (Doppler speed is accurate)
const COURSE_NOISE = 3; // deg
const STOPPED_SPEED = 0.5; // below this true speed iOS reports course −1
const ALT_TAU_SEC = 60;
const ALT_SIGMA = 1; // m, correlated altitude error
const ALT_WHITE = 0.3; // m
const ALT_VACC = 4; // m
const GARBAGE_JUMP = 30; // m
const GARBAGE_VACC = 30; // m
const GARBAGE_RATE = 0.1; // altitude jumps per second
const GRADE_HALF_SPAN = 10; // m either side for the central-difference grade
const INTEGRATION_STEP = 0.1; // s of moving time (RK2)
const MAX_SIM_SEC = 48 * 3600;

/**
 * Simulates a GPS trace of a run along `route` (points with optional `ele`). The truth runner moves at
 * `speed(d, grade)` along the route, stands still during `stops`, and the run ends at the first fix at
 * or after the moment it reaches the route end. Fixes are on a fixed `hz` grid; `speed` and `course`
 * fields come from the truth (course −1 while standing). Every grid step draws the same random numbers,
 * so gaps and altitude modes do not change the horizontal noise of the other fixes.
 */
export function simulateRun(route: SimRoute, opts: SimulateRunOptions): SimulatedRun {
  if (route.length === 0) throw new Error('simulateRun: empty route');
  const hz = opts.hz ?? 1;
  const dt = 1 / hz;
  const noiseM = opts.noiseM ?? 3;
  const ideal = noiseM === 0;
  const hAcc = opts.hAcc ?? Math.max(5, 1.5 * noiseM);
  const altitude = opts.altitude ?? 'ok';
  const rand = mulberry32(opts.seed ?? 1);

  // --- route lookup -------------------------------------------------------------------------------
  const proj = makeProjection(route[0]);
  const xy = route.map((p) => proj.toXY(p));
  const cum = cumulativeDistances(route);
  const length = cum[cum.length - 1];
  const segBearing: number[] = [];
  for (let i = 0; i + 1 < route.length; i++) {
    segBearing.push(cum[i + 1] > cum[i] ? bearing(route[i], route[i + 1]) : (segBearing[i - 1] ?? 0));
  }
  const hasEle = route.every((p) => typeof p.ele === 'number');

  /** Segment index i (cum[i] ≤ s ≤ cum[i+1]) and fraction f along it. */
  const locate = (s: number): { i: number; f: number } => {
    if (route.length === 1) return { i: 0, f: 0 };
    let lo = 0;
    let hi = cum.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cum[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    const span = cum[lo + 1] - cum[lo];
    return { i: lo, f: span > 0 ? Math.max(0, Math.min(1, (s - cum[lo]) / span)) : 0 };
  };
  const posAt = (s: number): XY => {
    const { i, f } = locate(s);
    if (route.length === 1) return xy[0];
    return { x: xy[i].x + f * (xy[i + 1].x - xy[i].x), y: xy[i].y + f * (xy[i + 1].y - xy[i].y) };
  };
  const eleAt = (s: number): number | null => {
    if (!hasEle) return null;
    const { i, f } = locate(s);
    const a = route[i].ele as number;
    const b = route[Math.min(i + 1, route.length - 1)].ele as number;
    return a + f * (b - a);
  };
  const gradeAt = (s: number): number => {
    if (!hasEle) return 0;
    const a = Math.max(0, s - GRADE_HALF_SPAN);
    const b = Math.min(length, s + GRADE_HALF_SPAN);
    // grade = Δele / Δd (dimensionless)
    return b > a ? ((eleAt(b) as number) - (eleAt(a) as number)) / (b - a) : 0;
  };
  const courseAt = (s: number): number => (segBearing.length ? segBearing[locate(s).i] : 0);
  const trueSpeed = (s: number): number => {
    const v = opts.speed(s, gradeAt(s));
    return Number.isFinite(v) ? Math.max(0, v) : 0;
  };

  // --- stops: wall time t ↔ moving time m ----------------------------------------------------------
  const stops = mergeIntervals((opts.stops ?? []).map((s) => [s.atSec, s.atSec + s.durationSec] as const));
  const stoppedAt = (t: number) => stops.some(([a, b]) => t >= a && t < b);
  // m(t) = t − time spent in stops before t
  const movingTime = (t: number) => stops.reduce((m, [a, b]) => m - Math.max(0, Math.min(t, b) - a), t);
  const wallTime = (m: number) => {
    let t = m;
    for (const [a, b] of stops) if (a < t) t += b - a;
    return t;
  };

  // --- truth trajectory S(m): distance vs moving time, integrated with RK2 (midpoint) -------------
  const ms: number[] = [0];
  const ss: number[] = [0];
  {
    let m = 0;
    let s = 0;
    const h = INTEGRATION_STEP;
    while (s < length) {
      if (m > MAX_SIM_SEC) throw new Error('simulateRun: runner never reaches the route end');
      const k1 = trueSpeed(s);
      const next = s + h * trueSpeed(Math.min(length, s + 0.5 * h * k1));
      if (next >= length) {
        m += (h * (length - s)) / (next - s); // exact crossing within the step
        s = length;
      } else {
        m += h;
        s = next;
      }
      ms.push(m);
      ss.push(s);
    }
  }
  const mEnd = ms[ms.length - 1];
  const tEnd = wallTime(mEnd);
  const trajAt = (m: number): number => {
    if (m <= 0) return 0;
    if (m >= mEnd) return length;
    let i = Math.min(Math.floor(m / INTEGRATION_STEP), ms.length - 2);
    while (i > 0 && ms[i] > m) i--;
    while (i < ms.length - 2 && ms[i + 1] < m) i++;
    const span = ms[i + 1] - ms[i];
    return span > 0 ? ss[i] + ((m - ms[i]) / span) * (ss[i + 1] - ss[i]) : ss[i + 1];
  };
  const truthAtSec = (sec: number) => (sec <= 0 ? 0 : trajAt(movingTime(sec)));

  // --- emit fixes -----------------------------------------------------------------------------------
  const sigma = noiseM / Math.SQRT2; // per-axis sd so that the 2-D RMS error is noiseM
  const sigmaW = WHITE_SHARE * sigma;
  const sigmaC = Math.sqrt(sigma * sigma - sigmaW * sigmaW);
  // Gauss–Markov step: e ← ρ·e + σ·√(1 − ρ²)·n, with ρ = exp(−dt/τ), keeps the stationary sd at σ
  const rho = Math.exp(-dt / NOISE_TAU_SEC);
  const altRho = Math.exp(-dt / ALT_TAU_SEC);
  const gaps = opts.gaps ?? [];
  const inGap = (t: number) => gaps.some((g) => t > g.fromSec && t < g.toSec);
  const kLast = Math.ceil(tEnd / dt - 1e-9);

  let eX = 0;
  let eY = 0;
  let altErr = 0;
  let altJump = 0;
  const fixes: GpsFix[] = [];
  for (let k = 0; k <= kLast; k++) {
    const t = k * dt;
    // fixed draw count per step keeps noise identical across gaps / altitude modes
    const n = Array.from({ length: 8 }, () => gaussian(rand));
    const uJump = rand();
    const uSign = rand();
    if (k === 0) {
      eX = sigmaC * n[0];
      eY = sigmaC * n[1];
      altErr = ALT_SIGMA * n[6];
    } else {
      eX = rho * eX + sigmaC * Math.sqrt(1 - rho * rho) * n[0];
      eY = rho * eY + sigmaC * Math.sqrt(1 - rho * rho) * n[1];
      altErr = altRho * altErr + ALT_SIGMA * Math.sqrt(1 - altRho * altRho) * n[6];
    }
    // garbage altitude toggles between 0 and ±30 m offsets (Poisson rate GARBAGE_RATE per second)
    if (uJump < GARBAGE_RATE * dt) altJump = altJump === 0 ? (uSign < 0.5 ? -GARBAGE_JUMP : GARBAGE_JUMP) : 0;
    if (inGap(t)) continue;

    const s = t >= tEnd ? length : truthAtSec(t);
    const v = stoppedAt(t) ? 0 : trueSpeed(s);
    const base = posAt(s);
    const ll = ideal
      ? proj.toLatLon(base.x, base.y)
      : proj.toLatLon(base.x + eX + sigmaW * n[2], base.y + eY + sigmaW * n[3]);
    const groundEle = eleAt(s) ?? 0;
    let alt: number | null = null;
    let vAcc: number | null = null;
    if (altitude === 'ok') {
      alt = ideal ? groundEle : groundEle + altErr + ALT_WHITE * n[7];
      vAcc = ALT_VACC;
    } else if (altitude === 'garbage') {
      alt = groundEle + altJump + (ideal ? 0 : altErr + ALT_WHITE * n[7]);
      vAcc = GARBAGE_VACC;
    }
    fixes.push({
      t: opts.startMs + Math.round(t * 1000),
      lat: ll.lat,
      lon: ll.lon,
      hAcc,
      alt,
      vAcc,
      speed: Math.max(0, v + (ideal ? 0 : SPEED_NOISE * n[4])),
      course: v < STOPPED_SPEED ? -1 : normalizeDeg(courseAt(s) + (ideal ? 0 : COURSE_NOISE * n[5])),
    });
  }
  return { fixes, truthAtSec };
}

/** Sorts and merges overlapping [a, b) intervals. */
function mergeIntervals(list: readonly (readonly [number, number])[]): [number, number][] {
  const sorted = list.filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
