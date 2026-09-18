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

/**
 * Ads are non-personalised here, always (ADR-0018).
 *
 * The product shows a learner one short video between segments; it does not
 * need to know who they are to do that, and asking would mean a consent wall
 * in front of a lesson. Google's own parameters express exactly this:
 *
 * - `npa=1` — non-personalised ads: no ad-personalisation signals are used.
 *   Applied to every request, everywhere, so there is nothing to consent to.
 * - `ltd=1` — limited ads: the request is served without reading or writing
 *   local identifiers at all. Google documents this as the mode for serving
 *   in the EEA/UK without TCF consent, so it is applied wherever European
 *   rules may reach the viewer.
 *
 * The trade-off is money: non-personalised inventory earns less than
 * personalised. That is the price of not interrupting a lesson with a banner,
 * and it is written down in docs/ADS.md.
 */
export function nonPersonalisedTag(tagUrl: string, opts: { limited?: boolean } = {}): string {
  const withNpa = setTagParam(tagUrl, 'npa', '1');
  return opts.limited ? setTagParam(withNpa, 'ltd', '1') : withNpa;
}

/**
 * Set one parameter on a VAST tag without touching the rest of it.
 *
 * Deliberately textual. `URLSearchParams` re-serialises the whole query, which
 * percent-encodes the slashes in Ad Manager's own `iu=/NNNN/unit-name`
 * parameter and produces a tag the ad server does not recognise — an empty
 * response, and a lesson with a blank slot where the ad should be. The tag
 * belongs to the seller; we add to it and change nothing else.
 */
function setTagParam(tagUrl: string, key: 'npa' | 'ltd', value: string): string {
  const existing = new RegExp(`([?&])${key}=[^&]*`);
  if (existing.test(tagUrl)) return tagUrl.replace(existing, `$1${key}=${value}`);
  return `${tagUrl}${tagUrl.includes('?') ? '&' : '?'}${key}=${value}`;
}

/**
 * IANA zones where limited ads are used. Europe as a whole is treated as in
 * scope rather than a precise EEA list: over-including costs a little revenue,
 * under-including would serve the wrong kind of ad to someone the rules
 * protect, and only one of those two mistakes matters.
 */
const LIMITED_ADS_ZONES = new Set([
  'Atlantic/Azores',
  'Atlantic/Canary',
  'Atlantic/Faeroe',
  'Atlantic/Faroe',
  'Atlantic/Madeira',
  'Atlantic/Reykjavik',
]);

/** Whether this viewer should get limited ads, from their own clock's timezone. */
export function limitedAdsForZone(timeZone: string | undefined): boolean {
  if (!timeZone) return true; // unknown: assume protected
  return timeZone.startsWith('Europe/') || LIMITED_ADS_ZONES.has(timeZone);
}

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
