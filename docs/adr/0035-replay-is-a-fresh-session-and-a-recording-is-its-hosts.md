# ADR-0035: "Replay" starts the lesson again as a session of your own; a recording is its host's alone

Status: accepted · 2026-09-23

## Context

The product had one word, *replay*, for two different things, and the code
had chosen the wrong one.

`/replay/:id` was a deterministic playback of a session's recording ledger:
the expert's sentences and audio, the board, the pace. Every card on Home led
to it. And the ledger it played was served by `GET /api/sessions/:id/ledger`
to **anyone with the id**, public or private, with only the `join` names
renamed. That ledger holds `caption` entries — the learner's own spoken words,
verbatim — the `note` cues whose `question` field is the model's reading of
what they asked, the `interrupt` entries, and every answer the expert composed
for that one person. The replay screen did not draw the captions, but the
saved page's "Questions asked" listed the notes to every visitor, and
`?tab=transcript` rendered the learner's lines under "Learner".

The owner's instruction was unambiguous:

> "A replay means that session can be started quickly. It's the same as a
> person start a session from the search, but because someone already did, we
> want to show convenient ways for them to start that session. Any
> interactions that user did during that original session or any other
> sessions, should not be repayable for other users to protect privacy. But the
> downloaded version should have those, and the download is only available to
> the user who took that session and is a paid user. […] they should even have
> a choice to say do not include my interactions in the downloaded video."

And on the shape of a session: the lesson and the learner's interruptions are
separate segments on one timeline, the lesson paused under each one, so that
"the session can be replayed exactly like a new session and a new user may
interact differently".

The codebase was already most of the way there. A cue carries `thread` —
`'lesson'` or a turn id — so the two kinds of segment were never mixed; the
lesson memo and the lesson voice store reuse the taught lesson and its audio
for the next learner, so a prepared lesson starts in about a hundred
milliseconds warm (ADR-0017, ADR-0019); and the learner's questions and the
answers were deliberately never stored in the voice store. What was missing
was the product decision on top.

## Decision

### 1. Replay is a fresh live session, for anyone

**"Replay" on a card, a shelf row or a saved page starts that lesson again as
a new session of the caller's own**: same topic, expert, band and language,
so the memo and the voice store already filled for it are what the session
reuses. The learner can interrupt, ask anything, set the pace, and it is
their questions and their recording. `POST /api/sessions` takes
`{ replayOf: sessionId }`; the server resolves the saved record and from then
on it is an ordinary session under every ordinary rule — daily allowance,
spend breaker, legend experts, the flag `quick_start` (ADR-0036).

A private session starts only for its own host. A replay of an unprepared
lesson is a contradiction the preparation gate refuses like any other miss.

The saved page says what the word means in one quiet line under the title:
*"Replay starts this lesson again, live, with Dario — ask anything along the
way."*

### 2. A recording is its host's, and nobody else's

**`GET /api/sessions/:id/ledger` and `/audio/:file` answer the host and
nobody else**: 401 without a bearer, 403 for anyone who is not the host, and
403 with `FEATURE_OFF` when the host's plan has `recording_playback` off.
There is no anonymised view of a recording, because the thing to anonymise
is the point of it. The session *record* — title, recap, expert, views,
likes — stays public with the host stripped, as before: the lesson is
public; the hour is not.

The headless export renderer is nobody, so it presents the same short-lived
token a download link does, minted in the host's name, and the ledger route
accepts `?token=` for it. The saved page reads the record for everyone and
the recording only when the viewer is the host, so a stranger's page never
asks for what it would be refused.

The host watches their recording from **"Watch my recording"** on the saved
page. It is labelled *Recording* on screen, not *Replay*.

### 3. The recording plays in the order it was heard, and shows the learner's words

A segment's lesson cues all take their `seq` when the segment is generated,
one segment ahead; an answer's cues take theirs when the learner asks. By
`seq`, every answer came *after* the whole segment it interrupted, so a
playback in cue order taught the segment through and then answered a question
nobody had heard asked. `recordingOrder` (`packages/contracts/src/ledger.ts`)
orders the sentences by the audio's own clock instead — each sentence's last
take, the one that was heard, at the time it was streamed; the lesson
sentences re-taken after an answer play after it — and both the replay and
the export plan use it.

