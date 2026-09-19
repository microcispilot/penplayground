# Statistics and reports

What the owner's dashboard reads, where each number comes from, what it is
worth, and what it deliberately does not say. The decision behind all of it is
[ADR-0027](adr/0027-statistics-and-reports.md); ADR-0011 is the telemetry it
derives from and ADR-0018 is the privacy stance it has to keep.

---

## The shape of it

Two kinds of row, and they are not the same kind of thing.

**Derived** — rebuildable from the recording ledgers on disk, which remain the
source of truth.

| Table | One row per | Written by |
|---|---|---|
| `session_stats` | finished session | `StatsDeriver`'s drain loop, and the backfill |
| `session_stage_stats` | (session, stage) | ” |
| `session_error_stats` | (session, error code) | ” |
| `session_reuse_links` | (session, kind of work it reused) | ” |
| `stats_work_origin` | (kind, scope) — who first paid for it | ” |

**Recorded** — exists nowhere else, and cannot be rebuilt.

| Table | One row per | Written by |
|---|---|---|
| `site_visits` | visit | `POST /api/visits` |
| `site_visit_screens` | (visit, screen) | ” |
| `session_engagement` | session | the beacon's replay/share counters, and the export routes |
| `plan_events` | plan change | the Stripe webhook |

Plus three columns on `participants`: `plan_interval`, `plan_status`,
`plan_since`.

Back up the recorded tables. The derived ones can be dropped and rebuilt:

```bash
pnpm --filter @pen/api stats:backfill            # anything missing or stale
pnpm --filter @pen/api stats:backfill --all      # everything, from scratch
pnpm --filter @pen/api stats:backfill --dry-run  # say what would change
```

It is safe against a live production database: every write is an upsert keyed
by session id and the ledgers it reads are append-only.

---

## Active time, defined

This is the number most likely to be quoted out of context, so here is exactly
what it counts.

A visit's `active_ms` is **engaged** time. The page credits a millisecond only
while **both** hold:

1. the document is visible (`visibilityState === 'visible'`), and
2. either the person did something — pointer, key, scroll, touch, wheel — in
   the last **60 s** (`VISIT_IDLE_MS`), **or** a lesson is audibly playing.

The second clause is the one worth arguing about, and it is there because a
lesson is the one part of this product where sitting perfectly still *is* the
engagement. It is derived from events the room and the replay already send —
`first_audio` and `answer_started` and `resume` turn it on, `pause`, `leave`,
`end` and `recap_shown` turn it off, and so does walking to any screen that
is not the room or the replay (`analytics.ts`, `LESSON_AUDIBLE`).

The page reports its credit every **15 s** (`VISIT_HEARTBEAT_MS`) and the
server accepts at most **22.5 s** per beacon (`× VISIT_CREDIT_SLACK`), so
neither a bug, a sleeping laptop, nor a forged beacon can inflate it. A tab
left open overnight sends nothing and is credited nothing.

**A visit is not a person.** The id is minted per visit and stored nowhere on
the device (ADR-0018), so the same person tomorrow is a new visit and — if
they are not signed in — a new `participant_id` too. A silence longer than
**30 min** (`VISIT_GAP_MS`) ends a visit; the next beacon starts a new one.

---

## Geography: what we can honestly say

There is no Cloudflare or CDN in front of this deployment (`docs/DEPLOY.md`:
an A record straight to the host), the host nginx loads no geoip module, the
`nginx:1.30-alpine` web container has none available, and there is no MaxMind
database anywhere in the repo or the image. **So region and city are not
available, and are not invented.**

Every visit records where its country came from, in `site_visits.geo_source`:

| `geo_source` | Where from | Country | Region | City |
|---|---|---|---|---|
| `edge` | `CF-IPCountry`, or `X-Geo-Country` / `-Region` / `-City` | yes | yes | yes |
| `timezone` | the browser's IANA zone, via ICU's CLDR tables | yes | — | — |
| `none` | nothing was available | — | — | — |

Today every row says `timezone`. `PEN_TRUST_GEO_HEADERS=1` switches the edge
path on, and it must stay off unless the proxy really does set those headers
**and strips what a client sent** — otherwise a visitor picks their own
country. The day someone installs `libnginx-mod-http-geoip2` on the host
vhost, or puts Cloudflare in front, region and city start arriving with no
code change. Note that only the **host** nginx sees the real peer address; the
web container sees loopback.

