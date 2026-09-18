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
  /** Writable: a replay seek lands inside a say (see `MediaSayPlayer.seekCurrent`). */
  currentTime: number;
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
  | 'PEN_MEDIA_DECODE_FAILED'
  | 'PEN_MEDIA_STALLED';

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
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly now?: () => number;
  /** Override the stall watchdog (tests); see `MEDIA_STALL_TIMEOUT_MS`. */
  readonly stallTimeoutMs?: number;
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
/**
 * How long a say that was told to play may go without its element's clock
 * moving before the player stops believing it.
 *
 * A media element that cannot start usually says so: `error`, or a rejected
 * `play()`. It does not always. Measured in Chromium: an element can sit at
 * HAVE_METADATA with `networkState` still LOADING, emitting nothing but
 * `stalled` — its duration read correctly off the blob, `paused` false, its
 * `play()` promise never settling, and `currentTime` never leaving zero. In
 * that run it happened to every media element in the browser from the moment a
 * room had been opened in it — the order a learner does things in: teach, then
 * replay. Chromium's `Media` domain says the pipeline stops at `kStarting`
 * with no audio decoder and no error: an output stream that never arrives.
 * It is the out-of-process audio service — the same run does not wedge at all
 * under `--disable-features=AudioServiceOutOfProcess` — and it is reached with
 * the page's own Web Audio and microphone stubbed out entirely, so it is not
 * ours to fix from here yet (the evidence and the next step are in
 * tasks/todo.md, "Chromium's audio service stops rendering"). This is
 * therefore a watchdog, not a cure. Without it the replay sits on sentence one
 * for ever: silent, one frozen caption, a board waiting on a sentence that
 * never ends, and a transport still reading "playing".
 *
 * So: after this long with no progress the say is timed off the wall clock
 * instead of its element. The sentence is mute, but the replay keeps its
 * clock, its captions and its board, the next sentence gets its turn, and the
 * failure is reported rather than swallowed. Four seconds is long enough that
 * a slow first decode is never mistaken for a dead one.
 */
