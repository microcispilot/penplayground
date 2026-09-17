import { describe, expect, it } from 'vitest';
import {
  AD_RULES,
  AdEventName,
  ClientMessage,
  GOOGLE_IMA_SAMPLE_TAG,
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
