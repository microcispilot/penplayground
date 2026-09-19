# ADR-0028: A visit keeps the address and the raw string, on a thirty-day clock

Status: accepted · 2026-09-19

Amends ADR-0027, which decided the opposite. ADR-0018 (privacy without a
banner) still holds and is not weakened by this: there is still no cookie and
still no cross-visit identifier.

## Context

ADR-0027 built the visit record and chose, deliberately, to store **no IP
address** and **no raw `User-Agent`**: the string was read once for a device
class and dropped, and the country came from the browser's own timezone. The
argument was that both are fingerprinting surfaces and the reports did not
need them.

The owner has since decided otherwise, and was explicit about the shape of
it: *"we don't want to get the location of the person like precise, but we
should have IP address, and other information that does not require explicit
access permission from the user."*

Two halves, and they pull in different directions. The first is a request for
the most sensitive column this database will ever have. The second is a
request for **breadth without a prompt** — everything a browser volunteers,
nothing it would make a learner click to allow.

The owner was also asked whether the published privacy policy should be
changed to spell this out, and said they are content for it not to be. That
is recorded here and in `docs/STATISTICS.md` rather than acted on.

## Decision

### 1. The address is stored, resolved by the code that already resolves one

`site_visits.ip_address` holds the client address in full, IPv4 and IPv6.

It comes from `clientAddress` in `services/api/src/rate-limit.ts` — the
function `clientKey` is now built on, which is what the per-IP live-session
cap (`PEN_MAX_SESSIONS_PER_IP`) and the beacon's own rate limiter have always
used: `X-Real-IP`, which only our own nginx sets from the peer address, and
otherwise the *first* hop of `X-Forwarded-For` and never the rest of it.

This is the point of doing it this way. A second opinion about which header
names a client is a security bug waiting to happen — the limiter and the log
disagreeing about who a caller is, and one of them being the forgeable one.
There is one resolution, in one function, and three callers.

`stats/address.ts` adds only what a stored value needs that a bucket key does
not: `node:net`'s `isIP` must recognise it, or the column is null rather than
a string nobody can use; and one spelling per machine — a port stripped,
brackets stripped, IPv6 lowercased, `::ffff:203.0.113.7` written as the IPv4
it is.

**Not truncated.** Dropping the last octet is the usual half-measure. It does
not make the row anonymous and it does make the address useless for the one
question it is kept for. Retention is what bounds this, not precision.

### 2. The raw `User-Agent` is kept beside the parsed columns, not instead

`device_type`, `os`, `browser` and `browser_major` stay exactly as they are —
they are what the reports group by, and the parser is deliberately small.
`user_agent` is the string they were parsed from, bounded at 400 characters
and stripped of control characters, for the question the parser did not
anticipate: why a device class looks wrong, what a new browser calls itself,
which embedded webview an odd cluster of sessions came from.

### 3. Everything else a browser volunteers, and nothing it would ask about

The test for inclusion is the owner's: **does reading it put a prompt in
front of a learner?** If yes, it is out.

| Signal | Where from | Why no permission is needed |
|---|---|---|
| `language` | `navigator.language`, or the first tag of `Accept-Language` | a request header the browser sends unasked, and a plain property of `navigator` |
| `timezone`, `utc_offset_minutes` | `Intl.DateTimeFormat().resolvedOptions().timeZone` | a property of the formatting API; no prompt exists for it |
| `screen_width` / `screen_height` | `window.screen` | a plain property of `window` |
| `viewport_width` / `viewport_height` | `innerWidth` / `innerHeight` | ” |
| `device_pixel_ratio` | `window.devicePixelRatio` | ” |
| `ip_address` | the edge, from the TCP peer | never sent by the page at all |
| `user_agent` | the request header | ” |

**Out, permanently:** the Geolocation API, which is the whole reason a
permission prompt exists on the web. Also out for the same reason: any
camera, microphone, clipboard, notification or sensor signal. None of them is
read by the tracker, and `packages/app/test/visits.test.ts` asserts the
beacon's keys against a closed list so one cannot be added quietly.

The screen-and-window pair is worth its two columns on its own: a
phone-width window on a desktop and an actual tablet are the same
`device_type` and a completely different layout problem, and nothing else we
record tells them apart.

### 4. Country stays where it was; an address is not a location

`geo_source` is unchanged — `edge`, `timezone`, `none` — and the address is
**not** a fourth source.

