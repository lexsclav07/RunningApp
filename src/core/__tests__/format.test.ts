/** @jest-environment node */
import { describe, expect, it } from '@jest/globals';
import { deltaPhrase, formatClock, formatDelta, formatDistance, formatPace, spokenDelta } from '../format';

const MINUS = '\u2212';

describe('formatClock', () => {
  it('formats m:ss under an hour and h:mm:ss above, flooring', () => {
    expect(formatClock(750)).toBe('12:30');
    expect(formatClock(3723)).toBe('1:02:03');
    expect(formatClock(65.9)).toBe('1:05');
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(3599.99)).toBe('59:59');
    expect(formatClock(3600)).toBe('1:00:00');
  });
});

describe('formatDelta', () => {
  it('signs, pads and rounds to the nearest second with U+2212 minus', () => {
    expect(formatDelta(30)).toBe('+00:30');
    expect(formatDelta(-30)).toBe(`${MINUS}00:30`);
    expect(formatDelta(0.4)).toBe('00:00');
    expect(formatDelta(-0.4)).toBe('00:00');
    expect(formatDelta(0)).toBe('00:00');
    expect(formatDelta(-75)).toBe(`${MINUS}01:15`);
    expect(formatDelta(25)).toBe('+00:25');
    expect(formatDelta(-18)).toBe(`${MINUS}00:18`);
    expect(formatDelta(59.6)).toBe('+01:00');
  });
});

describe('formatPace', () => {
  it('formats sec/km as m:ss and a placeholder when unknown', () => {
    expect(formatPace(307)).toBe('5:07');
    expect(formatPace(299.6)).toBe('5:00');
    expect(formatPace(null)).toBe('–:––');
    expect(formatPace(Number.NaN)).toBe('–:––');
    expect(formatPace(0)).toBe('–:––');
  });
});

describe('formatDistance', () => {
  it('uses metres below 1 km and km with 2 decimals above', () => {
    expect(formatDistance(850)).toBe('850 m');
    expect(formatDistance(4820)).toBe('4.82 km');
    expect(formatDistance(999.4)).toBe('999 m');
    expect(formatDistance(999.6)).toBe('1.00 km');
    expect(formatDistance(0)).toBe('0 m');
  });
});

describe('deltaPhrase', () => {
  it('reads ON TARGET inside the band and AHEAD / BEHIND outside', () => {
    expect(deltaPhrase(1.5)).toBe('ON TARGET');
    expect(deltaPhrase(-1.9)).toBe('ON TARGET');
    expect(deltaPhrase(12)).toBe('12 SEC AHEAD');
    expect(deltaPhrase(-18)).toBe('18 SEC BEHIND');
    expect(deltaPhrase(-65)).toBe('1:05 BEHIND');
    expect(deltaPhrase(60)).toBe('1:00 AHEAD');
    expect(deltaPhrase(4, 5)).toBe('ON TARGET');
  });
});

describe('spokenDelta', () => {
  it('speaks seconds, minutes and on-target', () => {
    expect(spokenDelta(12)).toBe('12 seconds ahead');
    expect(spokenDelta(-1.2)).toBe('on target');
    expect(spokenDelta(-2.4)).toBe('2 seconds behind');
    expect(spokenDelta(-65)).toBe('1 minute 5 seconds behind');
    expect(spokenDelta(120)).toBe('2 minutes ahead');
    expect(spokenDelta(61)).toBe('1 minute 1 second ahead');
  });
});
