/** @jest-environment node */
import { describe, expect, it } from '@jest/globals';
import { toGpx } from '../gpx';

describe('toGpx', () => {
  it('writes a GPX 1.1 track with creator "Ghost Pace"', () => {
    const gpx = toGpx({
      name: 'Riverside',
      points: [
        { lat: 51.5, lon: -0.13, ele: 12.34, t: Date.UTC(2026, 9, 29, 7, 0, 0) },
        { lat: 51.50001, lon: -0.12999, ele: 12.5, t: Date.UTC(2026, 9, 29, 7, 0, 1, 500) },
      ],
    });
    expect(gpx.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(gpx).toContain('<gpx version="1.1" creator="Ghost Pace" xmlns="http://www.topografix.com/GPX/1/1">');
    expect(gpx).toContain('<metadata><name>Riverside</name><time>2026-10-29T07:00:00Z</time></metadata>');
    expect(gpx).toContain('<trk><name>Riverside</name><trkseg>');
    expect(gpx).toContain('<trkpt lat="51.5" lon="-0.13"><ele>12.3</ele><time>2026-10-29T07:00:00Z</time></trkpt>');
    expect(gpx).toContain('<trkpt lat="51.50001" lon="-0.12999"><ele>12.5</ele><time>2026-10-29T07:00:01.500Z</time></trkpt>');
    expect(gpx.trimEnd().endsWith('</trkseg></trk>\n</gpx>')).toBe(true);
  });

  it('XML-escapes the name', () => {
    const gpx = toGpx({ name: `Tom & Jerry's <"loop">`, points: [] });
    expect(gpx).toContain('<name>Tom &amp; Jerry&apos;s &lt;&quot;loop&quot;&gt;</name>');
    expect(gpx).not.toContain('Tom & Jerry');
  });

  it('writes <ele> and <time> only when present', () => {
    const gpx = toGpx({
      name: 'r',
      points: [
        { lat: 1, lon: 2 },
        { lat: 1.5, lon: 2.5, ele: null },
        { lat: 1.25, lon: 2.25, ele: 0 },
      ],
    });
    expect(gpx).toContain('<trkpt lat="1" lon="2"></trkpt>');
    expect(gpx).toContain('<trkpt lat="1.5" lon="2.5"></trkpt>');
    expect(gpx).toContain('<trkpt lat="1.25" lon="2.25"><ele>0.0</ele></trkpt>');
    expect(gpx).not.toContain('<time>');
    expect(gpx).toContain('<metadata><name>r</name></metadata>');
  });

  it('rounds coordinates to 7 decimals and skips invalid points', () => {
    const gpx = toGpx({
      name: 'r',
      points: [
        { lat: 51.123456789, lon: -0.987654321 },
        { lat: Number.NaN, lon: 0 },
        { lat: 95, lon: 0 },
        { lat: 0, lon: Number.POSITIVE_INFINITY },
      ],
    });
    expect(gpx).toContain('<trkpt lat="51.1234568" lon="-0.9876543"></trkpt>');
    expect(gpx.match(/<trkpt /g)).toHaveLength(1);
  });

  it('produces an empty segment for no points', () => {
    expect(toGpx({ name: 'x', points: [] })).toContain('<trkseg></trkseg>');
  });
});
