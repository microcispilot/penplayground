# ADR-0056: Standard is $29 and Professional is $49

- Status: accepted
- Date: 2026-09-25
- Supersedes the prices in docs/PRODUCT.md and docs/QUESTIONS.md (round 1: $19 / $38)

## Context

The owner, 2026-09-25: *"I want the subscription prices to be 29 and 49
instead of current ones. properly update them end-to-end."* Until now the
number lived in three places that nothing held together: `Pricing.tsx` wrote
19 and 38 by hand, `docs/PRODUCT.md` repeated them, and the four
`STRIPE_PRICE_*` ids pointed at whatever amounts had been typed into the
Stripe dashboard. A page could say one price and Checkout charge another,
and nothing would have noticed.

## Decision

**The price is written once**, in `PLAN_PRICES_USD` (`packages/contracts/src/billing.ts`):
Standard **$29** a month or **$290** a year, Professional **$49** a month or
**$490** a year, Free $0. A year is ten months, so the page's "two months
free" is arithmetic, not copy.

Everything else reads it:

- **The pricing page** renders `monthlyEquivalentUsd(plan, interval)` and
  writes no number of its own ($24 and $41 a month when billed yearly).
- **The API checks Stripe at boot.** `Billing.verifyPrices` reads each
  configured price back from Stripe and holds its amount, currency,
  interval and active flag against the contract. A disagreement is a
  `billing.price_mismatch` error in the log and in Sentry, with the plan,
  the interval and both amounts. It never throws and never blocks the boot.
- **The Stripe prices are created from the contract** by
  `pnpm --filter @pen/api stripe:prices`, idempotently: each price carries
  a `lookup_key` of `pen_<plan>_<interval>_<usd>` and is reused when it
  exists. `--write` puts the four ids into `.env`. A Stripe price is
  immutable, so a new amount is a new price; the old ones stay active for
  the subscriptions already on them, and Checkout only ever uses the four
  ids in the environment.

## The voice of the page

Set in the same afternoon. The owner: *"I want them to be more professional
and high quality, not very cheap wording. Also they should not reveal the
internals, like no one prepared, means we do some internal things to do
them. Also I don't like the hyphen dash, it shows bot written."* And of the
Standard blurb: *"instead of to send on, you can say share with friends."*
So: no dash as punctuation anywhere on the page; nothing that describes how
a lesson is made ("nobody has prepared it yet", "cheap enough to run"), only
what the learner gets; and "share with friends" for what leaves the product.
`pricing.test.tsx` holds all three.

## Consequences

- Existing subscribers stay on the price they signed up at until the owner
  decides otherwise; Stripe does not move a subscription to a new price on
  its own.
- Production takes the new prices when the owner runs `stripe:prices` with
  the live key, puts the four ids into the server's environment and
  restarts the API. Until then the boot check reports the old amounts as a
  mismatch, which is the correct reading of that state.
- `plan-prices.test.ts` pins the numbers; `billing.test.ts` pins the check.