**What the timezone country is worth.** It is right for someone at home and
wrong for a traveller, a VPN, or anyone whose device clock is set oddly. It is
a country and never finer. Treat it as "roughly where our learners are", not
as a location. The mapping is built at boot from `Intl.Locale#timeZones` over
every current ISO-3166 region — all 418 zones this Node's ICU knows, each to
exactly one country, with the ISO 3166-3 *retired* codes excluded (without
that, `Europe/Berlin` files under `DD`, East Germany).

**No IP address is stored by any of this.** `clientKey` still reads
`X-Real-IP` in memory for rate limiting; nothing in the statistics writes it
down. The raw `User-Agent` is likewise read once for a device class and
dropped — it is a fingerprinting surface and keeping it would collect far more
than the question needs.

---

## Reuse: how the provenance is decided

The memos this product keeps record no producer, and four of the five would
have needed a disk-format change and a write on the lesson path to start
recording one. So the derivation works it out instead, from telemetry it
already has.

Each kind of memo has a **scope key**, spelled the way its own module spells
it:

| Kind | Scope key | Owned by |
|---|---|---|
| `pack` | `canonicalId` | `packages/onten` registry |
| `lesson` | `canonicalId\|band\|expertId\|language` | `FileLessonMemo` |
| `card` | same as `lesson` | `FileSessionMetaCache` (ADR-0013) |
| `picture` | same as `lesson` | `FileThumbnailImageCache` (ADR-0021) |
| `voice` | `canonicalId\|band\|expertId` — **no language** | `CachingSynthesizer` (ADR-0017) |

A session whose telemetry says it *generated* work for a scope claims its
origin (`on conflict do nothing`). A session whose telemetry says it *reused*
that scope writes a `session_reuse_links` row pointing at the holder, carrying
the topic **that learner typed**. Hence:

```
GET /api/admin/stats/reuse/<sessionId>
→ { reusedBy: 14, searches: [{ topic: "…", uses: 3 }, …], byKind: […] }
```

**Where this can be wrong.** It never invents reuse — a link exists only where
the telemetry recorded a reuse — but the *ancestor* can be misattributed:

- The claim is "first derivation wins", so the backfill must walk oldest
  first (it does). Derive out of order and a later session can claim a scope
  it did not originate.
- A memo that expired and was regenerated keeps its original claimant, not the
  session that paid the second time.
- A seeded pack (`seed-packs.ts`) has no originating session at all, so the
  link's `source_session_id` is honestly `null` and the reuse is still counted.
- Deleting a session nulls the links that pointed at it rather than removing
  them: the reuse happened, and it now names nobody.

If exact provenance ever matters more than this, the fix is the one
ADR-0027 declined: a `sourceSessionId` written into each memo at the moment it
is stored. That is four small changes on the lesson's hot path, and it was not
worth them.

---

## Reading the per-stage spend

`session_stage_stats.usd` is the stage's component total — each cost
component maps to exactly one stage (`llm`, `intent`, `image`, `tts`, `stt`,
`prepare`→search, `context`→onten). It answers "which stage costs us the
most". It is **not** a decomposition to sum: a component billed in a session
that left no stage sample of that name has nowhere to land. The authoritative
per-session total is `session_stats.total_usd`, and `/api/admin/stats/cost`
sums that.

## Why a learner stopped

`session_stats.leave_reason` is decided from the ledger alone, in this order,
so the same session always lands in the same bucket:

| Reason | Means |
|---|---|
| `completed` | the room reached its recap (`state.mode === 'complete'`) |
| `length_ceiling` | the plan's maximum session length ran out |
| `never_started` | no audio ever played: there was nothing to leave |
| `left_during_ad` | an ad was shown and never reported ending |
| `left_after_error` | something failed within 30 s of the last event |
| `left_mid_segment` | part-way through, and they simply stopped |
| `idle_timeout` | the sweeper closed an empty room after 10 minutes |
| `unknown` | a ledger that fits none of the above |

Beside it: `progress` (segments reached over segments planned), `left_at_ms`,
`last_stage`, `last_interaction`, `ad_playing_at_end` and `last_error_code`.
`GET /api/admin/stats/abandonment` adds the drop-off curve by segment and the
commonest last-things-seen.

`idle_timeout` is deliberately near the bottom: it says how the *room* closed,
not why the *person* left, and when both are true the useful answer is the
other one.

---

## The reporting API

All under `/api/admin/stats`, all admin-only, all SQL. Every one takes
`from`, `to` (ms epoch, `[from, to)`) and `bucket` (`hour|day|week|month`),
defaulting to the last 30 days by day, and clamps the window to 400 days.

