import { describe, expect, it } from 'vitest';
import {
  AD_RULES,
  AdEventName,
  ClientMessage,
  GOOGLE_IMA_SAMPLE_TAG,
  limitedAdsForZone,
  nonPersonalisedTag,
  ServerMessage,
} from '../src/index.js';

const ad = {
  kind: 'ad',
  adId: 'ad-s-1',
  afterSeq: 12,
  skippableAfterMs: AD_RULES.skipAfterMs,
  durationMs: AD_RULES.maxDurationMs,
  format: 'video',
  tagUrl: GOOGLE_IMA_SAMPLE_TAG,
  slot: 'boundary',
};

describe('ServerAd (video)', () => {
  it('carries a VAST tag, the slot and the product skip/ceiling rules', () => {
    const parsed = ServerMessage.parse(ad);
    expect(parsed).toEqual(ad);
    expect(AD_RULES.skipAfterMs).toBe(5_000);
    expect(AD_RULES.maxDurationMs).toBeGreaterThan(AD_RULES.skipAfterMs);
    // Every deadline has to land inside the conductor's ceiling, or the ceiling
    // is what the learner experiences: a paused lesson and a dead overlay.
    for (const ms of [
      AD_RULES.sdkLoadTimeoutMs,
      AD_RULES.requestTimeoutMs,
      AD_RULES.progressTimeoutMs,
    ])
      expect(ms).toBeLessThan(AD_RULES.maxDurationMs);
    // A started creative gets less rope than an unanswered request: by then the
    // learner is already looking at an ad slot.
    expect(AD_RULES.progressTimeoutMs).toBeLessThan(AD_RULES.requestTimeoutMs);
  });

  it('rejects a tag that is not a URL, an unknown format and an unknown slot', () => {
    expect(ServerMessage.safeParse({ ...ad, tagUrl: 'not a url' }).success).toBe(false);
    expect(ServerMessage.safeParse({ ...ad, format: 'card' }).success).toBe(false);
    expect(ServerMessage.safeParse({ ...ad, slot: 'midroll' }).success).toBe(false);
  });

  it('allows the preparation slot with afterSeq -1 and nothing lower', () => {
    expect(ServerMessage.safeParse({ ...ad, afterSeq: -1, slot: 'preparation' }).success).toBe(
      true,
    );
    expect(ServerMessage.safeParse({ ...ad, afterSeq: -2 }).success).toBe(false);
  });

  it('the sample tag is a Google Ad Manager VAST tag (test network, skippable pre-roll)', () => {
    const url = new URL(GOOGLE_IMA_SAMPLE_TAG);
    expect(url.host).toBe('pubads.g.doubleclick.net');
    expect(url.searchParams.get('output')).toBe('vast');
    expect(url.searchParams.get('iu')).toContain('single_preroll_skippable');
  });
});

describe('ClientAdEvent', () => {
  it('accepts every lifecycle name with an optional code', () => {
    for (const event of AdEventName.options) {
      const r = ClientMessage.safeParse({ kind: 'ad_event', adId: 'ad-s-1', event, atMs: 0 });
      expect(r.success, event).toBe(true);
    }
    expect(
      ClientMessage.safeParse({
        kind: 'ad_event',
        adId: 'ad-s-1',
        event: 'ad_error',
        atMs: 120,
        code: '1009',
      }).success,
    ).toBe(true);
  });

  it('rejects unknown events, negative offsets and empty ids', () => {
    expect(
      ClientMessage.safeParse({ kind: 'ad_event', adId: 'ad-s-1', event: 'ad_paused', atMs: 0 })
        .success,
    ).toBe(false);
    expect(
      ClientMessage.safeParse({ kind: 'ad_event', adId: 'ad-s-1', event: 'ad_started', atMs: -1 })
        .success,
    ).toBe(false);
    expect(
      ClientMessage.safeParse({ kind: 'ad_event', adId: '', event: 'ad_started', atMs: 0 }).success,
    ).toBe(false);
  });
});

describe('non-personalised ad tags', () => {
  it('adds the privacy parameters without disturbing the seller’s own tag', () => {
    const tag = nonPersonalisedTag(GOOGLE_IMA_SAMPLE_TAG);
    // Ad Manager's inventory unit is a path, and it must survive verbatim:
    // re-serialising the query encodes its slashes and the ad server then
    // answers with nothing at all.
    expect(tag).toContain('iu=/21775744923/external/single_preroll_skippable');
    expect(tag.startsWith(GOOGLE_IMA_SAMPLE_TAG)).toBe(true);
    expect(tag).toContain('npa=1');
    expect(tag).not.toContain('ltd=');
  });

  it('adds limited ads on top where European rules may reach the viewer', () => {
    const tag = nonPersonalisedTag(GOOGLE_IMA_SAMPLE_TAG, { limited: true });
    expect(tag).toContain('npa=1');
    expect(tag).toContain('ltd=1');
    expect(tag).toContain('iu=/21775744923/external/single_preroll_skippable');
  });

  it('forces the value when a tag already carries one, and is idempotent', () => {
    expect(nonPersonalisedTag('https://ads.test/vast?npa=0')).toBe('https://ads.test/vast?npa=1');
    const once = nonPersonalisedTag('https://ads.test/vast', { limited: true });
    expect(nonPersonalisedTag(once, { limited: true })).toBe(once);
  });

  it('treats Europe as limited-ads territory, and errs that way when the zone is unknown', () => {
    expect(limitedAdsForZone('Europe/Berlin')).toBe(true);
    expect(limitedAdsForZone('Europe/London')).toBe(true);
    expect(limitedAdsForZone('Atlantic/Reykjavik')).toBe(true);
    expect(limitedAdsForZone(undefined)).toBe(true);
    expect(limitedAdsForZone('America/New_York')).toBe(false);
    expect(limitedAdsForZone('Asia/Tokyo')).toBe(false);
  });
});
