/**
 * Browser-side voice pipeline (ADR-0004): microphone capture with harmonic
 * voicing + endpointing, and jitter-buffered PCM playback for the room.
 *
 * The capture worklet (`capture-processor.js`) is exported separately as
 * `@pen/voice/worklet` so the app can import its source text (`?raw`); the
 * resampler worker is `@pen/voice/resampler-worker` for `?worker` bundling.
 */
export * from './constants.js';
export { Microphone, CAPTURE_PROCESSOR_NAME } from './microphone.js';
export type { MicrophoneOptions, MicrophoneState } from './microphone.js';
export { resampleMonoToPcmS16le } from './pcm-resampler.js';
export { SpeechPresenceDetector } from './speech-presence.js';
export type { SpeechPresenceOptions } from './speech-presence.js';
export { UtteranceSegmenter, UNCONFIRMED_SOUND_RELEASE_MS } from './utterance-segmenter.js';
export type { UtteranceSegmenterOptions } from './utterance-segmenter.js';
export {
  AdaptiveJitterBuffer,
  ChunkValidator,
  DURATION_TOLERANCE_MS,
  MAX_BUFFERED_SECONDS,
  MAX_CHUNK_PCM_BYTES,
  MAX_CHUNK_SECONDS,
  PLAYBACK_BANK_SECONDS,
  PcmPlayer,
  SayTimeline,
  decodePcmS16le,
  queueCanAccept,
  queueCanPull,
  validateChunkShape,
} from './player.js';
export type {
  ChunkAccepted,
  ChunkRejection,
  ChunkVerdict,
  EnqueueResult,
  JitterBufferOptions,
  JitterDecision,
  PcmPlayerOptions,
  PlaybackChunk,
  PlaybackClock,
  PlaybackErrorCode,
  PlaybackSampleRate,
  PlayerAudioBuffer,
  PlayerAudioContext,
  PlayerAudioNode,
  PlayerAudioParam,
  PlayerBufferSource,
  PlayerGainNode,
  ShapeVerdict,
  TimelineEvents,
} from './player.js';
