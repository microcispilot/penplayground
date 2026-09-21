# ADR-0033: A solo session has no panel

Status: accepted · 2026-09-20

Follows ADR-0032, which made the panel a chat between people. This decides
what happens when there are no people.

## Context

ADR-0032 took the expert's lesson out of the side panel and made it a chat
between participants: the expert never sees it, and it never interrupts.

That left a question it did not answer. **Most sessions are one learner and
one expert.** In those, the panel is a roster of two and a chat in a room
where you are the only person who can type — and nobody is going to read it.
The owner, immediately: *"A solo session should have a proper layout that
makes sense. when a chat is not needed, then that's silly to show it. we
should have a different layout for that situation."*

Right. A chat with nobody in it is furniture pretending to be a feature, and
a permanent column of it is a quarter of the screen spent saying nothing.

Meet, Zoom and Teams all behave this way already: the grid and the chat panel
are a function of who is actually in the call, not scaffolding that is always
there. A one-to-one call does not show you a participant list.

## Decision

**The panel is rendered when there is somebody else in the room, and not
otherwise.** `state.participants.length <= 1` is the whole condition.

### Solo

- No panel, at any width. The board takes the room.
- No panel toggle in the bottom bar, and **no reaction control** — a reaction
  is broadcast to participants, and there are none, so it is the same silliness
  one control along.
- One small tile over the board's lower corner (`SoloExpert`), the way a
  self-view sits in Meet. It carries exactly the three things the roster
  carried that still mean something alone:
  - **the expert is here**, with a face rather than a name in a list;
  - **what they are doing right now** — listening, thinking, speaking — which
    is what keeps a voice-first lesson from being indistinguishable from a
    page that has stopped loading;
  - **the browser holding their voice.** This is the only state in the old
    roster a learner had to *act* on, and with the panel gone there is
    nowhere else to say it. It is also the only state where the tile stops
    being a picture and becomes a button: standing there is not something to
    press.

Everything else the panel carried in a solo session is **gone, not moved**.

### With guests

The panel returns exactly as ADR-0032 built it — roster, chat, composer,
docked or as a drawer by width. Rooms are a Professional feature, so this is
the smaller half of the traffic and the larger half of the chrome, which is
the right way round.

## Consequences

- The board is bigger in the ordinary case than it has ever been: over 85 %
  of the width at every size, where the docked panel used to take a quarter.
- `ui-room.spec.ts` drives a real solo session, so it stopped being a test of
  the panel and became the test of this: no panel, no toggle, no reaction
  control, the tile present and small, and nothing painted *on* the paper.
  The docked/drawer behaviour it used to assert lives in `ui-panel.spec.ts`,
  which builds a roster with guests in it.
- `.pen-board [data-presence]` replaced `#room-board [data-presence]` in that
  spec, and the difference is the decision: the paper carries nothing, the
  board's container carries the tile. A real expert does not write on the
  whiteboard to tell you they are listening.
- `solo-expert.test.tsx` covers what the tile has to say in every presence
  the room can report, that it is a button only when there is something to
  press, that it paints no alarm colour in any state, and that it is
  positioned logically so a Persian session mirrors it.
- The reaction path, the chat path and the roster are all untouched: this is
  a decision about *when* the panel exists, not about what it is.
