import { AUDIO, TIMING } from '@pen/contracts';

/**
 * Client-side audio constants that are NOT product-level (those live in
 * `@pen/contracts` TIMING / AUDIO). Everything here is a property of the
 * capture/playback implementation, shared between the segmenter, the resampler
 * and the microphone so they can never disagree about the bounds of one
 * utterance.
 */

/** Sample rate the STT seam consumes (ADR-0004: 16 kHz s16le mono). */
export const STT_SAMPLE_RATE_HZ = AUDIO.sttSampleRate;
export const STT_PCM_BYTES_PER_SAMPLE = 2;
export const STT_PCM_BYTES_PER_SECOND = STT_SAMPLE_RATE_HZ * STT_PCM_BYTES_PER_SAMPLE;

/** Hard cap on one utterance. Anything longer is cut and delivered; the
 * learner keeps talking into a fresh utterance. Bounds memory (20 s of 48 kHz
 * float is ~3.8 MB) and the STT request size. */
export const MAX_UTTERANCE_MS = 20_000;
/** An utterance shorter than this cannot carry a word; the segmenter's speech
 * gate (240 ms confirm) already guarantees more, this is the final byte-level
 * guard before anything reaches the network. */
export const MIN_UTTERANCE_PCM_MS = 120;
export const MIN_UTTERANCE_PCM_BYTES = (STT_PCM_BYTES_PER_SECOND * MIN_UTTERANCE_PCM_MS) / 1_000;
export const MAX_UTTERANCE_PCM_BYTES = (STT_PCM_BYTES_PER_SECOND * MAX_UTTERANCE_MS) / 1_000;

/** Live stream blocks: 160 ms at 16 kHz is 5 120 bytes, comfortably under the
 * 8 000-byte upstream frame bound while keeping the socket message rate low. */
export const UTTERANCE_STREAM_BLOCK_MS = AUDIO.upstreamFrameMs;

// Re-exported under pipeline names so the capture modules read as one
// vocabulary. The values are product decisions (docs/PRODUCT.md, ADR-0004).
export const MIN_UTTERANCE_MS = TIMING.bargeInConfirmMs;
export const MIN_VOICED_SPEECH_MS = TIMING.bargeInVoicedMs;
export const END_OF_UTTERANCE_MS = TIMING.endOfUtteranceMs;
export const PRE_ROLL_MS = TIMING.preRollMs;
export const BARGE_IN_FADE_MS = TIMING.bargeInFadeMs;

/** Microphone capture runs the AudioContext at 48 kHz: every consumer-grade
 * input device is native at 44.1 or 48 kHz and the resampler has an exact
 * 3:1 phase table for 48 k → 16 k. */
export const CAPTURE_SAMPLE_RATE_HZ = 48_000;
