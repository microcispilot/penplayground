import { describe, expect, it } from 'vitest';
import { SpeechPresenceDetector } from '../src/client/speech-presence.js';
import { frames, tone, whiteNoise } from './helpers.js';

const RATE = 48_000;
const FRAME = Math.round(RATE * 0.02);

function voicedHopsFor(signal: Float32Array): number {
  const detector = new SpeechPresenceDetector({ sourceSampleRate: RATE });
  let hops = 0;
  for (const frame of frames(signal, FRAME)) hops += detector.push(frame);
  return hops;
}

describe('SpeechPresenceDetector', () => {
  it('classifies a 200 Hz voiced tone as harmonic on nearly every hop', () => {
    const hops = voicedHopsFor(tone(RATE, 1_000, 200, 0.3));
    // One second at a 15 ms hop is ~66 windows; the first window needs 30 ms.
    expect(hops).toBeGreaterThan(55);
  });

  it('never classifies white noise as voice, even when loud', () => {
    expect(voicedHopsFor(whiteNoise(RATE, 1_000, 0.5, 7))).toBe(0);
  });

  it('ignores a tone too quiet to carry a decision', () => {
    expect(voicedHopsFor(tone(RATE, 500, 200, 0.001))).toBe(0);
  });

  it('credits voiced hops inside a trailing span for pre-roll accounting', () => {
    const detector = new SpeechPresenceDetector({ sourceSampleRate: RATE });
    for (const frame of frames(tone(RATE, 400, 180, 0.3), FRAME)) detector.push(frame);
    const credited = detector.recentVoicedSourceSamples(Math.round(RATE * 0.25));
    expect(credited).toBeGreaterThan(RATE * 0.15);
    expect(credited).toBeLessThanOrEqual(RATE * 0.25 + detector.hopSourceSamples);
    detector.reset();
    expect(detector.recentVoicedSourceSamples(RATE)).toBe(0);
  });

  it('rejects a source rate below the analysis rate', () => {
    expect(() => new SpeechPresenceDetector({ sourceSampleRate: 4_000 })).toThrow(
      'PEN_SPEECH_PRESENCE_SAMPLE_RATE_REJECTED',
    );
  });
});
