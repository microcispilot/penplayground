import { TIMING } from '@pen/contracts';
import { describe, expect, it } from 'vitest';
import {
  handwritingMs,
  MAX_STRETCH,
  MIN_OP_MS,
  penTravelMs,
  resolvePace,
  typewriterMs,
} from '../src/pacing.js';

describe('pacing', () => {
  it('natural durations follow the product constants', () => {
    expect(handwritingMs(TIMING.handwritingCps)).toBeCloseTo(1000, 6);
    expect(typewriterMs(TIMING.typewriterCps)).toBeCloseTo(1000, 6);
    expect(handwritingMs(22)).toBeCloseTo(2200, 6); // 10 cps: a patient teacher's hand
    expect(penTravelMs(850)).toBeCloseTo(1000, 6);
  });

  it('null pace → natural speed', () => {
    const r = resolvePace(2000, null);
    expect(r).toEqual({ durationMs: 2000, naturalMs: 2000, stretch: 1, mode: 'natural' });
  });

  it('a shorter sentence never speeds writing up', () => {
    const r = resolvePace(2000, 500);
    expect(r.durationMs).toBe(2000);
    expect(r.mode).toBe('natural');
  });

  it('a longer sentence stretches the op to its duration', () => {
    const r = resolvePace(2000, 4500);
    expect(r).toEqual({ durationMs: 4500, naturalMs: 2000, stretch: 2.25, mode: 'stretched' });
  });

  it('stretching is capped so a short label never crawls', () => {
    const r = resolvePace(1000, 60_000);
    expect(r.durationMs).toBe(1000 * MAX_STRETCH);
    expect(r.mode).toBe('capped');
  });

  it('tiny ops get a floor so they read as a gesture', () => {
    expect(resolvePace(5, null).durationMs).toBe(MIN_OP_MS);
    expect(resolvePace(0, 100).durationMs).toBe(MIN_OP_MS);
  });

  it('ignores non-finite pace values', () => {
    expect(resolvePace(1000, Number.NaN).durationMs).toBe(1000);
    expect(resolvePace(1000, Number.POSITIVE_INFINITY).durationMs).toBe(1000);
  });

  it('the writing rate scales the natural time: 1.3× writes 30 % faster, 0.75× slower', () => {
    expect(resolvePace(2000, null, 1.3).durationMs).toBeCloseTo(2000 / 1.3, 6);
    expect(resolvePace(2000, null, 0.75).durationMs).toBeCloseTo(2000 / 0.75, 6);
    // The floor and the stretch cap apply to the scaled time.
    expect(resolvePace(200, null, 2).durationMs).toBe(MIN_OP_MS);
    expect(resolvePace(1000, 60_000, 2).durationMs).toBe(500 * MAX_STRETCH);
    // A sentence longer than the scaled natural time still paces the op.
    expect(resolvePace(2000, 1800, 1.3)).toMatchObject({ durationMs: 1800, mode: 'stretched' });
    // Garbage rates fall back to 1.
    expect(resolvePace(1000, null, 0).durationMs).toBe(1000);
    expect(resolvePace(1000, null, Number.NaN).durationMs).toBe(1000);
  });
});
