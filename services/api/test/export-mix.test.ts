import { describe, expect, it } from 'vitest';
import { bytesFromPcm, mixTakes, pcmFromBytes } from '../src/export/mix.js';

const RATE = 44_100;
const ms = (n: number, rate = RATE) => Math.round((n / 1000) * rate);

/** `length` samples of a constant value. */
function tone(length: number, value: number): Int16Array {
  return new Int16Array(length).fill(value);
}

describe('mixTakes', () => {
  it('is exactly as long as the requested duration, silent where nothing plays', () => {
    const out = mixTakes([], 1234);
    expect(out.length).toBe(ms(1234));
    expect(out.every((s) => s === 0)).toBe(true);
    expect(mixTakes([], 0).length).toBe(0);
  });

  it('places takes at their offsets with silence in the gaps', () => {
    const out = mixTakes(
      [
        { pcm: tone(ms(100), 1000), sampleRate: RATE, offsetMs: 0, durationMs: 100 },
        { pcm: tone(ms(100), -2000), sampleRate: RATE, offsetMs: 300, durationMs: 100 },
      ],
      500,
    );
    expect(out.length).toBe(ms(500));
    expect(out[0]).toBe(1000);
    expect(out[ms(100) - 1]).toBe(1000);
    // The gap between the two.
    expect(out[ms(100)]).toBe(0);
    expect(out[ms(200)]).toBe(0);
    expect(out[ms(300) - 1]).toBe(0);
    expect(out[ms(300)]).toBe(-2000);
    expect(out[ms(400) - 1]).toBe(-2000);
    // Silence after the last take until the end.
    expect(out[ms(400)]).toBe(0);
    expect(out[out.length - 1]).toBe(0);
  });

  it('sums overlapping takes and saturates instead of wrapping', () => {
    const out = mixTakes(
      [
        { pcm: tone(ms(200), 1000), sampleRate: RATE, offsetMs: 0, durationMs: 200 },
        { pcm: tone(ms(200), 500), sampleRate: RATE, offsetMs: 100, durationMs: 200 },
        { pcm: tone(ms(50), 32000), sampleRate: RATE, offsetMs: 250, durationMs: 50 },
        { pcm: tone(ms(50), 32000), sampleRate: RATE, offsetMs: 250, durationMs: 50 },
      ],
      400,
    );
    expect(out[ms(50)]).toBe(1000);
    expect(out[ms(150)]).toBe(1500);
    expect(out[ms(250)]).toBe(32767);
    expect(out[ms(299)]).toBe(32767);
    const neg = mixTakes(
      [
        { pcm: tone(ms(10), -30000), sampleRate: RATE, offsetMs: 0, durationMs: 10 },
        { pcm: tone(ms(10), -30000), sampleRate: RATE, offsetMs: 0, durationMs: 10 },
      ],
      10,
    );
    expect(neg[0]).toBe(-32768);
  });

  it('trims a take to the ledger duration and to the end of the output', () => {
    const out = mixTakes(
      [
        // File longer than the ledger says: only 100 ms of it is played.
        { pcm: tone(ms(500), 700), sampleRate: RATE, offsetMs: 0, durationMs: 100 },
        // Starts before the output ends and runs past it: cut at the end.
        { pcm: tone(ms(500), 900), sampleRate: RATE, offsetMs: 200, durationMs: 500 },
      ],
      300,
    );
    expect(out.length).toBe(ms(300));
    expect(out[ms(100) - 1]).toBe(700);
    expect(out[ms(100)]).toBe(0);
    expect(out[ms(200)]).toBe(900);
    expect(out[out.length - 1]).toBe(900);
  });

  it('drops the part of a take that starts before t=0', () => {
    const pcm = new Int16Array(ms(100));
    for (let i = 0; i < pcm.length; i++) pcm[i] = i < ms(50) ? 11 : 22;
    const out = mixTakes([{ pcm, sampleRate: RATE, offsetMs: -50, durationMs: 100 }], 100);
    expect(out[0]).toBe(22);
    expect(out[ms(50) - 1]).toBe(22);
    expect(out[ms(50)]).toBe(0);
  });

  it('resamples 24 kHz and 48 kHz takes to the output rate, preserving length and level', () => {
    const out = mixTakes(
      [
        { pcm: tone(ms(200, 24_000), 4000), sampleRate: 24_000, offsetMs: 0, durationMs: 200 },
        { pcm: tone(ms(200, 48_000), -4000), sampleRate: 48_000, offsetMs: 300, durationMs: 200 },
      ],
      600,
    );
    expect(out.length).toBe(ms(600));
    // A constant stays constant through linear interpolation, and lands on the right samples.
    expect(out[0]).toBe(4000);
    expect(out[ms(199)]).toBe(4000);
    expect(out[ms(200) + 2]).toBe(0);
    expect(out[ms(300)]).toBe(-4000);
    expect(out[ms(499)]).toBe(-4000);
    expect(out[ms(500) + 2]).toBe(0);
    // Length in samples of the resampled take is within a sample of the exact ratio.
    const upsampled = mixTakes(
      [{ pcm: tone(24_000, 100), sampleRate: 24_000, offsetMs: 0, durationMs: 1000 }],
      1000,
    );
    const nonZero = upsampled.filter((s) => s !== 0).length;
    expect(Math.abs(nonZero - RATE)).toBeLessThanOrEqual(1);
  });

  it('interpolates between samples when upsampling a ramp', () => {
    const ramp = new Int16Array([0, 1000, 2000, 3000]);
    // 2 → 4 samples per unit: every other output sample is a midpoint.
    const out = mixTakes([{ pcm: ramp, sampleRate: 2, offsetMs: 0, durationMs: 2000 }], 2000, 4);
    expect(Array.from(out)).toEqual([0, 500, 1000, 1500, 2000, 2500, 3000, 3000]);
  });

  it('round-trips through bytes, aligned or not', () => {
    const pcm = new Int16Array([1, -1, 32767, -32768, 1234]);
    const bytes = bytesFromPcm(pcm);
    expect(bytes.byteLength).toBe(10);
    expect(Array.from(pcmFromBytes(bytes))).toEqual(Array.from(pcm));
    // An odd byte offset (Node's pooled Buffers) forces a copy but reads the same samples.
    const padded = new Uint8Array(11);
    padded.set(bytes, 1);
    const view = new Uint8Array(padded.buffer, 1, 10);
    expect(Array.from(pcmFromBytes(view))).toEqual(Array.from(pcm));
    // A trailing odd byte is ignored.
    const odd = new Uint8Array(padded.buffer, 0, 11);
    expect(pcmFromBytes(odd).length).toBe(5);
  });
});
