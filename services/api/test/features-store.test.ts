import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FeatureFlagsSnapshot } from '@pen/db';
import { afterEach, describe, expect, it } from 'vitest';
import { FeatureStore } from '../src/features/index.js';

/**
 * The store's promises (ADR-0036): the compiled-in rules with nothing stored,
 * the stored document over them, a bad rule dropped on its own, the last
 * known good document kept through an outage — and an overlay that survives
 * every poll, because the test seam was once wiped by the first read.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function cachePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pen-features-store-'));
  dirs.push(dir);
  return join(dir, 'feature-flags.json');
}
class FakeSource {
  constructor(
    public snapshot: FeatureFlagsSnapshot = {
      revision: 0,
      rules: {},
      updatedAt: 0,
      updatedBy: null,
    },
    public failing = false,
  ) {}
  async read(): Promise<FeatureFlagsSnapshot> {
    if (this.failing) throw new Error('database is unreachable');
    return this.snapshot;
  }
}
const OPEN = { default: true, plans: {}, platforms: {}, cells: {} };
const who = { plan: 'free' as const, platform: 'web' as const };

describe('FeatureStore', () => {
  it('serves the compiled-in rules with nothing stored', () => {
    const store = new FeatureStore({ path: cachePath(), pollMs: 0 });
    expect(store.enabled('prepare_new_topics', who)).toBe(true);
    expect(store.enabled('prepare_new_topics', { ...who, anonymous: true })).toBe(false);
    expect(store.enabled('ask_questions', who)).toBe(false);
    expect(store.enabled('quick_start', who)).toBe(true);
  });

  it('keeps an overlay through every read from the database', async () => {
    const source = new FakeSource();
    const store = new FeatureStore({
      source,
      path: cachePath(),
      pollMs: 0,
      overlay: { prepare_new_topics: OPEN },
    });
    expect(store.enabled('prepare_new_topics', who)).toBe(true);
    await store.start();
    expect(store.enabled('prepare_new_topics', who)).toBe(true);
    source.snapshot = { revision: 3, rules: { ads: OPEN }, updatedAt: 1, updatedBy: 'p' };
    await store.refresh();
    expect(store.enabled('prepare_new_topics', who)).toBe(true);
    expect(store.storedRule('ads')).toEqual(OPEN);
  });

  it('never writes the overlay to disk: the next process, with no overlay, sees only the database’s document', async () => {
    const path = cachePath();
    const source = new FakeSource({
      revision: 4,
      rules: { ads: OPEN },
      updatedAt: 1,
      updatedBy: 'p',
    });
    const overlaid = new FeatureStore({
      source,
      path,
      pollMs: 0,
      overlay: { prepare_new_topics: { ...OPEN, anonymous: true } },
    });
    await overlaid.start();
    expect(overlaid.enabled('prepare_new_topics', { ...who, anonymous: true })).toBe(true);
    overlaid.stop();
    // The Playwright servers keep their data directory between runs: a cache
    // that carried the overlay would hand a previous run's pins to this one.
    const next = new FeatureStore({ path, pollMs: 0 });
    expect(next.storedRule('ads')).toEqual(OPEN);
    expect(next.storedRule('prepare_new_topics')).toBeNull();
    expect(next.enabled('prepare_new_topics', { ...who, anonymous: true })).toBe(false);
  });

  it('drops a rule that does not validate on its own and keeps the rest', async () => {
    const source = new FakeSource({
      revision: 1,
      rules: { ads: { default: 'yes' }, quick_start: { ...OPEN, default: false } },
      updatedAt: 1,
      updatedBy: 'p',
    });
    const store = new FeatureStore({ source, path: cachePath(), pollMs: 0 });
    await store.start();
    expect(store.storedRule('ads')).toBeNull();
    expect(store.enabled('quick_start', who)).toBe(false);
  });

  it('keeps the last known good document through an outage, and reads it back from disk', async () => {
    const path = cachePath();
    const source = new FakeSource({
      revision: 2,
      rules: { quick_start: { ...OPEN, default: false } },
      updatedAt: 1,
      updatedBy: 'p',
    });
    const store = new FeatureStore({ source, path, pollMs: 0 });
    await store.start();
    source.failing = true;
    expect(await store.refresh()).toBe(false);
    expect(store.stale).toBe(true);
    expect(store.enabled('quick_start', who)).toBe(false);
    const again = new FeatureStore({ source, path, pollMs: 0 });
    expect(again.revision).toBe(2);
    expect(again.enabled('quick_start', who)).toBe(false);
  });
});
