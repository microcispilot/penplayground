import type { Cue, LessonPlan } from '@pen/contracts';
import { describe, expect, it } from 'vitest';
import { buildReplayTimeline } from '../src/room/replay-timeline.js';

const say = (seq: number, id: string, segment: number, text = 'x'): Cue => ({
  seq,
  segment,
  thread: 'lesson',
  at: 0,
  event: { type: 'say', id, text, tone: 'warm' },
});
const board = (seq: number, id: string, segment: number): Cue => ({
  seq,
  segment,
  thread: 'lesson',
  at: 0,
  event: {
    type: 'board',
    id,
    anchor: 'now',
    op: 'write',
    text: 'note',
    lang: '',
    ref: '',
    ref2: '',
    place: 'flow',
    emphasis: 'ink',
  },
});

const plan: LessonPlan = {
  title: 'How Transformers work',
  promise: 'p',
  band: 'beginner',
  seconds: 600,
  segments: [
    { index: 0, title: 'Tokens', goal: 'g', seconds: 300, hasCheck: false },
    { index: 1, title: 'Vectors', goal: 'g', seconds: 300, hasCheck: true },
  ],
};

/** Three sentences of 1 s, 2 s and 3 s, the last two in segment 1. */
function timeline() {
  const cues = [
    say(0, 's1', 0),
    board(1, 'b1', 0),
    say(2, 's2', 1),
    say(3, 's3', 1),
    board(4, 'b2', 1),
  ];
  const durations: Record<string, number> = { 's1@0': 1000, 's2@0': 2000, 's3@0': 3000 };
  return buildReplayTimeline({
    cues,
    sayOrder: ['s1@0', 's2@0', 's3@0'],
    durationOf: (key) => durations[key] ?? 0,
    plan,
  });
}

describe('replay timeline', () => {
  it('lays the sentences end to end on the recorded clock', () => {
    const t = timeline();
    expect(t.totalMs).toBe(6000);
    expect(t.says.map((s) => [s.sayId, s.startMs, s.durationMs])).toEqual([
      ['s1', 0, 1000],
      ['s2', 1000, 2000],
      ['s3', 3000, 3000],
    ]);
    // Each sentence remembers the cue that carried it: everything before is board history.
    expect(t.says.map((s) => s.cueSeq)).toEqual([0, 2, 3]);
  });

  it('locates a position as a sentence plus an offset inside it', () => {
    const t = timeline();
    expect(t.locate(0)).toEqual({ index: 0, offsetMs: 0 });
    expect(t.locate(999)).toEqual({ index: 0, offsetMs: 999 });
    // The boundary belongs to the sentence that starts there, not the one that ended.
    expect(t.locate(1000)).toEqual({ index: 1, offsetMs: 0 });
    expect(t.locate(2500)).toEqual({ index: 1, offsetMs: 1500 });
    expect(t.locate(3000)).toEqual({ index: 2, offsetMs: 0 });
    // 50 % of a six second recording is half way into the third sentence.
    expect(t.locate(3000)).toEqual({ index: 2, offsetMs: 0 });
    expect(t.locate(4500)).toEqual({ index: 2, offsetMs: 1500 });
  });

  it('clamps a seek past either end onto the recording', () => {
    const t = timeline();
    expect(t.locate(-5000)).toEqual({ index: 0, offsetMs: 0 });
    expect(t.locate(99_000)).toEqual({ index: 2, offsetMs: 2999 });
  });

  it('puts one chapter tick at the first sentence of each segment', () => {
    const t = timeline();
    expect(t.chapters).toEqual([
      { segment: 0, title: 'Tokens', startMs: 0 },
      { segment: 1, title: 'Vectors', startMs: 1000 },
    ]);
    expect(t.chapterAt(500)?.title).toBe('Tokens');
    expect(t.chapterAt(1000)?.title).toBe('Vectors');
    expect(t.chapterAt(5999)?.title).toBe('Vectors');
  });

  it('names a chapter by its step when the recording has no plan', () => {
    const t = buildReplayTimeline({
      cues: [say(0, 's1', 0)],
      sayOrder: ['s1@0'],
      durationOf: () => 1000,
      plan: null,
    });
    expect(t.chapters).toEqual([{ segment: 0, title: 'Step 1', startMs: 0 }]);
  });

  it('is empty, not broken, for a recording with no audible sentence', () => {
    const t = buildReplayTimeline({ cues: [], sayOrder: [], durationOf: () => 0, plan });
    expect(t.totalMs).toBe(0);
    expect(t.locate(1234)).toEqual({ index: 0, offsetMs: 0 });
    expect(t.chapterAt(0)).toBeNull();
  });
});
