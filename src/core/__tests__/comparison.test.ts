/** @jest-environment node */
import { describe, expect, it } from '@jest/globals';
import { advantageAt, statusOf } from '../comparison';
import { formatDelta } from '../format';
import { makeProfile, scaleProfile } from '../profile';

/** Reference reaching 2500 m at 12:30 (750 s) and finishing 5000 m in 30:00. */
const REF = makeProfile([2500, 5000], [750, 1800], 5000);
const AT = 2500;

describe('baseline advantage (reference time at position − run time)', () => {
  it('#1 a runner 30 s ahead of the reference (ref 12:30, run 12:00) reads +30', () => {
    const adv = advantageAt(REF, AT, 12 * 60);
    expect(adv).toBeCloseTo(30, 9);
    expect(statusOf(adv)).toBe('ahead');
    expect(formatDelta(adv)).toBe('+00:30');
  });

  it('#2 a runner 30 s behind the reference (ref 12:30, run 13:00) reads −30', () => {
    const adv = advantageAt(REF, AT, 13 * 60);
    expect(adv).toBeCloseTo(-30, 9);
    expect(statusOf(adv)).toBe('behind');
    expect(formatDelta(adv)).toBe('−00:30');
  });

  it('#3 a runner matching the reference (ref 12:30, run 12:30) reads 0', () => {
    const adv = advantageAt(REF, AT, 12 * 60 + 30);
    expect(adv).toBeCloseTo(0, 9);
    expect(statusOf(adv)).toBe('onTarget');
    expect(formatDelta(adv)).toBe('00:00');
  });

  it('interpolates the reference time between profile points', () => {
    // 1250 m is half-way to 2500 m → reference 375 s
    expect(advantageAt(REF, 1250, 360)).toBeCloseTo(15, 9);
  });

  it('ghost advantage uses the scaled profile at the same position', () => {
    const ghost = scaleProfile(REF, 1770);
    // ghost time at 2500 m = 750 × 1770/1800 = 737.5 s
    expect(advantageAt(ghost, AT, 720)).toBeCloseTo(17.5, 9);
    expect(advantageAt(REF, AT, 720)).toBeCloseTo(30, 9);
  });
});

describe('statusOf', () => {
  it('reads on target inside the ±2 s band', () => {
    expect(statusOf(0)).toBe('onTarget');
    expect(statusOf(1.9)).toBe('onTarget');
    expect(statusOf(-1.9)).toBe('onTarget');
  });

  it('reads ahead / behind at and beyond the band', () => {
    expect(statusOf(2)).toBe('ahead');
    expect(statusOf(-2)).toBe('behind');
    expect(statusOf(45)).toBe('ahead');
  });

  it('accepts a custom band', () => {
    expect(statusOf(4, 5)).toBe('onTarget');
    expect(statusOf(-6, 5)).toBe('behind');
  });
});
