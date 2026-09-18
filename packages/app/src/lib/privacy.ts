import { limitedAdsForZone } from '@pen/contracts';
import type { KeyValueStorage } from '../platform/types.js';

/**
 * Privacy without a wall (ADR-0017).
 *
 * There is no consent banner in this product, because there is nothing here
 * that needs consenting to: analytics are cookieless and content-free, ads are
 * non-personalised everywhere and limited where European rules may reach the
 * viewer, and the only thing kept on the device is what the learner asked for
 * (their bearer, their name, their pace). What there *is* is a quiet switch —
 * "Privacy choices" — for anyone who would rather not be counted at all.
 *
 * The choice is remembered on the device so it applies before the first
 * network call of the next visit, and sent to the server so the server-side
 * analytics sink honours it too. Either alone would be a half-truth.
 */

/** Versioned so a later change of what is collected can be re-presented honestly. */
export const PRIVACY_KEY = 'pen.privacy.v1';

export interface PrivacyChoice {
  /** False when the learner has turned product analytics off. */
  analytics: boolean;
}

export const DEFAULT_PRIVACY: PrivacyChoice = { analytics: true };

export function readPrivacy(storage: KeyValueStorage): PrivacyChoice {
  // A stored value is the only thing that turns analytics off; anything
  // unreadable simply means "not chosen", never a broken screen.
  return storage.get(PRIVACY_KEY) === 'off' ? { analytics: false } : DEFAULT_PRIVACY;
}

export function writePrivacy(storage: KeyValueStorage, choice: PrivacyChoice): void {
  storage.set(PRIVACY_KEY, choice.analytics ? 'on' : 'off');
}

/** Whether this viewer gets limited ads, read from their own clock. */
export function limitedAdsHere(): boolean {
  try {
    return limitedAdsForZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    // No Intl, no idea where they are: assume the stricter mode.
    return true;
  }
}

/**
 * Exactly what leaves this device, in the words the Privacy choices sheet
 * shows. Kept beside the code that sends it so the list cannot quietly drift
 * from the truth.
 */
export const WHAT_IS_COLLECTED: readonly string[] = [
  'Which screens you opened and what you tapped — as event names, never what you typed or said.',
  'How fast things were: time to the first word, answer latency, board timings.',
  'What a session cost us to run, and how much of it we reused instead of regenerating.',
  'Errors, with a code and where they happened.',
];

export const WHAT_IS_NEVER_COLLECTED: readonly string[] = [
  'What you asked, what the expert said, or anything written on the board.',
  'Advertising identifiers or cross-site cookies — analytics here are cookieless, and ads are non-personalised.',
];
