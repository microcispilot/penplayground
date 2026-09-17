import {
  END_OF_UTTERANCE_MS,
  MAX_UTTERANCE_MS,
  MIN_UTTERANCE_MS,
  MIN_UTTERANCE_PCM_BYTES,
  MIN_VOICED_SPEECH_MS,
  PRE_ROLL_MS,
  STT_SAMPLE_RATE_HZ,
  UTTERANCE_STREAM_BLOCK_MS,
} from './constants.js';
import { resampleMonoToPcmS16le } from './pcm-resampler.js';
import { SpeechPresenceDetector } from './speech-presence.js';

export { MIN_UTTERANCE_MS, MIN_VOICED_SPEECH_MS, UTTERANCE_STREAM_BLOCK_MS };

// The speech-confirmation window (MIN_UTTERANCE_MS, 240 ms): an opening is
// treated as real speech only after this much voiced audio. It gates three
// things identically — the barge-in signal, the live utterance stream, and
// complete-utterance admission — so a keyboard clack, cough, or background
// transient can never interrupt the expert or become a phantom turn, while a
// real interjection still lands in about a quarter second.
//
// The voice-confirmation window (MIN_VOICED_SPEECH_MS, 120 ms): of the audio
// that cleared the energy gate, at least this much must be harmonic (a human
// voice, see `speech-presence.ts`). Typing, chair creaks, doors, and fans
// clear energy thresholds for seconds at a time; none of them are periodic.
// Speech is, and 120 ms of voicing lands inside the first syllable of any
// real interjection, so the barge-in and turn latency budget is unchanged.

// Sound that keeps the energy gate open this long without ever confirming
// as a voice is not an utterance in progress; it is the room. Release it so
// memory stays bounded and the next real word opens a clean utterance.
export const UNCONFIRMED_SOUND_RELEASE_MS = 3_000;

const DEFAULT_SPEECH_RMS = 0.008;
// End-of-utterance silence (END_OF_UTTERANCE_MS, 800 ms). People pause
// mid-request ("point me to… the manual"); 550 ms split such requests into
// fragments the expert received as separate stateless questions. 800 ms holds
// through a thinking pause while still ending the turn promptly — the
// acknowledgment speech masks the difference in perceived response time.

function rms(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) {
    const finite = Number.isFinite(sample) ? sample : 0;
    sum += finite * finite;
  }
  return Math.sqrt(sum / Math.max(1, samples.length));
}

export interface UtteranceSegmenterOptions {
  readonly sourceSampleRate: number;
  /** Fires once per utterance, only after the opening has accumulated
   * MIN_UTTERANCE_MS of voiced audio — confirmed speech, never a transient.
   * This is the barge-in signal. */
  readonly onSpeechStart: () => void;
  /** Fires once per confirmed utterance when it ends (trailing silence,
   * length cap, or an external `clear()` such as mute). Always paired with a
   * preceding `onSpeechStart`. */
  readonly onSpeechEnd?: () => void;
  /** True while the AI human's own voice is playing. While it is, the
   * voiced threshold rises sharply so speaker bleed and room noise cannot
   * barge her mid-sentence; a real interruption still can. */
  readonly playbackActive?: () => boolean;
  /** Complete utterance, resampled to 16 kHz s16le on the calling thread.
   * Ignored when `onUtteranceSamples` is provided. */
  readonly onUtterance: (pcmS16leBytes: Uint8Array, utteranceId?: string) => void;
  /** Complete utterance as raw source-rate samples, for callers that resample
   * off-thread (the microphone hands them to the resampler worker). */
  readonly onUtteranceSamples?: (
    samples: Float32Array,
    sourceSampleRate: number,
    utteranceId?: string,
  ) => void;
  /** Live streaming: opens only after the utterance has passed the same
   * minimum-speech gate that admits a complete utterance, so VAD false-opens
   * never reach the network. All three callbacks must be provided together
   * for streaming to activate. */
  readonly onUtteranceStreamOpen?: (utteranceId: string) => void;
  readonly onUtteranceStreamChunk?: (utteranceId: string, pcmS16leBytes: Uint8Array) => void;
  readonly onUtteranceStreamEnd?: (utteranceId: string) => void;
  readonly createUtteranceId?: () => string;
  readonly speechRms?: number;
  readonly endSilenceMs?: number;
  readonly preRollMs?: number;
}

