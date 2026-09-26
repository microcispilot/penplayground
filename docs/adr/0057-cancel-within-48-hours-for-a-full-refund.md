# ADR-0057: Cancel within 48 hours for a full refund

- Status: accepted
- Date: 2026-09-25

## Context

The owner, 2026-09-25: *"we should have a cancellation policy. People can
cancel within 48 hours for full refund, otherwise they're not receiving any
refund. So have it part of the proper document or its own path, however the
other platforms do. Build a very standard one."* The Terms said only that
cancelling stops the next renewal and that legal refund rights apply; there
was no refund rule anywhere a buyer could read before paying.

## Decision

**A Cancellation and Refund Policy of its own, at `/refunds`**, the way the
platforms people already know publish theirs, with the rule in one line and
then the standard sections: cancelling, the 48-hour window, after the
window, yearly plans, the free plan, billing errors and legal rights, how to
request a refund, changes and contact.

The rule: **any charge, first payment or renewal, is refunded in full when
the subscription is cancelled within 48 hours of the charge; after that a
charge is not refunded, in whole or in part, and the plan runs to the end
of the period paid for.** Billing errors are refunded regardless. Where
local law gives a longer right, it applies.

The page shares `LegalLayout` with the Terms and the Privacy Policy, so it
has the same table of contents, footer and last-updated date; all three
now cross-link, the sidebar footer gains a Refunds link, the Terms' billing
clause quotes the rule and points at the page, and the pricing page's
footer says "A full refund within 48 hours of any charge" with the link.
`/refunds` is in the sitemap and has its own title and description.
`REFUND_WINDOW_HOURS` in `Refunds.tsx` is the number; the page derives its
headings from it.

## Consequences

- Refunds are still issued by hand through Stripe (the policy says to email
  support after cancelling in the portal). An automatic refund inside the
  window is a follow-up; the policy is written so it needs no change then.
- `legal.test.tsx` pins the sections, the two halves of the rule, the
  cross-links and the absence of dashes as punctuation.
