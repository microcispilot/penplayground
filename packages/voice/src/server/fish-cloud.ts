import type { SpeechChunk, SpeechSynthesizer, SynthesisRequest } from './types.js';

const FISH_TTS_URL = 'https://api.fish.audio/v1/tts';
const FRAME_MS = 120;
const MAX_TEXT_BYTES = 16 * 1024;

const DELIVERY_TAGS =
  /\[(?:soft tone|warm tone|chuckle|chuckling|sigh|sighing|emphasis|pause|long pause|excited|whisper|whispering|break|long-break)\]/gi;

/** Fish S2.1 reads bracket tags as emotion; strip anything the model may have added that we don't want spoken. */
export function stripDeliveryTags(text: string): string {
  return text
    .replace(DELIVERY_TAGS, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export interface FishCloudOptions {
  apiKey: string;
  /** s2.1-pro (default) | s2.1-pro-free | s2-pro | s1 */
  model?: string;
  latency?: 'normal' | 'balanced';
  fetchImpl?: typeof fetch;
  onFirstChunk?: (ms: number) => void;
}

/**
 * Fish Audio cloud adapter: HTTP chunked PCM, framed into fixed 120 ms
 * chunks with a continuous audio clock (the Simurgh contract).
 */
export class FishCloudSynthesizer implements SpeechSynthesizer {
  readonly id: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: FishCloudOptions) {
    this.id = `fish-cloud:${opts.model ?? 's2.1-pro'}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async *synthesize(request: SynthesisRequest): AsyncIterable<SpeechChunk> {
    const text = stripDeliveryTags(request.text);
    if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES)
      throw new Error('TTS_TEXT_TOO_LONG');
    const body: Record<string, unknown> = {
      text,
      reference_id: request.voice,
      format: 'pcm',
      sample_rate: request.sampleRate,
      latency: this.opts.latency ?? 'balanced',
      chunk_length: 200,
    };
    if (request.speed && Math.abs(request.speed - 1) > 1e-3)
      body.prosody = { speed: Math.min(2, Math.max(0.5, request.speed)), volume: 0 };
    const started = performance.now();
    const response = await this.fetchImpl(FISH_TTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        model: this.opts.model ?? 's2.1-pro',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: request.signal ?? null,
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(`TTS_UPSTREAM_${response.status}: ${detail.slice(0, 200)}`);
    }
    yield* frameStream(response.body, request.sampleRate, FRAME_MS, (i) => {
      if (i === 0) this.opts.onFirstChunk?.(Math.round(performance.now() - started));
    });
  }
}

/** Re-frame a raw s16le byte stream into fixed-duration chunks with a continuous clock. */
export async function* frameStream(
  body: ReadableStream<Uint8Array>,
  sampleRate: 24000 | 44100 | 48000,
  frameMs: number,
  onChunk?: (index: number) => void,
): AsyncIterable<SpeechChunk> {
  const frameBytes = Math.floor((sampleRate * frameMs) / 1000) * 2;
  let pending = new Uint8Array(0);
  let index = 0;
  let clockMs = 0;
  const emit = (payload: Uint8Array): SpeechChunk => {
    const durationMs = Math.max(1, Math.round(((payload.length / 2) * 1000) / sampleRate));
    const chunk: SpeechChunk = {
      audioChunkId: index,
      audioClockMs: clockMs,
      sampleRate,
      durationMs,
      pcm: payload,
      textSpan: null,
    };
    onChunk?.(index);
    index += 1;
    clockMs += durationMs;
    return chunk;
  };
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      const merged = new Uint8Array(pending.length + value.length);
      merged.set(pending);
      merged.set(value, pending.length);
      pending = merged;
      while (pending.length >= frameBytes) {
        yield emit(pending.slice(0, frameBytes));
        pending = pending.slice(frameBytes);
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (pending.length % 2) pending = pending.slice(0, pending.length - 1);
  if (pending.length) yield emit(pending);
}
