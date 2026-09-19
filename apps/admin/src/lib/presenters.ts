import type { RuntimeSetting, RuntimeSettingScope, RuntimeSettingValue } from '@pen/contracts';

/** How a value reads on screen. Never an empty cell: "not set" is a fact. */
export function showValue(value: RuntimeSettingValue | null): string {
  if (value === null) return 'Not set';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'number') return value.toLocaleString();
  return value;
}

/**
 * When a change lands, said the way an operator needs to hear it — as the
 * consequence, not the mechanism.
 */
export const SCOPE_NOTE: Readonly<Record<RuntimeSettingScope, string>> = {
  request: 'Takes effect immediately',
  session: 'Takes effect on the next lesson',
  restart: 'Takes effect after the API restarts',
};

/** Same moment, said twice: readable, and machine-readable for the `<time>`. */
export function showMoment(epochMs: number): { text: string; iso: string } {
  if (epochMs <= 0) return { text: 'never', iso: new Date(0).toISOString() };
  const date = new Date(epochMs);
  return { text: date.toLocaleString(), iso: date.toISOString() };
}

/**
 * The one-line answer to "what is this deployment running on", for the top of
 * the page: how many settings are not at their default, and how many of those
 * this particular box is ignoring because the environment pins them.
 */
export function overview(settings: readonly RuntimeSetting[]): {
  total: number;
  changed: number;
  pinned: number;
  needsRestart: number;
} {
  return {
    total: settings.length,
    changed: settings.filter((s) => s.storedValue !== null).length,
    pinned: settings.filter((s) => s.pinnedByEnv).length,
    needsRestart: settings.filter((s) => s.scope === 'restart' && s.storedValue !== null).length,
  };
}
