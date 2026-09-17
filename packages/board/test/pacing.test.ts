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
    expect(handwritingMs(22)).toBeCloseTo(2000, 6);
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
});
