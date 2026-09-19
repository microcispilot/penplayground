# ADR-0027: Statistics are derived from the ledger, visits are counted, and neither is a second PostHog

Status: accepted · 2026-09-19

## Context

The owner asked to be able to answer, from the product's own data: what a
session costs and why; how much of it was reused and for which searches; where
a learner stopped and what was happening when they did; who visited the site,
from where, on what, for how long, and what they did — **including everyone
who never signs in**; and how the subscription mix moves.

Almost none of that was queryable.

- **Per-session telemetry existed but only as files.** Every stage, cost line,
  interaction and error is written to `<PEN_DATA_DIR>/sessions/<id>/ledger.jsonl`
  and turned into a `SessionTelemetry` by `computeTelemetry` (ADR-0011). That
  is exactly right for one session's Insights tab and useless for "the average
  across every session": `/api/stats/reuse` answers by opening *every ledger on
  the node* and folding them in memory, which is fine at a hundred sessions and
  not at a hundred thousand.
- **Five tables about learners.** `participants`, `sessions`,
  `session_visits`, `session_likes`, `session_saves` — plus the runtime
  configuration's two, which are about the deployment rather than about
  anyone. No visit record, no active time, no device, no geography, no replay
  or share counter, no history of a plan changing.
- **Reuse had no provenance.** The telemetry knows *that* a lesson came from
  the memo and what it saved; nothing recorded *whose* lesson it was, so
  "this session has been reused fourteen times, and here are the searches"
  could not be asked at all.

The constraint that shapes all of it: **writing these rows must never slow a
lesson and must never fail one.**

## Decision

### 1. Derive, do not migrate

Per-session and per-stage facts are rolled out of the ledger into
`session_stats`, `session_stage_stats`, `session_error_stats`,
`session_reuse_links` and `stats_work_origin` when a session ends. The ledger
stays the source of truth; every one of those tables is throwaway.

`deriveSession` (`services/api/src/stats/derive.ts`) is **pure** — ledger and
session record in, rows out — so the derivation at session end, the backfill
over a year of files, and a unit test on a fixture cannot disagree.
`STATS_SCHEMA_VERSION` is stamped on every row, and
`pnpm --filter @pen/api stats:backfill` re-derives anything written by an older
one. A change to what a column *means* is therefore a re-run, never a
migration.

Sessions are derived **twice**: once on the first drain after the room
closes, and once again `STATS_SETTLE_MS` later, because the card copy and the session picture
are generated beside the lesson and their telemetry can land in the ledger
after the room has gone. Every write is an upsert keyed by session id, so the
second pass replaces the first. The backfill's staleness test is "has the
ledger grown, or is the row an older version", which catches anything later
still.

### 2. A queue a room hands to, and a drain loop that empties it

`RoomRegistry.end()` calls `deriver.enqueue(sessionId, …)` after the session
row is patched. That is a map write: it cannot be slow and it cannot throw. A
loop in `main` calls `deriver.drain()` every `STATS_DRAIN_MS`, derives one
session at a time, and sends every failure to the observer. There is no path
from a derivation error back into a room, a request, or a learner's screen.

Queueing rather than deriving inline is load-bearing, and the reason was found
the hard way. The obvious version — `void derive(id)` from `end()` — runs the
derivation's reads and writes *interleaved with the room's own last writes on
the same connection*. That is needless contention in production, and under
PGlite it wedges the process outright: `test/rooms-intake.test.ts`, whose
whole job is to end four rooms in `afterAll`, went from 2 s to never
finishing, at 98 % CPU and 1.2 GB resident, with V8 building WebAssembly stack
traces in a loop. Seconds of latency on a dashboard cost nothing. Sharing a
connection between a lesson and a report costs everything.

### 3. Reuse provenance, recorded rather than guessed — and without touching
the hot path

The memos this product keeps — the registry pack, the lesson memo, the lesson
voice store, the card copy, the picture — record no producer, and four of the
five would have needed a disk-format change and a write on the lesson path to
start recording one.

Instead the derivation does it, from telemetry it already has. Each kind of
memo has a **scope key** spelled the way its own module spells it
(`scopeKeyFor`). A session that *generated* work for a scope claims its origin
with `insert … on conflict do nothing`; a session that *reused* it writes a
`session_reuse_links` row pointing at whoever holds the claim, carrying the
**topic the consuming learner typed**. "Reused fourteen times, for these
searches" is then one indexed query.

