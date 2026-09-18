# ADR-0016: Plan limits and a daily spend circuit breaker — the cap is computed from the same cost lines the Insights tab shows

Status: accepted · 2026-09-17

## Context

Two promises in `docs/PRODUCT.md` were only ever written down, never enforced:
"3 sessions a day" on the free plan, and a per-session budget
(`docs/COST.md`: ≈ $0.30 of provider spend for a 20-minute solo session). The
route that created a session counted the last 24 hours and refused a fourth
free one; nothing bounded how long a session could run, and nothing at all
bounded what a day could cost. A single bad afternoon — a scripted client, a
topic that loops, a forgotten tab — was an open line to four providers.

The constraint that shaped the design: ADR-0011 already makes every priced
provider call write a `CostLine` into its session's ledger through the
telemetry port, and `GET /api/sessions/:id/telemetry` sums them. A second,
independent meter would eventually disagree with the first, and then nobody
would know which number was true.

## Decision

1. **`PLAN_LIMITS` is the one table** (`packages/contracts/src/billing.ts`),
   and it carries three numbers per plan rather than one:

   | Plan | Sessions / UTC day | Max session | Seats (host included) |
   | --- | --- | --- | --- |
   | Free | 3 | 20 min | 1 |
   | Standard | unlimited | 45 min | 1 |
   | Professional | unlimited | 60 min | 12 |

   Free's 20 minutes is the session `docs/COST.md` budgets; Standard and
   Professional leave room for a long class while still bounding a tab left
   open overnight. The room reads its seat count from the host's plan, and the
   registry's sweeper ends a session once it has run its plan's length.

2. **The day is a UTC day.** A rolling 24-hour window means a learner's quota
   resets at a different moment every day and they can never predict it.
   `utcDayStart()` is shared by the server and the client, so "2 of 3 sessions
   left today" and the 402 that eventually follows agree by construction.

3. **The breaker listens to the ledger, it does not keep its own books.**
   `SpendBreaker` (`services/api/src/spend.ts`) is fed by the room's
   `SessionMetrics.onCost` sink — the very lines that land in the recording
   ledger. On boot it rebuilds the running total by reading only the ledgers
   touched since midnight, so a restart mid-day does not hand the day a fresh
   budget. Ad revenue (`ads` lines, ADR-0014) is tallied separately and never
   reduces the number the cap measures: a cap that revenue could inflate would
   stop protecting the card behind it.

4. **Free stops at the cap, paid keeps going to a multiple of it.**
   `PEN_DAILY_SPEND_CAP_USD` (default 25) holds new free sessions with a 503
   `CAPACITY`; paying learners — the reason the cap is affordable — continue to
   `PEN_DAILY_SPEND_PAID_MULTIPLE ×` the cap (default 3). Sentry gets one
   warning per day at 80 %, while there is still a fifth of the budget left to
   react in. `PEN_DAILY_SPEND_CAP_USD=0` disables the breaker and says so in
   the boot log rather than pretending to be on.

5. **A limit is explained, never enforced silently.** `GET /api/me/usage`
   returns the caller's own numbers (`PlanUsage`), so Home can say "2 of 3
   sessions left today" before anyone clicks Start, and one friendly sentence
   with a Pricing link when they are gone. The refusals carry the same numbers
   and the same tone: "That is your 3 sessions for today. Standard makes them
   unlimited." There is no red box anywhere in this feature.

6. **Abuse limits sit beside the plan limits, not inside them.** Per-socket
   token buckets per message family, a bad-frame close after ten malformed
   frames, a per-session transcript ceiling, 64 KB JSON bodies, and at most
   `PEN_MAX_SESSIONS_PER_IP` (5) live rooms from one address. These bound a
   script; the plan limits bound a product.

## Consequences

- The number the breaker acts on and the number a host sees in Insights are the
  same number, by construction. `GET /api/admin/costs` exposes the day's total
  beside the per-purpose snapshot.
- The rebuild reads at most today's session directories, so it stays
  proportional to today's traffic rather than to everything on disk.
- The breaker is per process. A second node would need a shared counter
  (Redis behind the same interface); today's deployment is one node, and the
  boot rebuild is what makes a restart safe.
- A host who hits the session-length ceiling is ended at a sweeper tick, so the
  ceiling is accurate to within a minute. The session ends the way any session
  ends: recap, saved, replayable.
- The e2e suite runs every spec from one address, so its API is configured with
  a high per-IP cap; the cap itself is covered by `services/api/test/limits.test.ts`.
