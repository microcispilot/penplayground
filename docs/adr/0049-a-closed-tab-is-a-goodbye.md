# ADR-0049: A closed tab is a goodbye

Status: accepted · 2026-09-24

## Context

The owner:

> *"The user may not end the session, and just close the browser, tab or
> go back; the cleanups should happen properly to avoid issues like
> performance, unnecessary things, and costs and memory."*

What a closed tab did before: the socket dropped, `detach` told the room
the host had left, and the room paused — but only if it was *teaching* at
that moment. Mid-answer, mid-check-in, or while the learner held the floor,
the turn finished and the lesson went on, buying sentences ahead for
nobody. The room itself, with its Onten runtime, its ledger buffers and its
banked audio, stayed until the sweeper found it, and the sweeper's rule was
*empty and older than ten minutes*: a room abandoned in its first minute
lived nine more.

## Decision

### The host's socket going is the goodbye

`SessionRoom.leave(host)` marks the host away and, if the room is teaching,
pauses it the way the host's own Pause does: the pipeline's banked
sentences are cancelled rather than paid for further, the call is
deferred, the mode is `paused`. If a turn is in flight, it finishes — an
answer half-spoken is not cut — and `resumeLesson`, which every path back
to teaching goes through, pauses instead while the host is away. Anything
the host sends, or a rejoin, marks them present again; their own Resume
picks the lesson up where it stopped, as after any pause.

### The sweeper counts absence, not age

`LiveRoom.emptySince` is when the last seat emptied (or the room's birth,
until somebody sits down), null while anyone is seated. The sweeper ends a
room that has been empty for `ABSENT_ROOM_MS` (three minutes), whatever
its age, with the reason `idle` the statistics already know. Three minutes
is long enough for a reload, a dropped connection or a phone locked for a
minute to come back to the same lesson, and short enough that a closed tab
stops holding a room within a few minutes; the sweeper runs every minute,
so the real bound is four.

### What ending does, as before

`end` aborts the room's generation loop and every model and synthesis call
in flight through its abort signal, closes the media room, writes the
session row, rolls the ledger into statistics, and lets the registry drop
the room on its own schedule. The taught lesson's memo and its stored
audio stay: they are assets for the next learner of the topic, not this
session's leftovers.

## Consequences

- The spend after a closed tab is bounded by what was already in flight:
  the sentence being synthesised, an answer already asked for. Nothing new
  is bought for an empty room.
- A learner who closes a tab and comes back within three minutes finds the
  lesson paused where they left it; after that they start a fresh session
  of the same lesson, as with any ended session.
- Preparation of a topic nobody is waiting for is not exempt: an abandoned
  room mid-preparation is ended too. What was compiled and memoised by
  then is kept.
- Tests: `host-away.test.ts` (the room), `abandoned-room.test.ts` (over a
  real socket, with the sweeper).
