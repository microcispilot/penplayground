import { BOARD_PREFERENCE_DEFAULT, BoardPreference } from '@pen/contracts';
import type { KeyValueStorage } from '../platform/types.js';

/**
 * The board a learner chose, on this device.
 *
 * Device-first, exactly as `pace` is (`RoomSession.keepPace`): the local write
 * is the one that counts and it never fails, and the account write is a
 * courtesy that keeps the choice when they move machines. That ordering is not
 * a shortcut — a signed-out learner is a real learner here, and a board that
 * only worked once you had an account would be a worse product for the people
 * who use it most.
 *
 * Stored as one JSON object rather than three keys because the three values
 * are one decision: a surface and the two colours that go with it. Reading a
 * half-written preference — a surface from today and a chalk from a build that
 * spelled it differently — is the failure mode that costs an afternoon, and a
 * single parse either succeeds or falls back whole.
 */
export const BOARD_PREFERENCE_KEY = 'pen.board';

/**
 * What is on this device, validated. Anything unreadable, unparseable or from
 * a build with a different vocabulary returns the default rather than throwing
 * — the same contract every other preference reader here keeps, and the reason
 * a corrupted key cannot take the board down.
 *
 * Note this does NOT consult the plan. Storage holds what the learner picked;
 * `resolveSurface` and `resolveInkId` decide what they may have. Keeping those
 * apart is what lets a lapsed subscriber get their green board back when they
 * resubscribe, instead of having had it quietly erased.
 */
export function readBoardPreference(storage: KeyValueStorage): BoardPreference {
  try {
    const raw = storage.get(BOARD_PREFERENCE_KEY);
    if (!raw) return BOARD_PREFERENCE_DEFAULT;
    const parsed = BoardPreference.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : BOARD_PREFERENCE_DEFAULT;
  } catch {
    return BOARD_PREFERENCE_DEFAULT;
  }
}

export function writeBoardPreference(storage: KeyValueStorage, value: BoardPreference): void {
  try {
    storage.set(BOARD_PREFERENCE_KEY, JSON.stringify(value));
  } catch {
    /* storage unavailable: the choice still applies for this page */
  }
}

/**
 * Stamp the resolved board on `<html>`.
 *
 * Two attributes, because they are two independent axes: the surface decides
 * the paper, the frame and every ink role, and the chosen colour then
 * overrides the body ink alone. `tokens.css` declares `[data-ink]` after
 * `[data-board]` so that override lands — see the banner there, where the
 * source ordering is explained and is load-bearing.
 *
 * Both are always set, never removed. An absent `data-board` would fall back
 * to the `:root` block, which happens to be the whiteboard — correct by
 * accident today and wrong the first time somebody reorders that file.
 */
export function applyBoardAttributes(surface: string, ink: string): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-board', surface);
  root.setAttribute('data-ink', ink);
}

// ── the store ───────────────────────────────────────────────────────────────
//
// The same shape as `lib/theme.ts`: a module-level value, a listener set and a
// `useSyncExternalStore` read. The board is chosen in Settings and painted in
// the room, which are different routes and different trees, so this cannot be
// React state held by a common parent — there is no common parent.

const listeners = new Set<() => void>();
let current: BoardPreference | null = null;

/** Seed from storage once, on first read. */
export function boardPreference(storage: KeyValueStorage): BoardPreference {
  if (current === null) current = readBoardPreference(storage);
  return current;
}

/** Replace the preference, persist it, and tell every subscriber. */
export function setBoardPreference(storage: KeyValueStorage, value: BoardPreference): void {
  current = value;
  writeBoardPreference(storage, value);
  for (const listener of listeners) listener();
}

export function subscribeToBoardPreference(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests only: drop the memoised value so the next read re-seeds from storage. */
export function resetBoardPreferenceForTests(): void {
  current = null;
}
