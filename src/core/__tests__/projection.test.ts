/** @jest-environment node */
import { describe, expect, it } from '@jest/globals';
import { makeProfile } from '../profile';
import { PerformanceTracker, projectFinish, requiredPace } from '../projection';
import type { TimeProfile } from '../types';

/** Constant 300 s/km (0.3 s/m) over 5 km: 1500 s. */
const REF: TimeProfile = makeProfile([5000], [1500], 5000);

describe('PerformanceTracker', () => {
  it('is null until the window covers 150 m and 45 s', () => {
    const tr = new PerformanceTracker(REF);
    expect(tr.ratio()).toBeNull();
    tr.push(0, 0);
    tr.push(40, 140);
    expect(tr.ratio()).toBeNull(); // 140 m, 40 s
    tr.push(44, 155);
    expect(tr.ratio()).toBeNull(); // 155 m but 44 s
    tr.push(46, 160);
    // 46 s over 160 m vs reference 48 s
    expect(tr.ratio()).toBeCloseTo(46 / 48, 9);
  });

  it('reads actual ÷ reference time for a steady run', () => {
    const tr = new PerformanceTracker(REF);
    for (let s = 0; s <= 300; s++) tr.push(s, s * (1000 / 330)); // 330 s/km
    expect(tr.ratio()).toBeCloseTo(1.1, 6);
  });

  it('smooths with an EMA (α = 0.3)', () => {
    const tr = new PerformanceTracker(REF);
    tr.push(0, 0);
    tr.push(60, 200); // 60 s vs reference 60 s → 1
    expect(tr.ratio()).toBeCloseTo(1, 9);
    tr.push(120, 300); // window 0–300 m: 120 s vs 90 s → 4/3
    expect(tr.ratio()).toBeCloseTo(1 + 0.3 * (4 / 3 - 1), 9);
  });

  it('uses only the trailing 400 m of progress', () => {
    const tr = new PerformanceTracker(REF);
    tr.push(0, 0);
    tr.push(100, 500); // 100 s vs 150 s → 2/3
    expect(tr.ratio()).toBeCloseTo(2 / 3, 9);
    tr.push(220, 900); // window 500–900 m: 120 s vs 120 s → 1
    expect(tr.ratio()).toBeCloseTo(2 / 3 + 0.3 * (1 - 2 / 3), 9);
  });

  it('forgets an old pace once it leaves the window', () => {
    const tr = new PerformanceTracker(REF);
    let t = 0;
    for (let d = 0; d <= 1000; d += 3) tr.push((t = d * 0.36), d); // 1.2 × reference
    expect(tr.ratio()).toBeCloseTo(1.2, 6);
    const t0 = t;
    for (let d = 1002; d <= 2000; d += 3) tr.push(t0 + (d - 999) * 0.3, d); // reference pace
    expect(tr.ratio()).toBeCloseTo(1, 3);
  });

  it('clamps to [0.5, 2]', () => {
    const slow = new PerformanceTracker(REF);
    for (let s = 0; s <= 2000; s += 10) slow.push(s, s * 0.2); // 5000 s/km
    expect(slow.ratio()).toBe(2);
    const fast = new PerformanceTracker(REF);
    for (let s = 0; s <= 120; s++) fast.push(s, s * 10); // 100 s/km
    expect(fast.ratio()).toBe(0.5);
  });
});

describe('projectFinish', () => {
  it('adds the remaining reference time scaled by the performance ratio', () => {
    // at 2000 m after 660 s: 900 s of reference left × 1.1
    expect(projectFinish(REF, 2000, 660, 1.1)).toBeCloseTo(660 + 900 * 1.1, 9);
  });

  it('is null without a ratio', () => {
    expect(projectFinish(REF, 2000, 660, null)).toBeNull();
  });
});

describe('requiredPace', () => {
  const base = { length: 5000, progress: 3000, reference: REF, ratio: null };

  it('#12 2000 m remaining with 600 s left needs 300 s/km (ok)', () => {
    const r = requiredPace({ ...base, runSec: 900, targetFinishSec: 1500 });
    expect(r.status).toBe('ok');
    expect(r.secPerKm).toBeCloseTo(300, 9);
    expect(r.remainingM).toBeCloseTo(2000, 9);
    expect(r.remainingSec).toBeCloseTo(600, 9);
  });

  it('#12 with 0 s left the target is missed', () => {
    const r = requiredPace({ ...base, runSec: 1500, targetFinishSec: 1500 });
    expect(r.status).toBe('missed');
    expect(r.secPerKm).toBeNull();
    expect(r.remainingSec).toBe(0);
  });

  it('#12 a required 140 s/km is at risk and shows no pace', () => {
    const r = requiredPace({ ...base, runSec: 1220, targetFinishSec: 1500 }); // 280 s for 2 km
    expect(r.status).toBe('atRisk');
    expect(r.secPerKm).toBeNull();
    expect(r.remainingSec).toBeCloseTo(280, 9);
  });

  it('is at risk when the required ratio is below 0.92 × the current ratio', () => {
    // needs reference pace (required ratio 1) while running 1.2 × slower than the reference
    const r = requiredPace({ ...base, runSec: 900, targetFinishSec: 1500, ratio: 1.2 });
    expect(r.status).toBe('atRisk');
    expect(r.secPerKm).toBeNull();
    // at the reference's own pace the target stays reachable
    expect(requiredPace({ ...base, runSec: 900, targetFinishSec: 1500, ratio: 1.0 }).status).toBe('ok');
  });

  it('is unavailable within the last 50 m', () => {
    const r = requiredPace({ ...base, progress: 4960, runSec: 1400, targetFinishSec: 1500 });
    expect(r.status).toBe('unavailable');
    expect(r.secPerKm).toBeNull();
    expect(r.remainingM).toBeCloseTo(40, 9);
  });
});
