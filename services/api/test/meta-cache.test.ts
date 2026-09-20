import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Expert, LessonPlan, SessionMeta } from '@pen/contracts';
import { freshEstimateUsd } from '@pen/contracts';
import { FakeImageModel, FakeLanguageModel } from '@pen/llm';
import { planDigest, SessionMetaJobs, sessionMetaScope } from '@pen/session-engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { demoScripts } from '../src/demo-scripts.js';
import { FileSessionMetaCache, META_CACHE_FILE } from '../src/meta-cache.js';

/**
 * The per-lesson card-copy cache (ADR-0013): the second session on a topic
 * reuses the first one's description with zero model calls, and a lesson that
 * changed is written again. The picture has its own cache next door
 * (`thumbnail-cache.test.ts`).
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pen-meta-cache-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const expert: Expert = {
  id: 'ada',
  displayName: 'Ada Whitfield',
  role: 'Machine-learning teacher',
  tagline: 'Attention, one sentence at a time',
  biography: 'Teaches how language models read a sentence.',
  specialties: ['transformers'],
  interactionStyle: 'warm, concrete',
  aiDisclosure: 'I am an AI expert.',
  provenance: 'fictional-synthetic',
  portrait: null,
  voiceId: 'af_heart',
  voices: {},
  domain: 'computing-data',
  premium: false,
  requiredPlan: null,
  gender: 'woman',
};

/** The eviction case only needs one valid card. */
const card: SessionMeta = {
  description: 'A card.',
  keywords: ['a', 'b', 'c'],
  category: 'computing-data',
  subject: 'a brass clock escapement, gears meshing',
  headline: 'HOW ATTENTION WORKS',
};

const plan: LessonPlan = {
  title: 'How Transformers work in LLMs',
  promise: 'Read an attention diagram and explain every piece.',
  band: 'beginner',
  seconds: 840,
  segments: [
    {
      index: 0,
      title: 'Tokens become vectors',
      goal: 'See tokens as vectors',
      seconds: 280,
      hasCheck: false,
    },
    {
      index: 1,
      title: 'Attention',
      goal: 'Score a query against keys',
      seconds: 560,
      hasCheck: true,
    },
  ],
};

const input = (
  sessionId: string,
  over: Partial<Parameters<SessionMetaJobs['enqueue']>[0]> = {},
) => ({
  sessionId,
  expert,
  band: 'beginner' as const,
  topic: 'How Transformers work in LLMs',
  plan,
  language: 'en-US',
  billTo: 'free' as const,
  canonicalId: 'en.how-transformers-work-in-llms',
  cacheKey: 'pen:lesson:ada:beginner',
  ...over,
});

/**
 * Counts the calls the fake model actually served, so "zero model calls" is a
 * measurement. It answers under the id of the model the cards really run on,
 * so what a reuse saves is priced the way production prices it.
 */
function countingModel(id = 'gpt-5.6-luna') {
  const model = new FakeLanguageModel(demoScripts.scripts, demoScripts.completions);
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    model: {
      id,
      streamEvents: (r: Parameters<typeof model.streamEvents>[0]) => model.streamEvents(r),
      complete: async <T>(r: Parameters<typeof model.complete<T>>[0]) => {
        calls += 1;
        return model.complete(r);
      },
    },
  };
}

async function runJobs(opts: {
  cache: FileSessionMetaCache;
  model: ReturnType<typeof countingModel>['model'];
  results: Array<{ sessionId: string; reused: boolean; savedUsd: number; meta: SessionMeta }>;
}) {
  return new SessionMetaJobs({
    modelFor: () => opts.model,
    imageFor: () => new FakeImageModel(),
    quality: () => 'low',
    cache: opts.cache,
    onResult: (i, r) => {
      opts.results.push({
        sessionId: i.sessionId,
        reused: r.reused,
        savedUsd: r.savedUsd,
        meta: r.meta,
      });
    },
  });
}