Because the claim is "first derivation wins", the backfill walks **oldest
first**. Where it can be wrong is written down in `docs/STATISTICS.md`; it is
never wrong in a way that invents reuse, only in a way that can attribute it
to the wrong ancestor or to nobody (`source_session_id` stays null, and the
reuse is still counted).

### 4. Visits, including anonymous ones, with active time defined honestly

`site_visits` and `site_visit_screens` are the only genuinely new collection
here. A visit is a run of engagement, not a tab and not a person: the id is
minted per visit by the page and **stored nowhere on the device**, so the same
person tomorrow is a new row and the cookieless rule of ADR-0018 still holds.

`active_ms` is engaged time and nothing else. The page credits a millisecond
only while the document is visible **and** either the person did something in
the last `VISIT_IDLE_MS` or a lesson is audibly playing — which is the one
case where sitting still *is* the engagement. It reports that credit every
`VISIT_HEARTBEAT_MS`, and the server clamps each beacon to
`VISIT_HEARTBEAT_MS × VISIT_CREDIT_SLACK` again, so neither a bug nor a forged
beacon can inflate it. A tab left open overnight sends nothing and is credited
nothing.

What a beacon carries: a route pattern (never an id, never a URL), view and
action counters from a closed list, the browser's IANA timezone and language,
and the referrer's **host**. Nothing else.

### 5. Geography: one honest signal, and it says which one it is

There is no Cloudflare in front of this deployment, the nginx on the host
loads no geoip module, and there is no MaxMind database in the repo or the
image. Region and city cannot be had today without adding one of those, and
**they are not invented**.

So: a trusted edge header where one exists (`PEN_TRUST_GEO_HEADERS`, off by
default — a header nobody sets is a header anybody can forge), and otherwise
the browser's own IANA timezone mapped to a country through ICU's CLDR tables,
which Node already carries. Every row records `geo_source`, and the
`/api/admin/stats/geography` payload says it in words. Region and city stay
null until an edge supplies them, at which point they light up with no code
change.

**No IP address is stored.** `clientKey` still reads `X-Real-IP` in memory for
rate limiting, as it always has; nothing in the statistics writes it down. The
raw `User-Agent` is read once for a device class and dropped for the same
reason.

### 6. The opt-out is real, and retroactive

`participants.analytics_opt_out` stops a visit being written at all — not
filtered at read time, not written and ignored — and turning it on **erases
the visits already recorded**. "Not counted at all" cannot mean "counted until
you noticed". Their sessions' own cost rows stay, because those are facts
about a session that is already stored and already public; the row carries
`host_opted_out` so a per-person report can leave it out.

### 7. One allow-list, and it fails closed everywhere

The reports are guarded by the operations console's own check (ADR-0026),
passed in rather than rebuilt: a Google address in `PEN_ADMIN_EMAILS`, read
from the participant row and only for a row Google actually verified. Unset
means nobody, in development as much as in production — one set of people who
may see `/api/admin/*`, and revoking someone is one change, not two.

The one thing a report needs that a console does not is a way in for a
machine: `PEN_ADMIN_TOKEN`, in `Authorization: Bearer` or `X-Admin-Token`,
compared in constant time and treated as unset below 32 characters.

## Consequences

- The dashboard's aggregates are SQL against indexed tables. `/api/stats/reuse`,
  which reads every ledger on disk, stays for compatibility but is superseded
  by `/api/admin/stats/reuse`.
- Two tables are now the only place some facts live: `site_visits` and
  `plan_events` cannot be rebuilt from anything. They are backed up with the
  database and nothing else.
- Retention over anonymous participants reads low on purpose: an anonymous row
  is minted per browser, so the same person on a new device is a new cohort
  member. That is the price of having no cross-visit identifier, and it is the
  price ADR-0018 already chose to pay.
- **The privacy policy does not yet cover geography or device statistics.**
  Its "Operations" sentence permits processing IP, browser and operating
  system *to run and secure the Service*; deriving a country and a device class
  for product statistics is a different purpose, and the policy says nothing
  about location at all. `docs/STATISTICS.md` names the exact sentences that
  need to change. This is the owner's decision, not the implementation's.
- Monthly/yearly is now on the participant row (`plan_interval`), filled by the
  Stripe webhook. Rows that predate the column read as unknown until their next
  webhook; the backfill cannot fix that, because only Stripe knows.
