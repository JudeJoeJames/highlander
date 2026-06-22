/**
 * Deterministic RNG. We deliberately avoid Math.random() so that a command
 * stream replays identically everywhere (server, reconnecting clients, tests).
 * The seed lives in GameState and the reducer advances it on each random op.
 */

/** mulberry32: tiny, fast, good-enough PRNG returning [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle in place using the supplied rng. */
export function shuffleInPlace<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
}

/** Derive the next 32-bit seed from an rng stream. */
export function nextSeed(rng: () => number): number {
  return Math.floor(rng() * 0x100000000) >>> 0;
}
