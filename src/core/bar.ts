/** Full-scale values (s) the live bar can use, smallest first. */
export const BAR_STEPS: readonly number[] = [10, 20, 30, 60, 120, 300, 600];

/** The scale grows to keep |advantage| at most 1 / GROW_HEADROOM (80 %) of full scale. */
const GROW_HEADROOM = 1.25;
/** The scale shrinks one step only once |advantage| < this share of the next-lower step. */
const SHRINK_SHARE = 0.4;
/** |advantage| (s) below which the bar shows no fill. */
const MIN_FILL_SEC = 0.5;

/** Index of the smallest step ≥ x (the largest step when none is). */
function stepIndexAtLeast(x: number): number {
  const i = BAR_STEPS.findIndex((s) => s >= x);
  return i === -1 ? BAR_STEPS.length - 1 : i;
}

/**
 * Full-scale value (s) of the diverging bar, with hysteresis so jitter never rescales it: grows at once
 * to the smallest step ≥ 1.25 × |advantage|; shrinks by one step only when |advantage| < 0.4 × the
 * next-lower step.
 */
export function barScale(absAdvantage: number, prevScale: number | null): number {
  const a = Number.isFinite(absAdvantage) ? Math.abs(absAdvantage) : 0;
  const need = stepIndexAtLeast(GROW_HEADROOM * a);
  if (prevScale === null || !Number.isFinite(prevScale)) return BAR_STEPS[need];
  const prev = stepIndexAtLeast(prevScale);
  if (need > prev) return BAR_STEPS[need];
  if (prev > 0 && a < SHRINK_SHARE * BAR_STEPS[prev - 1]) return BAR_STEPS[prev - 1];
  return BAR_STEPS[prev];
}

/**
 * Bar fill for an advantage at a full scale: 'ahead' extends right, 'behind' left, with
 * fraction = min(1, |advantage| / scale). No reading or |advantage| < 0.5 s → no fill.
 */
export function barGeometry(advantage: number | null, scale: number): { side: 'ahead' | 'behind' | 'none'; fraction: number } {
  if (advantage === null || !Number.isFinite(advantage) || Math.abs(advantage) < MIN_FILL_SEC) {
    return { side: 'none', fraction: 0 };
  }
  const fraction = scale > 0 ? Math.min(1, Math.abs(advantage) / scale) : 1;
  return { side: advantage > 0 ? 'ahead' : 'behind', fraction };
}
