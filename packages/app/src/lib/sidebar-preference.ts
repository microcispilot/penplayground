import type { KeyValueStorage } from '../platform/types.js';

/** Whether the learner keeps the sidebar as the 72 px icon rail (ADR-0015). */
export const SIDEBAR_PREFERENCE_KEY = 'pen.sidebar';

export type SidebarPreference = 'expanded' | 'rail';

/** The remembered layout, or `expanded` when nothing valid is stored. */
export function readSidebarPreference(storage: KeyValueStorage): SidebarPreference {
  return storage.get(SIDEBAR_PREFERENCE_KEY) === 'rail' ? 'rail' : 'expanded';
}

export function writeSidebarPreference(storage: KeyValueStorage, value: SidebarPreference): void {
  storage.set(SIDEBAR_PREFERENCE_KEY, value);
}
