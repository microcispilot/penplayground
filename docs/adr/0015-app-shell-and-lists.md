# ADR-0015: The app shell — a persistent sidebar, the learner's shelves, and the legal pages

Status: accepted · 2026-09-17

## Context

The owner's brief, in two parts:

> "We should have terms of use and privacy policy. Use them from Simurgh, just change the app
> name, and make sure they are at the bottom of the web app's left sidebar."

> "An always-showing sidebar (like YouTube's: Home / Explore / … / History / Watch later / Liked
> / Playlists / Subscriptions) but titled for what our platform has and needs. Different for
> signed-in users and those not signed in, because history, sessions etc. attach to a user id — a
> not-signed-in user doesn't have those, but we can still show things there. Not shown when a
> session is started; only the home page (the app shell)."

Until now every screen rendered its own `<AppHeader />` and the only navigation was three links
in that header. There was nowhere to put History, saved or liked sessions, and nothing to hang
the legal pages off. Three of the six things the sidebar must list did not exist at all
(History, Learn later, Liked), and two more had no screen (Downloads, Rooms).

A second round of direction shaped the tone:

> "Do not make it look like a scary system; do not have unnecessary labels and consent banners."

## Decision

### 1. One shell, and two screens deliberately outside it

`AppShell` (header + sidebar + the screen) wraps every route except `/room/:id` and
`/replay/:id`, as a react-router layout route. In the room and the replay the board *is* the
screen; a sidebar there would be a second thing to look at while an expert is teaching.

The sidebar is 240 px on ≥ 1024 px, collapsible to a 72 px icon rail whose state is remembered
per device (`pen.sidebar`), and a slide-over drawer under 1024 px opened from a menu button in
the header. The rail is a mini-guide: icon over a short label ("Later", "Sessions"), never a
bare icon the learner has to decode.

### 2. The same rows whether or not you have signed in

The brief expected signed-out learners to have no history or sessions. That turns out to be
false here, and the truth is better: **every learner already has a participant id** — anonymous
ones are issued on first visit and own the sessions they start. So saves, likes and history are
keyed by participant id and work immediately, on this device, without an account; signing in
with Google adopts them onto the account exactly as sessions are already adopted.

So the "You" section shows the same live rows to everyone, plus one quiet "Sign in" row. Empty
shelves carry a single calm line and Google's own button ("Sign in and your history follows you
to every device") — never a greyed row, a lock, or a warning. Plan-gated rows (Downloads,
Rooms) carry a small "Standard" / "Professional" tag: what the row belongs to, not what the
learner is missing. There is no consent banner anywhere, and the AI disclosure stays the one
quiet line at the bottom of the sidebar ("Experts are AI.") next to the legal links and the
copyright.

### 3. Lists are (participant, session) pairs

Migration `0004_user_lists` adds three tables, all keyed by a composite primary key so a second
save or like is a no-op rather than a duplicate:

| Table | Holds | Read as |
|---|---|---|
| `session_saves` | what you put aside | **Learn later** |
| `session_likes` | what you liked | **Liked**, and the public count |
| `session_visits` | every seat you took, with `role` and first/last join | **History** |

`sessions.likes` is a denormalised counter moved inside the same transaction as the like, so a
public card never has to count rows. History is recorded where a seat is actually taken — the
host's when the session is created, everyone's when their socket attaches to the room — and not
derived from the recording ledger, which knows about cues rather than about people's shelves.

Adoption on Google sign-in moves all three tables with the participant. A like the account
already had is dropped rather than moved, and the public counter comes down with it, so one
person can never count twice.

### 4. Optimistic toggles over one small store

`useLists` (Zustand) holds the two id sets, the four counts and the like counts the client has
learned. A heart or a bookmark moves the moment it is pressed and is put back with a short
message if the server refuses. The Liked and Learn later screens are *views of the store*: un-
liking a session there takes its row away at once.

### 5. Legal pages built here, not ported verbatim

Simurgh's structure, its entity (Microcis, a California LLC) and its section order are kept;
every product-specific clause is rewritten for what Pen Playground actually does — an AI expert
teaching over voice and a shared whiteboard, sessions recorded and public by default with the
learner's name never shown, microphone audio for speech recognition, PostHog and Sentry
content-free, Stripe, Google Ad Manager on the free plan. Nothing about screen capture or
watching a desktop: that is the other product.

Simurgh's "counsel-review draft" framing is **dropped** on the owner's instruction. The pages
carry a title, one line of intro and "Last updated 17 September 2026", with a table of contents
on wide screens. The sections are data (`LegalSection[]`), so the contents list and the tests
cannot drift from the page.

### 6. `/experts` is a screen, so the portrait proxy gets narrower

The API serves exactly one path under `/experts`: `/experts/portraits/:file`. The dev proxy and
the production nginx vhost forwarded the whole `/experts` prefix, which swallowed the new
screen. Both now forward `/experts/portraits` only.

## Consequences

- One more migration to apply; nothing earlier changes. `sessions.likes` defaults to 0, so
  records written before this ADR read as "no likes yet" rather than as missing data.
- `GET /api/me/lists` is one round trip for the whole sidebar (membership + counts); the shelf
  screens fetch their own rows.
- Anonymous lists are device-bound until sign-in. That is honest and is what the empty-state
  copy says; the alternative (refusing to save anything until you sign in) would have been a
  wall in the one place the product should feel generous.
- `session_visits` gives us "what did this learner actually attend" for free — the basis for
  "continue where you left off" later.
- The e2e suite now runs with one worker: every spec drives the same API process, the same
  in-memory database and the same room registry, and two specs teaching at once blow each
  other's latency budgets.

## Alternatives considered

- **Sidebar inside each screen.** Rejected: five screens would each own a copy of the layout,
  and the collapse state would not survive navigation.
- **Hiding the "You" rows when signed out.** Rejected: the rows genuinely work for an anonymous
  participant, and hiding them would make signing in feel compulsory.
- **Deriving History from the recording ledger.** Rejected: the ledger is per session and on
  disk; "every session this participant sat in" is an indexed read the database should answer.
- **A `playlists` table for Learn later.** Rejected as premature: one saved shelf is what the
  brief asked for, and a second table would have to be migrated anyway when playlists arrive.
