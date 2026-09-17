/**
 * Browser-side voice pipeline (ADR-0004): microphone capture with harmonic
 * voicing + endpointing, and jitter-buffered PCM playback for the room.
 *
 * The capture worklet (`capture-processor.js`) is exported separately as
 * `@pen/voice/worklet` so the app can import its source text (`?raw`); the
 * resampler worker is `@pen/voice/resampler-worker` for `?worker` bundling.
 */
export * from './constants.js';
export type {
  MediaElementLike,
  MediaEventName,
  MediaPlayerErrorCode,
  MediaSayPlayerOptions,
} from './media-player.js';
export { MEDIA_RATE_MAX, MEDIA_RATE_MIN, MediaSayPlayer, pcmToWav } from './media-player.js';
export type { MicrophoneOptions, MicrophoneState } from './microphone.js';
export { CAPTURE_PROCESSOR_NAME, Microphone } from './microphone.js';
export { resampleMonoToPcmS16le } from './pcm-resampler.js';
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
export {
  AdaptiveJitterBuffer,
  ChunkValidator,
  DURATION_TOLERANCE_MS,
  decodePcmS16le,
  MAX_BUFFERED_SECONDS,
  MAX_CHUNK_PCM_BYTES,
  MAX_CHUNK_SECONDS,
  PcmPlayer,
  PLAYBACK_BANK_SECONDS,
  queueCanAccept,
  queueCanPull,
  SayTimeline,
  validateChunkShape,
} from './player.js';
export type { SpeechPresenceOptions } from './speech-presence.js';
export { SpeechPresenceDetector } from './speech-presence.js';
export type { UtteranceSegmenterOptions } from './utterance-segmenter.js';
export { UNCONFIRMED_SOUND_RELEASE_MS, UtteranceSegmenter } from './utterance-segmenter.js';
