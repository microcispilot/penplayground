import type { SpeechChunk, SpeechSynthesizer, SynthesisRequest } from './types.js';

/**
 * Test/offline synthesizer: emits silence timed like real speech
 * (~150 words/min) so the conductor, captions and board pacing can be
 * exercised end to end without a provider. Never selected in production.
 */
export class SilentSynthesizer implements SpeechSynthesizer {
  readonly id = 'silent';
  constructor(private readonly opts: { realtime?: boolean; wordsPerMinute?: number } = {}) {}

  async *synthesize(request: SynthesisRequest): AsyncIterable<SpeechChunk> {
    const words = request.text.trim().split(/\s+/).filter(Boolean).length || 1;
    const wpm = this.opts.wordsPerMinute ?? 150;
    const totalMs = Math.max(350, Math.round((words / wpm) * 60_000));
    const frameMs = 120;
    const frameBytes = Math.floor((request.sampleRate * frameMs) / 1000) * 2;
    let clock = 0;
    let i = 0;
    while (clock < totalMs) {
      if (request.signal?.aborted) return;
      const durationMs = Math.min(frameMs, totalMs - clock);
      const bytes = Math.floor((request.sampleRate * durationMs) / 1000) * 2;
      if (this.opts.realtime) await new Promise((r) => setTimeout(r, durationMs));
      yield { audioChunkId: i++, audioClockMs: clock, sampleRate: request.sampleRate, durationMs, pcm: new Uint8Array(Math.min(bytes, frameBytes)), textSpan: null };
      clock += durationMs;
    }
  }
}
