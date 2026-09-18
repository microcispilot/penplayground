/**
 * Server-side speech seams (ADR-0004). One chunk contract for every adapter
 * so one jitter buffer and one barge-in fade serve them all.
 */
export interface SpeechChunk {
  /** Monotonic per synthesis. */
  audioChunkId: number;
  /** Position of this chunk's first sample within the utterance, ms. */
  audioClockMs: number;
  sampleRate: 24000 | 44100 | 48000;
  durationMs: number;
  pcm: Uint8Array; // s16le mono
  textSpan: string | null;
  /**
   * True when this audio came from the synthesis cache rather than the
   * provider (ADR-0016). The pipeline reads it off the first chunk to record
   * the `tts` stage as reused and to bill the sentence at $0.
   */
  reused?: boolean;
}

export interface SynthesisRequest {
  text: string;
  /** Deployment-resolved voice reference (Fish reference_id or bridge profile id). */
  voice: string;
  sampleRate: 24000 | 44100 | 48000;
  /** 0.5–2.0 */
  speed?: number;
  /** Delivery hint the engine may honour ("warm", "curious"). */
  tone?: string;
  signal?: AbortSignal;
}

export interface SpeechSynthesizer {
  readonly id: string;
  /** Streams audio for one sentence; the first chunk should arrive within ~300 ms. */
  synthesize(request: SynthesisRequest): AsyncIterable<SpeechChunk>;
}

export interface VoiceResolver {
  /** Maps a catalog voice id (af_heart) to this deployment's engine voice. */
  resolve(voiceId: string): string;
}

export class StaticVoiceResolver implements VoiceResolver {
  constructor(
    private readonly map: Record<string, string>,
    private readonly fallback: string,
  ) {}
  resolve(voiceId: string): string {
    return this.map[voiceId] ?? this.fallback;
  }
}
