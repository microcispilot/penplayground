import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileLessonMemo, MemoryLessonMemo } from '../src/lesson-memo.js';

const base = {
  canonicalKnowledgeId: 'en.how-transformers-work-in-llms',
  band: 'beginner' as const,
  packId: 'pack-1',
  packRevision: 'r1',
  plan: { title: 'T' },
};

describe('lesson memo (incremental, per persona)', () => {
  it('grows segment by segment and never overwrites what is already memoised', async () => {
    const memo = new MemoryLessonMemo();
    const e = await memo.put({
      ...base,
      expertId: 'ada',
      cuesBySegment: [[{ type: 'say', id: 's1' }]],
      costUsd: { plan: 0.002, segments: [0.004] },
    });
    // A later session that reached segment 3 fills 2 and 3; segment 0 stays as first taught.
    await memo.extend(e.id, [
      { index: 0, cues: [{ type: 'say', id: 'other' }], usd: 9 },
      { index: 2, cues: [{ type: 'say', id: 's3' }], usd: 0.005 },
    ]);
    const found = await memo.find(base.canonicalKnowledgeId, 'beginner', 'ada');
    expect(found?.cuesBySegment).toEqual([
      [{ type: 'say', id: 's1' }],
      [],
      [{ type: 'say', id: 's3' }],
    ]);
    expect(found?.costUsd).toEqual({ plan: 0.002, segments: [0.004, 0, 0.005] });
    // An empty slot can be filled by whoever teaches it next.
    await memo.extend(e.id, [{ index: 1, cues: [{ type: 'say', id: 's2' }], usd: 0.003 }]);
    expect((await memo.find(base.canonicalKnowledgeId, 'beginner'))?.cuesBySegment[1]).toEqual([
      { type: 'say', id: 's2' },
    ]);
  });

  it('finds by persona: another expert’s script is never served', async () => {
    const memo = new MemoryLessonMemo();
    await memo.put({
      ...base,
      expertId: 'ada',
      cuesBySegment: [[1]],
      costUsd: { plan: 0, segments: [0] },
    });
    await memo.put({
      ...base,
      expertId: 'juno',
      cuesBySegment: [[2]],
      costUsd: { plan: 0, segments: [0] },
    });
    expect((await memo.find(base.canonicalKnowledgeId, 'beginner', 'ada'))?.expertId).toBe('ada');
    expect((await memo.find(base.canonicalKnowledgeId, 'beginner', 'juno'))?.expertId).toBe('juno');
    expect(await memo.find(base.canonicalKnowledgeId, 'beginner', 'kai')).toBeNull();
    expect(await memo.find(base.canonicalKnowledgeId, 'advanced', 'ada')).toBeNull();
    // Without a persona the latest memo for the scope wins (the registry's lessonMemoId).
    expect((await memo.find(base.canonicalKnowledgeId, 'beginner'))?.expertId).toBe('juno');
  });

  it('persists to disk, survives a reload and upgrades memos written before costs existed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pen-memo-'));
    const legacy = [
      {
        id: 'old1',
        ...base,
        expertId: 'ada',
        cuesBySegment: [[1], [2]],
        timesReused: 3,
        createdAt: 1,
      },
    ];
    writeFileSync(join(dir, 'lesson-memo.json'), JSON.stringify(legacy));
    const memo = new FileLessonMemo(dir);
    const found = await memo.find(base.canonicalKnowledgeId, 'beginner', 'ada');
    expect(found?.costUsd).toEqual({ plan: 0, segments: [0, 0] });
    await memo.extend('old1', [{ index: 2, cues: [3], usd: 0.01 }]);
    await memo.touch('old1');
    const again = new FileLessonMemo(dir);
    const reloaded = await again.find(base.canonicalKnowledgeId, 'beginner', 'ada');
    expect(reloaded?.cuesBySegment).toEqual([[1], [2], [3]]);
    expect(reloaded?.costUsd.segments).toEqual([0, 0, 0.01]);
    expect(reloaded?.timesReused).toBe(4);
    expect(JSON.parse(readFileSync(join(dir, 'lesson-memo.json'), 'utf8'))).toHaveLength(1);
  });
});
