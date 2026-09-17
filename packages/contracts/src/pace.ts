import { z } from 'zod';

/**
 * Pace: the one number that sets how fast the expert teaches (ADR-0010).
 *
 * 1× is tuned to a patient human teacher, not to a text-to-speech demo. The
 * host chooses a pace for the room; every participant hears and sees the same
 * one because the audio clock is the master clock (ADR-0002): the voice is
 * synthesised at the pace, the pauses between sentences are part of the audio,
 * and the board writes at the pace, so board and captions follow the audio
 * exactly as they do at 1×. Replay adds a playback rate on top (pitch-
 * preserving), like the speed control on a video.
 *
 * Every number the pace touches lives here, with the reason for its value.
 */
export const PACE = {
  /**
   * Fish `prosody.speed` at 1×. Fish's own 1.0 reads like a newsreader; 0.95
   * is where a native listener stops noticing the voice is "keeping up" and
   * starts hearing someone explaining. Multiplied by the pace.
   */
  ttsBaseSpeed: 0.95,
  /**
   * Silence appended after every sentence. Human explanatory speech carries
   * ~350–500 ms between sentences; TTS butts them together and that is the
   * "huge pace" feeling. Divided by the pace.
   */
  sentenceGapMs: 400,
  /**
   * After a check-in question the teacher waits: the learner needs a beat to
   * realise it is their turn. Replaces (not adds to) the sentence gap.
   */
  checkGapMs: 700,
  /**
   * After the sentence that carries a board title the learner is reading the
   * title; a longer beat lets the eye return to the teacher.
   */
  titleGapMs: 700,
  /**
   * Handwriting on the board, characters per second at 1×. Real board writing
   * measured 8–12 cps depending on the writer; 10 lands in the middle and stays
   * legible as it appears. Multiplied by the pace.
   */
  handwritingCps: 10,
  /** Typewriter reveal for code/markdown blocks; text nobody "writes" by hand can arrive faster. */
  typewriterCps: 40,
} as const;

/**
 * The presets the pace menu offers. 0.75× is where speech is still fluent
 * (Fish keeps prosody down to ~0.7); 1.3× is where a listener still follows
 * new material without re-reading captions. Finer steps are meaningless by
 * ear; coarser ones are jumps.
 */
export const PACE_PRESETS = [0.75, 0.9, 1, 1.15, 1.3] as const;
export const PACE_DEFAULT = 1;
/** Hard limits accepted on the wire; Fish accepts 0.5–2 and so does the board. */
export const PACE_MIN = 0.5;
export const PACE_MAX = 2;

/** Wire schema: a finite number inside the accepted range (the server clamps, never rejects, the presets). */
export const Pace = z.number().finite().min(PACE_MIN).max(PACE_MAX);
export type Pace = z.infer<typeof Pace>;

/** Bring any number into the accepted range; a non-finite value becomes the default. */
export function clampPace(pace: number): number {
  if (!Number.isFinite(pace)) return PACE_DEFAULT;
  return Math.min(PACE_MAX, Math.max(PACE_MIN, pace));
}

/** Fish `prosody.speed` for a pace, inside Fish's 0.5–2 range. */
export function ttsSpeedFor(pace: number): number {
  const speed = PACE.ttsBaseSpeed * clampPace(pace);
  return Math.min(2, Math.max(0.5, speed));
}

export type GapKind = 'sentence' | 'check' | 'title';

/** Silence after a sentence, in ms: the base beat for its kind divided by the pace. */
export function gapMsFor(kind: GapKind, pace: number): number {
  const base =
    kind === 'check' ? PACE.checkGapMs : kind === 'title' ? PACE.titleGapMs : PACE.sentenceGapMs;
  return Math.round(base / clampPace(pace));
}

/** Board handwriting rate for a pace, characters per second. */
export function handwritingCpsFor(pace: number): number {
  return PACE.handwritingCps * clampPace(pace);
}

/** "1×", "0.75×", "1.3×": what the pill shows. */
export function formatPace(pace: number): string {
  const p = clampPace(pace);
  const text = Number.isInteger(p) ? String(p) : p.toFixed(2).replace(/0+$/, '');
  return `${text}×`;
}

/** The preset one step slower than `pace` (for "slow down"), or the slowest one. */
export function slowerPreset(pace: number): number {
  const slower = PACE_PRESETS.filter((p) => p < clampPace(pace) - 1e-6);
  return slower.length > 0 ? (slower[slower.length - 1] ?? PACE_PRESETS[0]) : PACE_PRESETS[0];
}

/** The preset one step faster than `pace` (for "speed up"), or the fastest one. */
export function fasterPreset(pace: number): number {
  const faster = PACE_PRESETS.find((p) => p > clampPace(pace) + 1e-6);
  return faster ?? PACE_PRESETS[PACE_PRESETS.length - 1] ?? PACE_DEFAULT;
}
