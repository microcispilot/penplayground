import type { DownstreamAudioHeader, GapKind, SayEvent, TelemetryPort } from '@pen/contracts';
import { gapMsFor, NULL_TELEMETRY, ttsSpeedFor, ttsUsd } from '@pen/contracts';
import type { SpeechSynthesizer } from '@pen/voice';
import type { RoomObserver, RoomTransport } from './transport.js';

export interface SayPipelineOptions {
  synthesizer: SpeechSynthesizer;
  /** Default voice; a say may carry its own (the persona's voice for another language). */
  voice: string;
  sampleRate: 24000 | 44100 | 48000;
  transport: RoomTransport;
  observer: RoomObserver;
  /** How many sentences may be synthesised ahead of the last one the room finished hearing. */
  lookahead?: number;
  /**
   * The room's teaching pace, read when a sentence starts synthesis (ADR-0010).
   * A change applies from the next sentence; the one in flight keeps its speed.
   */
  pace?: () => number;
  /**
   * Which beat follows a sentence: a plain sentence gap, the longer wait after a
   * check-in question or a board title, or null for no pause. Asked once the
   * sentence's speech has streamed; may resolve asynchronously (the room waits
   * briefly for the cue that follows the sentence, since a title or a check is
   * emitted after the sentence it belongs to).
   */
  gapAfter?: (say: SayEvent, thread: string) => GapKind | null | Promise<GapKind | null>;
  onComplete?: (sayId: string, durationMs: number) => void;
  onFailure?: (sayId: string, error: unknown) => void;
  /** The first audio chunk of a sentence went out (turn latency is measured from here). */
  onFirstChunk?: (sayId: string, thread: string, take: number) => void;
  /** Per-sentence `tts` samples and byte-priced cost lines (ADR-0011). */
  telemetry?: TelemetryPort;
}

/** Silence is framed like speech so the player's contiguous-clock validation holds. */
const SILENCE_FRAME_MS = 120;
/** The last speech samples ramp to zero before the beat so the seam can never click. */
const TAIL_FADE_MS = 3;

