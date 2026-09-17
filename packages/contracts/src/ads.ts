import { z } from 'zod';

/**
 * Video ads on the free plan (ADR-0014). The product rule is a YouTube-style
 * in-stream video between lesson segments: visible, skippable after 5 s, never
 * inside the lesson audio, never on paid plans. The demand source is a VAST/VMAP
 * tag URL the server hands the client per ad, so the network is swappable
 * without a client change (Google Ad Manager today, any VAST seller later).
 */
export const AD_RULES = {
  /** The learner can always skip after this, whatever the VAST skip offset says. */
  skipAfterMs: 5_000,
  /** Hard ceiling per ad; the conductor resumes the lesson at this point no matter what. */
  maxDurationMs: 30_000,
  /** Ad blockers: if the IMA SDK is not on the page by then, the lesson resumes. */
  sdkLoadTimeoutMs: 2_000,
  /** A tag that has not produced a playable ad by then is treated as no fill. */
  requestTimeoutMs: 8_000,
} as const;

/** Where the ad plays: between two segments, or while a topic miss is being prepared. */
export const AdSlot = z.enum(['boundary', 'preparation']);
export type AdSlot = z.infer<typeof AdSlot>;

/** Only video for now; the enum keeps room for another format without a wire break. */
export const AdFormat = z.enum(['video']);
export type AdFormat = z.infer<typeof AdFormat>;

/** IMA lifecycle, as the product measures it (client analytics + the room's tally of ad outcomes). */
export const AdEventName = z.enum([
  'ad_requested',
  'ad_loaded',
  'ad_started',
  'ad_first_quartile',
  'ad_midpoint',
  'ad_third_quartile',
  'ad_completed',
  'ad_skipped',
  'ad_error',
  'ad_clicked',
]);
export type AdEventName = z.infer<typeof AdEventName>;

/** Outcomes that end an ad; each one resumes the lesson the same way. */
export const AdEndReason = z.enum(['completed', 'skipped', 'error', 'timeout', 'blocked']);
export type AdEndReason = z.infer<typeof AdEndReason>;

/**
 * Google's public IMA sample tag (a single skippable pre-roll). Served by Ad Manager's own test
 * network, so it exercises the real SDK path end to end without an account. Used only when the
 * API runs with PEN_AD_TEST_TAGS=1 (dev/e2e); it pays nothing.
 * https://developers.google.com/interactive-media-ads/docs/sdks/html5/client-side/tags
 */
export const GOOGLE_IMA_SAMPLE_TAG =
  'https://pubads.g.doubleclick.net/gampad/ads?iu=/21775744923/external/single_preroll_skippable&sz=640x480&ciu_szs=300x250%2C728x90&gdfp_req=1&output=vast&unviewed_position_start=1&env=vp&correlator=';
