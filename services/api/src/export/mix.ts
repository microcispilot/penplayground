import { EXPORT_AUDIO_RATE } from './ffmpeg.js';

/** One synthesised take to place on the export's timeline. */
export interface MixTake {
  /** s16le mono samples at `sampleRate`. */
  pcm: Int16Array;
  sampleRate: number;
  /** Where on the output this take starts, ms (negative = starts before t=0; that part is dropped). */
  offsetMs: number;
  /** Audio the ledger accounts for; anything beyond it in `pcm` is not played. */
  durationMs: number;
}

/**
 * Mix every take into one s16le mono track at `outRate`, `durationMs` long.
 * Silence fills the gaps; overlapping takes sum and saturate (they never
 * overlap in a real session — a barge-in cancels the take before the next
 * one starts — so saturation is a safety net, not a mode). Takes at another
 * sample rate are resampled with linear interpolation, which is transparent
 * for speech going 24 k → 44.1 k. Pure, so it is unit-tested sample by sample;
 * ffmpeg then gets one raw input instead of one per sentence.
 */
export function mixTakes(
  takes: readonly MixTake[],
  durationMs: number,
  outRate = EXPORT_AUDIO_RATE,
): Int16Array {
  const total = Math.max(0, Math.round((durationMs / 1000) * outRate));
  const out = new Int16Array(total);
  for (const take of takes) {
    if (take.sampleRate <= 0 || take.durationMs <= 0) continue;
    const inLength = Math.min(
      take.pcm.length,
      Math.round((take.durationMs / 1000) * take.sampleRate),
    );
    if (inLength <= 0) continue;
    const start = Math.round((take.offsetMs / 1000) * outRate);
    const ratio = take.sampleRate / outRate;
    const outLength = Math.round(inLength / ratio);
    // Only the part of the take that lands inside the output is touched.
    const first = Math.max(0, -start);
    const last = Math.min(outLength, total - start);
    if (ratio === 1) {
      for (let j = first; j < last; j++) {
        const i = start + j;
        out[i] = clamp16((out[i] ?? 0) + (take.pcm[j] ?? 0));
      }
      continue;
    }
    for (let j = first; j < last; j++) {
      const pos = j * ratio;
      const k = Math.floor(pos);
      const frac = pos - k;
      const a = take.pcm[k] ?? 0;
      const b = k + 1 < inLength ? (take.pcm[k + 1] ?? a) : a;
      const sample = a + (b - a) * frac;
      const i = start + j;
      out[i] = clamp16((out[i] ?? 0) + sample);
    }
  }
  return out;
}

function clamp16(v: number): number {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v);
}

/** Interpret a file's bytes as s16le samples (copying only when the buffer is not 2-byte aligned). */
export function pcmFromBytes(bytes: Uint8Array): Int16Array {
  const length = Math.floor(bytes.byteLength / 2);
  if (bytes.byteOffset % 2 === 0) return new Int16Array(bytes.buffer, bytes.byteOffset, length);
  const aligned = new Uint8Array(length * 2);
  aligned.set(bytes.subarray(0, length * 2));
  return new Int16Array(aligned.buffer);
}

/** The bytes to write for `-f s16le`. */
export function bytesFromPcm(pcm: Int16Array): Uint8Array {
  return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}