function defaultUtteranceId(): string {
  const random =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `utt-${random}`;
}

/** Local-only VAD / endpointer. It retains at most one 20-second utterance
 * plus pre-roll, and zeroes every buffer it releases. */
export class UtteranceSegmenter {
  readonly #sourceSampleRate: number;
  readonly #onSpeechStart: () => void;
  readonly #onSpeechEnd: (() => void) | undefined;
  readonly #playbackActive: (() => boolean) | undefined;
  readonly #onUtterance: (pcmS16leBytes: Uint8Array, utteranceId?: string) => void;
  readonly #onUtteranceSamples:
    | ((samples: Float32Array, sourceSampleRate: number, utteranceId?: string) => void)
    | undefined;
  readonly #speechRms: number;
  readonly #endSilenceSamples: number;
  readonly #preRollSamples: number;
  readonly #minSpeechSamples: number;
  readonly #minVoicedSpeechSamples: number;
  readonly #unconfirmedReleaseSamples: number;
  readonly #maxUtteranceSamples: number;
  readonly #presence: SpeechPresenceDetector;
  readonly #onUtteranceStreamOpen: ((utteranceId: string) => void) | undefined;
  readonly #onUtteranceStreamChunk:
    | ((utteranceId: string, pcmS16leBytes: Uint8Array) => void)
    | undefined;
  readonly #onUtteranceStreamEnd: ((utteranceId: string) => void) | undefined;
  readonly #createUtteranceId: () => string;
  readonly #streamBlockSamples: number;
  #preRoll: Float32Array[] = [];
  #preRollLength = 0;
  #utterance: Float32Array[] = [];
  #utteranceLength = 0;
  #voicedSamples = 0;
  #harmonicSamples = 0;
  #playbackActiveNow = false;
  #trailingSilenceSamples = 0;
  #speaking = false;
  #speechStartNotified = false;
  #noiseRms = 0.003;
  #streamUtteranceId: string | undefined;
  #streamBuffer: Float32Array[] = [];
  #streamBufferLength = 0;
  #streamedSamples = 0;

  constructor(options: UtteranceSegmenterOptions) {
    if (
      !Number.isFinite(options.sourceSampleRate) ||
      options.sourceSampleRate < STT_SAMPLE_RATE_HZ ||
      options.sourceSampleRate > 192_000
    ) {
      throw new Error('PEN_MICROPHONE_SAMPLE_RATE_REJECTED');
    }
    const rate = options.sourceSampleRate;
    const samplesFor = (ms: number): number => Math.round((ms * rate) / 1_000);
    this.#sourceSampleRate = rate;
    this.#onSpeechStart = options.onSpeechStart;
    this.#onSpeechEnd = options.onSpeechEnd;
    this.#playbackActive = options.playbackActive;
    this.#onUtterance = options.onUtterance;
    this.#onUtteranceSamples = options.onUtteranceSamples;
    this.#speechRms = options.speechRms ?? DEFAULT_SPEECH_RMS;
    this.#endSilenceSamples = samplesFor(options.endSilenceMs ?? END_OF_UTTERANCE_MS);
    this.#preRollSamples = samplesFor(options.preRollMs ?? PRE_ROLL_MS);
    this.#minSpeechSamples = samplesFor(MIN_UTTERANCE_MS);
    this.#minVoicedSpeechSamples = samplesFor(MIN_VOICED_SPEECH_MS);
    this.#unconfirmedReleaseSamples = samplesFor(UNCONFIRMED_SOUND_RELEASE_MS);
    this.#presence = new SpeechPresenceDetector({ sourceSampleRate: rate });
    this.#maxUtteranceSamples = samplesFor(MAX_UTTERANCE_MS);
    this.#onUtteranceStreamOpen = options.onUtteranceStreamOpen;
    this.#onUtteranceStreamChunk = options.onUtteranceStreamChunk;
    this.#onUtteranceStreamEnd = options.onUtteranceStreamEnd;
    this.#createUtteranceId = options.createUtteranceId ?? defaultUtteranceId;
    this.#streamBlockSamples = samplesFor(UTTERANCE_STREAM_BLOCK_MS);
  }

