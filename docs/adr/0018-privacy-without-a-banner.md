# ADR-0018: Privacy without a banner — cookieless analytics, non-personalised ads, and one quiet switch

Status: accepted · 2026-09-17

## Context

The obvious way to be compliant is a consent banner: a sheet over the page,
two buttons, a record of the answer. The owner's instruction was the opposite,
and it is a product judgement, not a legal one:

> "Do not make it look like a scary system; do not have unnecessary labels and
> consent banners."

A learner arrives with one sentence in their head — *I want to learn Swift* —
and the product's whole promise is that an expert starts talking within
seconds (`docs/PRODUCT.md`: "Clicks to first spoken sentence = 1"). A consent
wall is a click, a decision and a moment of suspicion placed between that
sentence and the lesson, and it buys nothing a learner wanted.

So the question became: what would we have to *stop doing* for there to be
nothing to consent to?

## Decision

1. **Analytics are cookieless.** PostHog runs with `persistence: 'memory'`:
   no cookie, no `localStorage` identifier, nothing written to the device that
   could recognise a returning visitor. Consent regimes turn on storing or
   reading identifiers on a device; there is nothing here to ask about. The
   cost is that a returning learner is a new anonymous id each visit — which is
   acceptable, because every question this product asks of its analytics is
   about sessions, latencies and cost, not about people (ADR-0011 already
   forbids content).

2. **Ads are non-personalised, everywhere.** Every VAST request carries
   `npa=1`, added by the server so no request can leave without it. Where
   European rules may reach the viewer the client adds `ltd=1` (limited ads:
   Google serves without reading or writing local identifiers, which is the
   mode its own documentation describes for serving without TCF consent).
   The region signal is the viewer's own timezone, and it errs towards limited:
   anything under `Europe/` counts, as does an unknown zone. Over-including
   costs a little revenue; under-including would serve the wrong kind of ad to
   someone the rules protect, and only one of those two mistakes matters.
   The trade-off is written down in `docs/ADS.md`.

3. **No banner, and no modal of any kind.** Nothing is asked before a lesson.

4. **One quiet switch.** "Privacy choices" sits in the footer and in the
   account sheet: a plain list of what is collected and what never is, a
   toggle that turns product analytics off, and a button that downloads
   everything this deployment holds about the caller. It is a preference, not
   a question — it never appears on its own.

5. **The switch is honoured on both sides.** Turning analytics off stops
   capture in the browser *and* sets `analyticsOptOut` on the participant row
   (migration `0006_analytics_opt_out`), which the server's own PostHog sink
   checks before every capture. Turning it off in the browser while the server
   kept counting would make the switch a lie.

6. **The rest of the storage is the learner's own.** The bearer, the display
   name, the remembered pace and the privacy choice stay in the device's
   storage because that is what the learner asked the product to remember.
   None of it is shared with anyone, and `DELETE /api/me` removes the account,
   every session it hosts and everything those sessions recorded.

## Consequences

- There is no TCF 2.2 CMP and no personalised ad revenue. Non-personalised
  in-stream inventory earns less than personalised; the free plan's economics
  in `docs/COST.md` are already quoted at the low end of the benchmark range
  (`PEN_AD_ECPM_USD` defaults to 8), so this is a haircut on an estimate, not a
  hole in the model.
- PostHog warns that memory persistence mints a new anonymous id per page load
  and that `identify()` then merges one onto the person each time. That is the
  shape of cookieless analytics; the alternative is the identifier we chose not
  to store. If person-level churn ever becomes a problem, the fix is to
  bootstrap the distinct id from the participant id the bearer already implies —
  not to add a cookie.
- If the product ever wants personalised ads, that is the day a CMP is needed,
  and it should be a deliberate decision with revenue numbers attached rather
  than a banner added "to be safe".
- Nothing in this feature uses alarming copy. Limits, refusals and privacy
  controls are all one plain sentence, and where something is unavailable the
  page says so kindly and points at Pricing.