| Route | Answers |
|---|---|
| `/overview` | the headline: sessions, completion, cost, reuse rate, visits, conversion |
| `/cost` | spend over time and by component, plan and expert; per-stage spend |
| `/stages` | per-stage counts, percentiles, failures and reuse; error codes |
| `/abandonment` | leave reasons, the drop-off curve, what happened last |
| `/retention` | cohort grid — `metric=session\|visit` |
| `/sessions`, `/sessions/:id` | per-session list and full detail |
| `/users`, `/users/:id` | per-user list and detail |
| `/reuse`, `/reuse/:id` | reuse totals and savings; one session's reusers and their searches |
| `/visits` | visits, visitors, active time, bounce, by screen and referrer |
| `/geography` | country / region / city rollup, with a note saying where it came from |
| `/devices` | device class, OS, browser |
| `/clock` | hour-of-day × day-of-week — sessions in UTC, visits in the visitor's own hour |
| `/plans` | plan mix with the monthly/yearly split, and plan changes over time |

**Authorisation.** The same allow-list as the operations console (ADR-0026):
a Google address in `PEN_ADMIN_EMAILS`, matched against the participant row
and only for a row Google verified — never against the bearer's own claims.
Unset means nobody, in every environment. A machine may use
`PEN_ADMIN_TOKEN` instead, in `Authorization: Bearer` or `X-Admin-Token`,
compared in constant time and treated as unset below 32 characters.

**The three new environment variables are not runtime settings** (ADR-0026's
catalogue classifies every one): `PEN_ADMIN_TOKEN` is a credential,
`PEN_TRUST_GEO_HEADERS` is a fact about the proxy in front of the box, and
`PEN_VISIT_STATS` is deliberately deploy-level — turning collection about
people back on is a decision about the privacy policy, not a switch to flip
while reading a dashboard.

**The beacon's ceiling.** `POST /api/visits` is the only route here anyone
may call without signing in, and every call writes a row, so it is limited to
120 beacons a minute per address — about five times what a person with six
tabs open produces. Past it a beacon is dropped in silence with a 200, the
same way an opted-out one is.

**When a session's rows appear.** A room that ends queues its id; a loop in
`main` drains the queue every ten seconds and derives one session at a time,
so a finished lesson shows up within seconds rather than instantly. It is
never derived inline with the room's own teardown — see ADR-0027 §2 for what
that cost when it was.

---

## The privacy policy needs three changes before this ships

This is the owner's decision, not the implementation's. What was added is
covered by nothing currently written, and here is exactly what to change.
(File: `packages/app/src/screens/legal/Privacy.tsx`.)

**1. The "Operations" sentence is about security, not statistics** — lines
82–86:

> **Operations.** To run and secure the Service we also process the usual
> technical records: IP address, browser or app version, operating system, and
> security and diagnostic signals.

It permits processing an IP address *to run and secure the Service*. Deriving
a **country** and a **device class** and keeping them as product statistics is
a different purpose, and purpose is the whole of what that sentence limits. It
needs a companion sentence — a new paragraph is cleaner than stretching this
one. Suggested:

> **Usage statistics.** We count visits to the site, including from people who
> have not signed in: which screens were opened, how much time was spent
> actively using them, and which of a short list of actions were taken. Each
> visit also records the kind of device and browser you used and, from your
> browser's timezone, the country you are likely in. We do not store your IP
> address for this, we do not keep the full browser identification string, and
> nothing here identifies you across visits.

**2. Location is not mentioned anywhere in the policy.** The only geographic
sentences are jurisdictional (the US/EEA/UK transfer paragraph, lines
185–190). "The country you are likely in" is personal data in the EEA/UK, and
it must be disclosed. The paragraph above does it; there is no existing
sentence to amend.

**3. The "Analytics and error reports" paragraph now describes only half of
it** — lines 74–81:

> **Analytics and error reports.** We use PostHog for product analytics and
> Sentry for error monitoring. Both are configured to be **content-free** …

Everything this feature adds is stored by us, not by PostHog or Sentry, so as
written a reader concludes that product analytics live entirely with third
parties. Add one clause: "We also keep our own usage statistics, described
below, on our own servers."

Two smaller consequential edits:

- **Retention** (lines 139–149) lists what is kept and for how long. Visits
  are not on that list. Add: "Usage statistics are kept in aggregate; the
  per-visit records behind them are removed when you turn analytics off, and
  when you delete your account."
