# Video ads runbook (free plan)

Design: `docs/adr/0014-video-ads.md`. Product rule: YouTube-style in-stream video between
segments, skippable after 5 s, never inside the lesson audio, never on paid tiers; on a topic miss
one ad plays while the session is prepared and consumes the first slot.

## What "highest paying" means here

For a new web property the highest-paying video demand that will actually accept the site is
**Google Ad Manager's Ad Exchange (AdX) video**, served through the **Google IMA HTML5 SDK**. It
pools Google Ads' video buyers (the largest in-stream demand on the open web), needs no sales
relationship, and is the route Google itself names as the replacement for AdSense for Video,
which was discontinued on 2026-05-31. Benchmarks (2026): open-exchange in-stream pre-roll ≈ $8–15
CPM, premium/targeted $15–30, YouTube skippable ≈ $11.

Alternatives, and when they make sense:

| Route | Pays | Attainable now? | Notes |
| --- | --- | --- | --- |
| Google Ad Manager + AdX video (IMA) | high fill, $8–15+ CPM | **yes** (approved AdSense account) | this runbook |
| Magnite / PubMatic / Index Exchange | can beat AdX on premium | later — publisher relationship, Magnite ≈ 5 M PV/mo | add as line items / header bidding inside Ad Manager once traffic exists |
| Ad networks (ExoClick, PropellerAds, …) | low CPM, weak brand safety | yes | never for a learning product |
| Sponsorships / direct deals | highest per view | needs a sales motion | trafficked in Ad Manager as guaranteed line items; same tag |

Everything above is a VAST tag to us: `PEN_AD_TAG_URL` is the whole integration surface.

## Steps (owner)

1. **AdSense account** — <https://www.google.com/adsense/> with the production domain
   (`penplayground.com`). Approval needs the site live with real content and the privacy policy
   page; a few days.
2. **Ad Manager account** — <https://admanager.google.com/> (free tier), signed in with the
   approved AdSense account. Enable **Ad Exchange** (Admin › Companies / "Ad Exchange" request)
   — Google enables AdX video for accounts that meet its policies; sessions and the recap are
   the "content around the player".
3. **Video ad unit** — Inventory › Ad units › New, "Video and audio", size `640x480` (v), name
   `pen-free-instream`. Under Delivery › Video ad rules (optional) create a pre-roll rule with
   **skippable after 5 s** so Ad Manager's skip counts match the product rule; max duration 30 s.
4. **Tag** — Inventory › Ad units › `pen-free-instream` › **Generate tags** › *Google Publisher
   Tag for Video and Audio* › IMA SDK › copy the tag. It looks like
   `https://pubads.g.doubleclick.net/gampad/ads?iu=/NNNNNNNN/pen-free-instream&sz=640x480&gdfp_req=1&output=vast&unviewed_position_start=1&env=vp&correlator=`.
5. **Configure the API** — in `/srv/pen-playground/api.env`:

   ```
   PEN_AD_TAG_URL=<the tag>
   PEN_AD_ECPM_USD=8          # your net eCPM once Ad Manager reports it; only feeds the estimate
   PEN_ADS_EVERY_SEGMENTS=3
   ```

   then `docker compose up -d api`. `curl -s http://127.0.0.1:4200/api/health` shows
   `"ads":"configured"`; the boot log has `ads.on`. Without the tag it logs `ads.off` with the
   reason and the free plan shows no ads.
6. **ads.txt** — `apps/web/public/ads.txt` holds a commented placeholder. Put in the line Ad
   Manager shows under Admin › Global settings › Network settings › **Publisher ID** (the same
   `pub-…` id as AdSense › Account › Settings), uncomment it, ship the web image. Verify:
   `curl -s https://penplayground.com/ads.txt` → `google.com, pub-…, DIRECT, f08c47fec0942fa0`.
   Ad Manager crawls it within ~24 h (Admin › Sellers / ads.txt status).
