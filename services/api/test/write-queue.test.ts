import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionMeta } from '@pen/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileSessionMetaCache } from '../src/meta-cache.js';
import { WriteQueue } from '../src/write-queue.js';

/**
 * What a failed write must not do: end writing.
 *
 * Both file caches serialised with `this.writing = this.writing.then(work)`,
 * which is correct until the first rejection and then permanent: `then`
 * without a rejection handler passes the failure down, so the chain becomes a
 * rejected promise, every later `work` never runs, and every later caller
 * gets the *original* error back. One transient `ENOSPC` and the card cache
 * and the picture cache are off for the life of the process.
 *
 * It costs money rather than errors. Nothing re-reads a cache it just failed
 * to write, so nobody sees a failure; what happens instead is that every
 * session pays ~$0.016 again for a picture that was already bought.
 */
describe('WriteQueue', () => {
  it('runs writes in the order they were queued', async () => {
    const q = new WriteQueue();
    const order: number[] = [];
    const slow = (n: number, ms: number) =>
      q.run(async () => {
        await new Promise((r) => setTimeout(r, ms));
        order.push(n);
      });
    await Promise.all([slow(1, 20), slow(2, 5), slow(3, 0)]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('hands a failure to its own caller and to nobody else', async () => {
    const q = new WriteQueue();
    const boom = q.run(() => {
      throw new Error('ENOSPC');
    });
    await expect(boom).rejects.toThrow('ENOSPC');

    // The whole point: the next write still runs, and succeeds.
    await expect(q.run(() => 'written')).resolves.toBe('written');
  });

  it('keeps running after a failure however many times it fails', async () => {
    const q = new WriteQueue();
    for (let i = 0; i < 5; i++)
      await expect(q.run(() => Promise.reject(new Error(`no ${i}`)))).rejects.toThrow(`no ${i}`);
    await expect(q.run(() => 'still here')).resolves.toBe('still here');
  });

  it('a failure does not become the next caller’s failure even when queued behind it', async () => {
    const q = new WriteQueue();
    // Both queued before either has run, which is the case the old chain got
    // wrong: the second inherited the first's rejection instead of running.
    const first = q.run(() => Promise.reject(new Error('ENOSPC')));
    const second = q.run(() => 'written');
    await expect(first).rejects.toThrow('ENOSPC');
    await expect(second).resolves.toBe('written');
  });

  it('idle() settles whatever happened, so a caller can wait without catching', async () => {
    const q = new WriteQueue();
    void q.run(() => Promise.reject(new Error('ENOSPC'))).catch(() => undefined);
    await expect(q.idle()).resolves.toBeUndefined();
  });
});

/**
 * And the same thing through the cache's own interface, on a real directory
 * made unwritable — because the queue being right is only interesting if the
 * thing that had the bug is now right.
 */
describe('the card cache survives a write it could not do', () => {
  let dir: string;
  const meta: SessionMeta = {
    description: 'Tokens become vectors.',
    keywords: ['transformers'],
    category: 'computing-data',
    subject: 'a brass clock escapement',
    headline: 'HOW ATTENTION WORKS',
  };
  const entry = { meta, planDigest: 'd1', usd: 0.0002, model: 'fake' };
  const key = (scope: string) => ({ scope, planDigest: 'd1' });

  let cards: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pen-write-queue-'));
    cards = join(dir, 'cards');
  });
  afterEach(() => {
    chmodSync(cards, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes again once the directory is writable, rather than staying broken', async () => {
    const cache = new FileSessionMetaCache(cards, 10);
    await cache.put(key('pen:a:beginner'), entry);
    expect(cache.size()).toBe(1);

    // Read-only, on the directory the temp file is actually written into:
    // `writeFileSync` inside the write now throws EACCES.
    chmodSync(cards, 0o555);
    await expect(cache.put(key('pen:b:beginner'), entry)).rejects.toThrow();

    chmodSync(cards, 0o755);
    // Before the queue, this rejected with the *previous* error and wrote
    // nothing, for ever.
    await expect(cache.put(key('pen:c:beginner'), entry)).resolves.toBeUndefined();
    expect(cache.size()).toBeGreaterThanOrEqual(2);
  });
});
