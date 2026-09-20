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

/**
 * The memo on disk is what production uses (`services/api/src/services.ts`),
 * and it is the cache that stops a lesson being written and spoken twice. So
 * the two ways it can quietly lose everything it holds both have a test.
 *
 * One: `save()` rewrote the whole file with no lock. Two rooms of one process
 * finishing a segment at the same moment issue two `writeFile`s at the same
 * path; each truncates and writes from its own offset, and the shorter one
 * finishing last leaves the longer one's tail behind it. Measured before the
 * fix at the OS level — 15 of 40 concurrent pairs left a file `JSON.parse`
 * refused.
 *
 * Two: `load()` treated *every* read failure as "there are no memos" — which
 * is right for a first run and catastrophic for a corrupt or unreadable file,
 * because the next `save()` then wrote `[]` over it. Every lesson the
 * deployment had ever taught, gone, with nothing said to anyone, and every
 * session after it paying again to write and speak what was already there.
 */
describe('the memo on disk', () => {
  const bulky = (i: number) =>
    entry({
      canonicalKnowledgeId: `en.topic-${i}`,
      // A real memo holds every spoken sentence of every segment.
      cuesBySegment: [Array.from({ length: 30 }, (_, n) => ({ say: `sentence ${n} `.repeat(20) }))],
    });

  it('never leaves half a document on disk', async () => {
    const { mkdtemp, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { FileLessonMemo } = await import('../src/lesson-memo.js');
    const dir = await mkdtemp(join(tmpdir(), 'pen-memo-'));
    const file = join(dir, 'lesson-memo.json');
    const memo = new FileLessonMemo(dir);
    // A deployment that has taught a few dozen lessons: ~390 KB of memo.
    for (let i = 0; i < 40; i++) await memo.put(bulky(i));
    let torn = 0;
    for (let round = 0; round < 20; round++) {
      const saving = memo.put(bulky(100 + round));
      // Anyone reading the file while a save is in flight — another process,
      // the backfill, or this one after a crash and a restart.
      for (let read = 0; read < 40; read++) {
        try {
          JSON.parse(await readFile(file, 'utf8'));
        } catch {
          torn += 1;
          break;
        }
      }
      await saving;
    }
    expect(torn).toBe(0);
    // And every lesson is still there afterwards.
    const reread = new FileLessonMemo(dir);
    expect(
      await reread.find('en.topic-0', 'beginner', 'ada-research-mentor', 'en-US'),
    ).toBeTruthy();
    expect(
      await reread.find('en.topic-119', 'beginner', 'ada-research-mentor', 'en-US'),
    ).toBeTruthy();
  });

  it('refuses to overwrite a file it could not read, and says so', async () => {
    const { mkdtemp, readFile, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { FileLessonMemo } = await import('../src/lesson-memo.js');
    const dir = await mkdtemp(join(tmpdir(), 'pen-memo-'));
    const file = join(dir, 'lesson-memo.json');
    const seed = new FileLessonMemo(dir);
    await seed.put(bulky(1));
    const good = await readFile(file, 'utf8');
    // Half a write: a crash mid-save, or the race above.
    await writeFile(file, good.slice(0, Math.floor(good.length / 2)));

    const errors: Array<{ scope: string; error: unknown }> = [];
    const memo = new FileLessonMemo(dir, {
      onError: (scope, error) => errors.push({ scope, error }),
    });
    // It reads as empty — there is nothing else it can honestly return …
    expect(await memo.find('en.topic-1', 'beginner', 'ada-research-mentor', 'en-US')).toBeNull();
    // … but it said so, rather than swallowing it.
    expect(errors.map((e) => e.scope)).toContain('lesson_memo.unreadable');
    // And the next write does not turn a recoverable file into an empty one.
    await memo.put(bulky(2));
    expect(await readFile(file, 'utf8')).toBe(good.slice(0, Math.floor(good.length / 2)));
  });

  it('starts empty on a first run without complaining', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { FileLessonMemo } = await import('../src/lesson-memo.js');
    const dir = await mkdtemp(join(tmpdir(), 'pen-memo-'));
    const errors: string[] = [];
    const memo = new FileLessonMemo(dir, { onError: (scope) => errors.push(scope) });
    expect(await memo.find('en.topic-1', 'beginner')).toBeNull();
    await memo.put(bulky(1));
    expect(await memo.find('en.topic-1', 'beginner', 'ada-research-mentor', 'en-US')).toBeTruthy();
    expect(errors).toEqual([]);
  });
});
