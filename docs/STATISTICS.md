# Statistics and reports

What the owner's dashboard reads, where each number comes from, what it is
worth, and what it deliberately does not say. The decision behind all of it is
[ADR-0027](adr/0027-statistics-and-reports.md), amended by
[ADR-0028](adr/0028-visit-identifiers-and-retention.md), which added the
client address, the raw `User-Agent` and a retention period for both;
ADR-0011 is the telemetry it derives from and ADR-0018 is the privacy stance
it has to keep.

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

**The address is stored, and it is not a source of geography.** A visit
records `ip_address` (ADR-0028), but nothing here turns one into a place:
that needs a geo database this deployment does not have, and guessing would
be inventing a location. The `edge` source is the only IP-derived one, and
the edge computes it. See the next section for exactly what is stored and for
how long.

---

## What a visit stores about the visitor, and for how long

Everything in this section is [ADR-0028](adr/0028-visit-identifiers-and-retention.md).
The rule behind the list is the owner's own: **anything a browser volunteers
without a permission prompt is in; anything that would put a prompt in front
of a learner is out.**

### The signals, and why each one needs no permission

| Column | Where it comes from | Why there is no prompt |
|---|---|---|
| `ip_address` | the edge, from the TCP peer address | never sent by the page; it is how the packet arrived |
| `user_agent` | the `User-Agent` request header | a header the browser sends unasked on every request |
| `device_type`, `os`, `browser`, `browser_major` | parsed from that header and the UA client hints | ” |
| `language` | `navigator.language`, or the first tag of `Accept-Language` | a plain property of `navigator`; the header is sent unasked |
| `timezone`, `utc_offset_minutes` | `Intl.DateTimeFormat().resolvedOptions().timeZone` | a property of the formatting API — no prompt exists for it |
| `screen_width`, `screen_height` | `window.screen` | a plain property of `window` |
| `viewport_width`, `viewport_height` | `innerWidth` / `innerHeight` | ” |
| `device_pixel_ratio` | `window.devicePixelRatio` | ” |
| `country`, `geo_source` | a trusted edge header, else the timezone above | see *Geography*; never derived from the address |

**Never read, deliberately:** the Geolocation API — the single clearest case
of a permission the web asks for — and with it camera, microphone, clipboard,
notifications and every sensor. `packages/app/test/visits.test.ts` asserts
the beacon's keys against a closed list, so one of them cannot be added
quietly.

Why the screen and the window are worth their columns: a phone-width browser
window on a desktop and an actual tablet are the same `device_type` and a
completely different layout problem. Nothing else recorded tells them apart.

Why the raw `User-Agent` is kept *as well as* the parsed columns: the reports
group by the parsed ones and the parser is deliberately small
(`stats/user-agent.ts`). The raw string is what you read when a device class
looks wrong, or when a browser nobody has heard of shows up.

### Where the address comes from

`site_visits.ip_address` is resolved by `clientAddress`
(`services/api/src/rate-limit.ts`) — the same function `clientKey` is built
on, and therefore the same resolution the per-IP live-session cap
(`PEN_MAX_SESSIONS_PER_IP`) and the beacon's rate limiter use: `X-Real-IP`,
which only our own nginx sets from the peer address, and otherwise the first
hop of `X-Forwarded-For` and never the rest of it. One opinion about which
header names a client, in one function, with three callers.

`stats/address.ts` then adds only what a stored value needs: `node:net`'s
`isIP` has to recognise it, or the column is null; and one spelling per
machine — port stripped, brackets stripped, IPv6 lowercased,
`::ffff:203.0.113.7` written as the IPv4 it is. Both families are stored in
full: truncating the last octet does not make a row anonymous and does make
the address useless for the question it is kept for.

Both identifiers are written **once**, by the beacon that created the row.
A later beacon on the same visit never rewrites them, so a visit's address is
the address it began at and nothing can put back what the sweep has cleared.

### Retention

`PEN_VISIT_IDENTIFIER_DAYS` — **default 30** — is how long a visit keeps
`ip_address` and `user_agent`. An hourly pass (`clearVisitIdentifiers`,
called from the same one-minute sweeper that closes idle rooms and stale
visits) sets both to null on older rows and changes nothing else: device
class, OS, browser, country, screen size, engaged time and every counter
survive untouched. **A report over last year reads exactly the same after a
sweep as before it.**

Thirty days because that is the dashboard's own default window
(`DEFAULT_WINDOW_MS`): the identifiers outlive the period anybody actually
looks at, and nothing more.

