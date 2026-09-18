import { describe, expect, it } from 'vitest';
import { Fetcher, FetchQueue, HostThrottle } from '../src/fetcher.js';
import { RobotsGate } from '../src/robots.js';
import { SILENT_KNOWLEDGE_OBSERVER } from '../src/types.js';
import { fakeFetch, recordingObserver } from './helpers.js';

function fetcherWith(
  fetchImpl: typeof fetch,
  opts: { gapMs?: number; maxPages?: number; maxPageBytes?: number; signal?: AbortSignal } = {},
) {
  const signal = opts.signal ?? new AbortController().signal;
  const observer = recordingObserver();
  const throttle = new HostThrottle(opts.gapMs ?? 0);
  const robots = new RobotsGate({
    fetchImpl,
    userAgent: 'PenPlaygroundBot/0.1',
    productToken: 'PenPlaygroundBot',
    timeoutMs: 500,
    observer: SILENT_KNOWLEDGE_OBSERVER,
  });
  const fetcher = new Fetcher({
    fetchImpl,
    userAgent: 'PenPlaygroundBot/0.1',
    robots,
    throttle,
    budget: {
      maxPages: opts.maxPages ?? 10,
      timeoutMs: 500,
      maxPageBytes: opts.maxPageBytes ?? 1_000_000,
    },
    observer,
    signal,
  });
  return { fetcher, throttle, observer, signal };
}

describe('HostThrottle', () => {
  it('spaces reservations per host and leaves other hosts untouched', () => {
    let t = 1000;
    const throttle = new HostThrottle(500, () => t);
    expect(throttle.reserve('a')).toBe(0);
    expect(throttle.reserve('a')).toBe(500);
    expect(throttle.reserve('b')).toBe(0);
    expect(throttle.readyIn('a')).toBe(1000);
    t = 2100;
    expect(throttle.readyIn('a')).toBe(0);
    expect(throttle.reserve('a')).toBe(0);
  });
});

