import type { DownstreamAudioHeader, SayEvent } from '@pen/contracts';
import type { SpeechSynthesizer } from '@pen/voice';
import type { RoomObserver, RoomTransport } from './transport.js';

export interface SayPipelineOptions {
  synthesizer: SpeechSynthesizer;
  voice: string;
  sampleRate: 24000 | 44100 | 48000;
  transport: RoomTransport;
  observer: RoomObserver;
  /** How many sentences may be synthesised ahead of the last one the room finished hearing. */
  lookahead?: number;
  onComplete?: (sayId: string, durationMs: number) => void;
  onFailure?: (sayId: string, error: unknown) => void;
}

/**
 * Sentence-level TTS pipeline: synthesises `say` cues in order, streams chunks
 * as binary audio frames, bounds lookahead so a barge-in wastes at most a
 * couple of sentences, and reports per-sentence duration for the clock.
 */
/** Markdown never reaches the voice: backticks, emphasis markers and bare URLs read badly aloud. */
export function spokenText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|[.,;:!?]|$)/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/https?:\/\/\S+/g, 'the link on the board')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export class SayPipeline {
  private readonly queue: Array<{ say: SayEvent; thread: string; take: number }> = [];
  private readonly lookahead: number;
  private inFlight = 0;
  private heardUpTo = 0;
  private enqueued = 0;
  private controller = new AbortController();
  private draining = false;
  private closed = false;

  constructor(private readonly opts: SayPipelineOptions) {
    this.lookahead = opts.lookahead ?? 3;
  }

  enqueue(say: SayEvent, thread: string, take = 0): void {
    if (this.closed) return;
    this.queue.push({ say, thread, take });
    void this.drain();
  }

  /** The room heard sentence #n (client progress); allows more lookahead. */
  markHeard(): void {
    this.heardUpTo += 1;
    void this.drain();
  }

  /** A thread finished (turn answered, ad over): whatever was synthesised counts as heard. */
  resetLookahead(): void {
    this.enqueued = this.heardUpTo;
    void this.drain();
  }

  /** Barge-in or pause: abort in-flight synthesis and drop everything queued. */
  cancel(): void {
    this.controller.abort();
    this.controller = new AbortController();
    this.queue.length = 0;
    this.inFlight = 0;
    this.enqueued = this.heardUpTo;
  }

  close(): void {
    this.closed = true;
    this.cancel();
  }

  get pending(): number {
    return this.queue.length + this.inFlight;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && this.enqueued - this.heardUpTo < this.lookahead) {
        const item = this.queue.shift();
        if (!item) break;
        this.enqueued += 1;
        this.inFlight += 1;
        const signal = this.controller.signal;
        await this.speak(item.say, item.take, signal);
        this.inFlight = Math.max(0, this.inFlight - 1);
      }
    } finally {
      this.draining = false;
    }
  }

  private async speak(say: SayEvent, take: number, signal: AbortSignal): Promise<void> {
    const started = performance.now();
    let durationMs = 0;
    let chunkIndex = 0;
    let first = true;
    try {
      const stream = this.opts.synthesizer.synthesize({
        text: spokenText(say.text),
        voice: this.opts.voice,
        sampleRate: this.opts.sampleRate,
        tone: say.tone,
        signal,
      });
      let previous: { header: DownstreamAudioHeader; pcm: Uint8Array } | null = null;
      for await (const chunk of stream) {
        if (signal.aborted) return;
        if (first) {
          this.opts.observer.event('tts.first_chunk', {
            sayId: say.id,
            ms: Math.round(performance.now() - started),
            engine: this.opts.synthesizer.id,
          });
          first = false;
        }
        const header: DownstreamAudioHeader = {
          dir: 'down',
          sayId: say.id,
          audioChunkId: chunkIndex++,
          audioClockMs: chunk.audioClockMs,
          sampleRate: chunk.sampleRate,
          durationMs: chunk.durationMs,
          textSpan: chunk.textSpan,
          final: false,
          take,
        };
        if (previous) this.opts.transport.broadcastAudio(previous.header, previous.pcm);
        previous = { header, pcm: chunk.pcm };
        durationMs = chunk.audioClockMs + chunk.durationMs;
      }
      if (signal.aborted) return;
      if (previous) {
        this.opts.transport.broadcastAudio({ ...previous.header, final: true }, previous.pcm);
      } else {
        // Zero-length synthesis (empty text): still close the sentence so the clock advances.
        this.opts.transport.broadcastAudio(
          {
            dir: 'down',
            sayId: say.id,
            audioChunkId: 0,
            audioClockMs: 0,
            sampleRate: this.opts.sampleRate,
            durationMs: 1,
            textSpan: null,
            final: true,
            take,
          },
          new Uint8Array(0),
        );
      }
      this.opts.transport.broadcast({ kind: 'say_complete', sayId: say.id, durationMs });
      this.opts.onComplete?.(say.id, durationMs);
    } catch (error) {
      if (signal.aborted) return;
      this.opts.observer.error('tts', error, { sayId: say.id });
      this.opts.onFailure?.(say.id, error);
    }
  }
}
