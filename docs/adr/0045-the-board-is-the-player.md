# ADR-0045: The board is the player

Status: accepted · 2026-09-24

Extends ADR-0035 (replay is a fresh session of your own) and ADR-0044 (the
session page is a watch page).

## Context

The watch page had a *Replay* button beside the board. The owner:

> *"we don't need an explicit replay button when someone clicks on the
> session card or through search. the session should be playable and
> pausable on clicking on that, exactly like youtube. the users should be
> able to see the session's board in the normal view (like youtube we see
> comments and up next etc), or full view which is only showing the session
> and board and its controls, like youtube full view."*

A replay is still what ADR-0035 says it is: the same expert teaching the
same lesson to *you*, live, as a fresh session — not a recording of somebody
else's hour. What changes is where it happens. It used to be a route of its
own, `/room/<new id>`, which the watch page sent you to. Now the watch page
is where it plays.

## Decision

### The board on the watch page is the player

Before anything plays, the board area shows the session's picture with one
play control over it, the way a video does. Pressing it creates the fresh
session (the same call as before, `replayOf`) and the live room mounts
**inside that same box**: the board, the expert's voice, the captions, the
check-ins, the ads a free plan gets, and the room's own control bar. The
URL stays `/sessions/<id>`; the fresh session is the player's business.
Opening a session from a card or a shelf row plays it on arrival (the click
is the gesture the audio needs); opening a shared link shows the play
control and waits.

### Click to pause, click to play

While the lesson is live, a press on the board pauses it and a press again
resumes it — the room's own pause and resume, the expert stopping mid-lesson
and picking up where it left off. The control bar's play/pause does the same.
The check-in card and the status line stay above the click layer, so
answering a question is never mistaken for a pause.

### Two views

**Normal view** is the watch page: the player at the top, the title, the
expert, the actions, the description, the comments, Up next. **Full view**
is the player alone over the whole screen — board and controls, nothing
else — reached from the control bar and left with the same control or
Escape. It is what `/room/<id>` has always looked like, and `/room/<id>`
stays for direct links and for rooms with guests.

### What the room screen became

`Room.tsx` is now a thin route around `SessionPlayer`, which takes a session
id and a layout: `full` (the route) or `inline` (the watch page's box). One
component, one runtime, one set of chrome; the layout decides padding, the
click layer, and what the full-screen control does.

### What went

The *Replay* button, the *Replay starts this lesson again…* note, and the
shelf rows' *Replay* button, which now opens the watch page playing. *Join*
stays for a live room; *Watch my recording* stays for a host. The Learn
later button is an icon: the bookmark says it.

## Consequences

- `useQuickStart` still creates the session and still says why it cannot,
  in the same words; it just no longer navigates. The e2e specs that
  waited for `/room/` after Replay now wait for the board inside the page.
- The room's global UI store means one player at a time, which is one
  player per page, which is what a watch page has.
- Rooms with guests are recordings, not lessons to replay (ADR-0035): the
  board area shows the picture and the note, and no play control.
- Every press is an event (ADR-0038): `player_play_clicked` with where it came
  from (the button, or arrival from a card), `full_view_toggled`; the pause and
  resume a press causes are the room's own events.