- `PEN_VISIT_IDENTIFIER_DAYS=0` writes neither column **and** clears every
  one already stored.
- The sweep runs even with `PEN_VISIT_STATS=0`: turning collection off must
  not turn off the forgetting of what was collected while it was on.
- It is cheap forever — `site_visits_identifier_idx` is a partial index
  holding only rows that still carry an identifier, so a sweep with nothing
  to do is an index probe, and a cleared row leaves the index. Measured on
  pglite with 20,000 visits spread over 200 days: the first sweep clears
  16,999 rows in **179 ms** (a sequential scan, correctly, for 85 % of the
  table), and every sweep after it is an `Index Scan using
  site_visits_identifier_idx` at **2.6 ms**, with the 3,001 rows inside the
  window still holding theirs.
- It is not a runtime setting. A retention period that can be lengthened
  from a dashboard is not a promise; it lives in `NOT_SETTINGS` as `privacy`,
  beside `PEN_VISIT_STATS`.

### Where these two never appear

Not in any report payload, not in a log line, not on a Sentry event, not in
an error message. The ingest's own failure path carries a visit id and
nothing else. `GET /api/me/export` does include a person's own visit rows,
address included — it is their data, and an access request should not be
answered with less than the truth.

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

## Who is here, and what they told us (ADR-0060)

`GET /api/admin/stats/people` is the console's first answer: accounts, unique visitors,
paying by plan, free accounts, active learners (a day, a week, thirty days), returning
visitors, engaged time per visitor, cost per learner and per paying account, subscription
revenue, and the ten learners who cost, learned and stayed the most. The stocks (accounts,
paying, free) are counted as of now, the flows for the window. A visitor is a device: the
participant id when the beacon carried one, else the visit id; an anonymous participant is
minted once per browser, so the same device coming back is one visitor.

`GET /api/admin/stats/surveys` gives the two one-step surveys by option with the free text
behind "other". `GET /api/admin/feedback` is the inbox: every issue, suggestion, feature
request and contact message, with a status the operator moves. The message is user content
and appears only there and in the inbox mail; events carry the kind and the length.

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

## The console that reads it

The pages live in `apps/admin/src/screens/statistics/` and are reached from
the operations console's own nav (ADR-0026). Thirteen endpoints, seven pages,
cut by the **question being asked** rather than by the route that answers it —
one scrolling page would put the cost of a lesson, a cohort grid and a list of
browsers in the same breath, and a page per endpoint would leave several of
them holding six numbers.

| Page | Answers | Reads |
|---|---|---|
| Overview | the headline, and the way in to the other six | `/overview`, `/cost`, `/visits` |
| Money | what the product spends and what it earns | `/cost`, `/plans` |
| Sessions | one lesson at a time, and what later lessons took from it | `/sessions`, `/sessions/:id`, `/reuse` |
| Pipeline | where time and money go inside a lesson, what failed, where the learner stopped | `/stages`, `/abandonment` |
| People | who they are, how long they spent, whether they came back | `/users`, `/users/:id`, `/retention`, `/overview` |
| Visits | what happens on the site, signed in or not | `/visits` |
| Audience | where they are, on what, and when | `/geography`, `/devices`, `/clock` |

`/reuse/:id` is the one route with no page of its own, deliberately: its whole
content — "reused fourteen times, for these searches" — already arrives with
`/sessions/:id`, which returns the same `gaveTo` block plus everything else
about that lesson. `/reuse` itself ranks the lessons others lean on, at the
top of Sessions; its totals reach Overview inside `/overview`'s own payload.

**The range.** One control for the whole section, above the tabs, held in the
URL as a *preset* (`?range=7d`) rather than as resolved milliseconds, so a
reload keeps it and a link carries it without freezing "the last seven days"
to the seven days it was copied on. Its default reproduces the API's own:
thirty days, by day. `apps/admin/test/range.test.ts` asserts that against
`DEFAULT_WINDOW_MS` and `MAX_WINDOW_MS` read out of `routes.ts` itself, so the
two cannot drift apart. The bucket selector appears only on the pages that
read a bucket.

**Charts, without a chart library.** A sparkline, a run of columns, a bar
behind a table row, a heat grid and a stacked lane — the geometry is about a
hundred lines in `apps/admin/src/charts/geometry.ts`, pure and unit-tested, and
the components do nothing but turn those numbers into elements. Everything is
drawn in the brand at varying weight rather than in a categorical palette: the
design system's other hues each carry a meaning (`presence`, `warm`,
`success`, `error`), and borrowing one to mean "yearly subscribers" would say
something untrue on the page where being untrue matters most.

