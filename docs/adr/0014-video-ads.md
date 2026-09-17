# ADR-0014: Video ads on the free plan — Google Ad Manager demand through the IMA SDK, behind one VAST tag URL

Status: accepted · 2026-09-17

## Context

The owner's brief: *"For ads, use the highest paying ad network for video views. We only show
video ads like in YouTube for now."* The free plan already reserved the slots (PRODUCT.md,
QUESTIONS.md #8): one ad every `PEN_ADS_EVERY_SEGMENTS` segments, skippable after 5 s, never
inside the lesson audio; on a topic miss one ad runs while sources are gathered and consumes the
first slot. Until now the slot rendered a static card.

What a brand-new web property can actually get, checked against primary sources on 2026-09-17:

- **AdSense for Video (legacy) is gone.** "The legacy AdSense for Video (AFV) service will be
  fully discontinued on May 31, 2026"; Google's migration path is "Ad Exchange Video (AdX Video)
  within Google Ad Manager", with the note that "a direct IMA SDK integration is always
  recommended for publishers migrating to Ad Manager" and players must "use the Google IMA SDK or
  [be] VAST/VPAID compliant". — <https://support.google.com/adsense/answer/1705822>
- **Google Ad Manager** is free at small-business scale (the paid 360 tier is for large direct
  sellers), needs an approved AdSense account to open, and serves video through the same IMA
  HTML5 SDK. It aggregates Google's own demand (AdX / Google Ads video buyers, the largest pool of
  in-stream video demand on the open web) plus any third-party line items. —
  <https://admanager.google.com/home/partner-solutions/small-business/>,
  <https://support.google.com/admanager/answer/9234653>
- **SSPs with direct video demand** (Magnite, PubMatic, Index Exchange) are the other route to
  high in-stream CPMs, but they onboard publishers by relationship: Magnite is quoted at ≈ 5 M
  monthly page views minimum; PubMatic and Index list no hard floor but require a sales
  conversation and typically an existing Ad Manager/Prebid setup to plug into. They are an
  *addition* to Ad Manager (as header-bidding or as line items), not a replacement a new site can
  start on. — <https://www.publisher-collective.com/blog/best-ssps-for-publishers>
- **Money.** Published 2026 benchmarks put open-exchange in-stream pre-roll at ≈ $8–15 CPM and
  targeted/premium in-stream at $15–30; YouTube's own skippable in-stream runs ≈ $11 CPM. That
  is the order of magnitude behind `PEN_AD_ECPM_USD` (default 8, the low end) and COST.md's "ads
  cover ≈ $0.10–0.30 per session" line (one to three completed ads per 20-minute session). —
  <https://www.namediaexperts.com/blog-posts/programmatic-advertising-costs-cpm-cpc-cpv-2026>,
  <https://www.digitalapplied.com/blog/youtube-ads-benchmarks-2026-cpv-cpm-ctr-industry>
- **The SDK.** IMA HTML5 client-side: load `https://imasdk.googleapis.com/js/sdkloader/ima3.js`,
  `AdDisplayContainer` + `AdsLoader` + `AdsRequest.adTagUrl` → `AdsManager` (`init`, `start`,
  `skip`, `setVolume`, `getRemainingTime`), events `LOADED, STARTED, FIRST_QUARTILE, MIDPOINT,
  THIRD_QUARTILE, COMPLETE, ALL_ADS_COMPLETED, SKIPPED, CLICK, AD_ERROR`; autoplay guidance is to
  request with `setAdWillAutoPlay` / `setAdWillPlayMuted` and fall back to muted playback. Google
  publishes public sample tags on its test network, including a single skippable pre-roll. —
  <https://developers.google.com/interactive-media-ads/docs/sdks/html5/client-side>,
  <https://developers.google.com/interactive-media-ads/docs/sdks/html5/client-side/autoplay>,
  <https://developers.google.com/interactive-media-ads/docs/sdks/html5/client-side/tags>
- **ads.txt** is "not mandatory" but "highly recommended" by Ad Manager; without it buyers
  increasingly refuse the inventory. — <https://support.google.com/admanager/answer/7441288>

## Decision

1. **Demand: Google Ad Manager (AdX video) through the IMA HTML5 SDK.** It is the highest-fill,
   highest-CPM in-stream demand a new site can be approved for, and the only Google route left
   for web video after AFV's shutdown. SSP demand is a later addition inside Ad Manager, not a
   different integration.
2. **One tag URL is the whole network abstraction.** The server puts a VAST/VMAP `tagUrl` on every
   `ad` message (`ServerAd.format = 'video'`, `slot`, the existing `skippableAfterMs` /
   `durationMs` timing the conductor already enforces). `PEN_AD_TAG_URL` is the Ad Manager tag;
   any other seller's VAST tag drops in with no client change. Unset → no ads, logged at boot;
   `PEN_AD_TEST_TAGS=1` substitutes Google's public sample tag in dev/e2e and is refused in
   production.
3. **Product rules live in the client, not the creative.** `AD_RULES` (contracts): skippable at
   5 s whichever comes first (our timer or the VAST offset), a 30 s ceiling the conductor enforces
   regardless, 2 s to have the SDK on the page or the lesson resumes, 8 s for the tag to produce a
   playable ad. The player is headless (`packages/app/src/ads/ad-player.ts`) with the React
   overlay (`VideoAd.tsx`) as a view; every outcome ends in exactly one `skipAd()`.
4. **Autoplay.** Request with sound when the page has had a user gesture
   (`navigator.userActivation`), otherwise muted with a tap-to-unmute; one muted retry on IMA
   error 1205 (autoplay disallowed).
5. **Measurement.** Every step is a product event (`ad_requested … ad_clicked`) through the app's
   analytics and a `ClientAdEvent` on the room socket. The room accepts each step once, from the
   host, for ad ids it sent; `AdEconomics` (API) tallies per session and books an estimated
   revenue line (`PEN_AD_ECPM_USD / 1000` per completed ad) into the session ledger as an `ads` cost line (`cost.revenueUsd`, never inside `totalUsd`; the API's house ledger nets it as a negative line), so
   the per-session economics show ads offsetting cost. Each accepted step is also a ledger
   `interaction` (ADR-0011), so Insights and PostHog carry the ad lifecycle like any other
   interaction; the generic `report` message is deliberately not used, since the room must
   validate ad steps before they count.
6. **The SDK loads lazily**, only when an ad is about to show; never on page load, never on paid
   plans. The desktop CSP allows exactly the Google hosts the SDK needs (`apps/desktop/index.html`).
7. **Policy files.** `/ads.txt` is served from the web container (placeholder line, owner fills
   in the publisher id); `docs/ADS.md` is the runbook.

## Consequences

- Revenue is an estimate until Ad Manager reporting is wired; the line is labelled as such.
- Skipping a non-skippable creative at 5 s is our product rule; configure Ad Manager's video ad
  rules for skippable inventory so the network's counts match ours (ADS.md).
- No ads at all until the owner creates the account and sets the tag: the free plan stays usable
  and the API says why in its boot log. Ad blockers cost 2 s of "Loading ad…" then the lesson.
- The replay (`ReplaySession`) keeps ignoring ads.
