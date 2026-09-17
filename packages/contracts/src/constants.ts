import { PACE } from './pace.js';

/** Product-level timing constants (docs/PRODUCT.md, ADR-0002, ADR-0004). */
export const TIMING = {
  /** Learner's last word → expert's first audible phoneme. */
  firstAudioTargetMs: 800,
  firstAudioCeilingMs: 1200,
  /** Voiced speech required before an interruption is confirmed. */
  bargeInConfirmMs: 240,
  bargeInVoicedMs: 120,
  /** Gain ramp when the expert is interrupted. */
  bargeInFadeMs: 20,
  /** Trailing silence that ends a learner utterance. */
  endOfUtteranceMs: 800,
  preRollMs: 250,
  /** Human handwriting pace on the board at 1×, characters per second (see pace.ts). */
  handwritingCps: PACE.handwritingCps,
  /** Typewriter pace for code/markdown blocks at 1×, characters per second. */
  typewriterCps: PACE.typewriterCps,
  /** Longest the board may stay untouched while the expert is silent before an honest status line appears. */
  deadAirCeilingMs: 2000,
} as const;

export const AUDIO = {
  ttsSampleRate: 44_100,
  sttSampleRate: 16_000,
  upstreamFrameMs: 160,
} as const;
