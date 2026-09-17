import { describe, expect, it } from 'vitest';
import {
  PACE_PREFERENCE_KEY,
  REPLAY_RATE_PREFERENCE_KEY,
  readPacePreference,
  writePacePreference,
} from '../src/lib/pace-preference.js';
import type { KeyValueStorage } from '../src/platform/types.js';

function memoryStorage(
  seed: Record<string, string> = {},
): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    get: (k) => data.get(k) ?? null,
    set: (k, v) => void data.set(k, v),
    remove: (k) => void data.delete(k),
  };
}

describe('pace preference', () => {
  it('remembers the chosen pace and reads it back', () => {
    const storage = memoryStorage();
    writePacePreference(storage, 1.15);
    expect(storage.data.get(PACE_PREFERENCE_KEY)).toBe('1.15');
    expect(readPacePreference(storage)).toBe(1.15);
  });

  it('returns null when nothing valid is stored', () => {
    expect(readPacePreference(memoryStorage())).toBeNull();
    expect(readPacePreference(memoryStorage({ [PACE_PREFERENCE_KEY]: 'fast' }))).toBeNull();
    expect(readPacePreference(memoryStorage({ [PACE_PREFERENCE_KEY]: '7' }))).toBeNull();
    expect(readPacePreference(memoryStorage({ [PACE_PREFERENCE_KEY]: '0.1' }))).toBeNull();
  });

  it('clamps what it writes and keeps the replay speed under its own key', () => {
    const storage = memoryStorage();
    writePacePreference(storage, 9);
    expect(readPacePreference(storage)).toBe(2);
    writePacePreference(storage, 1.3, REPLAY_RATE_PREFERENCE_KEY);
    expect(readPacePreference(storage, REPLAY_RATE_PREFERENCE_KEY)).toBe(1.3);
    expect(readPacePreference(storage)).toBe(2);
  });
});
