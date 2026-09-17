/** Deterministic signal generators shared by the client-pipeline tests. */

/** mulberry32: small, deterministic, good enough for white noise. */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function tone(
  sampleRate: number,
  durationMs: number,
  frequencyHz: number,
  amplitude: number,
  phaseOffsetSamples = 0,
): Float32Array {
  const count = Math.round((sampleRate * durationMs) / 1_000);
  const out = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    out[index] =
      amplitude * Math.sin((2 * Math.PI * frequencyHz * (index + phaseOffsetSamples)) / sampleRate);
  }
  return out;
}

export function whiteNoise(
  sampleRate: number,
  durationMs: number,
  amplitude: number,
  seed = 1,
): Float32Array {
  const random = prng(seed);
  const count = Math.round((sampleRate * durationMs) / 1_000);
  const out = new Float32Array(count);
  for (let index = 0; index < count; index += 1) out[index] = amplitude * (random() * 2 - 1);
  return out;
}

export function silence(sampleRate: number, durationMs: number): Float32Array {
  return new Float32Array(Math.round((sampleRate * durationMs) / 1_000));
}

export function concat(parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Split a signal into fixed frames (the worklet's 20 ms cadence). */
export function frames(signal: Float32Array, frameSamples: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (let offset = 0; offset < signal.length; offset += frameSamples) {
    out.push(signal.slice(offset, Math.min(signal.length, offset + frameSamples)));
  }
  return out;
}
