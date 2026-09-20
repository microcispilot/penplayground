# ADR-0031: One lesson, one card — and one deduplicator for the sessions that already piled up

Status: accepted · 2026-09-19

Builds on ADR-0013 (the card is cached per lesson scope), ADR-0017 (the lesson
voice store shares that scope) and ADR-0021 (so does the picture). Amends
nothing; the reuse those decisions bought is intact and this ADR measures it.

## Context

The owner opened Home and saw the same lesson several times over — same title,
same expert, same description — and said:

> "why duplicate topics are stored and generated? this is very bad if true.
> because it means we spent more tokens, time and storage"

Two claims are folded into that sentence, and they are not the same claim.
One is about the catalogue. The other is about the bill. They were measured
separately, on this machine's own `.pen-data`, before anything was changed.

### The generation is *not* duplicated

`onten/lesson-memo.json` held **one** entry for
`en.how-transformers-work-in-llms|beginner|niko-database-expert|en`, with
`timesReused: 16`. The card and picture cache (`session-meta-cache.json`) held
**two** entries — one per lesson scope, not one per session.

Counting the reuse markers across all 25 ledgers on disk:

| purpose | reused | fresh |
| --- | --- | --- |
| `plan` | 9 | 1 |
| `lesson` (cue script) | 14 | 2 |
| `session_meta` (card + picture copy) | 7 | 3 |
| `recap` | 0 | 10 |
| `turn` (a learner's question) | 0 | 2 |

And the same thing in money, per session on one topic, oldest first:
**$0.002106** for the first real telling, then $0.001221, $0.000302,
$0.000097, $0.000092, $0.000097, $0.000106, $0.000090. A second learner on the
same lesson costs about **one twentieth** of the first. That is the reuse
ADR-0013/0017/0021 were built for, and it is working.

The whole of `.pen-data/sessions` — 25 recordings — had cost **$0.009355**.
The premise that the tokens were spent twice is, measurably, not true.

Two things genuinely are regenerated per session, and both are correct:
the **recap** and the **answer to a learner's own question**, which are that
learner's session and not the lesson. The recap is the arguable one — it
summarises a script that was itself replayed — and it is noted as a possible
future memo, not fixed here.

### The catalogue *is* duplicated

`GET /api/sessions` returned `SessionRepository.listPublic()`, which was every
public, ended row ordered by views. Twenty rows, fourteen of them the same
lesson. Home rendered one card per row with no grouping anywhere
(`packages/app/src/screens/Home.tsx` has no dedupe, and never had).

So the owner saw a real defect, and it is a **display** defect, not a spend
one. Storage is duplicated too, but only in the honest sense that every
session has its own recording: 18 MB of ledgers and audio for 25 tellings of
four lessons.

### And a session row leaves orphans when it is deleted

While measuring, three tables turned out to have no deleter at all.
`session_saves`, `session_likes` and `session_visits` are `(participant,
session)` pairs with no foreign key, and nothing — not `DELETE
/api/sessions/:id`, not `DELETE /api/me` — has ever removed them by session
id. The list reads inner-join `sessions`, so leftovers are invisible rather
than harmless: they stay for ever. `site_visits.last_session_id` was never
nulled either.

## Decision

### 1. A "lesson" is the scope key, and the catalogue shows each one once

Two public, ended sessions are the same lesson when they share
`canonicalId|band|expertId|language` — the exact string `scopeKeyFor` spells
in `services/api/src/stats/derive.ts`, which is the key the lesson memo, the
card copy and the generated picture are all stored under. Sessions sharing it
were taught from the *same* memo. They are one lesson told twice.

Deliberately not duplicates:

- **another band, language or expert** — a different lesson, generated and
  priced separately;
- **a private session** — in nobody's catalogue;
- **a live session** — still being taught;
- **a session with no canonical topic** — nothing says it is the same lesson
  as anything, so it is its own group and stays visible.

`listPublic` collapses on that key. `listForHost`, history, saved, liked and
downloads are deliberately **not** collapsed: those are lists of what a person
did, and two of their own tellings are two of their own tellings.

### 2. The survivor rule, and why `segments` is not in it

Best first: how far the telling got (**recap points**, then **how long it
ran**), then how engaged anyone was (**views + likes + saves**), then the
**oldest**, whose link is the one most likely already shared, then by id so
two identical tellings rank the same way twice. `rankTellings` in
`packages/db/src/sessions.ts` is the rule in words; `listPublic` spells the
same one in SQL, and `duplicates-and-catalogue-agree` in
`packages/db/test/duplicates.test.ts` is the test that stops them drifting.

The obvious criterion — "most segments taught" — is wrong, and the data said
so. `sessions.segments` is `state.plan.segments.length`: the length of the
*plan*, not the number taught. Every telling of one memoised lesson carries
the same number, so it separates nothing and would only have hidden the
criteria that do. The real count is `session_stats.segments_reached`, which
lives in the derived statistics and which a session need not have. On this
machine, ranking on `segments` would have kept a row whose recording was not
even on disk; the recap count kept the 2.3 MB telling with the audio in it.

`sessions:dedupe` adds one criterion the database cannot see: **a telling
whose recording is still on disk outranks one whose directory has gone.**
Keeping an unreplayable row as a lesson's only card would be the worst outcome
the script could reach.

### 3. `sessions:dedupe`, dry by default

`pnpm --filter @pen/api sessions:dedupe` reports and writes nothing.
`--apply` does it. Every other script here defaults to doing the work and
takes `--dry-run`; this one deletes recordings, so the flag is the other way
round on purpose. It never runs at boot.

`--include-accounts` is needed to collapse a telling hosted by a **signed-in
account**. An anonymous session belongs to nobody who can come back for it; an
account's session is that person's history, and erasing it is a decision
somebody should have to type.

A repair pass runs first. A session whose row never got a `canonical_id` has
no scope and cannot be grouped, which is most of the duplicates on an old
database. The column is filled in **from evidence, never from a guess**: first
the `resolve` metric in the session's own ledger — what it actually resolved
to — and failing that the registry's answer for the session's stored topic,
which is precisely what `rooms.create` would have written. The canonical id
stays the registry's to decide and is never minted here
(`docs/ONTEN-BOUNDARY.md`).

### 4. Nothing is silently destroyed

For each telling that goes, in this order — everything that must survive moves
*before* anything is erased, so a crash half way leaves rows pointing at a
session that is still there:

1. its **saves, likes and history** move onto the survivor
   (`ListRepository.moveSession`), so nobody loses a lesson off a shelf; the
   like counter is recomputed from the rows rather than added up, so an
   overlap cannot double it;
2. every **site visit** that ended on it is repointed
   (`StatsRepository.moveSession`);
3. its **views** are added to the survivor's — the card now stands for the
   lesson, and dropping them would quietly lose the evidence behind "most
   learned";
4. a **redirect** row is written;
5. its **derived statistics** go (`StatsRepository.removeSession`) — they were
   rolled out of a ledger that is going too;
6. its **shelves are erased** if any remain, and its **directory** with them
   (ledger, audio, thumbnails, any rendered video);
7. the **row** goes last.

The scope-keyed caches — the lesson memo, the card cache, the picture cache,
the lesson voice store — are never touched. They belong to the lesson, not to
any session, and the survivor still needs them.

### 5. A share link outlives the session it was made from

`session_redirects` (`from_id` → `to_id`, with a reason) is written for every
erased id, and the read paths follow it: `GET /api/sessions/:id`, its
`/ledger`, its `/audio/:file`, every thumbnail size, and `/s/:id`. A link
somebody already has opens the lesson that was kept instead of a 404, and the
share page's canonical URL names the survivor, so a crawler is not told about
a page that is gone.

Redirects are **one hop, always**: collapsing a survivor repoints everything
that pointed at it rather than chaining, and an id that comes back as a
session drops any redirect standing in front of it. A check constraint
forbids the base case of an id pointing at itself. Mutating routes are
deliberately *not* redirected — nobody is the host of a session that is gone.

### 6. Deleting a session clears its shelves

`endAndErase` now calls `ListRepository.forgetSession`, and
`StatsRepository.removeSession` nulls `site_visits.last_session_id`. This is
the orphan bug above, and it is fixed for every deletion path — the host's own
delete, an account deletion, and this script — not only for the deduplicator.

## Consequences

- Home shows one card per lesson. A second learner taking the same lesson
  still gets their own session, their own recording and their own history
  entry; it simply does not add a card.
- The sitemap and Open Graph follow, because both are built from
  `listPublic`.
- Two lessons that differ only by expert are two cards. That is intended —
  they are two different generations — but it is the knob to revisit if the
  catalogue ever looks repetitive again.
- An operator can see what was merged: `session_redirects` is a readable
  audit of every collapse, with its reason.
- The recap is still generated per session. It is the one piece of
  per-session model work on a memoised lesson, ~$0.0002 a time, and memoising
  it is left for a later decision rather than smuggled into this one.

## Measured on this machine

`pnpm --filter @pen/api sessions:dedupe --apply`, against
`services/api/.pen-data`:

- 5 rows repaired with a canonical id (all `registry(hit)`; none of their
  ledgers carried a `resolve` metric).
- 3 lessons taught more than once; **15 tellings erased**, 15 redirects
  written, 10 shelf rows moved, 0 failures.
- 1 telling held back because a signed-in account hosts it.
- Sessions: **27 → 12**. Catalogue cards: **20 → 4**. Recordings on disk:
  **18 MB → 14 MB**. Orphaned visit rows afterwards: **0**.
