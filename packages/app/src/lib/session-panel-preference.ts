import type { KeyValueStorage } from '../platform/types.js';

/**
 * Whether the learner keeps the room's session panel open beside the board.
 *
 * Stored the way every other room habit is (`pace-preference.ts`,
 * `sidebar-preference.ts`): one key, one small value, through the platform's
 * storage so a private window or a locked-down browser simply gets the
 * default instead of an error.
 */
export const SESSION_PANEL_PREFERENCE_KEY = 'pen.session-panel';

export type SessionPanelPreference = 'open' | 'collapsed';

/** The remembered layout, or `open` when nothing valid is stored. */
export function readSessionPanelPreference(storage: KeyValueStorage): SessionPanelPreference {
  return storage.get(SESSION_PANEL_PREFERENCE_KEY) === 'collapsed' ? 'collapsed' : 'open';
}

export function writeSessionPanelPreference(
  storage: KeyValueStorage,
  value: SessionPanelPreference,
): void {
  storage.set(SESSION_PANEL_PREFERENCE_KEY, value);
}
