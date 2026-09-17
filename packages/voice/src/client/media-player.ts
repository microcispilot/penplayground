import type { PlaybackChunk, PlaybackClock, PlaybackSampleRate } from './player.js';
import { validateChunkShape } from './player.js';

/**
 * Replay playback with a speed control (ADR-0010). Web Audio's
 * `AudioBufferSourceNode.playbackRate` resamples, so a faster replay would be
 * a higher voice. `HTMLMediaElement.playbackRate` time-stretches instead
 * (`preservesPitch` is true by default and is set explicitly here), the same
 * engine a video player's speed menu uses. So the replay collects each say's
 * PCM into one WAV blob and plays it through a media element, keeping the
 * conductor's audio-clock contract: one say at a time, `onSayStart`,
 * `onSayEnd(sayId, recordedDurationMs)`, `onProgress(sayId, recordedOffsetMs)`,
 * and a `clock` that reads the say's own timeline (recorded milliseconds,
 * whatever the rate). Live rooms keep the sample-exact `PcmPlayer`: their
 * pace is synthesised, never stretched.
 */

/** The subset of HTMLMediaElement the player drives; a fake satisfies it in tests. */
export interface MediaElementLike {
  src: string;
  preload: string;
  playbackRate: number;
  preservesPitch: boolean;
  readonly currentTime: number;
  readonly paused: boolean;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  addEventListener(type: MediaEventName, listener: () => void): void;
  removeEventListener(type: MediaEventName, listener: () => void): void;
}
export type MediaEventName = 'ended' | 'error' | 'canplaythrough';

export type MediaPlayerErrorCode =
  | 'PEN_MEDIA_CHUNK_REJECTED'
  | 'PEN_MEDIA_PLAY_FAILED'
  | 'PEN_MEDIA_DECODE_FAILED';

export interface MediaSayPlayerOptions {
  readonly onSayStart?: (sayId: string) => void;
  /** `durationMs` is the say's recorded length, independent of the playback rate. */
  readonly onSayEnd?: (sayId: string, durationMs: number) => void;
  /** ≈30 Hz while playing; `offsetMs` is on the say's recorded timeline. */
  readonly onProgress?: (sayId: string, offsetMs: number) => void;
  readonly onError?: (code: MediaPlayerErrorCode, detail: string, error?: unknown) => void;
  /** Seams for tests and hosts without DOM media. */
  readonly createElement?: () => MediaElementLike;
  readonly createObjectUrl?: (blob: Blob) => string;
  readonly revokeObjectUrl?: (url: string) => void;
  readonly setInterval?: (callback: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

interface PendingSay {
  sayId: string;
  sampleRate: PlaybackSampleRate;
  parts: Uint8Array[];
  bytes: number;
  /** End of the last chunk on the say's clock. */
  endMs: number;
}

interface ReadySay {
  sayId: string;
  durationMs: number;
  url: string;
  element: MediaElementLike;
}

const PROGRESS_INTERVAL_MS = 33;
/** Replay speeds the browser stretches cleanly; outside this the voice smears. */
export const MEDIA_RATE_MIN = 0.5;
export const MEDIA_RATE_MAX = 2;

/** Wrap raw s16le mono PCM in a RIFF/WAVE container so a media element can decode it. */
export function pcmToWav(pcm: Uint8Array, sampleRate: number): Blob {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) v.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, 'RIFF');
  v.setUint32(4, 36 + pcm.byteLength, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  v.setUint32(16, 16, true); // PCM fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  write(36, 'data');
  v.setUint32(40, pcm.byteLength, true);
  const body = new Uint8Array(pcm.byteLength);
  body.set(pcm);
  return new Blob([header, body], { type: 'audio/wav' });
}

export class MediaSayPlayer {
  readonly #o: MediaSayPlayerOptions;
  readonly #pending = new Map<string, PendingSay>();
  readonly #queue: ReadySay[] = [];
  #current: ReadySay | null = null;
  #rate = 1;
  #paused = false;
  #ticker: unknown;
  #disposed = false;
  #ended = new Set<string>();

  constructor(options: MediaSayPlayerOptions = {}) {
    this.#o = options;
  }

  /** Playback speed; applies to the say playing now and every later one. Pitch is preserved. */
  get playbackRate(): number {
    return this.#rate;
  }

