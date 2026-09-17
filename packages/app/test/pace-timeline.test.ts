import type { LedgerEntry } from '@pen/contracts';
import { describe, expect, it } from 'vitest';
import { paceTimeline } from '../src/room/pace-timeline.js';

const cue = (t: number, id: string): LedgerEntry => ({
  kind: 'cue',
  t,
  cue: {
    seq: 0,
    segment: 0,
    thread: 'lesson',
    at: t,
    event: { type: 'say', id, text: 'x', tone: 'warm' },
  },
});
const pace = (t: number, value: number): LedgerEntry => ({
  kind: 'pace',
  t,
  pace: value,
  participantId: 'host-1234',
});

describe('paceTimeline', () => {
  it('is 1× and constant for a recording that never changed pace', () => {
    const tl = paceTimeline([cue(100, 's1'), cue(200, 's2')]);
    expect(tl.initial).toBe(1);
    expect(tl.constant).toBe(true);
    expect(tl.at(0)).toBe(1);
    expect(tl.at(5000)).toBe(1);
  });

  it('starts at the pace the host had set before the first cue, then follows every change by server time', () => {
    const tl = paceTimeline([
      { kind: 'join', t: 0, participantId: 'host-1234', name: 'Sam' },
      pace(50, 1.15),
      cue(100, 's1'),
      pace(150, 0.9),
      cue(200, 's2'),
      pace(300, 1.3),
      cue(400, 's3'),
    ]);
    expect(tl.initial).toBe(1.15);
    expect(tl.constant).toBe(false);
    expect(tl.at(100)).toBe(1.15);
    expect(tl.at(150)).toBe(0.9);
    expect(tl.at(200)).toBe(0.9);
    expect(tl.at(400)).toBe(1.3);
    expect(tl.at(10)).toBe(1);
  });

  it('clamps stored paces and tolerates entries out of order', () => {
    const tl = paceTimeline([pace(300, 0.75), cue(100, 's1'), pace(200, 2)]);
    expect(tl.initial).toBe(1);
    expect(tl.at(250)).toBe(2);
    expect(tl.at(300)).toBe(0.75);
  });
});
