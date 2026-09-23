import { describe, expect, it } from 'vitest';
import { type LedgerEntry, recordingIsPrivateTo, recordingOrder } from '../src/index.js';

/**
 * The order a recording is heard in (ADR-0035): by the audio's clock, not the
 * cues' sequence numbers — an answer plays where the question was asked, and
 * the lesson sentences re-taken after it play after it.
 */
const say = (seq: number, id: string, thread: string, t: number): LedgerEntry => ({
  kind: 'cue',
  t,
  cue: {
    seq,
    segment: 0,
    thread,
    at: t,
    event: { type: 'say', id, text: `${id} text`, tone: 'neutral' },
  },
});
const audio = (sayId: string, take: number, t: number): LedgerEntry => ({
  kind: 'audio',
  t,
  audioRef: `${sayId}.${take}.pcm#0`,
  header: {
    dir: 'down',
    sayId,
    take,
    audioChunkId: 0,
    sampleRate: 44100,
    audioClockMs: 0,
    durationMs: 800,
    textSpan: null,
    final: true,
  },
});

/** A segment of three sentences, interrupted after the first: the answer, then s2 and s3 re-taken. */
const entries: LedgerEntry[] = [
  say(0, 'L0.s1', 'lesson', 100),
  say(1, 'L0.s2', 'lesson', 100),
  say(2, 'L0.s3', 'lesson', 100),
  audio('L0.s1', 0, 1_000),
  audio('L0.s2', 0, 1_800), // banked, never heard: interrupted
  { kind: 'interrupt', t: 2_000, participantId: 'p1', atSeq: 0, offsetMs: 500 },
  { kind: 'caption', t: 2_600, participantId: 'p1', text: 'Wait, why divide by the root of d?' },
  say(3, 't1.s0', 't1', 2_650),
  say(4, 't1.s1', 't1', 3_100),
  audio('t1.s0', 0, 2_700),
  audio('t1.s1', 0, 3_400),
  audio('L0.s2', 1, 5_000),
  audio('L0.s3', 1, 5_900),
];

describe('recordingOrder', () => {
  it('plays the answer where it was asked, and the re-taken lesson after it', () => {
    const { keys, says } = recordingOrder(entries);
    expect(keys).toEqual(['L0.s1@0', 't1.s0@0', 't1.s1@0', 'L0.s2@1', 'L0.s3@1']);
    expect(says.find((s) => s.sayId === 't1.s0')?.asked).toBe('Wait, why divide by the root of d?');
    expect(says.find((s) => s.sayId === 't1.s1')?.asked).toBeNull();
    expect(says.find((s) => s.sayId === 'L0.s2')?.asked).toBeNull();
  });

  it('lessonOnly drops every turn and the words that opened it', () => {
    const { keys, says } = recordingOrder(entries, { lessonOnly: true });
    expect(keys).toEqual(['L0.s1@0', 'L0.s2@1', 'L0.s3@1']);
    expect(says.every((s) => s.asked === null && s.thread === 'lesson')).toBe(true);
  });

  it('keeps sentences that were never spoken at the end, in cue order', () => {
    const { keys } = recordingOrder([
      say(0, 'L0.s1', 'lesson', 0),
      say(1, 'L0.s2', 'lesson', 0),
      say(2, 'L0.s3', 'lesson', 0),
      audio('L0.s1', 0, 500),
    ]);
    expect(keys).toEqual(['L0.s1@0', 'L0.s2@0', 'L0.s3@0']);
  });
});

describe('recordingIsPrivateTo', () => {
  it('opens a recording to its host and to nobody else', () => {
    expect(recordingIsPrivateTo({ hostId: 'p1' }, 'p1')).toBe(true);
    expect(recordingIsPrivateTo({ hostId: 'p1' }, 'p2')).toBe(false);
    expect(recordingIsPrivateTo({ hostId: 'p1' }, null)).toBe(false);
    expect(recordingIsPrivateTo({ hostId: '' }, '')).toBe(false);
  });
});