  /** True between a confirmed `onSpeechStart` and its `onSpeechEnd`. */
  get speaking(): boolean {
    return this.#speechStartNotified;
  }

  get #streamingEnabled(): boolean {
    return (
      this.#onUtteranceStreamOpen !== undefined &&
      this.#onUtteranceStreamChunk !== undefined &&
      this.#onUtteranceStreamEnd !== undefined
    );
  }

  push(untrustedSamples: Float32Array): void {
    if (untrustedSamples.length === 0) return;
    const samples = new Float32Array(untrustedSamples.length);
    for (let index = 0; index < untrustedSamples.length; index += 1) {
      const value = untrustedSamples[index] ?? 0;
      samples[index] = Number.isFinite(value) ? (value > 1 ? 1 : value < -1 ? -1 : value) : 0;
    }
    const level = rms(samples);
    const playbackActive = this.#playbackActive?.() === true;
    this.#playbackActiveNow = playbackActive;
    // Voicing is classified on every frame so an utterance that opens on
    // energy can credit the voiced audio already sitting in its pre-roll.
    const voicedHops = this.#presence.push(samples);
    // While her own voice plays, a raised energy bar with an absolute floor
    // keeps speaker bleed from opening the mic constantly. Energy alone can
    // no longer cut her off (words confirm a barge), so the bar only needs
    // to be high enough to keep STT traffic sane, not to fight the room.
    const playbackDuck = playbackActive ? 2.5 : 1;
    const voicedThreshold = Math.max(
      Math.max(this.#speechRms, this.#noiseRms * (this.#speaking ? 2 : 4.25)) * playbackDuck,
      playbackActive ? 0.012 : 0,
    );
    const voiced = level >= voicedThreshold;
    if (!this.#speaking) {
      // The noise floor adapts on EVERY non-speaking frame — including ones
      // that momentarily classify as voiced. In a continuously noisy room
      // the old floor (adapted only on quiet frames) never rose, so the
      // noise stayed "voice" forever and barged every sentence.
      this.#noiseRms = Math.min(0.08, this.#noiseRms * 0.98 + level * 0.02);
      this.#appendPreRoll(samples);
      if (!voiced) return;
      this.#speaking = true;
      this.#utterance = this.#preRoll;
      this.#utteranceLength = this.#preRollLength;
      this.#preRoll = [];
      this.#preRollLength = 0;
      this.#voicedSamples = samples.length;
      this.#harmonicSamples = this.#presence.recentVoicedSourceSamples(this.#utteranceLength);
      this.#trailingSilenceSamples = 0;
    } else {
      this.#utterance.push(samples);
      this.#utteranceLength += samples.length;
      this.#harmonicSamples += voicedHops * this.#presence.hopSourceSamples;
      if (voiced) {
        this.#voicedSamples += samples.length;
        this.#trailingSilenceSamples = 0;
      } else {
        this.#trailingSilenceSamples += samples.length;
      }
    }
    // Confirmed-speech notification: the same gate that admits an utterance
    // and opens the stream also authorizes barge-in, so a transient below
    // the window, or a sound that is not a voice at all, can never cancel
    // the expert mid-sentence.
    if (!this.#speechStartNotified && this.#speechConfirmed()) {
      this.#speechStartNotified = true;
      this.#onSpeechStart();
    }
    this.#pumpStream(samples);
    if (
      this.#utteranceLength >= this.#maxUtteranceSamples ||
      this.#trailingSilenceSamples >= this.#endSilenceSamples
    ) {
      this.#finish();
    } else if (
      !this.#speechConfirmed() &&
      this.#utteranceLength >= this.#unconfirmedReleaseSamples
    ) {
      this.#releaseUnconfirmedSound();
    }
  }

  /** The one speech gate: enough energy above the floor AND enough of it
   * harmonic. Barge-in, stream opening, and complete-utterance admission all
   * consult this predicate, so they can never disagree about what counts as
   * a person speaking. */
  #speechConfirmed(): boolean {
    const energyRequired = this.#playbackActiveNow
      ? // Opening the mic mid-sentence needs sustained sound, not a blip;
        // only words (confirmed downstream) interrupt her.
        Math.round(this.#minSpeechSamples * 1.5)
      : this.#minSpeechSamples;
    return (
      this.#voicedSamples >= energyRequired && this.#harmonicSamples >= this.#minVoicedSpeechSamples
    );
  }

  /** Drop sound that never became a voice, keeping only a pre-roll's worth
   * of the newest audio so a word that starts right after still has its
   * onset. No stream was opened (streams open only on confirmation), so
   * nothing upstream knows this sound existed. */
  #releaseUnconfirmedSound(): void {
    const keep: Float32Array[] = [];
    let keepLength = 0;
    for (let index = this.#utterance.length - 1; index >= 0; index -= 1) {
      const chunk = this.#utterance[index];
      if (chunk === undefined) continue;
      if (keepLength >= this.#preRollSamples) {
        chunk.fill(0);
        continue;
      }
      keep.unshift(chunk);
      keepLength += chunk.length;
    }
    this.#utterance = [];
    this.#utteranceLength = 0;
    this.#voicedSamples = 0;
    this.#harmonicSamples = 0;
    this.#trailingSilenceSamples = 0;
    this.#speaking = false;
    this.#speechStartNotified = false;
    this.#preRoll = keep;
    this.#preRollLength = keepLength;
  }

  #pumpStream(latest: Float32Array): void {
    if (!this.#streamingEnabled || !this.#speaking) return;
    if (this.#streamUtteranceId === undefined) {
      if (!this.#speechConfirmed()) return;
      // The utterance just proved it is speech: open the stream and send
      // everything buffered so far (pre-roll included) as a catch-up burst.
      this.#streamUtteranceId = this.#createUtteranceId();
      this.#streamBuffer = [...this.#utterance];
      this.#streamBufferLength = this.#utteranceLength;
      this.#onUtteranceStreamOpen?.(this.#streamUtteranceId);
    } else {
      this.#streamBuffer.push(latest);
      this.#streamBufferLength += latest.length;
    }
    while (
      this.#streamBufferLength >= this.#streamBlockSamples &&
      this.#streamedSamples < this.#maxUtteranceSamples
    ) {
      this.#emitStreamBlock(this.#streamBlockSamples);
    }
  }

  #emitStreamBlock(requestedSamples: number): void {
    const utteranceId = this.#streamUtteranceId;
    if (utteranceId === undefined) return;
    const count = Math.min(
      requestedSamples,
      this.#streamBufferLength,
      this.#maxUtteranceSamples - this.#streamedSamples,
    );
    if (count <= 0) return;
    const block = new Float32Array(count);
    let filled = 0;
    while (filled < count) {
      const head = this.#streamBuffer[0];
      if (head === undefined) break;
      const take = Math.min(head.length, count - filled);
      block.set(head.subarray(0, take), filled);
      filled += take;
      if (take === head.length) {
        this.#streamBuffer.shift();
      } else {
        this.#streamBuffer[0] = head.subarray(take);
      }
      this.#streamBufferLength -= take;
    }
    this.#streamedSamples += filled;
    if (filled === 0) return;
    try {
      const bytes = resampleMonoToPcmS16le(
        filled === count ? block : block.subarray(0, filled),
        this.#sourceSampleRate,
      );
      if (bytes.byteLength >= 2) {
        this.#onUtteranceStreamChunk?.(utteranceId, bytes);
      }
    } finally {
      block.fill(0);
    }
  }

  /** Discard everything (mute, stop). A confirmed utterance in progress is
   * closed with `onSpeechEnd` so UI state never sticks on "speaking"; no
   * utterance is delivered because the learner revoked it. */
  clear(): void {
    const notified = this.#speechStartNotified;
    const streamUtteranceId = this.#streamUtteranceId;
    this.#reset();
    if (streamUtteranceId !== undefined) this.#onUtteranceStreamEnd?.(streamUtteranceId);
    if (notified) this.#onSpeechEnd?.();
  }

  #reset(): void {
    for (const chunk of this.#preRoll) chunk.fill(0);
    for (const chunk of this.#utterance) chunk.fill(0);
    this.#preRoll = [];
    this.#preRollLength = 0;
    this.#utterance = [];
    this.#utteranceLength = 0;
    this.#voicedSamples = 0;
    this.#harmonicSamples = 0;
    this.#trailingSilenceSamples = 0;
    this.#speaking = false;
    this.#speechStartNotified = false;
    this.#presence.reset();
    this.#streamUtteranceId = undefined;
    this.#streamBuffer = [];
    this.#streamBufferLength = 0;
    this.#streamedSamples = 0;
  }

  #appendPreRoll(samples: Float32Array): void {
    this.#preRoll.push(samples);
    this.#preRollLength += samples.length;
    while (this.#preRoll.length > 1 && this.#preRollLength > this.#preRollSamples) {
      const removed = this.#preRoll.shift();
      if (removed === undefined) break;
      this.#preRollLength -= removed.length;
      removed.fill(0);
    }
  }

  #finish(): void {
    const sampleCount = Math.min(this.#utteranceLength, this.#maxUtteranceSamples);
    const joined = new Float32Array(sampleCount);
    let offset = 0;
    for (const chunk of this.#utterance) {
      const remaining = sampleCount - offset;
      if (remaining <= 0) break;
      const length = Math.min(chunk.length, remaining);
      joined.set(chunk.subarray(0, length), offset);
      offset += length;
    }
    const hasEnoughSpeech = this.#speechConfirmed();
    const notified = this.#speechStartNotified;
    const streamUtteranceId = this.#streamUtteranceId;
    if (streamUtteranceId !== undefined) {
      // Flush the trailing partial block before the buffers are zeroed, then
      // close the live utterance. The stream and the complete utterance
      // cover exactly the same capped sample range.
      while (this.#streamBufferLength > 0 && this.#streamedSamples < this.#maxUtteranceSamples) {
        this.#emitStreamBlock(this.#streamBlockSamples);
      }
      this.#onUtteranceStreamEnd?.(streamUtteranceId);
    }
    this.#reset();
    if (notified) this.#onSpeechEnd?.();
    if (!hasEnoughSpeech) {
      joined.fill(0);
      return;
    }
    if (this.#onUtteranceSamples !== undefined) {
      this.#onUtteranceSamples(joined, this.#sourceSampleRate, streamUtteranceId);
      return;
    }
    let bytes: Uint8Array | undefined;
    try {
      bytes = resampleMonoToPcmS16le(joined, this.#sourceSampleRate);
      if (bytes.byteLength >= MIN_UTTERANCE_PCM_BYTES) {
        this.#onUtterance(bytes, streamUtteranceId);
      } else bytes.fill(0);
    } finally {
      joined.fill(0);
    }
  }
}