describe('Fetcher', () => {
  it('keeps ≥ gap ms between requests to the same host while other hosts proceed', async () => {
    const log: Array<{ url: string; at: number }> = [];
    const routes: Record<string, string> = {};
    for (let i = 0; i < 3; i++) routes[`https://same.example.org/${i}.md`] = `# Doc ${i}`;
    routes['https://other.example.org/x.md'] = '# Other';
    const { fetcher, throttle, signal } = fetcherWith(fakeFetch(routes, log), { gapMs: 40 });
    const queue = new FetchQueue<{ url: string; priority: number }>({
      concurrency: 4,
      throttle,
      signal,
      observer: SILENT_KNOWLEDGE_OBSERVER,
      run: async (job) => {
        await fetcher.get(job.url);
      },
    });
    for (const url of Object.keys(routes)) queue.push({ url, priority: 0 });
    queue.close();
    await queue.done;
    const same = log
      .filter((l) => l.url.startsWith('https://same.example.org/') && !l.url.endsWith('robots.txt'))
      .sort((a, b) => a.at - b.at);
    expect(same).toHaveLength(3);
    for (let i = 1; i < same.length; i++)
      expect((same[i]?.at ?? 0) - (same[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(35);
    // The other host is not serialised behind this one's gap: it goes before
    // the second request to `same` does. Asserting an absolute "within 30 ms"
    // instead measured the machine rather than the throttle — under a loaded
    // box (a full `pnpm test` runs every package at once) the scheduler alone
    // spends longer than that, and the suite went red for no defect.
    const other = log.find((l) => l.url.startsWith('https://other'));
    expect(other).toBeDefined();
    expect(other?.at ?? Number.POSITIVE_INFINITY).toBeLessThan(
      same[1]?.at ?? Number.POSITIVE_INFINITY,
    );
  });

  it('enforces the page budget, skips non-text types and bad statuses, truncates big bodies', async () => {
    const routes = {
      'https://x.example.org/a.md': '# A',
      'https://x.example.org/b.md': { body: 'Y'.repeat(5000), type: 'text/markdown' },
      'https://x.example.org/c.png': { body: 'png', type: 'image/png' },
      'https://x.example.org/d.md': { body: 'gone', status: 410 },
    };
    const { fetcher } = fetcherWith(fakeFetch(routes), { maxPages: 3, maxPageBytes: 1000 });
    const a = await fetcher.get('https://x.example.org/a.md');
    expect(a).toMatchObject({
      ok: true,
      page: { status: 200, contentType: 'text/markdown', body: '# A', truncated: false },
    });
    const b = await fetcher.get('https://x.example.org/b.md');
    expect(b.ok && b.page.truncated).toBe(true);
    expect(b.ok && b.page.body.length).toBe(1000);
    expect(await fetcher.get('https://x.example.org/c.png')).toEqual({ ok: false, reason: 'type' });
    expect(await fetcher.get('https://x.example.org/d.md')).toEqual({
      ok: false,
      reason: 'budget',
    });
    expect(fetcher.pagesFetched).toBe(3);
  });

  it('reports 4xx/5xx as status skips and includes that do not count toward the budget', async () => {
    const routes = {
      'https://x.example.org/d.md': { body: 'gone', status: 410 },
      'https://x.example.org/inc.rs': 'fn main() {}',
    };
    const { fetcher } = fetcherWith(fakeFetch(routes), { maxPages: 1 });
    expect(
      await fetcher.get('https://x.example.org/inc.rs', { countsTowardBudget: false }),
    ).toMatchObject({ ok: true });
    expect(await fetcher.get('https://x.example.org/d.md')).toEqual({
      ok: false,
      reason: 'status',
      status: 410,
    });
    expect(fetcher.pagesFetched).toBe(1);
  });

  it('returns aborted outcomes instead of throwing once the signal fires', async () => {
    const controller = new AbortController();
    const { fetcher } = fetcherWith(
      fakeFetch({ 'https://x.example.org/slow.md': { body: '# slow', delayMs: 500 } }),
      { signal: controller.signal },
    );
    const pending = fetcher.get('https://x.example.org/slow.md');
    setTimeout(() => controller.abort(), 20);
    expect(await pending).toEqual({ ok: false, reason: 'aborted' });
    expect(await fetcher.get('https://x.example.org/slow.md')).toEqual({
      ok: false,
      reason: 'aborted',
    });
  });

  it('times out slow servers and records the event', async () => {
    const { fetcher, observer } = fetcherWith(
      fakeFetch({ 'https://x.example.org/slow.md': { body: '# slow', delayMs: 2_000 } }),
    );
    expect(await fetcher.get('https://x.example.org/slow.md')).toEqual({
      ok: false,
      reason: 'timeout',
    });
    expect(observer.events.some((e) => e.name === 'knowledge.fetch_timeout')).toBe(true);
  });
});

describe('FetchQueue', () => {
  it('runs jobs by priority with bounded concurrency and resolves done after close', async () => {
    const started: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const queue = new FetchQueue<{ url: string; priority: number }>({
      concurrency: 2,
      throttle: new HostThrottle(0),
      signal: new AbortController().signal,
      observer: SILENT_KNOWLEDGE_OBSERVER,
      run: async (job) => {
        started.push(job.url);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight -= 1;
      },
    });
    queue.push({ url: 'https://h.example/c', priority: 3 });
    queue.push({ url: 'https://h.example/a', priority: 1 });
    queue.push({ url: 'https://h.example/b', priority: 2 });
    queue.push({ url: 'https://h.example/d', priority: 4 });
    queue.close();
    await queue.done;
    expect(started).toEqual([
      'https://h.example/a',
      'https://h.example/b',
      'https://h.example/c',
      'https://h.example/d',
    ]);
    expect(peak).toBe(2);
  });

  it('reports a job failure through the observer and keeps draining', async () => {
    const observer = recordingObserver();
    const ran: string[] = [];
    const queue = new FetchQueue<{ url: string; priority: number }>({
      concurrency: 1,
      throttle: new HostThrottle(0),
      signal: new AbortController().signal,
      observer,
      run: async (job) => {
        ran.push(job.url);
        if (job.url.endsWith('bad')) throw new Error('boom');
      },
    });
    queue.push({ url: 'https://h.example/bad', priority: 0 });
    queue.push({ url: 'https://h.example/good', priority: 1 });
    queue.close();
    await queue.done;
    expect(ran).toHaveLength(2);
    expect(observer.errors[0]?.area).toBe('knowledge.fetch_job');
  });
});
