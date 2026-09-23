import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AD_RULES,
  defaultFeaturesFor,
  GOOGLE_IMA_SAMPLE_TAG,
  nonPersonalisedTag,
} from '@pen/contracts';
import type { AdOutcome } from '@pen/session-engine';
import { afterEach, describe, expect, it } from 'vitest';
import { AdEconomics, type RevenueSink, resolveAdDemand } from '../src/ads.js';
import { loadConfig } from '../src/config.js';
import { RuntimeConfigStore } from '../src/runtime-config/index.js';
import { CostLedger } from '../src/services.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const base = {
  NODE_ENV: 'test',
  PEN_JWT_SECRET: 'x'.repeat(40),
  PEN_LLM_PROVIDER: 'fake',
  PEN_TTS_PROVIDER: 'silent',
};

/** Ad economics on a runtime-config store with nothing stored: the defaults. */
function economics(env: Record<string, string>, revenue?: RevenueSink): AdEconomics {
  const cfg = loadConfig(env);
  return new AdEconomics(cfg, store(cfg), revenue ?? null);
}

/** A store of its own per test, so a stale cache file cannot change an answer. */
function store(cfg: ReturnType<typeof loadConfig>): RuntimeConfigStore {
  const dir = mkdtempSync(join(tmpdir(), 'pen-ads-'));
  dirs.push(dir);
  return new RuntimeConfigStore({ cfg, path: join(dir, 'runtime-config.json') });
}

function outcome(event: AdOutcome['event'], sessionId = 's1'): AdOutcome {
  return { sessionId, adId: `ad-${sessionId}-1`, slot: 'boundary', event, atMs: 0, code: null };
}

describe('ad demand resolution', () => {
  it('uses the configured Ad Manager tag when set', () => {
    const cfg = loadConfig({
      ...base,
      PEN_AD_TAG_URL: 'https://pubads.g.doubleclick.net/gampad/ads?iu=/1/pen',
    });
    expect(resolveAdDemand(cfg)).toEqual({
      source: 'configured',
      tagUrl: 'https://pubads.g.doubleclick.net/gampad/ads?iu=/1/pen',
    });
  });

  it('falls back to the Google sample tag only with PEN_AD_TEST_TAGS=1', () => {
    expect(resolveAdDemand(loadConfig({ ...base, PEN_AD_TEST_TAGS: '1' }))).toEqual({
      source: 'google-sample',
      tagUrl: GOOGLE_IMA_SAMPLE_TAG,
    });
    const off = resolveAdDemand(loadConfig(base));
    expect(off.source).toBe('off');
    expect(off.tagUrl).toBeNull();
    if (off.source === 'off') expect(off.reason).toContain('PEN_AD_TAG_URL');
  });

  it('a configured tag wins over the test flag; test tags are refused in production', () => {
    const cfg = loadConfig({
      ...base,
      PEN_AD_TAG_URL: 'https://x.test/vast',
      PEN_AD_TEST_TAGS: '1',
    });
    expect(resolveAdDemand(cfg).source).toBe('configured');
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        PEN_JWT_SECRET: 'x'.repeat(40),
        FISH_AUDIO_API_KEY: 'k',
        PEN_AD_TEST_TAGS: '1',
      }),
    ).toThrow(/PEN_AD_TEST_TAGS/);
  });

  it('rejects a tag that is not a URL', () => {
    expect(() => loadConfig({ ...base, PEN_AD_TAG_URL: 'not-a-url' })).toThrow(/PEN_AD_TAG_URL/);
  });
});