/** In-place linear fade-out over the last `ms` of an s16le mono buffer. */
export function fadeTail(pcm: Uint8Array, sampleRate: number, ms = TAIL_FADE_MS): void {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength - (pcm.byteLength % 2));
  const total = view.byteLength / 2;
  const count = Math.min(total, Math.round((sampleRate * ms) / 1000));
  for (let i = 0; i < count; i += 1) {
    const index = total - 1 - i;
    view.setInt16(index * 2, Math.round(view.getInt16(index * 2, true) * (i / count)), true);
  }
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
  private readonly queue: Array<{ say: SayEvent; thread: string; take: number; voice: string }> =
    [];
  private readonly lookahead: number;
  private readonly telemetry: TelemetryPort;
  private inFlight = 0;
  private heardUpTo = 0;
  private enqueued = 0;
  private controller = new AbortController();
  private draining = false;
  private closed = false;

  constructor(private readonly opts: SayPipelineOptions) {
    this.lookahead = opts.lookahead ?? 3;
    this.telemetry = opts.telemetry ?? NULL_TELEMETRY;
  }

  enqueue(say: SayEvent, thread: string, take = 0, voice = this.opts.voice): void {
    if (this.closed) return;
    this.queue.push({ say, thread, take, voice });
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
        await this.speak(item.say, item.thread, item.take, item.voice, signal);
        this.inFlight = Math.max(0, this.inFlight - 1);
      }
    } finally {
      this.draining = false;
    }
  }

  private async speak(
    say: SayEvent,
    thread: string,
    take: number,
    voice: string,
    signal: AbortSignal,
  ): Promise<void> {
    const started = performance.now();
    const startedAt = Date.now();
    // The pace is read once per sentence: the voice, the beat after it and the
    // board all follow this one number, and a change waits for the next sentence.
    const pace = this.opts.pace?.() ?? 1;
    const engine = this.opts.synthesizer.id;
    const text = spokenText(say.text);
    const bytes = new TextEncoder().encode(text).length;
    let durationMs = 0;
    /** Spoken audio only; the beat after the sentence is reported separately as `gapMs`. */
    let speechMs = 0;
    let gapMs = 0;
    let chunkIndex = 0;
    let firstChunkMs = -1;
    // No synthesis cache exists yet (ADR-0011): every sentence is generated, so `reused` is always false here.
    const meta = { sayId: say.id, thread, take, engine, bytes, pace, reused: false };
    const finish = (ok: boolean, extra: Record<string, string | number | boolean>) =>
      this.telemetry.sample({
        stage: 'tts',
        ms: performance.now() - started,
        ok,
        startedAt,
        meta: { ...meta, firstChunkMs, audioMs: speechMs, gapMs, ...extra },
      });
    // The provider bills the request's bytes whether or not we play them all (barge-in).
    this.telemetry.cost({
      component: 'tts',
      unit: 'bytes',
      units: bytes,
      usd: ttsUsd(engine, bytes),
      meta: { engine, thread, reused: false },
    });
    try {
      const stream = this.opts.synthesizer.synthesize({
        text,
        voice,
        sampleRate: this.opts.sampleRate,
        speed: ttsSpeedFor(pace),
        tone: say.tone,
        signal,
      });
      let previous: { header: DownstreamAudioHeader; pcm: Uint8Array } | null = null;
      for await (const chunk of stream) {
        if (signal.aborted) {
          finish(true, { cancelled: true });
          return;
        }
        if (firstChunkMs < 0) {
          firstChunkMs = Math.round(performance.now() - started);
          this.opts.observer.event('tts.first_chunk', {
            sayId: say.id,
            ms: firstChunkMs,
            engine,
            pace,
          });
          this.opts.onFirstChunk?.(say.id, thread, take);
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
        speechMs = durationMs;
      }
      if (signal.aborted) {
        finish(true, { cancelled: true });
        return;
      }
      // The beat after the sentence is audio too: it rides the same clock, the
      // same ledger and the same replay as the words (ADR-0002, ADR-0010).
      // The speech itself is already on its way to the speakers; only the tail
      // waits for the decision, so the wait is never audible.
      const gapKind = this.opts.gapAfter ? await this.opts.gapAfter(say, thread) : 'sentence';
      if (signal.aborted) {
        finish(true, { cancelled: true });
        return;
      }
      gapMs = gapKind ? gapMsFor(gapKind, pace) : 0;
      if (previous && gapMs === 0) {
        this.opts.transport.broadcastAudio({ ...previous.header, final: true }, previous.pcm);
      } else if (gapMs > 0) {
        if (previous) {
          fadeTail(previous.pcm, previous.header.sampleRate);
          this.opts.transport.broadcastAudio(previous.header, previous.pcm);
        }
        const sampleRate = previous?.header.sampleRate ?? this.opts.sampleRate;
        for (let sent = 0; sent < gapMs; ) {
          const ms = Math.min(SILENCE_FRAME_MS, gapMs - sent);
          const samples = Math.max(1, Math.floor((sampleRate * ms) / 1000));
          const frameMs = Math.max(1, Math.round((samples * 1000) / sampleRate));
          sent += ms;
          this.opts.transport.broadcastAudio(
            {
              dir: 'down',
              sayId: say.id,
              audioChunkId: chunkIndex++,
              audioClockMs: durationMs,
              sampleRate,
              durationMs: frameMs,
              textSpan: null,
              final: sent >= gapMs,
              take,
            },
            new Uint8Array(samples * 2),
          );
          durationMs += frameMs;
        }
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
      finish(true, { cancelled: false });
      this.opts.onComplete?.(say.id, durationMs);
    } catch (error) {
      if (signal.aborted) {
        finish(true, { cancelled: true });
        return;
      }
      const ref = this.opts.observer.error('tts', error, { sayId: say.id, engine });
      finish(false, { cancelled: false });
      this.telemetry.error({ code: ttsErrorCode(error), stage: 'tts', ref: ref ?? null });
      this.opts.onFailure?.(say.id, error);
    }
  }
}

/** "TTS_UPSTREAM_502: …" → "TTS_UPSTREAM_502"; anything else → TTS_ERROR. Never the message. */
export function ttsErrorCode(error: unknown): string {
  const head = (error instanceof Error ? error.message : String(error)).split(':')[0]?.trim() ?? '';
  return /^TTS_[A-Z0-9_]{1,60}$/.test(head) ? head : 'TTS_ERROR';
}
