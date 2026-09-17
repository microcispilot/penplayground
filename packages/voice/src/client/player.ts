import { AUDIO, DOWNSTREAM_FRAME_BYTES_MAX } from '@pen/contracts';
import { BARGE_IN_FADE_MS } from './constants.js';

/**
 * Room audio playback: a jitter-buffered, sample-exact PCM player for the
 * expert's voice, ported from Simurgh's Fish playback and extended with what
 * the Pen conductor needs — per-say boundaries, pause/resume, a master clock
 * for board sync, and progress events.
 *
 * Pure pieces (`AdaptiveJitterBuffer`, `ChunkValidator`, `SayTimeline`,
 * `decodePcmS16le`, `queueCanAccept`) are exported separately so the policy
 * is unit-testable without an AudioContext; `PcmPlayer` only wires them to
 * Web Audio through the minimal `PlayerAudioContext` seam.
 */

export type PlaybackSampleRate = 24000 | 44100 | 48000;

/** One downstream audio chunk (the `DownstreamAudioHeader` fields + PCM). */
export interface PlaybackChunk {
  readonly sayId: string;
  /** Strictly increasing per say. */
  readonly audioChunkId: number;
  /** Position of this chunk within the say, ms; contiguous. */
  readonly audioClockMs: number;
  readonly sampleRate: PlaybackSampleRate;
  readonly durationMs: number;
  /** s16le mono. */
  readonly pcm: Uint8Array;
  /** Last chunk of this say. */
  readonly final: boolean;
}

export type PlaybackErrorCode =
  | 'PEN_PLAYBACK_CHUNK_REJECTED'
  | 'PEN_PLAYBACK_PCM_REJECTED'
  | 'PEN_PLAYBACK_SAMPLE_RATE_REJECTED'
  | 'PEN_PLAYBACK_CLOCK_DISCONTINUITY'
  | 'PEN_PLAYBACK_DURATION_MISMATCH'
  | 'PEN_PLAYBACK_CHUNK_ID_REJECTED'
  | 'PEN_PLAYBACK_SAY_STALE'
  | 'PEN_PLAYBACK_QUEUE_BOUND_REJECTED'
  | 'PEN_PLAYBACK_AUDIO_CONTEXT_FAILED'
  | 'PEN_PLAYBACK_AUDIO_CONTEXT_SUSPENDED';

export interface ChunkRejection {
  readonly ok: false;
  readonly code: PlaybackErrorCode;
  readonly detail: string;
}
export type ShapeVerdict = { readonly ok: true } | ChunkRejection;
export interface ChunkAccepted {
  readonly ok: true;
  /** First chunk seen for this say (the say-edge fade-in applies). */
  readonly firstOfSay: boolean;
}
export type ChunkVerdict = ChunkAccepted | ChunkRejection;

export interface PlaybackClock {
  /** The say whose audio is at the speaker right now, or null when silent. */
  readonly sayId: string | null;
  /** Position within that say, ms, derived from the AudioContext clock. */
  readonly offsetMs: number;
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

// The player banks audio as fast as it arrives: Fish delivers ~4.5x realtime
// when healthy (measured), and a deep bank is what survives the unhealthy
// moments — provider slowdowns and home-WiFi stalls alike. A 2-second cap
// GUARANTEED a dropout for any stall longer than 2 s. Thirty seconds of 44.1k
// mono is ~2.6 MB; barge-in discards it instantly.
export const PLAYBACK_BANK_SECONDS = 30;
/** A chunk may not exceed one downstream frame (≈1 s at 48 kHz). */
export const MAX_CHUNK_PCM_BYTES = DOWNSTREAM_FRAME_BYTES_MAX;
export const MAX_CHUNK_SECONDS = MAX_CHUNK_PCM_BYTES / 2 / 24_000;
export const MAX_BUFFERED_SECONDS = PLAYBACK_BANK_SECONDS + MAX_CHUNK_SECONDS;
/** `durationMs` must agree with the byte-derived truth within this. */
export const DURATION_TOLERANCE_MS = 2;
const PLAYBACK_LEAD_SECONDS = 0.03;
// A short amplitude ramp applied when playback (re)starts, so resuming after
// a rebuffer never begins at an arbitrary sample value (an audible pop).
const RESUME_FADE_SECONDS = 0.005;
// On cancel (barge-in), ramp the gain down briefly before stopping so
// interruption sounds like a person stopping, not a snapped tape.
const CANCEL_FADE_SECONDS = BARGE_IN_FADE_MS / 1_000;
// Pause is a gain fade followed by a context suspend: the suspend freezes the
// media clock sample-exactly, the fade keeps the freeze inaudible.
const PAUSE_FADE_SECONDS = 0.005;
// Each say is synthesized independently, so consecutive says are butted
// together at the sample level. A 3 ms edge ramp on each say removes the DC
// step a seam between two unrelated waveforms would otherwise click with.
const SAY_EDGE_FADE_SECONDS = 0.003;
const VOLUME_RAMP_SECONDS = 0.01;
const PROGRESS_INTERVAL_MS = 33;
/** Finished say ids remembered for stale-chunk rejection. */
const FINISHED_SAY_MEMORY = 64;

export function queueCanPull(bufferedSeconds: number): boolean {
  return (
    Number.isFinite(bufferedSeconds) && bufferedSeconds >= 0 && bufferedSeconds <= PLAYBACK_BANK_SECONDS
  );
}

export function queueCanAccept(bufferedSeconds: number, incomingSeconds: number): boolean {
  return (
    queueCanPull(bufferedSeconds) &&
    Number.isFinite(incomingSeconds) &&
    incomingSeconds > 0 &&
    incomingSeconds <= MAX_CHUNK_SECONDS &&
    bufferedSeconds + incomingSeconds <= MAX_BUFFERED_SECONDS
  );
}

// ---------------------------------------------------------------------------
// Adaptive jitter buffer (startup / rebuffer policy)
// ---------------------------------------------------------------------------

export interface JitterDecision {
  readonly targetMs: number;
  readonly underrun: boolean;
  readonly playbackActive: boolean;
}

export interface JitterBufferOptions {
  readonly initialTargetMs?: number;
  readonly minTargetMs?: number;
  readonly maxTargetMs?: number;
  readonly underrunBumpMs?: number;
}

// Pen plays one SAY (one sentence, one synthesis request) at a time and the
// gateway synthesizes the next say while this one plays, so a say rarely has
// intra-stream bursts; the startup target only has to cover arrival jitter of
// the first few chunks, and every millisecond of it is on the time-to-first-
// audio path (800 ms budget). Simurgh's whole-reply streams needed 600 ms
// initial / 2.2 s max to cover Fish's sentence-segment bursts; here the
// underrun bump grows the target when a provider actually lags.
const DEFAULT_JITTER: Required<JitterBufferOptions> = {
  initialTargetMs: 120,
  minTargetMs: 80,
  maxTargetMs: 1_200,
  underrunBumpMs: 240,
};

/** Bounded adaptive startup/rebuffer policy; it never retains audio itself. */
export class AdaptiveJitterBuffer {
  readonly #bounds: Required<JitterBufferOptions>;
  #targetMs: number;
  #jitterMs = 0;
  #lastArrivalMs: number | undefined;
  #lastChunkDurationMs = 0;
  #playbackActive = false;

