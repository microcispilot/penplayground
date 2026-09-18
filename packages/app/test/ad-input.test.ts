import { describe, expect, it } from 'vitest';
import { AdInputGate } from '../src/room/ad-input.js';

describe('what this device does while an ad is up', () => {
  it('mutes the microphone once, and unmutes it once, however often the state is set', () => {
    const muted: boolean[] = [];
    const gate = new AdInputGate((paused) => muted.push(paused));
    expect(gate.paused).toBe(false);
    expect(gate.refuses()).toBe(false);

    gate.set(true);
    gate.set(true);
    expect(muted).toEqual([true]);
    expect(gate.refuses()).toBe(true);

    gate.set(false);
    gate.set(false);
    expect(muted).toEqual([true, false]);
    expect(gate.refuses()).toBe(false);
  });

  it('gives everything back on one transition, however the ad ended', () => {
    // Skipped, completed, timed out, blocked, the socket dropping: the
    // conductor turns every one of them into the same `showAd(null)`.
    for (const ending of ['skipped', 'completed', 'timeout', 'blocked'] as const) {
      const muted: boolean[] = [];
      const gate = new AdInputGate((paused) => muted.push(paused));
      gate.set(true);
      gate.set(false);
      expect(muted, ending).toEqual([true, false]);
      expect(gate.paused, ending).toBe(false);
    }
  });
});