describe('the card cache', () => {
  it('draws the first session and serves the second from the file with no model call', async () => {
    const cache = new FileSessionMetaCache(dir);
    const counting = countingModel();
    const results: Array<{
      sessionId: string;
      reused: boolean;
      savedUsd: number;
      meta: SessionMeta;
    }> = [];
    const jobs = await runJobs({ cache, model: counting.model, results });

    jobs.enqueue(input('s_first_0001'));
    await jobs.idle();
    expect(counting.calls).toBe(1);
    expect(results[0]?.reused).toBe(false);
    expect(existsSync(join(dir, META_CACHE_FILE))).toBe(true);

    jobs.enqueue(input('s_second_001'));
    await jobs.idle();
    expect(counting.calls).toBe(1);
    expect(results[1]?.reused).toBe(true);
    // The same card, and an honest account of what not drawing it saved.
    expect(results[1]?.meta.description).toBe(results[0]?.meta.description);
    expect(results[1]?.meta.keywords).toEqual(results[0]?.meta.keywords);
    // Nothing was billed, and what the call would have cost is recorded instead.
    expect(results[1]?.savedUsd).toBeCloseTo(freshEstimateUsd('sessionMeta', 'gpt-5.6-luna'), 10);
    expect(results[1]?.savedUsd).toBeGreaterThan(0);
    jobs.close();
  });

  it('misses for another band, persona or language, and after the lesson changed', async () => {
    const cache = new FileSessionMetaCache(dir);
    const counting = countingModel();
    const results: Array<{
      sessionId: string;
      reused: boolean;
      savedUsd: number;
      meta: SessionMeta;
    }> = [];
    const jobs = await runJobs({ cache, model: counting.model, results });
    jobs.enqueue(input('s_base_00001'));
    await jobs.idle();
    expect(counting.calls).toBe(1);

    const other = { ...expert, id: 'juno' } as Expert;
    const renamed: LessonPlan = {
      ...plan,
      segments: [
        { ...(plan.segments[0] as LessonPlan['segments'][number]), title: 'Tokens, then vectors' },
        plan.segments[1] as LessonPlan['segments'][number],
      ],
    };
    const variants: Array<[string, Partial<Parameters<SessionMetaJobs['enqueue']>[0]>]> = [
      ['band', { band: 'advanced' }],
      ['persona', { expert: other }],
      ['language', { language: 'fa-IR' }],
      ['plan', { plan: renamed }],
    ];
    for (const [n, over] of variants) {
      const before = counting.calls;
      jobs.enqueue(input(`s_${n.slice(0, 4)}_${before}0001`.slice(0, 12), over));
      await jobs.idle();
      expect(counting.calls, n).toBe(before + 1);
    }
    // A topic that never resolved has no scope to cache under: it always draws.
    const before = counting.calls;
    const { canonicalId: _omitted, ...unresolved } = input('s_unresolved1');
    jobs.enqueue(unresolved);
    await jobs.idle();
    jobs.enqueue({ ...unresolved, sessionId: 's_unresolved2' });
    await jobs.idle();
    expect(counting.calls).toBe(before + 2);
    expect(results.every((r) => r.reused === false)).toBe(true);
    jobs.close();
  });

  it('keeps one entry per scope and evicts the oldest when it is full', async () => {
    const cache = new FileSessionMetaCache(dir, 2);
    const key = (scope: string) => ({ scope, planDigest: 'd1' });
    const value = { meta: card, planDigest: 'd1', usd: 0.001, model: 'fake' };
    await cache.put(key('a'), value);
    await cache.put(key('b'), value);
    await cache.put(key('c'), value);
    expect(cache.size()).toBe(2);
    expect(await cache.get(key('a'))).toBeNull();
    expect(await cache.get(key('c'))).not.toBeNull();
    // A new plan for the same scope replaces the card rather than adding one.
    await cache.put({ scope: 'c', planDigest: 'd2' }, { ...value, planDigest: 'd2' });
    expect(cache.size()).toBe(2);
    expect(await cache.get(key('c'))).toBeNull();
    expect(await cache.get({ scope: 'c', planDigest: 'd2' })).not.toBeNull();
    // What is on disk is what a fresh process reads back.
    expect(
      Object.keys(JSON.parse(readFileSync(join(dir, META_CACHE_FILE), 'utf8')).entries),
    ).toEqual(['b', 'c']);
    expect(new FileSessionMetaCache(dir, 2).size()).toBe(2);
  });

  it('is a cold cache, never a failure, when the file is corrupt', async () => {
    const cache = new FileSessionMetaCache(dir);
    await cache.put(
      { scope: 'x', planDigest: 'd' },
      { meta: card, planDigest: 'd', usd: 0, model: 'fake' },
    );
    rmSync(join(dir, META_CACHE_FILE));
    expect(new FileSessionMetaCache(dir).size()).toBe(0);
  });

  it('keys a card by the lesson memo scope and the plan it describes', () => {
    expect(
      sessionMetaScope({
        canonicalId: 'en.x',
        band: 'beginner',
        expertId: 'ada',
        language: 'en-US',
      }),
    ).toBe('en.x|beginner|ada|en-US');
    expect(planDigest(plan)).toBe(planDigest({ ...plan }));
    expect(planDigest(plan)).not.toBe(planDigest({ ...plan, title: 'Another lesson' }));
  });
});