  constructor(options: JitterBufferOptions = {}) {
    this.#bounds = { ...DEFAULT_JITTER, ...options };
    this.#targetMs = this.#bounds.initialTargetMs;
  }

  get targetMs(): number {
    return this.#targetMs;
  }

  get playbackActive(): boolean {
    return this.#playbackActive;
  }

  observeArrival(
    arrivalMs: number,
    chunkDurationMs: number,
    scheduledAheadMs: number,
    pendingAfterArrivalMs: number,
  ): JitterDecision {
    const { minTargetMs, maxTargetMs, underrunBumpMs } = this.#bounds;
    if (this.#lastArrivalMs !== undefined) {
      const spacingMs = Math.max(0, arrivalMs - this.#lastArrivalMs);
      // Only LATE arrivals are jitter for a playout buffer: a chunk that
      // arrives sooner than its predecessor's duration (the normal
      // faster-than-realtime case) can never cause an underrun, so it must
      // not inflate the startup delay.
      const lateMs = Math.max(0, spacingMs - this.#lastChunkDurationMs);
      this.#jitterMs = this.#jitterMs * 0.8 + lateMs * 0.2;
      const measuredTarget = Math.min(maxTargetMs, Math.max(minTargetMs, 80 + this.#jitterMs * 3));
      this.#targetMs = Math.max(
        minTargetMs,
        Math.min(maxTargetMs, this.#targetMs * 0.95 + measuredTarget * 0.05),
      );
    }
    this.#lastArrivalMs = arrivalMs;
    this.#lastChunkDurationMs = chunkDurationMs;

    const underrun = this.#playbackActive && scheduledAheadMs <= 1;
    if (underrun) {
      this.#playbackActive = false;
      this.#targetMs = Math.min(maxTargetMs, Math.max(this.#targetMs + underrunBumpMs, minTargetMs));
    }
    if (!this.#playbackActive && pendingAfterArrivalMs >= this.#targetMs) {
      this.#playbackActive = true;
    }
    return { targetMs: this.#targetMs, underrun, playbackActive: this.#playbackActive };
  }

  forceStart(): void {
    this.#playbackActive = true;
  }

  reset(): void {
    // Per-stream state only. The learned target and jitter estimate SURVIVE
    // across says: the provider's cadence doesn't change between sentences,
    // and resetting the depth re-created the first-sentence stutter on every
    // single stream.
    this.#lastArrivalMs = undefined;
    this.#lastChunkDurationMs = 0;
    this.#playbackActive = false;
  }
}

// ---------------------------------------------------------------------------
// PCM decode
// ---------------------------------------------------------------------------

export function decodePcmS16le(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) {
    throw new Error('PEN_PLAYBACK_PCM_REJECTED');
  }
  const samples = new Float32Array(bytes.byteLength / 2);
  // Little-endian s16 → float in one typed pass. An Int16Array view needs a
  // 2-byte-aligned offset; the (rare) unaligned chunk takes the DataView path.
  if (bytes.byteOffset % 2 === 0) {
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = (pcm[index] ?? 0) / 32_768;
    }
    return samples;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 32_768;
  }
  return samples;
}

// ---------------------------------------------------------------------------
// Chunk validation
// ---------------------------------------------------------------------------

interface SayValidationState {
  nextClockMs: number | undefined;
  lastChunkId: number | undefined;
  finalSeen: boolean;
}

function reject(code: PlaybackErrorCode, detail: string): ChunkRejection {
  return { ok: false, code, detail };
}

/** Structural validation of an untrusted chunk; no per-say state. */
export function validateChunkShape(value: unknown): ShapeVerdict {
  if (typeof value !== 'object' || value === null) {
    return reject('PEN_PLAYBACK_CHUNK_REJECTED', 'chunk is not an object');
  }
  const chunk = value as Partial<PlaybackChunk>;
  if (typeof chunk.sayId !== 'string' || chunk.sayId.length === 0 || chunk.sayId.length > 64) {
    return reject('PEN_PLAYBACK_CHUNK_REJECTED', 'sayId must be a short non-empty string');
  }
  if (!Number.isInteger(chunk.audioChunkId) || (chunk.audioChunkId as number) < 0) {
    return reject('PEN_PLAYBACK_CHUNK_REJECTED', 'audioChunkId must be a non-negative integer');
  }
  if (!Number.isInteger(chunk.audioClockMs) || (chunk.audioClockMs as number) < 0) {
    return reject('PEN_PLAYBACK_CHUNK_REJECTED', 'audioClockMs must be a non-negative integer');
  }
  if (chunk.sampleRate !== 24000 && chunk.sampleRate !== 44100 && chunk.sampleRate !== 48000) {
    return reject('PEN_PLAYBACK_SAMPLE_RATE_REJECTED', `unsupported sampleRate ${chunk.sampleRate}`);
  }
  if (!Number.isInteger(chunk.durationMs) || (chunk.durationMs as number) <= 0) {
    return reject('PEN_PLAYBACK_CHUNK_REJECTED', 'durationMs must be a positive integer');
  }
  if (typeof chunk.final !== 'boolean') {
    return reject('PEN_PLAYBACK_CHUNK_REJECTED', 'final must be a boolean');
  }
  const pcm = chunk.pcm;
  if (!(pcm instanceof Uint8Array)) {
    return reject('PEN_PLAYBACK_PCM_REJECTED', 'pcm must be a Uint8Array');
  }
  if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
    return reject('PEN_PLAYBACK_PCM_REJECTED', `pcm length ${pcm.byteLength} is not a non-empty even byte count`);
  }
  if (pcm.byteLength > MAX_CHUNK_PCM_BYTES) {
    return reject('PEN_PLAYBACK_PCM_REJECTED', `pcm length ${pcm.byteLength} exceeds ${MAX_CHUNK_PCM_BYTES}`);
  }
  const derivedMs = (pcm.byteLength / 2 / chunk.sampleRate) * 1_000;
  if (Math.abs(derivedMs - (chunk.durationMs as number)) > DURATION_TOLERANCE_MS) {
    return reject(
      'PEN_PLAYBACK_DURATION_MISMATCH',
      `durationMs ${chunk.durationMs} vs ${derivedMs.toFixed(2)} ms of PCM`,
    );
  }
  return { ok: true };
}

/**
 * Per-say sequence validation: strictly increasing chunk ids, a contiguous
 * audio clock, nothing after `final`, nothing for a say that already ended.
 * Any single violation rejects the chunk — a hole inside a continuous stream
 * is corruption, and playing through it would be heard as a cut-off word.
 */
export class ChunkValidator {
  readonly #says = new Map<string, SayValidationState>();
  readonly #finished: string[] = [];
  #sampleRate: PlaybackSampleRate | undefined;

  /** Pin the sample rate every subsequent chunk must carry. */
  pinSampleRate(sampleRate: PlaybackSampleRate): void {
    this.#sampleRate = sampleRate;
  }

  get sampleRate(): PlaybackSampleRate | undefined {
    return this.#sampleRate;
  }

  accept(value: unknown): ChunkVerdict {
    const shape = validateChunkShape(value);
    if (!shape.ok) return shape;
    const chunk = value as PlaybackChunk;
    if (this.#sampleRate !== undefined && chunk.sampleRate !== this.#sampleRate) {
      return reject(
        'PEN_PLAYBACK_SAMPLE_RATE_REJECTED',
        `chunk at ${chunk.sampleRate} Hz, player pinned to ${this.#sampleRate} Hz`,
      );
    }
    if (this.#finished.includes(chunk.sayId)) {
      return reject('PEN_PLAYBACK_SAY_STALE', `say ${chunk.sayId} already ended`);
    }
    let state = this.#says.get(chunk.sayId);
    const firstOfSay = state === undefined;
    if (state === undefined) {
      state = { nextClockMs: undefined, lastChunkId: undefined, finalSeen: false };
      this.#says.set(chunk.sayId, state);
    }
    if (state.finalSeen) {
      return reject('PEN_PLAYBACK_SAY_STALE', `chunk ${chunk.audioChunkId} after final of ${chunk.sayId}`);
    }
    if (state.lastChunkId !== undefined && chunk.audioChunkId <= state.lastChunkId) {
      return reject(
        'PEN_PLAYBACK_CHUNK_ID_REJECTED',
        `chunk id ${chunk.audioChunkId} not after ${state.lastChunkId} in ${chunk.sayId}`,
      );
    }
    // The first chunk of a say adopts its clock as the baseline (a say that
    // begins mid-way is a resumed stream, not a violation); every later chunk
    // must butt exactly against its predecessor.
    if (state.nextClockMs !== undefined && chunk.audioClockMs !== state.nextClockMs) {
      return reject(
        'PEN_PLAYBACK_CLOCK_DISCONTINUITY',
        `audioClockMs ${chunk.audioClockMs}, expected ${state.nextClockMs} in ${chunk.sayId}`,
      );
    }
    state.lastChunkId = chunk.audioChunkId;
    state.nextClockMs = chunk.audioClockMs + chunk.durationMs;
    if (chunk.final) {
      state.finalSeen = true;
      this.#remember(chunk.sayId);
    }
    if (this.#sampleRate === undefined) this.#sampleRate = chunk.sampleRate;
    return { ok: true, firstOfSay };
  }

  #remember(sayId: string): void {
    this.#says.delete(sayId);
    this.#finished.push(sayId);
    while (this.#finished.length > FINISHED_SAY_MEMORY) this.#finished.shift();
  }

  /** Forget in-flight says (cancel). The pinned sample rate and the finished
   * memory survive: a stale chunk stays stale after a barge-in. */
  reset(): void {
    this.#says.clear();
  }
}

// ---------------------------------------------------------------------------
// Say timeline (the master clock)
// ---------------------------------------------------------------------------

interface ScheduledRun {
  /** AudioContext time at which the run's first sample plays. */
  startTime: number;
  /** Absolute sample index (across the whole timeline) of that sample. */
  startSample: number;
  sampleCount: number;
}

interface SaySegment {
  readonly sayId: string;
  startSample: number;
  endSample: number | undefined;
  started: boolean;
}

export interface TimelineEvents {
  readonly onSayStart?: (sayId: string) => void;
  readonly onSayEnd?: (sayId: string, durationMs: number) => void;
}

/**
 * Maps the AudioContext clock to "which say, how far in". Sources are
 * scheduled at anchor + samplesScheduled / sampleRate so consecutive flushes
 * butt with zero drift (accumulating floating-point chunk DURATIONS opened
 * sub-sample seams heard as periodic ticks); the timeline records those runs
 * and the say boundaries inside them, all in absolute sample indices.
 */
export class SayTimeline {
  readonly #sampleRate: number;
  #runs: ScheduledRun[] = [];
  #says: SaySegment[] = [];
  #totalScheduled = 0;

  constructor(sampleRate: number) {
    this.#sampleRate = sampleRate;
  }

  get totalScheduledSamples(): number {
    return this.#totalScheduled;
  }

  /** True while some say still awaits its final chunk. */
  get hasOpenSay(): boolean {
    return this.#says.some((say) => say.endSample === undefined);
  }

  get isEmpty(): boolean {
    return this.#says.length === 0;
  }

  /** The AudioContext time at which the next contiguous sample would play. */
  continuityTime(): number | undefined {
    const last = this.#runs[this.#runs.length - 1];
    if (last === undefined) return undefined;
    return last.startTime + last.sampleCount / this.#sampleRate;
  }

  /** Record a scheduled run. Contiguous runs are merged so the list stays tiny. */
  addRun(startTime: number, sampleCount: number): void {
    const last = this.#runs[this.#runs.length - 1];
    const continuity = this.continuityTime();
    if (last !== undefined && continuity !== undefined && Math.abs(startTime - continuity) <= 1e-6) {
      last.sampleCount += sampleCount;
    } else {
      this.#runs.push({ startTime, startSample: this.#totalScheduled, sampleCount });
    }
    this.#totalScheduled += sampleCount;
  }

  /** Mark that `sampleCount` samples of `sayId` occupy the timeline starting
   * at the current scheduled end (call BEFORE `addRun` for the same samples). */
  addSaySamples(sayId: string, sampleCount: number, final: boolean, alreadyScheduled: number): void {
    const start = this.#totalScheduled + alreadyScheduled;
    let say = this.#says[this.#says.length - 1];
    if (say === undefined || say.sayId !== sayId || say.endSample !== undefined) {
      say = { sayId, startSample: start, endSample: undefined, started: false };
      this.#says.push(say);
    }
    if (final) say.endSample = start + sampleCount;
  }

  /** Absolute samples played at `currentTime`. */
  playedSamples(currentTime: number): number {
    let played = 0;
    for (const run of this.#runs) {
      if (currentTime < run.startTime) break;
      const elapsed = (currentTime - run.startTime) * this.#sampleRate;
      played = run.startSample + Math.min(run.sampleCount, elapsed);
    }
    return played;
  }

  clockAt(currentTime: number): PlaybackClock {
    const played = this.playedSamples(currentTime);
    for (const say of this.#says) {
      if (played < say.startSample) break;
      if (say.endSample === undefined || played < say.endSample) {
        return {
          sayId: say.sayId,
          offsetMs: Math.max(0, Math.floor(((played - say.startSample) / this.#sampleRate) * 1_000)),
        };
      }
    }
    return { sayId: null, offsetMs: 0 };
  }

  /** Fire start/end events crossed by the clock; drop finished says and runs. */
  dispatch(currentTime: number, events: TimelineEvents): void {
    const played = this.playedSamples(currentTime);
    while (this.#says.length > 0) {
      const say = this.#says[0];
      if (say === undefined) break;
      if (!say.started) {
        if (played < say.startSample) break;
        say.started = true;
        events.onSayStart?.(say.sayId);
      }
      if (say.endSample === undefined || played < say.endSample) break;
      this.#says.shift();
      const durationMs = Math.round(((say.endSample - say.startSample) / this.#sampleRate) * 1_000);
      events.onSayEnd?.(say.sayId, durationMs);
    }
    // Keep the newest fully-played run: it anchors the clock during a gap.
    while (this.#runs.length > 1) {
      const run = this.#runs[0];
      if (run === undefined) break;
      if (currentTime < run.startTime + run.sampleCount / this.#sampleRate) break;
      this.#runs.shift();
    }
  }

  /** All scheduled audio has played and no say is waiting for more. */
  isDrained(currentTime: number): boolean {
    return !this.hasOpenSay && this.playedSamples(currentTime) >= this.#totalScheduled;
  }

  reset(): void {
    this.#runs = [];
    this.#says = [];
    this.#totalScheduled = 0;
  }
}

// ---------------------------------------------------------------------------
// Web Audio seam (structural, so a stub satisfies it in tests)
// ---------------------------------------------------------------------------

export interface PlayerAudioNode {
  disconnect(): void;
}
export interface PlayerAudioParam {
  value: number;
  cancelScheduledValues(startTime: number): unknown;
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
}
export interface PlayerGainNode extends PlayerAudioNode {
  readonly gain: PlayerAudioParam;
  connect(destination: PlayerAudioNode): unknown;
}
export interface PlayerAudioBuffer {
  readonly length: number;
  readonly sampleRate: number;
  getChannelData(channel: number): Float32Array;
}
export interface PlayerBufferSource extends PlayerAudioNode {
  buffer: PlayerAudioBuffer | null;
  connect(destination: PlayerAudioNode): unknown;
  start(when?: number): void;
  stop(when?: number): void;
  addEventListener(type: 'ended', listener: () => void, options?: { once: boolean }): void;
}
export interface PlayerAudioContext {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly state: 'suspended' | 'running' | 'closed' | 'interrupted';
  readonly destination: PlayerAudioNode;
  createGain(): PlayerGainNode;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): PlayerAudioBuffer;
  createBufferSource(): PlayerBufferSource;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

export interface PcmPlayerOptions {
  /** Fires once per rejected chunk or failed audio operation. */
  readonly onError: (code: PlaybackErrorCode, detail: string, error?: unknown) => void;
  /** The say's first sample reached the speaker. */
  readonly onSayStart?: (sayId: string) => void;
  /** The say's last sample played (never fired for a cancelled say). */
  readonly onSayEnd?: (sayId: string, durationMs: number) => void;
  /** ≈30 Hz while audio is playing. */
  readonly onProgress?: (sayId: string, offsetMs: number) => void;
  /** Playback ran dry while a say was still open: a rebuffer is under way. */
  readonly onUnderrun?: () => void;
  readonly jitter?: JitterBufferOptions;
  /** Platform seams (tests, Electron): default to the browser globals. */
  readonly createAudioContext?: (sampleRate: PlaybackSampleRate) => PlayerAudioContext;
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly setInterval?: (callback: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

export type EnqueueResult =
  | { readonly accepted: true; readonly bufferedMs: number }
  | { readonly accepted: false; readonly code: PlaybackErrorCode };

interface PendingAudio {
  readonly sayId: string;
  readonly samples: Float32Array;
  readonly final: boolean;
}

interface ScheduledAudio {
  readonly source: PlayerBufferSource;
  readonly buffer: PlayerAudioBuffer;
}

function applyFadeIn(samples: Float32Array, fadeSamples: number): void {
  const count = Math.min(samples.length, fadeSamples);
  for (let index = 0; index < count; index += 1) {
    samples[index] = (samples[index] ?? 0) * (index / count);
  }
}

function applyFadeOut(samples: Float32Array, fadeSamples: number): void {
  const count = Math.min(samples.length, fadeSamples);
  const last = samples.length - 1;
  for (let index = 0; index < count; index += 1) {
    samples[last - index] = (samples[last - index] ?? 0) * (index / count);
  }
}

/**
 * Sample-exact, jitter-buffered PCM playback for the room. One resident
 * AudioContext at the stream's own sample rate: a context at the device rate
 * would resample every scheduled source independently, with no interpolation
 * continuity across source boundaries — heard as a tick at every seam. At the
 * stream rate the system performs one continuous resample at the device
 * boundary. The context is created on the first chunk (or by `prime()` from
 * a user gesture) and every later chunk must carry the same rate.
 */
export class PcmPlayer {
  readonly #options: PcmPlayerOptions;
  readonly #validator = new ChunkValidator();
  readonly #jitter: AdaptiveJitterBuffer;
  readonly #pending: PendingAudio[] = [];
  readonly #scheduled = new Set<ScheduledAudio>();
  #context: PlayerAudioContext | undefined;
  #timeline: SayTimeline | undefined;
  #masterGain: PlayerGainNode | undefined;
  /** One gain per playback run: cancel fades this node and releases it, so
   * audio scheduled inside the fade never un-fades the tail. */
  #runGain: PlayerGainNode | undefined;
  #pendingSeconds = 0;
  #resumeFadePending = true;
  #paused = false;
  #pauseTimer: unknown;
  #ticker: unknown;
  #volume = 1;
  #underrunReported = false;
  #suspendedReported = false;
  #disposed = false;

  constructor(options: PcmPlayerOptions) {
    this.#options = options;
    this.#jitter = new AdaptiveJitterBuffer(options.jitter);
  }

  /** Master clock for board sync, derived from AudioContext.currentTime. */
  get clock(): PlaybackClock {
    const context = this.#context;
    const timeline = this.#timeline;
    if (context === undefined || timeline === undefined) return { sayId: null, offsetMs: 0 };
    return timeline.clockAt(context.currentTime);
  }

  get paused(): boolean {
    return this.#paused;
  }

  /** Audio banked ahead of the speaker (scheduled + pending), ms. */
  get bufferedMs(): number {
    return this.#bufferedSeconds() * 1_000;
  }

  get speaking(): boolean {
    const context = this.#context;
    const timeline = this.#timeline;
    return (
      context !== undefined &&
      timeline !== undefined &&
      context.state === 'running' &&
      timeline.playedSamples(context.currentTime) < timeline.totalScheduledSamples
    );
  }

  /** Whether a chunk of `durationMs` would fit the bank right now (backpressure). */
  canAccept(durationMs: number): boolean {
    return queueCanAccept(this.#bufferedSeconds(), durationMs / 1_000);
  }

  /**
   * Create and unlock the AudioContext ahead of the first chunk. Call from a
   * user gesture so autoplay policy never holds the first sentence back, and
   * so context creation is off the time-to-first-audio path.
   */
  async prime(sampleRate: PlaybackSampleRate = AUDIO.ttsSampleRate): Promise<void> {
    if (this.#disposed) return;
    const context = this.#ensureContext(sampleRate);
    // While paused the clock must stay frozen; the context is unlocked by
    // resume() instead.
    if (context === undefined || this.#paused) return;
    try {
      await context.resume();
    } catch (error: unknown) {
      this.#options.onError('PEN_PLAYBACK_AUDIO_CONTEXT_SUSPENDED', 'resume() rejected', error);
      return;
    }
    if (context.state !== 'running' && !this.#paused) {
      this.#reportSuspended(context.state);
    }
  }

  /** Validate, decode and bank one chunk. Synchronous: safe to call straight
   * from the socket handler. Rejections are reported through `onError` and
   * returned, never thrown. */
  enqueue(untrustedChunk: unknown): EnqueueResult {
    if (this.#disposed) {
      this.#options.onError('PEN_PLAYBACK_AUDIO_CONTEXT_FAILED', 'player is disposed');
      return { accepted: false, code: 'PEN_PLAYBACK_AUDIO_CONTEXT_FAILED' };
    }
    const verdict = this.#validator.accept(untrustedChunk);
    if (!verdict.ok) {
      this.#options.onError(verdict.code, verdict.detail);
      return { accepted: false, code: verdict.code };
    }
    const chunk = untrustedChunk as PlaybackChunk;
    const context = this.#ensureContext(chunk.sampleRate);
    if (context === undefined) return { accepted: false, code: 'PEN_PLAYBACK_AUDIO_CONTEXT_FAILED' };
    if (context.sampleRate !== chunk.sampleRate) {
      const detail = `context at ${context.sampleRate} Hz cannot play ${chunk.sampleRate} Hz`;
      this.#options.onError('PEN_PLAYBACK_SAMPLE_RATE_REJECTED', detail);
      return { accepted: false, code: 'PEN_PLAYBACK_SAMPLE_RATE_REJECTED' };
    }
    const timeline = this.#timelineFor(context);
    // Settle events the ticker has not yet observed (say ended, drained)
    // BEFORE judging this arrival, so the gap between two says is a fresh
    // startup, never a phantom underrun that bumps the target for good.
    this.#tick(context, timeline);

    const durationSeconds = chunk.pcm.byteLength / 2 / chunk.sampleRate;
    const bufferedSeconds = this.#bufferedSeconds();
    if (!queueCanAccept(bufferedSeconds, durationSeconds)) {
      const detail = `${bufferedSeconds.toFixed(2)} s banked + ${durationSeconds.toFixed(3)} s exceeds bound`;
      this.#options.onError('PEN_PLAYBACK_QUEUE_BOUND_REJECTED', detail);
      return { accepted: false, code: 'PEN_PLAYBACK_QUEUE_BOUND_REJECTED' };
    }
    const samples = decodePcmS16le(chunk.pcm);
    const edge = Math.round(SAY_EDGE_FADE_SECONDS * chunk.sampleRate);
    if (verdict.firstOfSay) applyFadeIn(samples, edge);
    if (chunk.final) applyFadeOut(samples, edge);
    this.#pending.push({ sayId: chunk.sayId, samples, final: chunk.final });
    this.#pendingSeconds += durationSeconds;

    const scheduledAheadMs = this.#scheduledAheadSeconds(context, timeline) * 1_000;
    const decision = this.#jitter.observeArrival(
      context.currentTime * 1_000,
      chunk.durationMs,
      scheduledAheadMs,
      this.#pendingSeconds * 1_000,
    );
    if (decision.underrun) this.#resumeFadePending = true;
    // A final chunk means nothing more is coming for this say: there is no
    // reason to hold the bank back for a startup target it may never reach.
    if (chunk.final && !decision.playbackActive) this.#jitter.forceStart();
    if (this.#jitter.playbackActive) this.#schedulePending(context, timeline);
    this.#startTicker();
    return { accepted: true, bufferedMs: this.#bufferedSeconds() * 1_000 };
  }

  /** Freeze playback sample-exactly (gain fade, then context suspend). Audio
   * keeps banking while paused. */
  pause(): void {
    if (this.#paused || this.#disposed) return;
    this.#paused = true;
    const context = this.#context;
    const gain = this.#masterGain;
    if (context === undefined || gain === undefined) return;
    this.#ramp(gain, 0, PAUSE_FADE_SECONDS, context);
    const timeout = this.#options.setTimeout ?? ((cb, ms) => globalThis.setTimeout(cb, ms));
    this.#pauseTimer = timeout(() => {
      this.#pauseTimer = undefined;
      if (!this.#paused || this.#context !== context) return;
      context.suspend().catch((error: unknown) => {
        this.#options.onError('PEN_PLAYBACK_AUDIO_CONTEXT_FAILED', 'suspend() rejected', error);
      });
    }, PAUSE_FADE_SECONDS * 1_000 + 2);
  }

  /** Continue from the exact sample where `pause()` froze the clock. */
  resume(): void {
    if (!this.#paused || this.#disposed) return;
    this.#paused = false;
    this.#clearPauseTimer();
    const context = this.#context;
    const gain = this.#masterGain;
    if (context === undefined || gain === undefined) return;
    context.resume().then(
      () => {
        if (this.#paused || this.#context !== context) return;
        this.#ramp(gain, this.#volume, RESUME_FADE_SECONDS, context);
      },
      (error: unknown) => {
        this.#options.onError('PEN_PLAYBACK_AUDIO_CONTEXT_SUSPENDED', 'resume() rejected', error);
      },
    );
  }

  /**
   * Barge-in: fade the current audio over 20 ms and discard everything banked.
   * Returns where playback was when it stopped, so the conductor can tell the
   * brain how much of the say the learner actually heard.
   */
  cancel(): PlaybackClock {
    const snapshot = this.clock;
    this.#validator.reset();
    this.#jitter.reset();
    this.#resumeFadePending = true;
    this.#underrunReported = false;
    for (const pending of this.#pending) pending.samples.fill(0);
    this.#pending.length = 0;
    this.#pendingSeconds = 0;
    this.#timeline?.reset();
    this.#stopTicker();
    // The context and master gain stay resident: creating an AudioContext
    // per reply sat on the time-to-first-audio path of every turn. The run's
    // sources are faded and released; the next run re-arms its gain on its
    // first chunk (#ensureRunGain).
    const context = this.#context;
    const runGain = this.#runGain;
    this.#runGain = undefined;
    const scheduled = [...this.#scheduled];
    this.#scheduled.clear();
    if (context !== undefined && runGain !== undefined) {
      // Interruption is a person stopping mid-word, not a snapped tape.
      this.#ramp(runGain, 0, CANCEL_FADE_SECONDS, context);
    }
    const releaseSources = (): void => {
      for (const entry of scheduled) {
        try {
          entry.source.stop();
        } catch {
          // A source that naturally ended is already safe to release.
        }
        entry.buffer.getChannelData(0).fill(0);
        entry.source.disconnect();
      }
      runGain?.disconnect();
    };
    if (context !== undefined && scheduled.length > 0 && context.state === 'running') {
      const timeout = this.#options.setTimeout ?? ((cb, ms) => globalThis.setTimeout(cb, ms));
      timeout(releaseSources, CANCEL_FADE_SECONDS * 1_000 + 10);
    } else {
      releaseSources();
    }
    return snapshot;
  }

  /** 0..1, applied with a short ramp so changes never zipper. */
  setVolume(volume: number): void {
    this.#volume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
    const context = this.#context;
    const gain = this.#masterGain;
    if (context === undefined || gain === undefined || this.#paused) return;
    this.#ramp(gain, this.#volume, VOLUME_RAMP_SECONDS, context);
  }

  get volume(): number {
    return this.#volume;
  }

  /** Final teardown of the resident audio context (page end). */
  dispose(): void {
    if (this.#disposed) return;
    this.cancel();
    this.#disposed = true;
    this.#clearPauseTimer();
    const context = this.#context;
    this.#context = undefined;
    this.#timeline = undefined;
    this.#masterGain = undefined;
    if (context !== undefined && context.state !== 'closed') {
      context.close().catch((error: unknown) => {
        this.#options.onError('PEN_PLAYBACK_AUDIO_CONTEXT_FAILED', 'close() rejected', error);
      });
    }
  }

  // -- internals -----------------------------------------------------------

  #ensureContext(sampleRate: PlaybackSampleRate): PlayerAudioContext | undefined {
    const existing = this.#context;
    if (existing !== undefined) {
      this.#ensureRunGain(existing);
      if (existing.state !== 'running' && !this.#paused) this.#tryResume(existing);
      return existing;
    }
    let context: PlayerAudioContext;
    try {
      context =
        this.#options.createAudioContext?.(sampleRate) ??
        new AudioContext({ latencyHint: 'interactive', sampleRate });
    } catch (error: unknown) {
      this.#options.onError('PEN_PLAYBACK_AUDIO_CONTEXT_FAILED', 'AudioContext creation failed', error);
      return undefined;
    }
    this.#context = context;
    this.#validator.pinSampleRate(sampleRate);
    this.#timeline = new SayTimeline(context.sampleRate);
    const master = context.createGain();
    master.gain.value = this.#paused ? 0 : this.#volume;
    master.connect(context.destination);
    this.#masterGain = master;
    this.#ensureRunGain(context);
    if (!this.#paused) this.#tryResume(context);
    return context;
  }

  #timelineFor(context: PlayerAudioContext): SayTimeline {
    const timeline = this.#timeline ?? new SayTimeline(context.sampleRate);
    this.#timeline = timeline;
    return timeline;
  }

  #tryResume(context: PlayerAudioContext): void {
    context.resume().then(
      () => {
        if (context.state !== 'running' && !this.#paused) this.#reportSuspended(context.state);
      },
      (error: unknown) => {
        this.#options.onError('PEN_PLAYBACK_AUDIO_CONTEXT_SUSPENDED', 'resume() rejected', error);
      },
    );
  }

  /** Autoplay policy keeps the context suspended until a gesture: report it
   * once per episode so the UI can ask for a tap, not once per chunk. */
  #reportSuspended(state: string): void {
    if (this.#suspendedReported) return;
    this.#suspendedReported = true;
    this.#options.onError('PEN_PLAYBACK_AUDIO_CONTEXT_SUSPENDED', `AudioContext state is ${state}`);
  }

  #ensureRunGain(context: PlayerAudioContext): void {
    if (this.#runGain !== undefined) return;
    const gain = context.createGain();
    gain.connect(this.#masterGain ?? context.destination);
    this.#runGain = gain;
  }

  #ramp(gain: PlayerGainNode, target: number, seconds: number, context: PlayerAudioContext): void {
    const now = context.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(target, now + seconds);
  }

  #scheduledAheadSeconds(context: PlayerAudioContext, timeline: SayTimeline): number {
    const end = timeline.continuityTime();
    if (end === undefined) return 0;
    return Math.max(0, end - context.currentTime);
  }

  #bufferedSeconds(): number {
    const context = this.#context;
    const timeline = this.#timeline;
    const scheduled =
      context === undefined || timeline === undefined
        ? 0
        : this.#scheduledAheadSeconds(context, timeline);
    return scheduled + this.#pendingSeconds;
  }

  #schedulePending(context: PlayerAudioContext, timeline: SayTimeline): void {
    if (this.#pending.length === 0) return;
    const sampleRate = context.sampleRate;
    const earliest = context.currentTime + PLAYBACK_LEAD_SECONDS;
    const continuity = timeline.continuityTime();
    const startAt = continuity === undefined ? earliest : Math.max(earliest, continuity);
    // Coalesce every pending chunk into one contiguous buffer so a schedule
    // flush plays as a single sample-accurate source: no per-chunk seams for
    // main-thread jank to open into audible gaps.
    let totalSamples = 0;
    for (const pending of this.#pending) totalSamples += pending.samples.length;
    const merged = context.createBuffer(1, totalSamples, sampleRate);
    const mergedChannel = merged.getChannelData(0);
    let offset = 0;
    while (this.#pending.length > 0) {
      const pending = this.#pending.shift();
      if (pending === undefined) break;
      timeline.addSaySamples(pending.sayId, pending.samples.length, pending.final, offset);
      mergedChannel.set(pending.samples, offset);
      offset += pending.samples.length;
      pending.samples.fill(0);
    }
    this.#pendingSeconds = 0;
    if (this.#resumeFadePending) {
      // Ramp in from silence so a (re)start never begins at an arbitrary
      // sample value — that discontinuity is heard as a pop.
      this.#resumeFadePending = false;
      applyFadeIn(mergedChannel, Math.round(RESUME_FADE_SECONDS * sampleRate));
    }
    const source = context.createBufferSource();
    source.buffer = merged;
    source.connect(this.#runGain ?? this.#masterGain ?? context.destination);
    const scheduled: ScheduledAudio = { source, buffer: merged };
    this.#scheduled.add(scheduled);
    source.addEventListener(
      'ended',
      () => {
        merged.getChannelData(0).fill(0);
        source.disconnect();
        this.#scheduled.delete(scheduled);
      },
      { once: true },
    );
    source.start(startAt);
    timeline.addRun(startAt, merged.length);
    this.#underrunReported = false;
  }

  /** Observe the clock: say events, progress, underrun, drain. */
  #tick(context: PlayerAudioContext, timeline: SayTimeline): void {
    const now = context.currentTime;
    timeline.dispatch(now, {
      onSayStart: this.#options.onSayStart,
      onSayEnd: this.#options.onSayEnd,
    });
    if (
      !this.#underrunReported &&
      this.#jitter.playbackActive &&
      timeline.hasOpenSay &&
      this.#pending.length === 0 &&
      timeline.playedSamples(now) >= timeline.totalScheduledSamples
    ) {
      this.#underrunReported = true;
      this.#options.onUnderrun?.();
    }
    if (timeline.isDrained(now) && this.#pending.length === 0) {
      // Silence between says: the next say buffers afresh instead of being
      // judged an underrun of this one.
      this.#jitter.reset();
      this.#resumeFadePending = true;
      timeline.reset();
      this.#stopTicker();
    }
  }

  #startTicker(): void {
    if (this.#ticker !== undefined) return;
    const interval = this.#options.setInterval ?? ((cb, ms) => globalThis.setInterval(cb, ms));
    this.#ticker = interval(() => {
      const context = this.#context;
      const timeline = this.#timeline;
      if (context === undefined || timeline === undefined) {
        this.#stopTicker();
        return;
      }
      this.#tick(context, timeline);
      if (this.#paused || this.#ticker === undefined) return;
      const clock = timeline.clockAt(context.currentTime);
      if (clock.sayId !== null) this.#options.onProgress?.(clock.sayId, clock.offsetMs);
    }, PROGRESS_INTERVAL_MS);
  }

  #stopTicker(): void {
    if (this.#ticker === undefined) return;
    const clear = this.#options.clearInterval ?? ((h) => globalThis.clearInterval(h as number));
    clear(this.#ticker);
    this.#ticker = undefined;
  }

  #clearPauseTimer(): void {
    if (this.#pauseTimer === undefined) return;
    const clear = this.#options.clearTimeout ?? ((h) => globalThis.clearTimeout(h as number));
    clear(this.#pauseTimer);
    this.#pauseTimer = undefined;
  }
}
