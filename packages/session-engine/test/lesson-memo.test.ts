import { describe, expect, it } from 'vitest';
import { MemoryLessonMemo } from '../src/lesson-memo.js';

/**
 * The memo's own rule, which is what makes remembering every lesson safe.
 *
 * Until today a lesson was only memoised when its knowledge pack had
 * *qualified*. That gated out the ordinary case — a learner types a topic
 * nobody prepared, the pack is acquired live and never qualifies — so the next
 * learner of that exact title regenerated the whole lesson and re-synthesised
 * every sentence. It was measured twice in production on the same topic.
 *
 * Every lesson is remembered now, and the safety the gate stood in for moved
 * here: a memo records the pack it was written from, and is only replayed for
 * a session teaching from that same pack and revision.
 */
const entry = (over: Partial<Parameters<MemoryLessonMemo['put']>[0]> = {}) => ({
  canonicalKnowledgeId: 'en.how-a-pendulum-clock-keeps-time',
  band: 'beginner' as const,
  language: 'en-US',
  packId: 'pack-1',
  packRevision: '1',
  expertId: 'ada-research-mentor',
  plan: { title: 'Clockwork' },
  cuesBySegment: [[{ say: 'one' }]],
  costUsd: { plan: 0.01, segments: [0.02] },
  ...over,
});

describe('a memo belongs to the knowledge it was written from', () => {
  it('replays for the same pack and revision', async () => {
    const memo = new MemoryLessonMemo();
    await memo.put(entry());
    const found = await memo.find(
      'en.how-a-pendulum-clock-keeps-time',
      'beginner',
      'ada-research-mentor',
      'en-US',
      {
        packId: 'pack-1',
        packRevision: '1',
      },
    );
    expect(found?.packId).toBe('pack-1');
  });

  it('is not replayed once that knowledge is revised', async () => {
    const memo = new MemoryLessonMemo();
    await memo.put(entry());
    const found = await memo.find(
      'en.how-a-pendulum-clock-keeps-time',
      'beginner',
      'ada-research-mentor',
      'en-US',
      {
        packId: 'pack-1',
        packRevision: '2',
      },
    );
    expect(found, 'a revised pack teaches a new lesson').toBeNull();
  });

  it('is not replayed for a different pack on the same topic', async () => {
    const memo = new MemoryLessonMemo();
    await memo.put(entry());
    const found = await memo.find(
      'en.how-a-pendulum-clock-keeps-time',
      'beginner',
      'ada-research-mentor',
      'en-US',
      {
        packId: 'pack-2',
        packRevision: '1',
      },
    );
    expect(found).toBeNull();
  });

  it('still answers a caller that does not name a pack, so older callers are unchanged', async () => {
    const memo = new MemoryLessonMemo();
    await memo.put(entry());
    expect(
      await memo.find(
        'en.how-a-pendulum-clock-keeps-time',
        'beginner',
        'ada-research-mentor',
        'en-US',
      ),
    ).not.toBeNull();
  });

  it('keeps the newest lesson when the same pack wrote more than one', async () => {
    const memo = new MemoryLessonMemo();
    await memo.put(entry({ plan: { title: 'older' } }));
    await new Promise((r) => setTimeout(r, 2));
    await memo.put(entry({ plan: { title: 'newer' } }));
    const found = await memo.find(
      'en.how-a-pendulum-clock-keeps-time',
      'beginner',
      'ada-research-mentor',
      'en-US',
      {
        packId: 'pack-1',
        packRevision: '1',
      },
    );
    expect(found).not.toBeNull();
    expect((found?.plan as { title: string } | undefined)?.title).toBe('newer');
  });
});
