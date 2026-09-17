/**
 * Local-only speech-presence detector: decides whether sound that cleared the
 * energy gate is a human voice, not a keyboard, a chair, a fan, or a door.
 *
 * Energy alone admits anything loud enough. Typing in particular reads as a
 * continuous run of broadband transients that keeps an energy VAD "speaking"
 * for the full utterance cap, and every such phantom utterance became a
 * network round-trip, a failed turn, and a spoken apology. Voiced speech has
 * one property none of those sounds share: a harmonic (periodic) structure
 * with a fundamental between roughly 60 and 450 Hz. This detector measures
 * that periodicity with a normalized autocorrelation over the pitch-lag band,
 * plus a zero-crossing bound that rejects broadband clicks and hiss.
 *
 * The analysis runs on an 8 kHz decimated copy in 30 ms windows with a 15 ms
 * hop. At those sizes the cost is about one million multiply-adds per second
 * of audio, invisible next to resampling. Nothing here retains audio beyond
 * one analysis window; the segmenter owns utterance custody.
 */

const TARGET_RATE_HZ = 8_000;
const WINDOW_MS = 30;
const HOP_MS = 15;
const PITCH_MIN_HZ = 60;
const PITCH_MAX_HZ = 450;
/** A window quieter than this cannot carry a decision either way. */
const MIN_WINDOW_RMS = 0.0025;
/** Normalized autocorrelation peak that marks a window as harmonic. Voiced
 * speech sits at 0.75 to 0.95; keyboard clicks, fans, and hiss stay below
 * 0.4 to 0.5 even when loud. */
const HARMONIC_PEAK_MIN = 0.62;
/** Fraction of sign changes per sample. Voiced speech at 8 kHz stays under
 * about 0.25; broadband transients and noise run at 0.4 and above. */
const ZERO_CROSSING_MAX = 0.3;
/** Voiced-hop history retained for pre-roll crediting: one second of hops. */
const VOICED_HISTORY_HOPS = 70;

export interface SpeechPresenceOptions {
  readonly sourceSampleRate: number;
}

/** Streaming harmonic-voicing classifier for a mono float PCM feed. */
export class SpeechPresenceDetector {
  readonly #decimation: number;
  readonly #windowSamples: number;
  readonly #hopSamples: number;
  readonly #minLag: number;
  readonly #maxLag: number;
  /** Source samples represented by one analysis hop. */
  readonly hopSourceSamples: number;
  readonly #window: Float32Array;
  #windowFill = 0;
  #decimationAccumulator = 0;
  #decimationCount = 0;
  /** Source-sample position of the newest decimated sample. */
  #sourcePosition = 0;
  /** Source positions at which recent windows were classified voiced, oldest
   * first. Bounded to one second of hops. */
  #voicedPositions: number[] = [];

  constructor(options: SpeechPresenceOptions) {
    if (!Number.isFinite(options.sourceSampleRate) || options.sourceSampleRate < TARGET_RATE_HZ) {
      throw new Error('PEN_SPEECH_PRESENCE_SAMPLE_RATE_REJECTED');
    }
    this.#decimation = Math.max(1, Math.round(options.sourceSampleRate / TARGET_RATE_HZ));
    const effectiveRate = options.sourceSampleRate / this.#decimation;
    this.#windowSamples = Math.round((effectiveRate * WINDOW_MS) / 1_000);
    this.#hopSamples = Math.round((effectiveRate * HOP_MS) / 1_000);
    this.hopSourceSamples = this.#hopSamples * this.#decimation;
    this.#minLag = Math.max(2, Math.floor(effectiveRate / PITCH_MAX_HZ));
    this.#maxLag = Math.min(this.#windowSamples - 8, Math.ceil(effectiveRate / PITCH_MIN_HZ));
    this.#window = new Float32Array(this.#windowSamples);
  }

  /** Feed source-rate samples. Returns how many analysis hops in this push
   * were classified as voiced speech. */
  push(samples: Float32Array): number {
    let voicedHops = 0;
    for (const sample of samples) {
      this.#decimationAccumulator += sample;
      this.#decimationCount += 1;
      this.#sourcePosition += 1;
      if (this.#decimationCount < this.#decimation) continue;
      const value = this.#decimationAccumulator / this.#decimationCount;
      this.#decimationAccumulator = 0;
      this.#decimationCount = 0;
      this.#window[this.#windowFill] = value;
      this.#windowFill += 1;
      if (this.#windowFill < this.#windowSamples) continue;
      if (this.#classifyWindow()) {
        voicedHops += 1;
        this.#voicedPositions.push(this.#sourcePosition);
        const oldest = this.#sourcePosition - this.hopSourceSamples * VOICED_HISTORY_HOPS;
        while (this.#voicedPositions.length > 0 && (this.#voicedPositions[0] ?? 0) < oldest) {
          this.#voicedPositions.shift();
        }
      }
      // Slide by one hop: keep the newest (window - hop) samples.
      this.#window.copyWithin(0, this.#hopSamples);
      this.#windowFill = this.#windowSamples - this.#hopSamples;
    }
    return voicedHops;
  }

  /** Source samples of voiced speech classified within the trailing span,
   * so an utterance that opened on energy can credit voicing that landed in
   * its pre-roll. */
  recentVoicedSourceSamples(spanSourceSamples: number): number {
    const oldest = this.#sourcePosition - spanSourceSamples;
    let hops = 0;
    for (let index = this.#voicedPositions.length - 1; index >= 0; index -= 1) {
      if ((this.#voicedPositions[index] ?? 0) < oldest) break;
      hops += 1;
    }
    return hops * this.hopSourceSamples;
  }

  reset(): void {
    this.#window.fill(0);
    this.#windowFill = 0;
    this.#decimationAccumulator = 0;
    this.#decimationCount = 0;
    this.#voicedPositions = [];
  }

  #classifyWindow(): boolean {
    const window = this.#window;
    const length = this.#windowSamples;
    let mean = 0;
    for (let index = 0; index < length; index += 1) mean += window[index] ?? 0;
    mean /= length;
    let energy = 0;
    let crossings = 0;
    let previous = (window[0] ?? 0) - mean;
    for (let index = 0; index < length; index += 1) {
      const sample = (window[index] ?? 0) - mean;
      energy += sample * sample;
      if (sample >= 0 !== previous >= 0) crossings += 1;
      previous = sample;
    }
    const rms = Math.sqrt(energy / length);
    if (rms < MIN_WINDOW_RMS) return false;
    if (crossings / length > ZERO_CROSSING_MAX) return false;
    return this.#harmonicPeak(mean) >= HARMONIC_PEAK_MIN;
  }

  /** Peak of the normalized autocorrelation across the pitch-lag band. */
  #harmonicPeak(mean: number): number {
    const window = this.#window;
    const length = this.#windowSamples;
    let peak = 0;
    for (let lag = this.#minLag; lag <= this.#maxLag; lag += 1) {
      let cross = 0;
      let head = 0;
      let tail = 0;
      const span = length - lag;
      for (let index = 0; index < span; index += 1) {
        const a = (window[index] ?? 0) - mean;
        const b = (window[index + lag] ?? 0) - mean;
        cross += a * b;
        head += a * a;
        tail += b * b;
      }
      const norm = Math.sqrt(head * tail);
      if (norm <= 0) continue;
      const value = cross / norm;
      if (value > peak) peak = value;
    }
    return peak;
  }
}
