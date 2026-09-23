# ADR-0038: Every decision a visitor makes is an event — and every refusal says why

Status: accepted · 2026-09-23

## Context

The owner is about to test the product as a visitor who never signs in, and
asked for two guarantees first: that the visit is *cost controlled*, and that
we have *"proper observability of what that user did, where they clicked, the
entire sessions … all paths, all the CTAs and actions."*

An audit of the client and the API against that bar found the session itself
well covered (ADR-0011: every stage timed, every provider call priced, every
in-room interaction in the ledger and in PostHog) and everything around it
mostly dark:

- **Start on Home sent no analytics event.** It bumped a visit counter, and
  bumped it before the input was checked, so an empty box and a second press
  counted as a start.
- **No CTA outside a room was an event**: the mic button, an expert chosen,
  a topic chip, a card opened, Upgrade, a plan on Pricing, the sign-in dialog
  and every step of the email flow, like, save, share, theme, the sidebar,
  Privacy choices, delete account.
- **Six visit counters in the contract were never incremented**
  (`session_joined`, `export_requested`, `checkout_started`, `saved`,
  `liked`, `privacy_opened`).
- **Refusals were invisible.** A daily limit, the spend breaker, the
  preparation gate, a rate limit, an expert above the plan: each was a
  status code and a sentence to the learner and nothing to a dashboard.
- **Interactions the room itself decided never reached PostHog** — a hand
  called, a question the material had nothing on, a validated ad step — only
  the ledger had them.
- **Pause, resume, end and pace were not recorded** by anyone.
- **The email sign-in dialog signed the bearer in and left the header saying
  "Sign in"**: it called the API client directly and never told the provider.
- **An uncaught route error was Hono's plain-text 500**: no Sentry event, no
  JSON, no reference.
- **The error monitor was installed in an effect**, so a crash during the
  very first render, or on the headless export render, reached the boundary
  with nowhere to send it.
- **Page views captured the first load only** (`capture_pageview: true`),
  in a single-page app.
- **Cost:** the three-a-day promise is per participant, and an anonymous
  participant is one rate-limited call away. Clear the bearer, mint another,
  three more sessions.

## Decision

### 1. Two closed lists, one rule

`InteractionName` stays what it was: a *session's* record, travelling to its
ledger and to PostHog. Beside it, `ActionName` (`packages/contracts/src/telemetry.ts`)
is the closed list of what a *visitor* decides anywhere that is not a live
session: `start_clicked`, `start_refused`, `say_it_clicked`, `expert_chosen`,
`topic_chosen`, `session_opened`, `limit_shown`, `unprepared_shown`,
`upgrade_clicked`, `plan_selected`, `checkout_failed`, `sign_in_opened`,
`sign_in_submitted`, `sign_in_failed`, `signed_in`, `signed_out`, `liked`,
`saved`, `share_clicked`, `visibility_changed`, `session_deleted`,
`download_variant_changed`, `download_failed`, `theme_changed`,
`board_chosen`, `ink_chosen`, `nav_clicked`, `privacy_opened`,
`analytics_toggled`, `retry_clicked` and the rest — every one a code, none a
sentence, and a test holds the two lists disjoint and snake_case.

`trackAction(name, props)` sends one to PostHog with the screen it happened on
and `kind: 'action'`, bumps the visit counter when it is one of the six, and
leaves a Sentry breadcrumb. It never reports to a room: a visit has no ledger.

The interactions the room lacked are added and sent: `pace_changed`,
`participant_muted`, `sound_enabled`, `connection_lost`, `reconnect_requested`.

### 2. Who, on every event

`setAnalyticsPerson({ anonymous, plan })` registers both as PostHog
super-properties (with `platform`) the moment the participant is known, and
tags Sentry the same. A dashboard splits any event — a Start, a refusal, a
page view — by whether the person was signed in, without a call site
remembering to say so. Identity is unchanged: `identify(participantId)`, the
bearer the app already keeps, so a returning anonymous visitor is the same
person and a cleared bearer is a stranger.

### 3. Every refusal is `session_refused` with a `reason`

`rate_limited`, `daily_limit`, `capacity`, `ip_daily_limit`, `feature_off`,
`replay_not_found`, `replay_private`, `not_replayable`, `expert_plan`,
`ip_live_cap`, `preparation_required` (which replaces the lone
`preparation_refused`). The conversion that did not happen is on the same
dashboard as the ones that did, with the true reason. One event per
participant, per reason, per minute: a refusal is a fact about a person,
and a script hammering the route is refused every time and recorded once,
so analytics volume cannot be made to grow with the hammering.

Also from the API: `participant_issued` (a new visitor, with platform),
`session_viewed` (somebody else's saved page opened), `interaction` (the
ledger's copy of every interaction, under the participant who did it, capped
at 2 000 per session like stages are at 500) and `session_error`.

### 4. The floor under the three-a-day promise

`PEN_MAX_FREE_SESSIONS_PER_IP_PER_DAY` (default 12, runtime-configurable,
0 = off): free sessions one address may start in a UTC day, across every
participant it mints. Paid plans are never counted. A household of learners
fits; a script minting identities does not. It is answered in the allowance's
own voice (402, "from this connection … or upgrade to continue") and kept in
memory on purpose: it is a ceiling against a script, not a ledger, and a
restart forgiving it is the right failure. The check counts what the address
is starting right now as well as what it has started, so a burst that
arrives together cannot all pass it. The Playwright suite is one address
(`local`) starting some twenty free lessons, so its API environments set the
cap to 0. A shared address — a school, an office, a carrier NAT — is the
known cost of the default; the runtime setting is there to raise it the day
that shows up in `session_refused { reason: 'ip_daily_limit' }`.

### 5. The nets

`app.onError` captures every uncaught route error to Sentry tagged with the
route and answers `{ error: 'INTERNAL', message, ref }` as JSON.
`installMonitor` runs synchronously in the provider's body, before any
effect. `capture_pageview: 'history_change'` records every route.

### 6. One door in

The email flows go through the provider (`signInWithEmail`,
`completeRegistration`, `resetPassword`) like Google does, so a sign-in by any
door is the same thing: the participant in context, the analytics identity,
the visit's counter, one `signed_in` event with `method`.

## What is still true, and still open

- Nothing here carries content. Props are codes, ids, counts, booleans; the
  `beforeSend` scrubbers on both Sentry clients are unchanged.
- The visit tracker (ADR-0027) is unchanged; it now receives the six
  counters it always had room for.
- **Intake translation still runs before the preparation gate.** A free
  learner typing a non-English topic nobody has prepared pays one small
  translation call before being refused, because the English title is what
  the registry resolves. Cached per topic; recorded here rather than hidden.
- Reading one visitor back: `docs/RUNBOOK.md` § 4, "Following one visitor".

## Consequences

- Tests: `packages/app/test/analytics-privacy.test.ts` (actions, person,
  early monitor), `services/api/test/observability.test.ts` (arrival,
  refusals, the address cap, views, the error net),
  `services/api/test/telemetry.integration.test.ts` (interactions forwarded),
  `packages/contracts/test/telemetry.test.ts` (the two lists).
- The PostHog dashboard's tiles filter `app = 'pen-academy-api'` and read
  `session_started` / `session_ended`; nothing they read changed.