describe('AdEconomics', () => {
  it('gives the free plan a video policy with the product rules, and paid plans none', () => {
    const ads = economics({ ...base, PEN_AD_TEST_TAGS: '1' });
    const policy = ads.policyFor(defaultFeaturesFor('free'), 's1', 3);
    expect(policy).toMatchObject({
      everySegments: 3,
      durationMs: AD_RULES.maxDurationMs,
      skippableAfterMs: AD_RULES.skipAfterMs,
      tagUrl: nonPersonalisedTag(GOOGLE_IMA_SAMPLE_TAG),
      // Default eCPM $8 → the per-completion line the room writes to the session ledger.
      revenuePerCompletionUsd: 0.008,
    });
    // Every request leaves here non-personalised, so there is never one that
    // would have needed a consent banner in front of the lesson (ADR-0018).
    expect(policy?.tagUrl).toContain('npa=1');
    expect(ads.policyFor(defaultFeaturesFor('standard'), 's1', 3)).toBeNull();
    expect(ads.policyFor(defaultFeaturesFor('professional'), 's1', 3)).toBeNull();
  });

  it('gives nobody a policy when no demand is configured (and says why in the log)', () => {
    const ads = economics(base);
    expect(ads.demand.source).toBe('off');
    expect(ads.policyFor(defaultFeaturesFor('free'), 's1', 3)).toBeNull();
  });

  it('records an estimated revenue line per completed ad as a negative cost under `ads`', () => {
    const costs = new CostLedger();
    const ads = economics({ ...base, PEN_AD_TEST_TAGS: '1', PEN_AD_ECPM_USD: '12' }, costs);
    const policy = ads.policyFor(defaultFeaturesFor('free'), 's1', 3);
    if (!policy?.onEvent) throw new Error('policy');
    policy.onEvent(outcome('ad_requested'));
    policy.onEvent(outcome('ad_started'));
    policy.onEvent(outcome('ad_completed'));
    policy.onEvent(outcome('ad_completed', 's2'));
    policy.onEvent(outcome('ad_skipped', 's2'));
    policy.onEvent({ ...outcome('ad_error', 's2'), code: '1009' });
    expect(ads.tally('s1')).toEqual({
      requested: 1,
      started: 1,
      completed: 1,
      skipped: 0,
      errors: 0,
      clicks: 0,
      revenueUsd: 0.012,
    });
    expect(ads.tally('s2')).toMatchObject({ completed: 1, skipped: 1, errors: 1 });
    expect(costs.snapshot().ads).toMatchObject({ calls: 2, usd: -0.024 });
    ads.forget('s1');
    expect(ads.tally('s1').completed).toBe(0);
  });
});

describe('the eCPM a session is priced at', () => {
  it('is the one its room was built with, even after the setting moves', () => {
    // Revenue is summed over many completions across many minutes. A rate
    // that moved half way through would make the total the sum of two
    // different prices (ADR-0025).
    // Not pinned in the environment: a pin would rightly beat the save, and
    // then this test would be checking the wrong tier.
    const cfg = loadConfig({ ...base, PEN_AD_TEST_TAGS: '1' });
    const settings = store(cfg);
    const costs = new CostLedger();
    const ads = new AdEconomics(cfg, settings, costs);

    const first = ads.policyFor(defaultFeaturesFor('free'), 'early', 3);
    expect(first?.revenuePerCompletionUsd).toBeCloseTo(0.008, 6);

    // Somebody saves a new rate while that session is still running.
    settings.apply(
      { revision: 1, settings: { PEN_AD_ECPM_USD: 20 }, updatedAt: 1, updatedBy: 'p' },
      'database',
    );
    const later = ads.policyFor(defaultFeaturesFor('free'), 'late', 3);
    expect(later?.revenuePerCompletionUsd).toBeCloseTo(0.02, 6);

    // Each session's completions are priced at its own rate, not today's.
    first?.onEvent?.(outcome('ad_completed', 'early'));
    later?.onEvent?.(outcome('ad_completed', 'late'));
    expect(ads.tally('early').revenueUsd).toBeCloseTo(0.008, 6);
    expect(ads.tally('late').revenueUsd).toBeCloseTo(0.02, 6);

    // And releasing a session takes its rate with it.
    ads.forget('early');
    expect(ads.tally('early').revenueUsd).toBe(0);
  });
});