**Honesty on the page.** `/geography`'s `note` is printed verbatim rather than
paraphrased, and the region and city columns are kept and left visibly empty —
the owner asked for countries, regions and cities, and hiding the two that
cannot be answered would answer a different question. `/visits` prints the
server's own definition of engaged time beside the tile that carries it. A
cohort period that has not happened yet is drawn as an empty cell, never as
0 %. A null is an em dash and a zero is a zero: "no audio ever played" and "no
time at all" are different facts.

**What the console cannot show yet.** There is no window total for replays,
shares, downloads or exports: `session_engagement` is only joined per session
(`SessionListRow.replays`/`shares`, `SessionDetail.downloads`/`exports`), so
those numbers are on the Sessions list and a lesson's own page and nowhere
else. The smallest honest fix is one more aggregate in
`ReportRepository` — `select sum(replays), sum(shares), sum(downloads),
sum(exports) from session_engagement e join session_stats t using (session_id)
where t.started_at >= $from and t.started_at < $to` — surfaced on `/overview`.
It was not added here because `packages/db` was outside the change's fence.
`ORDERABLE` likewise has no `replays` or `shares` key, so the Sessions list
sorts by views but not by either of those.

---

## The published privacy policy, and what it does and does not cover

**The policy is unchanged, by the owner's instruction.** They were asked
whether it should spell out what the visit record now stores and said they
are content for it not to be. This section is the record of that decision and
of exactly where the published words land against the code, so it can be
revisited in one place rather than rediscovered. The implementation takes no
view; nothing below has been applied to
`packages/app/src/screens/legal/Privacy.tsx`.

### What is now stored, in one place

| | |
|---|---|
| **Who** | every visitor, signed in or not, unless `analytics_opt_out` is on |
| **What** | client address; raw `User-Agent`; device class, OS, browser; screen and window size; pixel ratio; language; timezone and UTC offset; country and its source; referrer host; `utm_*`; screen names, view counts, engaged time; a closed list of action counters |
| **For how long** | address and raw `User-Agent`: **30 days** (`PEN_VISIT_IDENTIFIER_DAYS`), then nulled in place. Everything else: indefinitely, as statistics |
| **Erased when** | the person turns analytics off (rows deleted), or deletes their account |
| **Never** | precise location, coordinates, region or city from an address, cookies, cross-visit identifiers, URLs beyond `utm_*`, content of any kind |

### Sentence by sentence, against what is published

**Covered.** *"**Operations.** To run and secure the Service we also process
the usual technical records: IP address, browser or app version, operating
system, and security and diagnostic signals."* This names the IP address, the
browser and the operating system explicitly, and it is the sentence a reader
would point at. Note what it limits, though: the *purpose* — "to run and
secure the Service". Product statistics are a different purpose from
security, and purpose is the whole of what that sentence constrains.

**Partly covered.** *"**Analytics and error reports.** We use PostHog for
product analytics and Sentry for error monitoring…"* A reader finishes this
paragraph believing product analytics live entirely with third parties.
Everything described on this page is stored by us, on our own servers.

**Not covered.**

