/** Display formatting (metric only). Signed deltas use U+2212 for minus; positive = ahead. */

const MINUS = '\u2212';
const PLACEHOLDER = '–:––';

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Run clock: "12:30", "1:02:03" (floored to whole seconds). */
export function formatClock(sec: number): string {
  if (!Number.isFinite(sec)) return PLACEHOLDER;
  if (sec < 0) return MINUS + formatClock(-sec);
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(ss)}` : `${m}:${pad2(ss)}`;
}

/** Signed time difference: "+00:25", "−00:18", "00:00" (rounded to the nearest second). */
export function formatDelta(sec: number): string {
  if (!Number.isFinite(sec)) return PLACEHOLDER;
  const r = Math.round(Math.abs(sec));
  if (r === 0) return '00:00';
  return `${sec > 0 ? '+' : MINUS}${pad2(Math.floor(r / 60))}:${pad2(r % 60)}`;
}

/** Pace in sec/km as "5:07"; "–:––" when unknown. */
export function formatPace(secPerKm: number | null): string {
  if (secPerKm === null || !Number.isFinite(secPerKm) || secPerKm <= 0) return PLACEHOLDER;
  const r = Math.round(secPerKm);
  return `${Math.floor(r / 60)}:${pad2(r % 60)}`;
}

/** "850 m" below 1 km, "4.82 km" above. */
export function formatDistance(m: number): string {
  const v = Number.isFinite(m) ? Math.max(0, m) : 0;
  const r = Math.round(v);
  return r < 1000 ? `${r} m` : `${(v / 1000).toFixed(2)} km`;
}

/** Short on-screen phrase: "ON TARGET" inside ±band, else "12 SEC AHEAD" / "1:05 BEHIND". */
export function deltaPhrase(sec: number, band = 2): string {
  if (!Number.isFinite(sec)) return '';
  if (Math.abs(sec) < band) return 'ON TARGET';
  const r = Math.round(Math.abs(sec));
  const side = sec > 0 ? 'AHEAD' : 'BEHIND';
  return r >= 60 ? `${Math.floor(r / 60)}:${pad2(r % 60)} ${side}` : `${r} SEC ${side}`;
}

/** Text for speech: "12 seconds ahead", "1 minute 5 seconds behind", "on target". */
export function spokenDelta(sec: number, band = 2): string {
  if (!Number.isFinite(sec)) return '';
  if (Math.abs(sec) < band) return 'on target';
  const r = Math.round(Math.abs(sec));
  const m = Math.floor(r / 60);
  const s = r % 60;
  const parts: string[] = [];
  if (m > 0) parts.push(`${m} ${m === 1 ? 'minute' : 'minutes'}`);
  if (s > 0 || m === 0) parts.push(`${s} ${s === 1 ? 'second' : 'seconds'}`);
  return `${parts.join(' ')} ${sec > 0 ? 'ahead' : 'behind'}`;
}
