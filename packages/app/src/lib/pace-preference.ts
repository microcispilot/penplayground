import { clampPace, PACE_MAX, PACE_MIN } from '@pen/contracts';
import type { KeyValueStorage } from '../platform/types.js';

/** The learner's last chosen teaching pace, applied when they host their next session. */
export const PACE_PREFERENCE_KEY = 'pen.pace';
/** The learner's last chosen replay speed (a separate habit from how they like to be taught). */
export const REPLAY_RATE_PREFERENCE_KEY = 'pen.replay-rate';

/** A remembered pace, or null when nothing valid is stored (the platform storage already swallows access errors). */
export function readPacePreference(
  storage: KeyValueStorage,
  key = PACE_PREFERENCE_KEY,
): number | null {
  const raw = storage.get(key);
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < PACE_MIN || value > PACE_MAX) return null;
  return value;
}

export function writePacePreference(
  storage: KeyValueStorage,
  pace: number,
  key = PACE_PREFERENCE_KEY,
): void {
  storage.set(key, String(clampPace(pace)));
}
