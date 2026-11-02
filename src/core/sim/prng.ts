/** Deterministic randomness for simulations and tests. */

/** Mulberry32: a fast 32-bit seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sample (mean 0, sd 1) from a uniform source. */
export function gaussian(rand: () => number): number {
  // Box–Muller: z = √(−2 ln u1) · cos(2π u2), with u1 ∈ (0, 1] so the log is finite
  const u1 = 1 - rand();
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
