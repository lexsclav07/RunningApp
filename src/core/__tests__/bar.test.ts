/** @jest-environment node */
import { describe, expect, it } from '@jest/globals';
import { BAR_STEPS, barGeometry, barScale } from '../bar';
import { mulberry32 } from '../sim/prng';

describe('barGeometry', () => {
  it('#14 (logic) +12 s at a 20 s scale fills right (ahead) to 0.6', () => {
    expect(barGeometry(12, 20)).toEqual({ side: 'ahead', fraction: 0.6 });
  });

  it('#14 (logic) −12 s at a 20 s scale fills left (behind) to 0.6', () => {
    expect(barGeometry(-12, 20)).toEqual({ side: 'behind', fraction: 0.6 });
  });

  it('#14 (logic) 0 s shows no fill', () => {
    expect(barGeometry(0, 20)).toEqual({ side: 'none', fraction: 0 });
  });

  it('shows no fill without a reading or below half a second', () => {
    expect(barGeometry(null, 20)).toEqual({ side: 'none', fraction: 0 });
    expect(barGeometry(0.49, 20)).toEqual({ side: 'none', fraction: 0 });
    expect(barGeometry(-0.49, 20)).toEqual({ side: 'none', fraction: 0 });
    expect(barGeometry(0.5, 20)).toEqual({ side: 'ahead', fraction: 0.025 });
  });

  it('caps the fraction at 1', () => {
    expect(barGeometry(50, 20)).toEqual({ side: 'ahead', fraction: 1 });
    expect(barGeometry(-700, 600)).toEqual({ side: 'behind', fraction: 1 });
  });
});

describe('barScale', () => {
  it('uses the fixed steps', () => {
    expect(BAR_STEPS).toEqual([10, 20, 30, 60, 120, 300, 600]);
  });

  it('starts at the smallest step ≥ 1.25 × |advantage|', () => {
    expect(barScale(0, null)).toBe(10);
    expect(barScale(8, null)).toBe(10);
    expect(barScale(12, null)).toBe(20);
    expect(barScale(30, null)).toBe(60);
    expect(barScale(5000, null)).toBe(600);
  });

  it('grows straight to the needed step', () => {
    expect(barScale(30, 20)).toBe(60);
    expect(barScale(200, 10)).toBe(300);
  });

  it('shrinks one step only when |advantage| < 0.4 × the next-lower step', () => {
    expect(barScale(13, 60)).toBe(60); // 13 ≥ 0.4 × 30
    expect(barScale(11, 60)).toBe(30); // 11 < 12
    expect(barScale(1, 60)).toBe(30); // one step at a time
    expect(barScale(1, 30)).toBe(20);
    expect(barScale(1, 10)).toBe(10); // nothing below the smallest step
  });

  it('#14 (logic) the scale never shrinks under ±1 s jitter', () => {
    const rand = mulberry32(14);
    for (const centre of [0, 7.5, -12, 23, -45, 95]) {
      let scale: number | null = null;
      for (let i = 0; i < 300; i++) {
        const adv = centre + (rand() * 2 - 1);
        const next = barScale(Math.abs(adv), scale);
        if (scale !== null) expect(next).toBeGreaterThanOrEqual(scale);
        expect(Math.abs(adv)).toBeLessThanOrEqual(next);
        scale = next;
      }
    }
  });
});
