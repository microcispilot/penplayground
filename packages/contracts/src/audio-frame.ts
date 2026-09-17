import { z } from 'zod';
import { SayId } from './ids.js';

/**
 * Binary audio frames on the room socket.
 *
 * Layout: `u16 (LE) headerLength` · `headerLength` bytes of UTF-8 JSON header ·
 * PCM s16le mono payload. One codec for both directions so one jitter buffer
 * and one barge-in fade serve every adapter (Simurgh's lesson: Fish NDJSON
 * field names are the lingua franca).
 */
export const DownstreamAudioHeader = z.object({
  dir: z.literal('down'),
  sayId: SayId,
  /** Monotonic per say. */
  audioChunkId: z.number().int().nonnegative(),
  /** Position of this chunk within the say, ms. */
  audioClockMs: z.number().int().nonnegative(),
  sampleRate: z.union([z.literal(24000), z.literal(44100), z.literal(48000)]),
  durationMs: z.number().int().positive(),
  /** Text covered by this chunk, when the synthesizer reports it. */
  textSpan: z.string().nullable(),
  /** Last chunk of this say. */
  final: z.boolean(),
  /**
   * Re-synthesis counter for the same say (after a barge-in the interrupted
   * sentence is spoken again from the start). Clients drop chunks whose take
   * is older than the latest they were told to expect.
   */
  take: z.number().int().nonnegative(),
});
export type DownstreamAudioHeader = z.infer<typeof DownstreamAudioHeader>;

export const UpstreamAudioHeader = z.object({
  dir: z.literal('up'),
  utteranceId: z.string(),
  sampleRate: z.literal(16000),
});
export type UpstreamAudioHeader = z.infer<typeof UpstreamAudioHeader>;

export const AudioHeader = z.discriminatedUnion('dir', [
  DownstreamAudioHeader,
  UpstreamAudioHeader,
]);
export type AudioHeader = z.infer<typeof AudioHeader>;

/** Upstream frames are ≤ 250 ms of 16 kHz s16le (8 000 bytes). */
export const UPSTREAM_FRAME_BYTES_MAX = 8000;
/** Downstream frames are ≤ ~1 s of 48 kHz s16le. */
export const DOWNSTREAM_FRAME_BYTES_MAX = 96_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeAudioFrame(header: AudioHeader, pcm: Uint8Array): Uint8Array {
  const headerBytes = encoder.encode(JSON.stringify(header));
  if (headerBytes.length > 0xffff) throw new Error('audio frame header too large');
  const out = new Uint8Array(2 + headerBytes.length + pcm.length);
  out[0] = headerBytes.length & 0xff;
  out[1] = headerBytes.length >>> 8;
  out.set(headerBytes, 2);
  out.set(pcm, 2 + headerBytes.length);
  return out;
}

export function decodeAudioFrame(frame: Uint8Array): { header: AudioHeader; pcm: Uint8Array } {
  if (frame.length < 2) throw new Error('audio frame too short');
  const len = (frame[0] ?? 0) | ((frame[1] ?? 0) << 8);
  if (frame.length < 2 + len) throw new Error('audio frame truncated');
  const header = AudioHeader.parse(JSON.parse(decoder.decode(frame.subarray(2, 2 + len))));
  return { header, pcm: frame.subarray(2 + len) };
}
