import { createOnten } from '@pen/onten';
import { describe, expect, it } from 'vitest';
import { CorpusBuilder } from '../src/builder.js';
import { stageIndex } from '../src/progress.js';
import { NoSearch } from '../src/search.js';
import type { SearchProvider } from '../src/types.js';
import {
  collectProgress,
  fakeCompilation,
  fakeFetch,
  fakeModel,
  htmlDoc,
  markdownDoc,
  POLICY,
  recordingObserver,
  resolutionFor,
  seedFor,
  TEST_BUDGET,
} from './helpers.js';

const DOCS = 'https://docs.example.org/guide';

function guideSeed(count: number, delays: number[] = [], transform: 'none' | 'docc' = 'none') {
  const urls = Array.from({ length: count }, (_, i) => ({ url: `${DOCS}/chapter-${i + 1}.md`, title: `Chapter ${i + 1}`, transform }));
  const routes: Record<string, { body: string; delayMs?: number }> = {};
  urls.forEach((u, i) => {
    routes[u.url] = { body: markdownDoc(u.title), ...(delays[i] ? { delayMs: delays[i] } : {}) };
  });
  return { seed: seedFor('guide', /example guide/, 'the example guide', urls), routes, urls: urls.map((u) => u.url) };
}

describe('CorpusBuilder', () => {
  it('(a) emits documents to the compilation in arrival order, one at a time', async () => {
    const hosts = ['https://a.example.org/a.md', 'https://b.example.org/b.md', 'https://c.example.org/c.md'];
    const routes = {
      [hosts[0] ?? '']: { body: markdownDoc('A'), delayMs: 90 },
      [hosts[1] ?? '']: { body: markdownDoc('B'), delayMs: 10 },
      [hosts[2] ?? '']: { body: markdownDoc('C'), delayMs: 45 },
    };
    const seed = seedFor('multi', /example guide/, 'three hosts', hosts.map((url, i) => ({ url, title: `Doc ${i}` })));
    const fake = fakeCompilation({ interactiveAfter: 3 });
    const builder = new CorpusBuilder({ compiler: { startProgressiveCompilation: () => fake.compilation }, model: fakeModel(), policy: POLICY, search: new NoSearch(), fetchImpl: fakeFetch(routes), seeds: [seed], budget: TEST_BUDGET });
    const prepared = await builder.prepare({ resolution: resolutionFor('Example guide'), onProgress: () => undefined, signal: new AbortController().signal });
    await prepared.background;
    expect(fake.sources.map((s) => s.url)).toEqual([hosts[1], hosts[2], hosts[0]]);
    expect(fake.sources.every((s) => s.mediaType === 'text/markdown' && s.text.includes('```swift'))).toBe(true);
  });

  it('(b) resolves on the interactive promise before every source is fetched, then finishes in the background with an evaluation set', async () => {
    const { seed, routes, urls } = guideSeed(6, [0, 0, 120, 120, 150, 150]);
    const fake = fakeCompilation({ interactiveAfter: 2 });
    const observer = recordingObserver();
    const builder = new CorpusBuilder({ compiler: { startProgressiveCompilation: () => fake.compilation }, model: fakeModel(), policy: POLICY, search: new NoSearch(), fetchImpl: fakeFetch(routes), seeds: [seed], budget: TEST_BUDGET, observer });
    const prepared = await builder.prepare({ resolution: resolutionFor('Example guide'), onProgress: () => undefined, signal: new AbortController().signal });
    expect(prepared.provisional).toBe(true);
    expect(prepared.packId).toBe('pack_test');
    expect(fake.sources.length).toBeGreaterThanOrEqual(2);
    expect(fake.sources.length).toBeLessThan(urls.length);
    expect(fake.finished()).toBe(false);
    const reference = await prepared.background;
    expect(reference?.packId).toBe('pack_test');
    expect(fake.sources.map((s) => s.url).sort()).toEqual([...urls].sort());
    expect(fake.evaluation()?.development).toHaveLength(6);
    expect(fake.evaluation()?.negative).toHaveLength(4);
    expect((await prepared.outline).curriculum).toContain('Optionals');
    expect(observer.errors).toEqual([]);
    expect(observer.events.some((e) => e.name === 'knowledge.qualified')).toBe(true);
  });

  it('(c) never ingests developer.apple.com: it is excerpted (≤ 300 chars) into references, from the search snippet when there is one', async () => {
    const { seed, routes } = guideSeed(2);
    const apple = 'https://developer.apple.com/documentation/swift/optional';
    const appleFromSearch = 'https://developer.apple.com/documentation/swift/array';
    const allRoutes = { ...routes, [apple]: htmlDoc('Optional', 12) };
    const search: SearchProvider = {
      name: 'fake',
      search: async () => [{ url: appleFromSearch, title: 'Array | Apple Developer Documentation', snippet: 'An ordered, random-access collection. '.repeat(20), score: 0.9 }],
    };
    const fake = fakeCompilation({ interactiveAfter: 2 });
    const log: Array<{ url: string; at: number }> = [];
    const builder = new CorpusBuilder({ compiler: { startProgressiveCompilation: () => fake.compilation }, model: fakeModel({ candidateUrls: [apple] }), policy: POLICY, search, fetchImpl: fakeFetch(allRoutes, log), seeds: [seed], budget: TEST_BUDGET });
    const prepared = await builder.prepare({ resolution: resolutionFor('Example guide'), onProgress: () => undefined, signal: new AbortController().signal });
    await prepared.background;
    expect(fake.sources.some((s) => s.url.includes('developer.apple.com'))).toBe(false);
    const refs = prepared.references;
    expect(refs.map((r) => r.url).sort()).toEqual([appleFromSearch, apple].sort());
    for (const r of refs) {
      expect(r.excerpt.length).toBeLessThanOrEqual(300);
      expect(r.excerpt.length).toBeGreaterThan(50);
      expect(r.license).toBe('proprietary');
    }
    expect(refs.find((r) => r.url === apple)?.title).toBe('Optional');
    // The search-hit reference used the snippet and was never fetched.
    expect(log.some((l) => l.url === appleFromSearch)).toBe(false);
    expect(log.filter((l) => l.url === apple)).toHaveLength(1);
  });

  it('(d) honours robots.txt disallow rules', async () => {
    const host = 'https://blocked.example.org';
    const routes = {
      [`${host}/robots.txt`]: { body: 'User-agent: *\nDisallow: /private/\n', type: 'text/plain' },
      [`${host}/private/secret.md`]: markdownDoc('Secret'),
      [`${host}/public/open.md`]: markdownDoc('Open'),
      [`${host}/public/other.md`]: markdownDoc('Other'),
    };
    const seed = seedFor('blocked', /example guide/, 'the blocked site', [
      { url: `${host}/private/secret.md`, title: 'Secret' },
      { url: `${host}/public/open.md`, title: 'Open' },
      { url: `${host}/public/other.md`, title: 'Other' },
    ]);
    const fake = fakeCompilation({ interactiveAfter: 1 });
    const observer = recordingObserver();
    const log: Array<{ url: string; at: number }> = [];
    const builder = new CorpusBuilder({ compiler: { startProgressiveCompilation: () => fake.compilation }, model: fakeModel(), policy: POLICY, search: new NoSearch(), fetchImpl: fakeFetch(routes, log), seeds: [seed], budget: TEST_BUDGET, observer });
    const prepared = await builder.prepare({ resolution: resolutionFor('Example guide'), onProgress: () => undefined, signal: new AbortController().signal });
    await prepared.background;
    expect(log.filter((l) => l.url === `${host}/robots.txt`)).toHaveLength(1);
    expect(log.some((l) => l.url.includes('/private/'))).toBe(false);
    expect(fake.sources.map((s) => s.title).sort()).toEqual(['Open', 'Other']);
    expect(observer.events.find((e) => e.name === 'knowledge.robots_blocked')?.data.url).toBe(`${host}/private/secret.md`);
  });

  it('(f) reports progress with monotonic fraction and stage, honest status lines, and ends qualified at 1', async () => {
    const { seed, routes } = guideSeed(5, [0, 30, 30, 60, 60]);
    const fake = fakeCompilation({ interactiveAfter: 3 });
    const { list, onProgress } = collectProgress();
    const builder = new CorpusBuilder({ compiler: { startProgressiveCompilation: () => fake.compilation }, model: fakeModel(), policy: POLICY, search: new NoSearch(), fetchImpl: fakeFetch(routes), seeds: [seed], budget: TEST_BUDGET });
    const prepared = await builder.prepare({ resolution: resolutionFor('Example guide'), onProgress, signal: new AbortController().signal });
    const atReady = list.length;
    await prepared.background;
    expect(list.length).toBeGreaterThan(atReady);
    expect(list[0]?.stage).toBe('resolving');
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      if (!prev || !cur) throw new Error('unreachable');
      expect(cur.fraction).toBeGreaterThanOrEqual(prev.fraction);
      expect(stageIndex(cur.stage)).toBeGreaterThanOrEqual(stageIndex(prev.stage));
      expect(cur.sourcesFetched).toBeGreaterThanOrEqual(prev.sourcesFetched);
    }
    for (const p of list) {
      expect(p.status.length).toBeGreaterThan(0);
      expect(p.status.length).toBeLessThanOrEqual(120);
    }
    expect(list.some((p) => p.stage === 'fetching' && p.status.startsWith('Reading the example guide'))).toBe(true);
    expect(list.some((p) => p.stage === 'ready')).toBe(true);
    const last = list.at(-1);
    expect(last?.stage).toBe('qualified');
    expect(last?.fraction).toBe(1);
    expect(last?.sourcesFetched).toBe(5);
  });

  it('cancels everything through the signal: prepare rejects with AbortError, background resolves null, progress ends failed', async () => {
    const { seed, routes } = guideSeed(4, [300, 300, 300, 300]);
    const fake = fakeCompilation({ interactiveAfter: 2 });
    const { list, onProgress } = collectProgress();
    const controller = new AbortController();
    const builder = new CorpusBuilder({ compiler: { startProgressiveCompilation: () => fake.compilation }, model: fakeModel(), policy: POLICY, search: new NoSearch(), fetchImpl: fakeFetch(routes), seeds: [seed], budget: TEST_BUDGET });
    const pending = builder.prepare({ resolution: resolutionFor('Example guide'), onProgress, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.sources).toHaveLength(0);
    expect(list.at(-1)?.stage).toBe('failed');
    expect(list.at(-1)?.status).toMatch(/cancelled/i);
  });

  it('fails honestly when nothing readable was found and reports the error through the observer', async () => {
    const seed = seedFor('empty', /example guide/, 'an empty site', [{ url: 'https://empty.example.org/a.md', title: 'A' }]);
    const routes = { 'https://empty.example.org/a.md': { body: 'too short', type: 'text/markdown' } };
    const fake = fakeCompilation({ interactiveAfter: 1 });
    const observer = recordingObserver();
    const { list, onProgress } = collectProgress();
    const builder = new CorpusBuilder({ compiler: { startProgressiveCompilation: () => fake.compilation }, model: fakeModel(), policy: POLICY, search: new NoSearch(), fetchImpl: fakeFetch(routes), seeds: [seed], budget: TEST_BUDGET, observer });
    await expect(builder.prepare({ resolution: resolutionFor('Example guide'), onProgress, signal: new AbortController().signal })).rejects.toThrow(/no usable source/);
    expect(list.at(-1)?.stage).toBe('failed');
    expect(observer.errors.some((e) => e.area === 'knowledge.prepare')).toBe(true);
    expect(observer.events.some((e) => e.name === 'knowledge.page_skipped' && e.data.reason === 'empty')).toBe(true);
  });

  it('falls back to a heuristic outline and evaluation when the model fails, and still qualifies', async () => {
    const { seed, routes } = guideSeed(3);
    const fake = fakeCompilation({ interactiveAfter: 2 });
    const observer = recordingObserver();
    const builder = new CorpusBuilder({ compiler: { startProgressiveCompilation: () => fake.compilation }, model: fakeModel({ failOutline: true, failEvalset: true }), policy: POLICY, search: new NoSearch(), fetchImpl: fakeFetch(routes), seeds: [seed], budget: TEST_BUDGET, observer });
    const prepared = await builder.prepare({ resolution: resolutionFor('Example guide'), onProgress: () => undefined, signal: new AbortController().signal });
    expect(await prepared.background).not.toBeNull();
    expect((await prepared.outline).queries.length).toBeGreaterThanOrEqual(8);
    expect(fake.evaluation()?.development).toHaveLength(6);
    expect(observer.errors.map((e) => e.area).sort()).toEqual(['knowledge.evalset', 'knowledge.outline']);
  });

  it('converts HTML search hits to markdown, skips non-text and rejects private hosts', async () => {
    const { seed, routes } = guideSeed(2);
    const html = 'https://blog.example.net/post';
    const pdf = 'https://blog.example.net/paper.pdf';
    const binary = 'https://blog.example.net/image';
    const search: SearchProvider = {
      name: 'fake',
      search: async () => [
        { url: html, title: 'Post', snippet: '', score: null },
        { url: pdf, title: 'Paper', snippet: '', score: null },
        { url: binary, title: 'Image', snippet: '', score: null },
        { url: 'http://127.0.0.1:8080/admin', title: 'Local', snippet: '', score: null },
        { url: 'https://localhost/secret', title: 'Local', snippet: '', score: null },
      ],
    };
    const allRoutes = { ...routes, [html]: htmlDoc('Post'), [binary]: { body: 'xxx', type: 'image/png' } };
    const fake = fakeCompilation({ interactiveAfter: 2 });
    const log: Array<{ url: string; at: number }> = [];
    const observer = recordingObserver();
    const builder = new CorpusBuilder({ compiler: { startProgressiveCompilation: () => fake.compilation }, model: fakeModel(), policy: POLICY, search, fetchImpl: fakeFetch(allRoutes, log), seeds: [seed], budget: TEST_BUDGET, observer });
    const prepared = await builder.prepare({ resolution: resolutionFor('Example guide'), onProgress: () => undefined, signal: new AbortController().signal });
    await prepared.background;
    const post = fake.sources.find((s) => s.url === html);
    expect(post?.title).toBe('Post');
    expect(post?.text).toContain('# Post');
    expect(post?.text).toContain('```python\nprint("hi")\n```');
    expect(post?.text).not.toContain('Home');
    expect(post?.rights.redistribution).toBe('derived_only');
    expect(post?.rights.licenseText).toMatch(/review before publication/);
    expect(log.some((l) => l.url.includes('127.0.0.1') || l.url.includes('localhost'))).toBe(false);
    expect(log.some((l) => l.url === pdf)).toBe(false);
    expect(observer.events.some((e) => e.name === 'knowledge.page_skipped' && e.data.reason === 'type')).toBe(true);
  });

  it('works end to end against the real Onten MockCompiler: provisional pack, then a qualified pack with evaluation', async () => {
    const onten = createOnten();
    const { seed, routes } = guideSeed(4, [], 'docc');
    const observer = recordingObserver();
    const builder = new CorpusBuilder({ compiler: onten.compiler, model: fakeModel(), policy: onten.policy, search: new NoSearch(), fetchImpl: fakeFetch(routes), seeds: [seed], budget: TEST_BUDGET, observer });
    const resolution = await onten.registry.resolveTopic({ text: 'I want to learn the example guide', language: 'en', locale: 'en-US', band: 'beginner' });
    expect(resolution.match).toBe('miss');
    const prepared = await builder.prepare({ resolution, onProgress: () => undefined, signal: new AbortController().signal });
    const provisional = await onten.registry.getPack(prepared.packId);
    expect(provisional?.units.length).toBeGreaterThanOrEqual(6);
    expect(provisional?.qualified).toBe(false);
    const reference = await prepared.background;
    expect(reference?.packId).toBe(prepared.packId);
    const pack = await onten.registry.getPack(prepared.packId);
    expect(pack?.qualified).toBe(true);
    expect(pack?.sources).toHaveLength(4);
    expect(pack?.evaluation.development).toHaveLength(6);
    expect(pack?.evaluation.negative).toHaveLength(4);
    expect(pack?.sources.every((s) => s.rights.ingestionAllowed)).toBe(true);
    expect(observer.errors).toEqual([]);
  });
});
