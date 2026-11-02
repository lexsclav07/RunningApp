/** GPX 1.1 export (https://www.topografix.com/GPX/1/1/). */

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

/** Degrees rounded to 7 decimals (≈ 1 cm), without trailing zeros. */
const coord = (x: number) => String(Number(x.toFixed(7)));

/** ISO 8601 UTC from epoch ms; whole seconds drop the ".000". */
const isoTime = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

/**
 * A single-track GPX 1.1 document (creator "Ghost Pace"). `<ele>` (m, 1 decimal) and `<time>` (from epoch
 * ms `t`) are written only when present; points with invalid coordinates are skipped. The metadata time
 * is the first point's time.
 */
export function toGpx(args: { name: string; points: { lat: number; lon: number; ele?: number | null; t?: number }[] }): string {
  const name = escapeXml(args.name);
  const valid = args.points.filter(
    (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180,
  );
  const timed = valid.find((p) => typeof p.t === 'number' && Number.isFinite(p.t));
  const trkpts = valid.map((p) => {
    const ele = typeof p.ele === 'number' && Number.isFinite(p.ele) ? `<ele>${p.ele.toFixed(1)}</ele>` : '';
    const time = typeof p.t === 'number' && Number.isFinite(p.t) ? `<time>${isoTime(p.t)}</time>` : '';
    return `<trkpt lat="${coord(p.lat)}" lon="${coord(p.lon)}">${ele}${time}</trkpt>`;
  });
  const metaTime = timed?.t !== undefined ? `<time>${isoTime(timed.t)}</time>` : '';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Ghost Pace" xmlns="http://www.topografix.com/GPX/1/1">',
    `<metadata><name>${name}</name>${metaTime}</metadata>`,
    `<trk><name>${name}</name><trkseg>${trkpts.map((p) => `\n${p}`).join('')}${trkpts.length > 0 ? '\n' : ''}</trkseg></trk>`,
    '</gpx>',
    '',
  ].join('\n');
}
