/**
 * Deterministic randomness. Every client renders the same cue the same way
 * (ADR-0002), so all "hand" wobble, jitter and overshoot is seeded from the
 * shape id — never from Math.random().
 */

/** FNV-1a 32-bit string hash; stable across platforms. */
export function hashSeed(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export type Rng = () => number;

/** mulberry32: tiny, fast, good enough distribution for visual jitter. */
export function createRng(seed: number | string): Rng {
  let a = (typeof seed === 'string' ? hashSeed(seed) : seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform value in [-amplitude, +amplitude]. */
export function jitter(rng: Rng, amplitude: number): number {
  return (rng() * 2 - 1) * amplitude;
}
