import type { LessonEvent } from '@pen/contracts';
import { describe, expect, it } from 'vitest';
import { expertFirstName, FakeLanguageModel } from '../src/fake.js';
import type { EventStreamRequest } from '../src/types.js';

const request = (system: string): EventStreamRequest => ({
  messages: [
    { role: 'system', content: system },
    { role: 'user', content: 'teach' },
  ],
  cacheKey: 'k',
  maxOutputTokens: 100,
  purpose: 'lesson',
});

const events: LessonEvent[] = [
  { type: 'say', id: 's1', text: "Hi — I'm {{expert}}. {{expert}} here.", tone: 'warm' },
  { type: 'done' },
];

async function collect(model: FakeLanguageModel, req: EventStreamRequest): Promise<LessonEvent[]> {
  const out: LessonEvent[] = [];
  for await (const ev of model.streamEvents(req)) out.push(ev);
  return out;
}

describe('FakeLanguageModel persona substitution', () => {
  it('reads the persona first name from the system prompt', () => {
    expect(expertFirstName(request('YOU ARE Mei Tanaka, a teacher.\nmore'))).toBe('Mei');
    expect(expertFirstName(request('no persona line'))).toBeNull();
  });

  it('replaces every {{expert}} in spoken text with that name', async () => {
    const model = new FakeLanguageModel([{ match: () => true, events, gapMs: 0 }]);
    const out = await collect(model, request('YOU ARE Mei Tanaka, a teacher.'));
    expect(out[0]).toMatchObject({ type: 'say', text: "Hi — I'm Mei. Mei here." });
  });

  it('leaves the placeholder alone when the request names nobody', async () => {
    const model = new FakeLanguageModel([{ match: () => true, events, gapMs: 0 }]);
    const out = await collect(model, request('generic instructions'));
    expect(out[0]).toMatchObject({ text: "Hi — I'm {{expert}}. {{expert}} here." });
  });
});
