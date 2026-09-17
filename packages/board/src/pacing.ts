import { TIMING } from '@pen/contracts';

/**
 * Pacing math. The conductor hands each op a `paceMs` (the anchored sentence's
 * measured duration) or null. Rules (ADR-0002, BoardPort contract):
 *   - never faster than the human constants below;
 *   - stretch to `paceMs` when the sentence is longer than the natural time;
 *   - but never crawl: a three-character label must not take twenty seconds,
 *     so stretching is capped at MAX_STRETCH × natural. A `with:` op that
 *     finishes before its sentence is fine; one that drags is not.
 */

export const HAND_CPS: number = TIMING.handwritingCps;
export const TYPEWRITER_CPS: number = TIMING.typewriterCps;

/** Pen travel while sketching, in world units per second (a relaxed marker). */
export const PEN_UNITS_PER_SECOND = 850;

/** Floor so even a one-character op reads as a gesture, not a pop-in. */
export const MIN_OP_MS = 160;

/** Upper bound on stretching a short op to a long sentence. */
export const MAX_STRETCH = 3;

/** Fade used by `erase`. */
export const FADE_MS = 360;

/** Camera moves (design token --duration-scene). */
export const CAMERA_MS = 550;

export function handwritingMs(chars: number): number {
  return Math.max(0, chars) * (1000 / HAND_CPS);
}

export function typewriterMs(chars: number): number {
  return Math.max(0, chars) * (1000 / TYPEWRITER_CPS);
}

export function penTravelMs(lengthUnits: number): number {
  return Math.max(0, lengthUnits) * (1000 / PEN_UNITS_PER_SECOND);
}

export interface ResolvedPace {
  /** What the op will actually take. */
  durationMs: number;
  /** The human-speed time for this op. */
  naturalMs: number;
  /** durationMs / naturalMs (≥ 1). */
  stretch: number;
  mode: 'natural' | 'stretched' | 'capped';
}

/**
 * `rate` multiplies the human writing speed (the room's pace × the replay
 * rate, ADR-0010): at 1.3 the hand moves 30 % faster and the natural time
 * shrinks accordingly; the floor and the stretch cap apply to the scaled time.
 */
export function resolvePace(naturalMs: number, paceMs: number | null, rate = 1): ResolvedPace {
  const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
  const natural = Math.max(MIN_OP_MS, naturalMs / r);
  if (paceMs === null || !Number.isFinite(paceMs) || paceMs <= natural) {
    return { durationMs: natural, naturalMs: natural, stretch: 1, mode: 'natural' };
  }
  const max = natural * MAX_STRETCH;
  if (paceMs > max) {
    return { durationMs: max, naturalMs: natural, stretch: MAX_STRETCH, mode: 'capped' };
  }
  return { durationMs: paceMs, naturalMs: natural, stretch: paceMs / natural, mode: 'stretched' };
}