- **The "what is collected" list** shown in Privacy choices
  (`packages/app/src/lib/privacy.ts`, lines 54–64) is described in its own
  comment as "exactly what leaves this device … so the list cannot quietly
  drift from the truth". It has drifted: it says nothing about visits, active
  time, device or country. One more bullet, in the same voice:
  "How long you were actively on a screen, roughly which country you are in
  (from your device's timezone), and what kind of device you used."

Until those land, `PEN_VISIT_STATS=0` turns the whole visit ingest off: the
endpoint still answers, and writes nothing. The derived session tables are
unaffected by that switch — they contain no new personal data, only facts
about sessions the product already stores.

---

## What is not collected, and will not be

- No transcripts, no spoken text, no board content, no question text.
  `sessions.topic` — what the learner typed as a search — is the only
  learner-written text anywhere in these tables, and it is already stored and
  already public on the session's own page.
- No IP address, no raw `User-Agent`, no URL or query string beyond `utm_*`.
- No cookie and no cross-visit identifier. A visit id is minted per visit and
  stored nowhere.
- No error tracking and no session replay. Those are Sentry's and nobody's
  respectively; this is statistics over our own data.

## The opt-out

`participants.analytics_opt_out` (the "Privacy choices" switch):

- a beacon from that participant writes **nothing** — dropped before anything
  is parsed, and the endpoint answers `{ counted: false }`;
- turning it on **erases the visits already recorded** for them;
- their sessions' cost rows stay, carrying `host_opted_out` so a per-person
  report can leave them out. Those are facts about a session that is already
  stored, not new data about a person;
- `DELETE /api/me` removes their visits, their plan history, and every derived
  row of every session they hosted;
- `GET /api/me/export` includes their visits.

## What has not been proved

- **Nothing has run against *production* data.** There is no production
  `.pen-data` in this checkout. What has run is the derivation over **165 real
  ledgers** written by the real pipeline during end-to-end runs
  (`services/api/.pen-data-e2e`), with the `sessions` rows reconstructed from
  the ledgers themselves because that directory has no database: 165 derived
  in 0.5 s (3 ms each), 125 pack hits, 191 lesson segments reused against 4
  generated, 191 voice sentences reused against 265 generated, 439 reuse links
  written, the most-leaned-on session reused by 115 others — and a second full
  pass produced byte-identical totals. Costs read $0 because those runs used
  the fake provider, which is what the ledgers say. Run
  `pnpm --filter @pen/api stats:backfill --dry-run` against a copy of
  production before the real thing.
- **The edge geo path is untested end to end**, because no edge here sets
  those headers. `resolveGeo` is unit-tested in both directions; that a real
  nginx with geoip2 sets them as expected is not.
- **Several visit counters have no call site yet**: `session_joined`,
  `export_requested`, `checkout_started`, `saved`, `liked`, `privacy_opened`.
  The columns exist and are counted correctly when a beacon carries them;
  nothing sends them today, so those columns read zero. `session_started`,
  `replay_started`, `download_requested`, `share_copied` and `signed_in` are
  wired.
- **No browser but headless Chromium has run the tracker.** Its rules are
  tested against a driven clock and a stubbed `fetch`/`sendBeacon` in
  happy-dom (`packages/app/test/visits.test.ts`), and the Playwright suite
  drives the whole product with it live — but nothing in that suite asserts
  on a beacon, so what it proves is only that the tracker breaks nothing.
  That Safari on an iPhone really delivers the `pagehide` beacon, and that a
  backgrounded tab really stops crediting on a phone, are claims this
  environment cannot settle.
- **A pre-existing product race, which this made easier to hit.** Home
  refuses to start a lesson until the anonymous bearer has come back — it
  says "Connecting to Pen Playground…" and does nothing — and the input is on
  screen a couple of hundred milliseconds before that answer is. Measured on
  the e2e dev server: the window is 87 ms on `main` and 175 ms here, because
  one more unbundled module loads before the app boots (it costs nothing in a
  production build). Clicking into that window loses the click. The e2e
  helper now clicks again rather than hanging for five minutes
  (`apps/web/e2e/ui-helpers.ts`), but the product itself should probably
  queue the intent rather than drop it — that is a UI decision and was left
  alone.
- **`plan_interval` is blank for every subscription that predates it** and
  fills in on that customer's next Stripe webhook. Nothing can backfill it but
  Stripe.