7. **Verify in the product** — a free-plan session; the first boundary shows the ad with the
   "Ad · 1 of 1" label, the countdown and the skip at 5 s. `docker compose logs api | grep
   room.ad` shows `room.ad` (sent) and `room.ad_event` (requested/loaded/started/…); the
   session's `room.economics` line carries `completed` and `revenueUsd`.

## Local development and tests

- `PEN_AD_TEST_TAGS=1` makes the API use Google's public sample tag (a single skippable pre-roll
  on Google's test network; pays nothing; refused in production). The web e2e
  (`apps/web/e2e/ads.spec.ts`) runs with it and needs network access to
  `imasdk.googleapis.com` and `pubads.g.doubleclick.net`.
- Unit tests: contracts (`packages/contracts/test/ads.test.ts`), scheduling and outcome tally
  (`packages/session-engine/test/ads.test.ts`, `services/api/test/ads.test.ts`), player state
  machine with a fake IMA (`packages/app/test/ad-player.test.ts`, `ima-loader.test.ts`).

## Behaviour to know

- **Ad blockers**: the SDK has 2 s to appear, the tag 8 s to produce a playable ad; otherwise
  the lesson resumes (event `ad_error` with `SDK_TIMEOUT` / `PEN_AD_SDK_BLOCKED` / `TIMEOUT`).
- **Autoplay**: with sound after any gesture on the page; otherwise muted with "Tap to unmute";
  one muted retry on IMA error 1205.
- **Ceiling**: 30 s, enforced by the conductor even if the creative misbehaves (`ad_error CEILING`).
- **Desktop**: the Electron renderer's CSP (`apps/desktop/index.html`) allows
  `imasdk.googleapis.com`, `*.doubleclick.net`, `*.googlesyndication.com` and `https:` media.
- **Measurement**: `ad_requested, ad_loaded, ad_started, ad_first_quartile, ad_midpoint,
  ad_third_quartile, ad_completed, ad_skipped {atMs}, ad_error {code}, ad_clicked` — PostHog
  (client, `VITE_POSTHOG_TOKEN`) and the room socket (`ad_event`, host only, once per step).
  Per session: `session_ended` carries `adsCompleted / adsSkipped / adsErrors /
  adRevenueEstimateUsd`; the cost ledger has a negative `ads` line.

## Personalisation: we do not ask, so we do not get it (ADR-0018)

Every request this product makes carries **`npa=1`** (non-personalised ads), added by the API so
no tag can leave without it. Where European rules may reach the viewer the client adds **`ltd=1`**
(limited ads), which Google documents as serving without reading or writing local identifiers —
the mode that needs no TCF consent. The region signal is the viewer's own timezone: anything under
`Europe/` counts, and an unknown zone counts too, because over-including costs a little money and
under-including serves the wrong kind of ad to someone the rules protect.

**The trade-off, plainly:** non-personalised in-stream inventory earns less than personalised —
commonly quoted at 30–50 % less on the open exchange. `PEN_AD_ECPM_USD` defaults to 8, the low end
of the 2026 benchmark range (ADR-0014), so the estimate in `docs/COST.md` already assumes the
lower number rather than the headline one. What it buys is that a learner never meets a consent
wall between "I want to learn Swift" and the first spoken sentence, and that there is no
advertising profile of anyone who uses this product.

If personalised ads are ever wanted, that is the day a TCF 2.2 CMP is needed — a deliberate
decision with revenue attached, not a banner added to be safe.

## Policy notes

- Ad Manager video policies require the player to be a real video player context and the ad to
  be user-initiated or announced; the "Ad · 1 of 1" label, the countdown and the visible skip
  satisfy the disclosure norms. Never place an ad inside the lesson audio.
- Children's content: sessions are general-audience learning; if a topic is directed at children
  the request must be tagged for child-directed treatment (`tfcd=1` on the tag). Not wired yet.
- Consent (EEA/UK): Ad Manager's own consent handling needs a TCF 2.2 CMP before serving
  *personalised* ads there. We do not serve those at all: `npa=1` everywhere and `ltd=1` in
  Europe (see above), so no CMP is required.