- **Location of any kind.** The policy's only geographic sentences are
  jurisdictional (the transfers paragraph: "Microcis is based in the United
  States…"). "The country you are likely in" is personal data in the EEA and
  the UK, and no published sentence discloses that it is derived or kept.
- **Retention of these records.** "How long we keep it" covers accounts,
  sessions, "security and diagnostic records … for a short, bounded period",
  and third-party analytics under each provider's settings. The visit table
  is none of those, and the thirty-day identifier period is not stated.
- **The screen, window and pixel-ratio signals**, which no sentence mentions.
- **The "what is collected" list in Privacy choices**
  (`packages/app/src/lib/privacy.ts`) describes itself as "exactly what
  leaves this device … so the list cannot quietly drift from the truth". It
  says nothing about visits, active time, device, country, screen size or the
  address. It has drifted, and it has been left as it is under the same
  instruction.

### If the owner changes their mind

The smallest honest change is one new paragraph beside "Operations", and one
clause in the retention paragraph:

> **Usage statistics.** We count visits to the site, including from people
> who have not signed in: which screens were opened, how much time was spent
> actively using them, and which of a short list of actions were taken. Each
> visit also records your IP address, your browser's identification string,
> the kind of device, browser and screen you used, your language, and — from
> your browser's timezone — the country you are likely in. We do not use your
> IP address to work out where you are, and we do not ask for or use your
> device's location. We keep the IP address and the browser identification
> string for 30 days and then erase them from the record, keeping only the
> statistics. Nothing here identifies you across visits.

> …and the IP address and browser identification string in our usage
> statistics are erased after 30 days.

And one more bullet in the Privacy choices list, in its own voice: "Your IP
address and browser details, kept for 30 days; how long you were actively on
a screen; roughly which country you are in (from your device's timezone); and
what kind of device and screen you used."

`PEN_VISIT_STATS=0` turns the whole visit ingest off — the endpoint still
answers, and writes nothing — and `PEN_VISIT_IDENTIFIER_DAYS=0` turns off the
two identifiers alone and erases the ones already stored. The derived session
tables are unaffected by either switch: they contain no new personal data,
only facts about sessions the product already stores.

---

## What is not collected, and will not be

- No transcripts, no spoken text, no board content, no question text.
  `sessions.topic` — what the learner typed as a search — is the only
  learner-written text anywhere in these tables, and it is already stored and
  already public on the session's own page.
- No URL or query string beyond `utm_*`.
- **No precise location.** No coordinates, no region and no city derived from
  an address — the only region and city that can ever appear come from an
  edge that computed them, with `PEN_TRUST_GEO_HEADERS=1` (ADR-0028).
- **Nothing that needs the visitor's permission.** The Geolocation API above
  all, and with it camera, microphone, clipboard, notifications and sensors.
- No cookie and no cross-visit identifier. A visit id is minted per visit and
  stored nowhere.
- The IP address and the raw `User-Agent` *are* stored — this list used to
  say otherwise, and ADR-0028 changed it. They are the only two columns with
  an expiry date; see *What a visit stores about the visitor*.
- No error tracking and no session replay. Those are Sentry's and nobody's
  respectively; this is statistics over our own data.

## The opt-out

`participants.analytics_opt_out` (the "Privacy choices" switch):

- a beacon from that participant writes **nothing** — dropped before anything
  is parsed, and the endpoint answers `{ counted: false }`. No address, no
  raw `User-Agent`, no row at all;
- turning it on **erases the visits already recorded** for them, which
  removes the two identifiers with the rows that carried them;
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
- **No address has been recorded from a real edge.** The resolution is the
  one `PEN_MAX_SESSIONS_PER_IP` has always used and it is tested through the
  route with both headers set by hand, for IPv4 and IPv6 — but that the
  production nginx sets `X-Real-IP` to the peer address is a claim about
  `deploy/nginx/pen-playground.conf.example`, not something this environment
  can run. Confirm after the next deploy with
  `select ip_address is not null from site_visits order by started_at desc limit 5`.
- **The retention sweep has not run on a real clock.** Its SQL is tested
  against Postgres (pglite) with rows aged by hand, and the hourly cadence is
  tested against a driven clock; a deployment left running for thirty-one
  days clearing its own rows is not something a test suite observes.
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
- **The console has never rendered a real answer.** Every page has been driven
  end to end in Chromium (`apps/admin/e2e/statistics.spec.ts`) and in
  happy-dom (`apps/admin/test/statistics-screen.test.tsx`), but against a
  deterministic fixture rather than against the API — a month of derived
  sessions and visits is not something either suite can produce. The fixture
  is parsed by the *same* zod schemas the console parses a live answer with
  (`apps/admin/src/lib/stats-schemas.ts`), and those schemas are written
  against `routes.ts` and `packages/db/src/reports.ts` column by column, so a
  shape that drifts fails a test. What is still unproved is the round trip:
  point the console at a live API with rows in it and read the numbers. The
  review pictures are in `.pen-data/admin-review/`.

## The voice engine (ADR-0048)

`session_stats.voice_engine` (`cartesia` | `fish`; null for sessions from
before engines were a choice) and `voice_tts` (the synthesizer id, e.g.
`cartesia:sonic-3.6+d1`) come from the recording's `voice_engine` ledger
entry, written when the room was created and bound. The cost report's
`byVoiceEngine` gives, per engine, sessions, total spend, voice spend and the
median of the rooms' own first-chunk medians; `/api/admin/stats/sessions`
takes `voiceEngine=` as a filter; a session's and a user's pages show it.
PostHog carries `voice.engine` and `voice.tts` on `session_started` and
`session_ended`, keyed by the host, for per-user questions.
