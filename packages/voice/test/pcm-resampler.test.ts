import { describe, expect, it } from 'vitest';
import { resampleMonoToPcmS16le } from '../src/client/pcm-resampler.js';
import { silence, tone } from './helpers.js';

function int16View(bytes: Uint8Array): Int16Array {
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
}

describe('resampleMonoToPcmS16le', () => {
  it('produces exactly one third of the samples for 48 kHz → 16 kHz, as s16le', () => {
    const out = resampleMonoToPcmS16le(silence(48_000, 1_000), 48_000);
    expect(out.byteLength).toBe(16_000 * 2);
    expect(int16View(out).every((v) => v === 0)).toBe(true);
  });

  it('preserves a 1 kHz tone amplitude within the pass band and never clips', () => {
    const out = int16View(resampleMonoToPcmS16le(tone(48_000, 500, 1_000, 0.5), 48_000));
    let peak = 0;
    let sum = 0;
    // Skip the filter's edge region at both ends.
    for (let index = 64; index < out.length - 64; index += 1) {
      const value = Math.abs(out[index] ?? 0);
      if (value > peak) peak = value;
      sum += out[index] ?? 0;
    }
    expect(peak).toBeGreaterThan(0.5 * 32_767 * 0.95);
    expect(peak).toBeLessThanOrEqual(0.5 * 32_767 * 1.05);
    // No DC offset introduced.
    expect(Math.abs(sum / out.length)).toBeLessThan(50);
  });

  it('band-limits: a 12 kHz tone (above the 16 kHz Nyquist) is attenuated to near silence', () => {
    const out = int16View(resampleMonoToPcmS16le(tone(48_000, 500, 12_000, 0.5), 48_000));
    let peak = 0;
    for (let index = 64; index < out.length - 64; index += 1) {
      peak = Math.max(peak, Math.abs(out[index] ?? 0));
    }
    expect(peak).toBeLessThan(0.5 * 32_767 * 0.05);
  });

  it('clamps full-scale input to the s16 range', () => {
    const loud = tone(48_000, 100, 440, 4);
    const out = int16View(resampleMonoToPcmS16le(loud, 48_000));
    for (const value of out) {
      expect(value).toBeGreaterThanOrEqual(-32_768);
      expect(value).toBeLessThanOrEqual(32_767);
    }
  });

  it('caps the output at the 20 s utterance bound', () => {
    const out = resampleMonoToPcmS16le(silence(48_000, 21_000), 48_000);
    expect(out.byteLength).toBe(16_000 * 20 * 2);
  });

  it('rejects unusable rates and empty input', () => {
    expect(() => resampleMonoToPcmS16le(silence(48_000, 10), 8_000)).toThrow(
      'PEN_MICROPHONE_SAMPLE_RATE_REJECTED',
    );
    expect(() => resampleMonoToPcmS16le(new Float32Array(0), 48_000)).toThrow(
      'PEN_MICROPHONE_SAMPLE_RATE_REJECTED',
    );
  });
});
