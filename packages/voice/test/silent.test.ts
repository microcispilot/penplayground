import { describe, expect, it } from 'vitest';
import { SilentSynthesizer } from '../src/server/silent.js';

async function totalMs(speed?: number): Promise<number> {
  const tts = new SilentSynthesizer();
  let end = 0;
  const req = {
    text: 'one two three four five six seven eight nine',
    voice: 'v',
    sampleRate: 44100 as const,
  };
  for await (const c of tts.synthesize(speed === undefined ? req : { ...req, speed }))
    end = c.audioClockMs + c.durationMs;
  return end;
}

describe('SilentSynthesizer', () => {
  it('shortens the silence in proportion to the requested speed, like a real engine', async () => {
    const base = await totalMs(); // 9 words at 150 wpm = 3600 ms
    expect(base).toBe(3600);
    expect(await totalMs(0.95)).toBe(Math.round(3600 / 0.95));
    expect(await totalMs(1.235)).toBe(Math.round(3600 / 1.235));
    expect(await totalMs(0.7125)).toBe(Math.round(3600 / 0.7125));
    expect(await totalMs(9)).toBe(1800); // clamped to 2×
  });
});
