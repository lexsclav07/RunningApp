/** @jest-environment node */
import { describe, expect, it } from '@jest/globals';
import { classifyFix } from '../filter';
import { makeProjection } from '../geo';
import type { GpsFix } from '../types';

const T0 = Date.UTC(2026, 9, 29, 7, 0, 0);
const proj = makeProjection({ lat: 51.5, lon: -0.13 });

function fixAt(sec: number, x: number, y: number, over: Partial<GpsFix> = {}): GpsFix {
  const ll = proj.toLatLon(x, y);
  return { t: T0 + sec * 1000, lat: ll.lat, lon: ll.lon, hAcc: 5, alt: null, vAcc: null, speed: 3, course: 0, ...over };
}

describe('classifyFix', () => {
  it('accepts the first fix', () => {
    expect(classifyFix(fixAt(0, 0, 0), null)).toEqual({ accept: true, quality: 'good' });
  });

  it('grades quality from horizontal accuracy', () => {
    const prev = fixAt(0, 0, 0);
    expect(classifyFix(fixAt(1, 0, 3, { hAcc: 10 }), prev).quality).toBe('good');
    expect(classifyFix(fixAt(1, 0, 3, { hAcc: 10.5 }), prev).quality).toBe('fair');
    expect(classifyFix(fixAt(1, 0, 3, { hAcc: 25 }), prev).quality).toBe('fair');
    expect(classifyFix(fixAt(1, 0, 3, { hAcc: null }), prev)).toEqual({ accept: true, quality: 'fair' });
    expect(classifyFix(fixAt(1, 0, 3, { hAcc: 40 }), prev)).toEqual({ accept: true, quality: 'poor' });
  });

  it('rejects a stale or duplicate fix', () => {
    const prev = fixAt(10, 0, 0);
    expect(classifyFix(fixAt(10, 0, 0), prev)).toMatchObject({ accept: false, reason: 'stale' });
    expect(classifyFix(fixAt(9, 0, -3), prev)).toMatchObject({ accept: false, reason: 'stale' });
    expect(classifyFix(fixAt(11, 0, 3), prev).accept).toBe(true);
  });

  it('rejects an 80 m-accuracy fix', () => {
    expect(classifyFix(fixAt(1, 0, 3, { hAcc: 80 }), fixAt(0, 0, 0))).toEqual({
      accept: false,
      quality: 'poor',
      reason: 'accuracy',
    });
    expect(classifyFix(fixAt(0, 0, 0, { hAcc: 80 }), null).accept).toBe(false);
    expect(classifyFix(fixAt(1, 0, 3, { hAcc: 50 }), fixAt(0, 0, 0)).accept).toBe(true);
  });

  it('rejects an invalid (negative) accuracy', () => {
    expect(classifyFix(fixAt(1, 0, 3, { hAcc: -1 }), fixAt(0, 0, 0))).toMatchObject({
      accept: false,
      reason: 'accuracy',
    });
  });

  it('rejects a teleport of 500 m in 1 s', () => {
    expect(classifyFix(fixAt(1, 500, 0), fixAt(0, 0, 0))).toMatchObject({ accept: false, reason: 'speed' });
    // the same jump spread over a 60 s gap is plausible
    expect(classifyFix(fixAt(60, 500, 0), fixAt(0, 0, 0)).accept).toBe(true);
    // 11 m in 1 s is a fast sprint but allowed
    expect(classifyFix(fixAt(1, 11, 0), fixAt(0, 0, 0)).accept).toBe(true);
  });
});
