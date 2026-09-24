import { cartesiaDelivery } from './delivery.js';
import { frameStream } from './fish-cloud.js';
import type { SpeechChunk, SpeechSynthesizer, SynthesisRequest } from './types.js';

const CARTESIA_TTS_URL = 'https://api.cartesia.ai/tts/bytes';
/** The API contract this adapter was written against (docs.cartesia.ai, 2026-09). */
const CARTESIA_VERSION = '2026-08-14';
const FRAME_MS = 120;
const MAX_TEXT_BYTES = 16 * 1024;
/**
 * Part of the engine id, and so of every stored take's hash (ADR-0017):
 * bumped when the way a sentence is delivered changes.
 */
const DELIVERY_VERSION = 'd1';
/** Sonic's own range for `generation_config.speed`; our pace is clamped into it. */
const SPEED_MIN = 0.6;
const SPEED_MAX = 1.5;

export interface CartesiaOptions {
  apiKey: string;
  /** sonic-3.6 (default) | sonic-3.5 | sonic-3 | sonic-latest */
  model?: string;
  fetchImpl?: typeof fetch;
  onFirstChunk?: (ms: number) => void;
}

/**
 * Cartesia adapter (ADR-0048): one HTTP request per sentence to `/tts/bytes`
 * with a raw `pcm_s16le` body, re-framed into the same fixed 120 ms chunks
 * with a continuous clock that every other engine produces, so nothing
 * downstream can tell engines apart. Delivery — the tone as
 * `generation_config.emotion`, the vetted inline cues in Sonic's own
 * dialect — is `cartesiaDelivery`'s; this file only carries it.
 */
export class CartesiaSynthesizer implements SpeechSynthesizer {
  readonly id: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: CartesiaOptions) {
    this.id = `cartesia:${opts.model ?? 'sonic-3.6'}+${DELIVERY_VERSION}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async *synthesize(request: SynthesisRequest): AsyncIterable<SpeechChunk> {
    const { transcript, emotion } = cartesiaDelivery(request.text, request.tone, request.language);
    if (new TextEncoder().encode(transcript).length > MAX_TEXT_BYTES)
      throw new Error('TTS_TEXT_TOO_LONG');
    const generation: Record<string, unknown> = {};
    if (request.speed && Math.abs(request.speed - 1) > 1e-3)
      generation.speed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, request.speed));
    if (emotion) generation.emotion = emotion;
    const body: Record<string, unknown> = {
      model_id: this.opts.model ?? 'sonic-3.6',
      transcript,
      voice: { mode: 'id', id: request.voice },
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: request.sampleRate },
      ...(request.language ? { language: request.language.split('-')[0]?.toLowerCase() } : {}),
      ...(Object.keys(generation).length > 0 ? { generation_config: generation } : {}),
    };
    const started = performance.now();
    const response = await this.fetchImpl(CARTESIA_TTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        'Cartesia-Version': CARTESIA_VERSION,
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
