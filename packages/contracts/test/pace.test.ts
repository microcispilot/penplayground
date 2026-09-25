import { describe, expect, it } from 'vitest';
import {
  ClientMessage,
  clampPace,
  fasterPreset,
  formatPace,
  gapMsFor,
  handwritingCpsFor,
  LedgerEntry,
  PACE,
  PACE_MAX,
  PACE_MIN,
  PACE_PRESETS,
  Pace,
  RoomState,
  slowerPreset,
  TIMING,
  ttsSpeedFor,
} from '../src/index.js';

describe('pace math', () => {
  it('scales the TTS speed from the teacher baseline at every preset, inside Fish limits', () => {
    for (const p of PACE_PRESETS) expect(ttsSpeedFor(p)).toBeCloseTo(PACE.ttsBaseSpeed * p, 6);
    expect(ttsSpeedFor(1)).toBeCloseTo(0.85, 6);
    expect(ttsSpeedFor(0.75)).toBeCloseTo(0.6375, 6);
    expect(ttsSpeedFor(1.3)).toBeCloseTo(1.105, 6);
    // 0.85 × 0.5 would go below Fish's floor: clamped.
    expect(ttsSpeedFor(0.5)).toBe(0.5);
    expect(ttsSpeedFor(2)).toBeCloseTo(1.7, 6);
    expect(ttsSpeedFor(99)).toBeLessThanOrEqual(2);
  });

  it('divides the pauses by the pace: slower pace, longer beats', () => {
    expect(gapMsFor('sentence', 1)).toBe(400);
    expect(gapMsFor('check', 1)).toBe(700);
    expect(gapMsFor('title', 1)).toBe(700);
    expect(gapMsFor('sentence', 0.75)).toBe(533);
    expect(gapMsFor('sentence', 0.9)).toBe(444);
    expect(gapMsFor('sentence', 1.15)).toBe(348);
    expect(gapMsFor('sentence', 1.3)).toBe(308);
    expect(gapMsFor('check', 1.3)).toBe(538);
    for (const p of PACE_PRESETS)
      expect(gapMsFor('check', p)).toBeGreaterThan(gapMsFor('sentence', p));
  });

  it('multiplies the board handwriting rate by the pace', () => {
    expect(handwritingCpsFor(1)).toBe(20);
    expect(handwritingCpsFor(0.75)).toBeCloseTo(15, 6);
    expect(handwritingCpsFor(0.9)).toBeCloseTo(18, 6);
    expect(handwritingCpsFor(1.15)).toBeCloseTo(23, 6);
    expect(handwritingCpsFor(1.3)).toBeCloseTo(26, 6);
    // The product timing constant is the same number: one place for the 1× rhythm.
    expect(TIMING.handwritingCps).toBe(PACE.handwritingCps);
  });

  it('clamps to the accepted range and survives garbage', () => {
    expect(clampPace(0.1)).toBe(PACE_MIN);
    expect(clampPace(5)).toBe(PACE_MAX);
    expect(clampPace(1.15)).toBe(1.15);
    expect(clampPace(Number.NaN)).toBe(1);
    expect(clampPace(Number.POSITIVE_INFINITY)).toBe(1);
    expect(Pace.safeParse(0.5).success).toBe(true);
    expect(Pace.safeParse(2).success).toBe(true);
    expect(Pace.safeParse(0.49).success).toBe(false);
    expect(Pace.safeParse(2.01).success).toBe(false);
    expect(Pace.safeParse('1').success).toBe(false);
  });

  it('formats presets the way the pill shows them', () => {
    expect(PACE_PRESETS.map(formatPace)).toEqual(['0.75×', '0.9×', '1×', '1.15×', '1.3×']);
    expect(formatPace(2)).toBe('2×');
  });

  it('steps through the presets for spoken "slower" / "faster"', () => {
    expect(slowerPreset(1)).toBe(0.9);
    expect(slowerPreset(0.75)).toBe(0.75);
    expect(slowerPreset(1.2)).toBe(1.15);
    expect(fasterPreset(1)).toBe(1.15);
    expect(fasterPreset(1.3)).toBe(1.3);
    expect(fasterPreset(0.8)).toBe(0.9);
  });
});

describe('pace on the wire and in the ledger', () => {
  it('accepts a host set_pace message and rejects one outside the range', () => {
    expect(ClientMessage.safeParse({ kind: 'set_pace', pace: 1.3 }).success).toBe(true);
    expect(ClientMessage.safeParse({ kind: 'set_pace', pace: 3 }).success).toBe(false);
    expect(ClientMessage.safeParse({ kind: 'set_pace' }).success).toBe(false);
  });

  it('records a pace change with who set it and when', () => {
    const entry = LedgerEntry.parse({
      kind: 'pace',
      t: 1000,
      pace: 0.9,
      participantId: 'participant-1',
    });
    expect(entry.kind).toBe('pace');
    expect(
      LedgerEntry.safeParse({ kind: 'pace', t: 1, pace: 0.1, participantId: 'participant-1' })
        .success,
    ).toBe(false);
  });

  it('requires a pace on the room state', () => {
    const base = {
      sessionId: 'session-1234',
      topic: 't',
      language: 'en',
      expertId: 'ada-okonkwo',
      phase: 'live',
      mode: 'teaching',
      floor: null,
      hostId: 'participant-1',
      participants: [],
      plan: null,
      segment: 0,
      clockMs: 0,
      preparation: null,
      evidenceTier: 'reviewed_pack_source',
      startedAt: 0,
      recap: null,
      resume: null,
    };
    expect(RoomState.safeParse(base).success).toBe(false);
    expect(RoomState.safeParse({ ...base, pace: 1.15 }).success).toBe(true);
  });
});
