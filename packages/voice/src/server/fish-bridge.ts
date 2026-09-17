import type { SpeechChunk, SpeechSynthesizer, SynthesisRequest } from './types.js';

/**
 * Simurgh tts-bridge adapter (self-hosted Fish S2-Pro on the GPU host):
 * POST /synthesize → application/x-ndjson, one TTSAudioChunk per line with
 * base64 s16le PCM. Barge-in: POST /synthesize/stop/{session_id}.
 */
export interface FishBridgeOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export class FishBridgeSynthesizer implements SpeechSynthesizer {
  readonly id = 'fish-bridge';
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: FishBridgeOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async *synthesize(request: SynthesisRequest): AsyncIterable<SpeechChunk> {
    const sessionId = `pen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const response = await this.fetchImpl(`${this.opts.baseUrl}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        voice_profile_id: request.voice,
        engine: 'fish-s2',
        text: request.text,
        sample_rate: request.sampleRate,
        emotion: request.tone ?? null,
        speaking_rate: request.speed ?? 1.0,
        interruption_allowed: true,
      }),
      signal: request.signal ?? null,
    });
    if (!response.ok || !response.body) throw new Error(`TTS_BRIDGE_${response.status}`);
    const stop = () => {
      void this.fetchImpl(`${this.opts.baseUrl}/synthesize/stop/${sessionId}`, {
        method: 'POST',
      }).catch(() => undefined);
    };
    request.signal?.addEventListener('abort', stop, { once: true });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let index = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl = buf.indexOf('\n');
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) {
            const j = JSON.parse(line) as {
              audio_clock_ms: number;
              pcm_s16le_bytes: string;
              sample_rate: number;
              duration_ms: number;
              text_span?: string;
            };
            yield {
              audioChunkId: index++,
              audioClockMs: j.audio_clock_ms,
              sampleRate: j.sample_rate as SpeechChunk['sampleRate'],
              durationMs: j.duration_ms,
              pcm: Uint8Array.from(Buffer.from(j.pcm_s16le_bytes, 'base64')),
              textSpan: j.text_span ?? null,
            };
          }
          nl = buf.indexOf('\n');
        }
      }
    } finally {
      request.signal?.removeEventListener('abort', stop);
      reader.releaseLock();
    }
  }
}