The learner's own words were never recorded as sound (only the expert's voice
is). The honest playback shows them: the caption that opened each turn is
shown over the first sentence that answers it, as the room captioned it live.

### 4. The download, with or without the learner in it

The MP4 is the host's, on a plan with `session_download`. There are two
recordings to download: **with my questions** (`?interactions=1`, the session
as lived) and **lesson only** (`?interactions=0`, every turn left out: the
questions, the answers, the notes, the board work an answer drew). Two files,
two jobs, one queue: `export.mp4` / `export-lesson.mp4`, `export.json` /
`export-lesson.json`, `ExportVariant` on the job record. The download URL
names which it is, and the Downloads shelf lists the newest.

### 5. Structure, not a new format

The turn is a *thread* on the one cue stream, and stays so. Nothing was moved
into a second ledger, because the same format is what makes a turn
injectable into a live stream and separable from a recording: `thread`
decides, everywhere, and `recordingOrder({ lessonOnly })` is the one place
the separation is spelled.

## Amendment (same day): rooms, resume, and a question with nothing behind it

The owner ruled on the three things the first version left open.

**Rooms are recordings, not replays.** A room — a session with guests — is
recorded whole, questions and all, for its host, who alone watches or
exports it, "like a Zoom recording". Everyone in it is told: a *Recording*
mark in the bar while there are guests, and a guest is told once as they
take their seat. Replay is for solo sessions: `replayOf` a room answers
`409 NOT_REPLAYABLE`, a room's page shows no Replay, and rooms are not
catalogue cards (`listPublic` leaves out any session with a guest visit).
The room's *lesson* is still reused — the memo holds it — the moment anyone
searches the topic; that is Onten's and the memo's job, not the recording's.
`guests` rides on every served record (counted from `session_visits`, never
stored on the row), and is what "room" means everywhere.

**Resume restarts the cut sentence.** Kept exactly as it was: a bridge line,
then the interrupted sentence from its first word. The owner: "a real human
would not start in the middle of the sentence … restarting from the
beginning of that cut sentence doesn't hurt and it's even better and more
natural." `docs/PRODUCT.md` now says the same, and `resume.offsetMs` stays
recorded for the ledger without being acted on.

**A question the material has nothing on gets a human redirect, not a
model.** When Onten answers `missing` the expert says one warm line from
`outOfScope` (`brain.ts`, per language) — "I hear you, but for the sake of
time and today's topic, let's stay with this one … start a session on it
after" — with no model call, no note pinned, and nothing invented. The miss
is recorded as `question_out_of_scope` (turn, kind, length) beside the
learner's own words in the host's recording, so why the material had nothing
can be read back from the transcript later.

**Nothing about the learner goes on the board.** A real expert does not
write the asker's name or their question on the whiteboard. The board
carries the lesson and the expert's own check-in questions, and that is
all: the conductor draws nothing for a `note` cue (ADR-0032 already did
this; the executor's note shape is unreachable and stays so). In a room,
who asked what is the chat's job — every final line spoken to the expert
lands there under the speaker's name with a small "to Dario" mark, in its
own run, never mixed into the conversation (`ChatLine.kind`). In a solo
session nothing is shown: the learner asked it.

## Consequences

- `ReplaySession` is a host-only player. Opened by anyone else it says so and
  offers "Start this lesson".
- The glossary's **Replay** changes meaning; **Recording** is the old one.
- The e2e journey that clicked *Replay* to reach `/replay/:id` clicks *Watch my
  recording*.
- `shared_replays` is gone from the entitlement table and from Pricing: the
  owner decided a room's recording is the host's to watch or export, and a
  guest's part in it is theirs to have heard live.
- Tests: `packages/contracts/test/recording-order.test.ts`,
  `services/api/test/features.test.ts` (replay, recording access, the two
  downloads), `services/api/test/anonymise.test.ts`, `dedupe.test.ts`.