Turning an address into a country needs a geo database. There is none in this
repo, none in the image, and no geoip module in the deploy nginx
(ADR-0027 §geography, still true). Buying one, or calling a paid lookup, was
out of scope. Guessing a country from an address without one would be
inventing a location, which is the one thing the owner ruled out.

So: the timezone-derived country stays, `geo_source` keeps saying which
source a row used, and **region, city and coordinates remain out of scope** —
they arrive only from an edge that computes them, and only with
`PEN_TRUST_GEO_HEADERS=1`. When that day comes the `edge` source is the
IP-derived one, computed by something that actually has the data.

### 5. Retention: thirty days, swept hourly, identifiers only

`PEN_VISIT_IDENTIFIER_DAYS` (default **30**) is how long a visit may keep the
address and the raw string. An hourly pass —
`StatsRepository.clearVisitIdentifiers`, called from `VisitIngest.sweep`,
which the one-minute sweeper in `main.ts` already calls — sets both to null
on older rows and **touches nothing else**. Every derived column survives:
device class, OS, browser, country, screen, engaged time, every counter. A
report over last year is unchanged by the sweep having run; only the ability
to point at a machine is gone.

**Why thirty.** It is the dashboard's own default window
(`DEFAULT_WINDOW_MS` in `stats/routes.ts`): the identifiers outlive the
period anybody actually looks at, and nothing more. It is also long enough to
carry an investigation across a month-end and short enough that the table is
never a standing archive of who visited a learning site. A longer period
would have to be argued for; this one only has to be defended.

**Zero means never.** `PEN_VISIT_IDENTIFIER_DAYS=0` writes neither column
*and* clears every one already stored, because turning collection off that
only applies to the future is the same half-truth the opt-out was built to
avoid.

The sweep runs even when `PEN_VISIT_STATS=0`. Switching collection off must
not also switch off the forgetting of what was collected while it was on.

It is cheap by construction: `site_visits_identifier_idx` is a *partial*
index on `started_at` holding only the rows that still carry an identifier, so
a sweep that finds nothing is an index probe, and a row leaves the index the
moment it is cleared.

### 6. Both are written once, by the beacon that created the row

The upsert sets the identifiers on insert only; the conflict branch leaves
them alone. A visit's address is the address it began at, and — more
importantly — a late beacon on an old visit can never put back what the
sweep has cleared.

### 7. Neither is a runtime setting

`PEN_VISIT_IDENTIFIER_DAYS` joins `PEN_VISIT_STATS` in `NOT_SETTINGS` as
`privacy` (ADR-0025's catalogue). A retention period is a promise about
people's data, and a promise that can be lengthened from a dashboard is not
one. Shortening it is a deploy, and the sweep applies the new period within
the hour.

### 8. The opt-out is unchanged, and now covers two more columns

`participants.analytics_opt_out` still drops a beacon before anything is
parsed — so no address is written for an opted-out participant — and turning
it on still *deletes* their visit rows outright, which takes the address and
the raw string with them. Nothing new was needed; it is asserted rather than
assumed (`stats-reports.test.ts`).

### 9. Statistics, not a security log

These columns exist to answer questions about visits. The address is not
logged anywhere else, is never attached to a Sentry event or an error
message, and appears in no report payload. `GET /api/me/export` returns a
person their own visit rows, address included, because that is their data and
an access request should not be answered with less than the truth.

## Consequences

- `site_visits` now contains personal data of a different order from what
  ADR-0027 put there. It was already in the "back this up, it cannot be
  rebuilt" list; it is now also the table whose retention matters.
- ADR-0027's consequence "no IP address, no raw User-Agent" is superseded by
  this ADR. The sentence in `docs/STATISTICS.md` that made that promise has
  been rewritten rather than left to age.
- **The privacy policy is unchanged, by the owner's instruction.** What is
  now stored, for how long, and which published sentence does and does not
  cover it is written down in `docs/STATISTICS.md` so the decision is legible
  later and can be revisited in one place. The implementation takes no view.
- `0010_visit_identifiers.sql` adds seven nullable columns and one index. The
  columns are instant; the `CREATE INDEX` takes a write lock on `site_visits`
  for as long as it takes to build. That table is days old and small, so this
  is a non-event today — but if it is ever run against a large one, make it
  `CREATE INDEX CONCURRENTLY` in a migration of its own first.
- A country still cannot be had for a visitor whose browser reports no
  timezone, even though we now hold their address. That is the honest
  consequence of declining a geo database, and `geo_source` says `none`
  rather than covering it up.