  set playbackRate(rate: number) {
    const r = Number.isFinite(rate) ? Math.min(MEDIA_RATE_MAX, Math.max(MEDIA_RATE_MIN, rate)) : 1;
    this.#rate = r;
    if (this.#current) this.#current.element.playbackRate = r;
    for (const say of this.#queue) say.element.playbackRate = r;
  }

  get paused(): boolean {
    return this.#paused;
  }

  /** Master clock on the say's recorded timeline (what the conductor schedules against). */
  get clock(): PlaybackClock {
    const current = this.#current;
    if (!current) return { sayId: null, offsetMs: 0 };
    const ms = Math.floor(current.element.currentTime * 1_000);
    return { sayId: current.sayId, offsetMs: Math.max(0, Math.min(current.durationMs, ms)) };
  }

  get speaking(): boolean {
    return this.#current !== null && !this.#paused;
  }

  /** Bank one chunk; the say becomes playable once its final chunk arrived. */
  enqueue(untrusted: unknown): void {
    if (this.#disposed) return;
    const shape = validateChunkShape(untrusted);
    if (!shape.ok) {
      this.#o.onError?.('PEN_MEDIA_CHUNK_REJECTED', shape.detail);
      return;
    }
    const chunk = untrusted as PlaybackChunk;
    if (this.#ended.has(chunk.sayId)) return; // stale take after a cancel
    let say = this.#pending.get(chunk.sayId);
    if (!say) {
      say = { sayId: chunk.sayId, sampleRate: chunk.sampleRate, parts: [], bytes: 0, endMs: 0 };
      this.#pending.set(chunk.sayId, say);
    }
    say.parts.push(chunk.pcm);
    say.bytes += chunk.pcm.byteLength;
    say.endMs = Math.max(say.endMs, chunk.audioClockMs + chunk.durationMs);
    if (!chunk.final) return;
    this.#pending.delete(chunk.sayId);
    const pcm = new Uint8Array(say.bytes);
    let offset = 0;
    for (const part of say.parts) {
      pcm.set(part, offset);
      offset += part.byteLength;
    }
    const url = (this.#o.createObjectUrl ?? ((b) => URL.createObjectURL(b)))(
      pcmToWav(pcm, say.sampleRate),
    );
    const element = (this.#o.createElement ?? (() => new Audio()))();
    element.preload = 'auto';
    element.preservesPitch = true;
    element.playbackRate = this.#rate;
    element.src = url;
    // Decode ahead so the seam between two says is the browser's, not the network's.
    element.load();
    this.#queue.push({ sayId: say.sayId, durationMs: say.endMs, url, element });
    if (!this.#current && !this.#paused) this.#playNext();
  }

  pause(): void {
    if (this.#paused || this.#disposed) return;
    this.#paused = true;
    this.#current?.element.pause();
  }

  resume(): void {
    if (!this.#paused || this.#disposed) return;
    this.#paused = false;
    if (this.#current) this.#play(this.#current);
    else this.#playNext();
  }

  /** Stop now and forget everything banked; returns where playback was. */
  cancel(): PlaybackClock {
    const snapshot = this.clock;
    const current = this.#current;
    this.#current = null;
    if (current) this.#release(current);
    for (const say of this.#queue.splice(0)) this.#release(say);
    for (const say of this.#pending.keys()) this.#ended.add(say);
    this.#pending.clear();
    this.#stopTicker();
    return snapshot;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.cancel();
    this.#disposed = true;
  }

  // -- internals -----------------------------------------------------------

  #playNext(): void {
    const next = this.#queue.shift();
    if (!next) {
      this.#stopTicker();
      return;
    }
    this.#current = next;
    const onEnded = () => {
      next.element.removeEventListener('ended', onEnded);
      next.element.removeEventListener('error', onError);
      if (this.#current !== next) return;
      this.#current = null;
      this.#release(next);
      this.#o.onSayEnd?.(next.sayId, next.durationMs);
      if (!this.#paused && !this.#disposed) this.#playNext();
    };
    const onError = () => {
      this.#o.onError?.('PEN_MEDIA_DECODE_FAILED', `say ${next.sayId} could not be decoded`);
      onEnded();
    };
    next.element.addEventListener('ended', onEnded);
    next.element.addEventListener('error', onError);
    this.#o.onSayStart?.(next.sayId);
    this.#play(next);
    this.#startTicker();
  }

  #play(say: ReadySay): void {
    say.element.playbackRate = this.#rate;
    say.element.play().catch((error: unknown) => {
      if (this.#current !== say) return;
      this.#o.onError?.('PEN_MEDIA_PLAY_FAILED', `play() rejected for ${say.sayId}`, error);
    });
  }

  #release(say: ReadySay): void {
    this.#ended.add(say.sayId);
    try {
      say.element.pause();
      say.element.src = '';
    } catch {
      // A detached element is already released.
    }
    (this.#o.revokeObjectUrl ?? ((u) => URL.revokeObjectURL(u)))(say.url);
  }

  #startTicker(): void {
    if (this.#ticker !== undefined) return;
    const interval = this.#o.setInterval ?? ((cb, ms) => globalThis.setInterval(cb, ms));
    this.#ticker = interval(() => {
      const clock = this.clock;
      if (clock.sayId !== null && !this.#paused) this.#o.onProgress?.(clock.sayId, clock.offsetMs);
    }, PROGRESS_INTERVAL_MS);
  }

  #stopTicker(): void {
    if (this.#ticker === undefined) return;
    const clear = this.#o.clearInterval ?? ((h) => globalThis.clearInterval(h as number));
    clear(this.#ticker);
    this.#ticker = undefined;
  }
}
