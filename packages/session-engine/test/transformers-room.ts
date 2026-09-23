import { FakeLanguageModel } from '@pen/llm';

/**
 * The scripted Transformers lesson the room tests teach: two segments, one
 * check-in, one answer, and the plan, grade and recap completions behind
 * them. `room.test.ts` keeps its own copy beside its other fixtures; this one
 * is for the tests that only need the model (`hands.test.ts`).
 */
const board = (id: string, anchor: string, text: string) => ({
  type: 'board' as const,
  id,
  anchor,
  op: 'write' as const,
  text,
  lang: '',
  ref: '',
  ref2: '',
  place: 'flow' as const,
  emphasis: 'ink' as const,
});
const say = (id: string, text: string) => ({
  type: 'say' as const,
  id,
  text,
  tone: 'warm' as const,
});

export function fakeModel() {
  return new FakeLanguageModel(
    [
      {
        match: (r) =>
          r.purpose === 'lesson' && r.messages.some((m) => m.content.includes('SEGMENT 1:')),
        gapMs: 5,
        events: [
          say('s1', "Let's start with a sentence."),
          board('b1', 's1', 'the cat sat on the mat'),
          say('s2', 'Six tokens is everything the model sees at first.'),
          { type: 'done' },
        ],
      },
      {
        match: (r) =>
          r.purpose === 'lesson' && r.messages.some((m) => m.content.includes('SEGMENT 2:')),
        gapMs: 5,
        events: [
          say('s1', 'Each token becomes a vector.'),
          board('b1', 'after:s1', 'token → vector'),
          say('s2', 'Quick one: what is a vector here?'),
          {
            type: 'check',
            id: 'c1',
            askedBy: 's2',
            options: ['A word', 'A list of numbers', 'A position'],
            expected: 'A list of numbers',
            explain: 'A vector is just a list of numbers.',
          },
          { type: 'done' },
        ],
      },
      {
        match: (r) => r.purpose === 'turn',
        gapMs: 5,
        events: [
          {
            type: 'note',
            language: 'en-US',
            question: 'why divide by √d?',
            headline: 'keeps scores in range',
            detail: 'dot products grow with length',
          },
          say('s1', 'Without it the dot products get huge.'),
          say('s2', 'Okay, back to where we were.'),
          { type: 'done' },
        ],
      },
    ],
    [
      {
        purpose: 'plan',
        value: {
          title: 'How Transformers work',
          promise: 'Learn to read an attention diagram.',
          segments: [
            { title: 'Tokens', goal: 'See tokens as vectors', minutes: 1, hasCheck: false },
            { title: 'Vectors', goal: 'Vectors and positions', minutes: 1, hasCheck: true },
          ],
        },
      },
      {
        purpose: 'grade',
        value: { verdict: 'correct', feedback: 'Exactly that, a list of numbers. Nicely done.' },
      },
      {
        purpose: 'recap',
        value: { points: ['Tokens become vectors', 'Attention scores query against key'] },
      },
    ],
  );
}