export const MEDIA_STALL_TIMEOUT_MS = 4_000;
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
  /** Watchdog for the say playing now (see `MEDIA_STALL_TIMEOUT_MS`). */
  #stallTimer: unknown;
  /** The element's position at the last watchdog check, on the say's timeline. */
  #lastSeenMs = 0;
  /** Set when the current say is being timed off the wall clock, its element having stalled. */
  #fallback: { fromMs: number; at: number } | null = null;
  /** Deadline that ends a stalled say at its recorded length. */
  #endTimer: unknown;
  /** Ends the say playing now: the `ended` handler, reused by the stall fallback. */
  #finish: (() => void) | null = null;

  constructor(options: MediaSayPlayerOptions = {}) {
    this.#o = options;
  }

  /** Playback speed; applies to the say playing now and every later one. Pitch is preserved. */
  get playbackRate(): number {
    return this.#rate;
  }

  set playbackRate(rate: number) {
    const r = Number.isFinite(rate) ? Math.min(MEDIA_RATE_MAX, Math.max(MEDIA_RATE_MIN, rate)) : 1;
    const current = this.#current;
    // A wall-clock say is measured at the old rate up to here; the rest runs at the new one.
    if (current && this.#fallback) {
      this.#fallback = { fromMs: this.#offsetMs(current), at: this.#now() };
    }
    this.#rate = r;
    if (current) current.element.playbackRate = r;
    for (const say of this.#queue) say.element.playbackRate = r;
    if (current && this.#fallback) this.#armFallbackEnd(current);
  }

  get paused(): boolean {
    return this.#paused;
  }

  /** Master clock on the say's recorded timeline (what the conductor schedules against). */
  get clock(): PlaybackClock {
    const current = this.#current;
    if (!current) return { sayId: null, offsetMs: 0 };
    const ms = this.#offsetMs(current);
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

  /**
   * Move inside the say that is playing, on its own recorded timeline. The
   * replay scrubber lands here after it has rebuilt the board for the target
   * cue: audio and board share one clock, so they must be moved together.
   * Returns false when nothing is playing yet — the caller should try again
   * from `onSayStart`.
   */
  seekCurrent(offsetMs: number): boolean {
    const current = this.#current;
    if (!current || this.#disposed) return false;
    const clamped = Math.max(0, Math.min(current.durationMs, offsetMs));
    // A say already on the wall clock has no element position to move: the
    // scrubber moves the clock itself, and the remainder is re-timed from there.
    if (this.#fallback) {
      this.#fallback = { fromMs: clamped, at: this.#now() };
      this.#armFallbackEnd(current);
      return true;
    }
    try {
      current.element.currentTime = clamped / 1_000;
    } catch {
      // A media element that has not loaded its metadata rejects a seek; the
      // next `canplaythrough` will start from zero rather than throw at the UI.
      return false;
    }
    // The watchdog measures progress from wherever the viewer just landed.
    this.#watch(current);
    return true;
  }

  pause(): void {
    if (this.#paused || this.#disposed) return;
    const current = this.#current;
    // Freeze the wall clock where it stands before `#paused` changes what it reads.
    if (current && this.#fallback)
      this.#fallback = { fromMs: this.#offsetMs(current), at: this.#now() };
    this.#paused = true;
    this.#clearTimer('stall');
    this.#clearTimer('end');
    current?.element.pause();
  }

  resume(): void {
    if (!this.#paused || this.#disposed) return;
    this.#paused = false;
    const current = this.#current;
    if (!current) {
      this.#playNext();
      return;
    }
    if (this.#fallback) {
      this.#fallback = { ...this.#fallback, at: this.#now() };
      this.#armFallbackEnd(current);
      return;
    }
    this.#play(current);
  }

  /** Stop now and forget everything banked; returns where playback was. */
  cancel(): PlaybackClock {
    const snapshot = this.clock;
    const current = this.#current;
    this.#current = null;
    this.#fallback = null;
    this.#finish = null;
    this.#clearTimer('stall');
    this.#clearTimer('end');
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
    this.#fallback = null;
    const onEnded = () => {
      next.element.removeEventListener('ended', onEnded);
      next.element.removeEventListener('error', onError);
      if (this.#current !== next) return;
      this.#clearTimer('stall');
      this.#clearTimer('end');
      this.#finish = null;
      this.#current = null;
      this.#fallback = null;
      this.#release(next);
      this.#o.onSayEnd?.(next.sayId, next.durationMs);
      if (!this.#paused && !this.#disposed) this.#playNext();
    };
    const onError = () => {
      this.#o.onError?.('PEN_MEDIA_DECODE_FAILED', `say ${next.sayId} could not be decoded`);
      onEnded();
    };
    this.#finish = onEnded;
    next.element.addEventListener('ended', onEnded);
    next.element.addEventListener('error', onError);
    this.#o.onSayStart?.(next.sayId);
    this.#play(next);
    this.#startTicker();
  }

  #play(say: ReadySay): void {
    say.element.playbackRate = this.#rate;
    // Armed before `play()`: a promise that never settles is one of the shapes
    // this failure takes, so nothing may depend on the call coming back.
    this.#watch(say);
    say.element.play().catch((error: unknown) => {
      if (this.#current !== say) return;
      // Reported, not recovered from here: the watchdog below is what keeps the
      // replay moving, whether `play()` refused or simply never answered.
      this.#o.onError?.('PEN_MEDIA_PLAY_FAILED', `play() rejected for ${say.sayId}`, error);
    });
  }

  /** Where the say playing now is, from its element or from the wall clock that replaced it. */
  #offsetMs(say: ReadySay): number {
    const fallback = this.#fallback;
    if (!fallback) return Math.floor(say.element.currentTime * 1_000);
    if (this.#paused) return Math.floor(fallback.fromMs);
    return Math.floor(fallback.fromMs + (this.#now() - fallback.at) * this.#rate);
  }

  /** Start (or restart) the stall watchdog for `say` from wherever its element stands. */
  #watch(say: ReadySay): void {
    this.#clearTimer('stall');
    if (this.#paused || this.#disposed || this.#fallback) return;
    this.#lastSeenMs = Math.floor(say.element.currentTime * 1_000);
    this.#stallTimer = this.#setT(() => this.#checkProgress(say), this.#stallMs);
  }

  #checkProgress(say: ReadySay): void {
    this.#stallTimer = undefined;
    if (this.#disposed || this.#paused || this.#fallback || this.#current !== say) return;
    const at = Math.floor(say.element.currentTime * 1_000);
    if (at > this.#lastSeenMs) {
      this.#watch(say);
      return;
    }
    this.#o.onError?.(
      'PEN_MEDIA_STALLED',
      `say ${say.sayId} made no progress in ${this.#stallMs} ms`,
    );
    this.#fallback = { fromMs: Math.max(0, Math.min(say.durationMs, at)), at: this.#now() };
    try {
      // Nothing is coming out of it; if it ever wakes up it must not speak over the rest.
      say.element.pause();
    } catch {
      // A detached element is already quiet.
    }
    this.#armFallbackEnd(say);
  }

  /** End a wall-clock say when its recorded length has run out. */
  #armFallbackEnd(say: ReadySay): void {
    this.#clearTimer('end');
    const fallback = this.#fallback;
    if (!fallback || this.#paused || this.#disposed) return;
    const remaining = Math.max(0, say.durationMs - fallback.fromMs) / this.#rate;
    this.#endTimer = this.#setT(() => this.#finish?.(), remaining);
  }

  #clearTimer(which: 'stall' | 'end'): void {
    const handle = which === 'stall' ? this.#stallTimer : this.#endTimer;
    if (handle !== undefined) this.#clearT(handle);
    if (which === 'stall') this.#stallTimer = undefined;
    else this.#endTimer = undefined;
  }

  get #stallMs(): number {
    return this.#o.stallTimeoutMs ?? MEDIA_STALL_TIMEOUT_MS;
  }

  #now(): number {
    return (this.#o.now ?? Date.now)();
  }

  #setT(callback: () => void, ms: number): unknown {
    return (this.#o.setTimeout ?? ((cb, at) => globalThis.setTimeout(cb, at)))(callback, ms);
  }

  #clearT(handle: unknown): void {
    (this.#o.clearTimeout ?? ((h) => globalThis.clearTimeout(h as number)))(handle);
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
