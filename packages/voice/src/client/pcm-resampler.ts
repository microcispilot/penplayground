import { MAX_UTTERANCE_MS, STT_SAMPLE_RATE_HZ } from './constants.js';

const RESAMPLER_RADIUS = 12;

function pcm16(value: number): number {
  const clamped = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

function sinc(value: number): number {
  if (Math.abs(value) < 1e-8) return 1;
  const radians = Math.PI * value;
  return Math.sin(radians) / radians;
}

// Windowed-sinc taps are identical for every output sample that shares the
// same fractional source position, so they are computed once per phase and
// reused. 48 kHz → 16 kHz has exactly 3 phases; other rates quantize the
// fractional position to PHASE_STEPS sub-positions, well below the
// audibility floor for 16 kHz speech. Per-tap sin/cos on every output sample
// cost ~48 transcendental calls per sample on the main thread.
const PHASE_STEPS = 256;
const TAPS = RESAMPLER_RADIUS * 2;

interface ResamplerFilterBank {
  /** [phase][tap] */
  readonly weights: Float64Array;
  /** Per-phase sum of weights (full window). */
  readonly totals: Float64Array;
}

const filterBanks = new Map<number, ResamplerFilterBank>();

function filterBankFor(sourceSampleRate: number): ResamplerFilterBank {
  const cached = filterBanks.get(sourceSampleRate);
  if (cached !== undefined) return cached;
  const cutoff = Math.min(1, STT_SAMPLE_RATE_HZ / sourceSampleRate) * 0.94;
  const weights = new Float64Array(PHASE_STEPS * TAPS);
  const totals = new Float64Array(PHASE_STEPS);
  for (let phase = 0; phase < PHASE_STEPS; phase += 1) {
    const fraction = phase / PHASE_STEPS;
    let total = 0;
    for (let tap = 0; tap < TAPS; tap += 1) {
      const sourceOffset = tap - RESAMPLER_RADIUS + 1;
      const distance = fraction - sourceOffset;
      const normalizedDistance = Math.abs(distance) / RESAMPLER_RADIUS;
      const weight =
        normalizedDistance >= 1
          ? 0
          : cutoff * sinc(distance * cutoff) * (0.5 * (1 + Math.cos(Math.PI * normalizedDistance)));
      weights[phase * TAPS + tap] = weight;
      total += weight;
    }
    totals[phase] = total;
  }
  const bank = { weights, totals };
  filterBanks.set(sourceSampleRate, bank);
  return bank;
}

/** Deterministic band-limited mono resampling to the STT rate (16 kHz),
 * followed by signed little-endian 16-bit PCM. Output is capped at
 * MAX_UTTERANCE_MS worth of samples. */
export function resampleMonoToPcmS16le(input: Float32Array, sourceSampleRate: number): Uint8Array {
  if (
    !Number.isFinite(sourceSampleRate) ||
    sourceSampleRate < STT_SAMPLE_RATE_HZ ||
    sourceSampleRate > 192_000 ||
    input.length === 0
  ) {
    throw new Error('PEN_MICROPHONE_SAMPLE_RATE_REJECTED');
  }
  const outputSamples = Math.min(
    STT_SAMPLE_RATE_HZ * (MAX_UTTERANCE_MS / 1_000),
    Math.floor((input.length * STT_SAMPLE_RATE_HZ) / sourceSampleRate),
  );
  const bytes = new Uint8Array(outputSamples * 2);
  const view = new DataView(bytes.buffer);
  const ratio = sourceSampleRate / STT_SAMPLE_RATE_HZ;
  const { weights, totals } = filterBankFor(sourceSampleRate);
  const inputLength = input.length;
  for (let outputIndex = 0; outputIndex < outputSamples; outputIndex += 1) {
    const sourcePosition = outputIndex * ratio;
    const center = Math.floor(sourcePosition);
    const phase = Math.min(PHASE_STEPS - 1, Math.round((sourcePosition - center) * PHASE_STEPS));
    const base = phase * TAPS;
    const firstSource = center - RESAMPLER_RADIUS + 1;
    let weighted = 0;
    let totalWeight = totals[phase] ?? 0;
    if (firstSource >= 0 && firstSource + TAPS <= inputLength) {
      for (let tap = 0; tap < TAPS; tap += 1) {
        weighted += (input[firstSource + tap] ?? 0) * (weights[base + tap] ?? 0);
      }
    } else {
      // Signal edges: only in-range taps contribute, so renormalize.
      totalWeight = 0;
      for (let tap = 0; tap < TAPS; tap += 1) {
        const sourceIndex = firstSource + tap;
        if (sourceIndex < 0 || sourceIndex >= inputLength) continue;
        const weight = weights[base + tap] ?? 0;
        weighted += (input[sourceIndex] ?? 0) * weight;
        totalWeight += weight;
      }
    }
    const sample = pcm16(totalWeight === 0 ? 0 : weighted / totalWeight);
    view.setInt16(outputIndex * 2, sample, true);
  }
  return bytes;
}
