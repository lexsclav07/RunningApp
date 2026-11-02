const day = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const full = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

/** "Mon 3 Nov" */
export const formatDay = (ms: number) => day.format(ms);
/** "3 Nov 2026" */
export const formatDate = (ms: number) => full.format(ms);
/** "Mon 3 Nov, 7:42 am" */
export const formatDayTime = (ms: number) => `${day.format(ms)}, ${time.format(ms)}`;

/** "Today", "Yesterday", "3 days ago", else the date. */
export function formatRelativeDay(ms: number, now = Date.now()): string {
  const start = (t: number) => new Date(t).setHours(0, 0, 0, 0);
  const days = Math.round((start(now) - start(ms)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return `${days} days ago`;
  return formatDate(ms);
}
